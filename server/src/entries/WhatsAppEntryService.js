import { createHmac, randomBytes } from 'node:crypto';
import { calculatePrize } from '../../../src/shared/economy.js';
import { maskPhone, normalizePhone } from '../payments/PaymentService.js';

export const WHATSAPP_ENTRY_STATUSES = new Set([
  'pending_admin_validation',
  'approved_for_queue',
  'queued',
  'linked',
  'playing',
  'finished',
  'rejected',
  'expired',
  'cancelled_by_player',
  'cancelled_by_admin',
  'refund_pending',
  'requeued_after_opponent_cancel',
  'admin_review',
  'abandoned_before_start',
]);

const ACTIVE_STATUSES = new Set([
  'pending_admin_validation',
  'approved_for_queue',
  'queued',
  'linked',
  'playing',
  'requeued_after_opponent_cancel',
  'admin_review',
]);

const TOKEN_VALID_STATUSES = new Set(['approved_for_queue', 'queued', 'linked', 'playing', 'requeued_after_opponent_cancel']);
const CLEARABLE_STATUSES = new Set(['pending_admin_validation', 'approved_for_queue', 'queued']);

function isPaidConfirmedLikeEntry(entry) {
  const approvedBy = String(entry?.approvedBy || '');
  const adminConfirmed = Boolean(
    entry?.approvedAt
    && approvedBy
    && approvedBy !== 'whatsapp-queue'
    && approvedBy !== 'test',
  );
  const matchLinkSent = Boolean(entry?.linkSentAt && entry?.whatsappMatchId);
  return Boolean(
    entry?.paidConfirmed === true
    || adminConfirmed
    || matchLinkSent
    || (
      entry?.approvedAt
      && (
      entry.status === 'requeued_after_opponent_cancel'
      || entry.status === 'linked'
      || entry.status === 'playing'
      )
    ),
  );
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function auditEntry({ action, actor, at, details = null }) {
  return { action, actor, at, details };
}

function invalidateMatchLinks() {
  return {
    accessTokenHash: null,
    accessExpiresAt: null,
    whatsappMatchId: null,
    roomUrl: null,
    linkSentAt: null,
  };
}

function releaseFreePlayer({ wasCancelledByPlayer }) {
  return {
    status: wasCancelledByPlayer ? 'cancelled_by_player' : 'expired',
    queuedAt: null,
    whatsappReplyTo: null,
  };
}

function restorePaidEntry({ current, wasCancelledByPlayer, at }) {
  return {
    status: wasCancelledByPlayer ? 'admin_review' : 'requeued_after_opponent_cancel',
    queuedAt: wasCancelledByPlayer ? null : at,
    whatsappReplyTo: current.whatsappReplyTo || current.phone || null,
  };
}

function buildSafePathSegment(value) {
  return encodeURIComponent(String(value || '').trim()).replace(/%2F/gi, '');
}

export function sanitizeWhatsAppEntry(entry) {
  if (!entry) return null;
  const { phone, accessTokenHash, queueSocketId, whatsappReplyTo, ...safe } = entry;
  return {
    ...structuredClone(safe),
    phoneMasked: maskPhone(phone),
  };
}

export class WhatsAppEntryService {
  constructor({
    store,
    adminNumbers = [],
    accessSecret,
    publicGameUrl,
    entryExpiryMinutes = 60,
    accessTtlMinutes = 180,
    clock = Date.now,
    tokenFactory = () => randomBytes(32).toString('base64url'),
  } = {}) {
    this.store = store;
    this.adminNumbers = new Set(adminNumbers.map(normalizePhone).filter(Boolean));
    this.accessSecret = String(accessSecret || '');
    this.publicGameUrl = String(publicGameUrl || '').replace(/\/$/, '');
    this.entryExpiryMs = Number(entryExpiryMinutes) * 60 * 1000;
    this.accessTtlMs = Number(accessTtlMinutes) * 60 * 1000;
    this.clock = clock;
    this.tokenFactory = tokenFactory;
  }

  assertConfigured() {
    if (!this.store || !this.accessSecret || !this.publicGameUrl) throw new Error('WHATSAPP_ENTRIES_NOT_CONFIGURED');
  }

  isConfigured() {
    return Boolean(this.store && this.accessSecret && this.publicGameUrl);
  }

  isAdmin(phone) {
    return this.adminNumbers.has(normalizePhone(phone));
  }

  hashToken(token) {
    return createHmac('sha256', this.accessSecret).update(String(token)).digest('hex');
  }

  buildAccessLink(token, { matchId = null } = {}) {
    const encodedToken = encodeURIComponent(String(token || ''));
    const safeMatchId = buildSafePathSegment(matchId);
    if (safeMatchId) return `${this.publicGameUrl}/join/${safeMatchId}?online=1&entry=${encodedToken}`;
    return `${this.publicGameUrl}/?online=1&entry=${encodedToken}`;
  }

  expirePendingEntries() {
    const cutoff = this.clock() - this.entryExpiryMs;
    this.store.listEntries()
      .filter((entry) => entry.status === 'pending_admin_validation' && Date.parse(entry.createdAt) < cutoff)
      .forEach((entry) => {
        this.store.updateEntry(entry.entryId, (current) => {
          const at = nowIso(this.clock);
          return {
            ...current,
            status: 'expired',
            updatedAt: at,
            auditLog: [...current.auditLog, auditEntry({ action: 'entry_expired', actor: 'system', at })],
          };
        });
      });
  }

  listEntries({ status = null } = {}) {
    this.expirePendingEntries();
    return this.store.listEntries()
      .filter((entry) => !status || entry.status === status)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map(sanitizeWhatsAppEntry);
  }

  getEntry(entryId, { includeSecrets = false } = {}) {
    this.expirePendingEntries();
    const entry = this.store.getEntry(entryId);
    return includeSecrets ? entry : sanitizeWhatsAppEntry(entry);
  }

  getActiveEntryForPhone(phone) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return null;
    this.expirePendingEntries();
    const entry = this.store.listEntries()
      .filter((item) => item.phone === normalizedPhone && ACTIVE_STATUSES.has(item.status))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    return entry ? sanitizeWhatsAppEntry(entry) : null;
  }

  listEntriesForPhone(phone, { includeSecrets = false } = {}) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return [];
    this.expirePendingEntries();
    const entries = this.store.listEntries()
      .filter((item) => item.phone === normalizedPhone)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return includeSecrets ? entries : entries.map(sanitizeWhatsAppEntry);
  }

  getClearableStateForPhone(phone) {
    const entries = this.listEntriesForPhone(phone);
    return {
      activeEntries: entries.filter((entry) => ACTIVE_STATUSES.has(entry.status)),
      pendingEntries: entries.filter((entry) => entry.status === 'pending_admin_validation'),
    };
  }

  getPreStartMatchForPhone(phone) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return null;
    this.expirePendingEntries();
    const entry = this.store.listEntries()
      .filter((item) => (
        item.phone === normalizedPhone
        && ACTIVE_STATUSES.has(item.status)
        && item.whatsappMatchId
        && !item.linkedMatchId
        && !item.playingAt
      ))
      .sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt))[0];
    if (!entry) return null;
    return {
      entry: sanitizeWhatsAppEntry(entry),
      matchId: entry.whatsappMatchId,
      table: entry.selectedTable,
      paidConfirmed: isPaidConfirmedLikeEntry(entry),
    };
  }

  abortPreStartMatchAndReleaseParticipants({
    matchId,
    reason = 'pre_start_match_aborted',
    cancelledBy = null,
    actor = 'system',
    forceFreeMode = false,
  } = {}) {
    const safeMatchId = String(matchId || '').trim();
    const normalizedCancelledBy = normalizePhone(cancelledBy);
    if (!safeMatchId) return { aborted: false, reason: 'missing_match_id', participants: [] };
    this.expirePendingEntries();

    const allEntries = this.store.listEntries();
    const participants = allEntries.filter((entry) => (
      entry.whatsappMatchId === safeMatchId
      && ACTIVE_STATUSES.has(entry.status)
      && !entry.linkedMatchId
      && !entry.playingAt
    ));

    if (!participants.length) {
      const previouslyAborted = allEntries
        .filter((entry) => entry.abortedMatchId === safeMatchId)
        .map((entry) => sanitizeWhatsAppEntry(entry));
      return {
        aborted: previouslyAborted.length > 0,
        alreadyProcessed: previouslyAborted.length > 0,
        reason: previouslyAborted.length > 0 ? 'already_aborted' : 'pre_start_match_not_found',
        matchId: safeMatchId,
        participants: previouslyAborted,
      };
    }

    const at = nowIso(this.clock);
    const released = participants.map((entry) => {
      const previousStatus = entry.status;
      const previousQueueSocketId = entry.queueSocketId || null;
      const previousLinkTokenActive = Boolean(entry.accessTokenHash);
      const notifyTo = entry.whatsappReplyTo || entry.phone || null;
      const wasCancelledByPlayer = Boolean(normalizedCancelledBy && entry.phone === normalizedCancelledBy);
      const paidConfirmed = entry.paidConfirmed === true
        || (!forceFreeMode && isPaidConfirmedLikeEntry(entry));
      const updated = this.store.updateEntry(entry.entryId, (current) => ({
        ...current,
        paidConfirmed: paidConfirmed ? true : current.paidConfirmed,
        ...(paidConfirmed
          ? restorePaidEntry({ current, wasCancelledByPlayer, at })
          : releaseFreePlayer({ wasCancelledByPlayer })),
        ...invalidateMatchLinks(),
        queueSocketId: null,
        playerId: null,
        abortedMatchId: safeMatchId,
        abortedAt: at,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({
          action: paidConfirmed
            ? (wasCancelledByPlayer ? 'paid_entry_sent_to_admin_review_after_abort' : 'paid_entry_restored_after_match_abort')
            : (wasCancelledByPlayer ? 'entry_cancelled_before_match_start' : 'entry_released_after_match_abort'),
          actor: String(actor || normalizedCancelledBy || 'system'),
          at,
          details: {
            reason: String(reason || 'pre_start_match_aborted').slice(0, 120),
            matchId: safeMatchId,
            cancelledBy: normalizedCancelledBy ? maskPhone(normalizedCancelledBy) : null,
            previousStatus,
            forceFreeMode: Boolean(forceFreeMode),
            paidConfirmed,
          },
        })],
      }));
      return {
        ...sanitizeWhatsAppEntry(updated),
        playerPhone: entry.phone,
        notifyTo,
        previousStatus,
        previousQueueSocketId,
        previousLinkTokenActive,
        previousMatchId: safeMatchId,
        linkInvalidated: true,
        paidConfirmed,
        restoredPaidEntry: paidConfirmed,
      };
    });

    return {
      aborted: true,
      alreadyProcessed: false,
      reason,
      matchId: safeMatchId,
      cancelledBy: normalizedCancelledBy || null,
      table: participants[0]?.selectedTable ?? null,
      paidEntryPreserved: released.some((entry) => entry.paidConfirmed),
      participants: released,
    };
  }

  clearPlayerEntries(phone, { actor = 'system', source = 'clear-player-state', forceFreeMode = false } = {}) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return { cleared: 0, skipped: 0, paidEntryPreserved: false, entries: [] };
    this.expirePendingEntries();
    const at = nowIso(this.clock);
    const result = {
      cleared: 0,
      skipped: 0,
      paidEntryPreserved: false,
      entries: [],
    };

    this.store.listEntries()
      .filter((entry) => entry.phone === normalizedPhone && ACTIVE_STATUSES.has(entry.status))
      .forEach((entry) => {
        const isRealMatch = Boolean(entry.linkedMatchId || entry.playingAt || entry.status === 'playing' || entry.status === 'linked');
        const freeSafeEntry = Boolean(
          forceFreeMode
          && entry.mode === 'safe_test_without_pix'
          && entry.paidConfirmed !== true,
        );
        const paidConfirmed = freeSafeEntry ? false : isPaidConfirmedLikeEntry(entry);
        if (paidConfirmed && !isRealMatch) {
          result.skipped += 1;
          result.paidEntryPreserved = true;
          const updated = this.store.updateEntry(entry.entryId, (current) => ({
            ...current,
            updatedAt: at,
            auditLog: [...current.auditLog, auditEntry({
              action: 'paid_entry_preserved_on_clear_attempt',
              actor: String(actor || 'system'),
              at,
              details: { source },
            })],
          }));
          result.entries.push({
            entryId: updated.entryId,
            status: updated.status,
            selectedTable: updated.selectedTable,
            cleared: false,
            paidConfirmed: true,
            reason: 'paid_entry_requires_admin_review',
          });
          return;
        }
        const clearableStatus = CLEARABLE_STATUSES.has(entry.status)
          || (freeSafeEntry && ['requeued_after_opponent_cancel', 'admin_review'].includes(entry.status));
        if (isRealMatch || !clearableStatus) {
          result.skipped += 1;
          result.entries.push({
            entryId: entry.entryId,
            status: entry.status,
            selectedTable: entry.selectedTable,
            cleared: false,
            reason: isRealMatch ? 'real_match_not_cancelled' : 'status_not_clearable',
            paidConfirmed,
          });
          return;
        }

        const updated = this.store.updateEntry(entry.entryId, (current) => ({
          ...current,
          status: 'expired',
          accessTokenHash: null,
          accessExpiresAt: null,
          queueSocketId: null,
          queuedAt: null,
          whatsappReplyTo: null,
          whatsappMatchId: null,
          roomUrl: null,
          updatedAt: at,
          auditLog: [...current.auditLog, auditEntry({
            action: 'entry_player_state_cleared',
            actor: String(actor || 'system'),
            at,
            details: { source },
          })],
        }));
        result.cleared += 1;
        result.entries.push({
          entryId: updated.entryId,
          status: updated.status,
          selectedTable: updated.selectedTable,
          cleared: true,
        });
      });

    return result;
  }

  cancelPreStartMatchForPhone(phone, { actor = 'system', source = 'opponent-cancel-before-start' } = {}) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return { cancelled: false, reason: 'invalid_phone', requeued: [] };
    this.expirePendingEntries();
    const entries = this.store.listEntries();
    const current = entries
      .filter((entry) => (
        entry.phone === normalizedPhone
        && ACTIVE_STATUSES.has(entry.status)
        && entry.whatsappMatchId
        && entry.linkSentAt
        && !entry.linkedMatchId
        && !entry.queueSocketId
        && !entry.playingAt
      ))
      .sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt))[0];

    if (!current) return { cancelled: false, reason: 'no_pre_start_match', requeued: [] };

    const at = nowIso(this.clock);
    const matchId = current.whatsappMatchId;
    const table = current.selectedTable;
    const paidConfirmed = isPaidConfirmedLikeEntry(current);
    if (paidConfirmed) {
      const updated = this.store.updateEntry(current.entryId, (entry) => ({
        ...entry,
        updatedAt: at,
        auditLog: [...entry.auditLog, auditEntry({
          action: 'player_cancel_blocked_after_payment',
          actor: String(actor || normalizedPhone),
          at,
          details: { source, matchId, paidConfirmed: true },
        })],
      }));
      return {
        cancelled: false,
        paidCancelBlocked: true,
        reason: 'paid_entry_cannot_self_cancel',
        matchId,
        table,
        entry: sanitizeWhatsAppEntry(updated),
        requeued: [],
      };
    }
    const cancelledStatus = paidConfirmed ? 'refund_pending' : 'cancelled_by_player';
    const cancelled = sanitizeWhatsAppEntry(this.store.updateEntry(current.entryId, (entry) => ({
      ...entry,
      status: cancelledStatus,
      accessTokenHash: null,
      accessExpiresAt: null,
      queuedAt: null,
      queueSocketId: null,
      updatedAt: at,
      auditLog: [...entry.auditLog, auditEntry({
        action: paidConfirmed ? 'entry_cancelled_by_player_admin_review' : 'entry_cancelled_by_player',
        actor: String(actor || normalizedPhone),
        at,
        details: { source, matchId, paidConfirmed },
      })],
    })));

    const requeued = entries
      .filter((entry) => (
        entry.entryId !== current.entryId
        && entry.whatsappMatchId === matchId
        && Number(entry.selectedTable) === Number(table)
        && ACTIVE_STATUSES.has(entry.status)
        && !entry.linkedMatchId
        && !entry.queueSocketId
        && !entry.playingAt
      ))
      .map((entry) => {
        const updated = this.store.updateEntry(entry.entryId, (opponent) => ({
          ...opponent,
          status: 'requeued_after_opponent_cancel',
          queuedAt: opponent.queuedAt || at,
          queueSocketId: null,
          whatsappMatchId: null,
          roomUrl: null,
          updatedAt: at,
          auditLog: [...opponent.auditLog,
            auditEntry({
              action: 'entry_requeued_after_opponent_cancel',
              actor: 'system',
              at,
              details: {
                source,
                previousMatchId: matchId,
                cancelledEntryId: current.entryId,
                paidConfirmed: isPaidConfirmedLikeEntry(opponent),
              },
            }),
            auditEntry({
              action: 'paid_entry_preserved',
              actor: 'system',
              at,
              details: {
                reason: 'opponent_cancelled_before_start',
                previousMatchId: matchId,
                paidConfirmed: isPaidConfirmedLikeEntry(opponent),
              },
            }),
          ],
        }));
        return {
          ...sanitizeWhatsAppEntry(updated),
          notifyTo: updated.whatsappReplyTo || updated.phone || null,
        };
      });

    return {
      cancelled: true,
      matchId,
      table,
      cancelledEntry: cancelled,
      cancelledPaidConfirmed: paidConfirmed,
      requeued,
    };
  }

  adminDecidePaidEntryForPhone(phone, { actor = 'admin', decision, source = 'admin-whatsapp-command' } = {}) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return { updated: false, reason: 'invalid_phone', entry: null };
    const safeDecision = String(decision || '').trim();
    const statusByDecision = {
      cancel: 'cancelled_by_admin',
      refund: 'refund_pending',
      requeue: 'requeued_after_opponent_cancel',
    };
    const nextStatus = statusByDecision[safeDecision];
    if (!nextStatus) return { updated: false, reason: 'invalid_decision', entry: null };

    this.expirePendingEntries();
    const entry = this.store.listEntries()
      .filter((item) => item.phone === normalizedPhone && ACTIVE_STATUSES.has(item.status))
      .sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt))[0];

    if (!entry) return { updated: false, reason: 'no_active_entry', entry: null };
    const paidConfirmed = isPaidConfirmedLikeEntry(entry);
    if (!paidConfirmed) return { updated: false, reason: 'entry_not_paid_confirmed', entry: sanitizeWhatsAppEntry(entry) };

    const at = nowIso(this.clock);
    const updated = this.store.updateEntry(entry.entryId, (current) => ({
      ...current,
      status: nextStatus,
      queuedAt: safeDecision === 'requeue' ? (current.queuedAt || at) : null,
      queueSocketId: null,
      linkedMatchId: safeDecision === 'requeue' ? null : current.linkedMatchId,
      whatsappMatchId: safeDecision === 'requeue' ? null : current.whatsappMatchId,
      roomUrl: safeDecision === 'requeue' ? null : current.roomUrl,
      updatedAt: at,
      auditLog: [...current.auditLog, auditEntry({
        action: `admin_${safeDecision}_paid_entry`,
        actor: String(actor || 'admin'),
        at,
        details: { source, paidConfirmed: true },
      })],
    }));

    return {
      updated: true,
      decision: safeDecision,
      entry: sanitizeWhatsAppEntry(updated),
    };
  }

  createEntry({ phone, selectedTable, source = 'whatsapp' }) {
    this.assertConfigured();
    const normalizedPhone = normalizePhone(phone);
    const economy = calculatePrize(selectedTable);
    if (!normalizedPhone) throw new Error('INVALID_PHONE');
    if (!economy) throw new Error('INVALID_TABLE');

    const existing = this.getActiveEntryForPhone(normalizedPhone);
    if (existing) {
      if (Number(existing.selectedTable) !== Number(economy.tableValue)) throw new Error('ENTRY_TABLE_LOCKED');
      return existing;
    }

    const at = nowIso(this.clock);
    const entryId = this.store.nextEntryId();
    return sanitizeWhatsAppEntry(this.store.createEntry({
      entryId,
      phone: normalizedPhone,
      selectedTable: economy.tableValue,
      tableAmount: economy.playerEntry,
      prizeAmount: economy.winnerPrize,
      source,
      mode: 'safe_test_without_pix',
      status: 'pending_admin_validation',
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      accessTokenHash: null,
      accessExpiresAt: null,
      queueSocketId: null,
      queuedAt: null,
      whatsappReplyTo: null,
      linkedMatchId: null,
      whatsappMatchId: null,
      playerId: null,
      roomUrl: null,
      linkSentAt: null,
      playingAt: null,
      finishedAt: null,
      auditLog: [auditEntry({
        action: 'entry_created',
        actor: normalizedPhone,
        at,
        details: { selectedTable: economy.tableValue, source, mode: 'safe_test_without_pix' },
      })],
      createdAt: at,
      updatedAt: at,
    }));
  }

  approveEntry({ entryId, actor, source = 'admin-panel' }) {
    this.assertConfigured();
    this.expirePendingEntries();
    const entry = this.store.getEntry(entryId);
    if (!entry) throw new Error('ENTRY_NOT_FOUND');
    if (entry.status !== 'pending_admin_validation') throw new Error('ENTRY_NOT_PENDING');

    const token = this.tokenFactory();
    const at = nowIso(this.clock);
    const accessExpiresAt = new Date(this.clock() + this.accessTtlMs).toISOString();
    const updated = this.store.updateEntry(entry.entryId, (current) => ({
      ...current,
      status: 'approved_for_queue',
      approvedBy: String(actor || 'admin'),
      approvedAt: at,
      accessTokenHash: this.hashToken(token),
      accessExpiresAt,
      updatedAt: at,
      auditLog: [...current.auditLog, auditEntry({
        action: 'entry_approved_for_queue',
        actor: String(actor || 'admin'),
        at,
        details: { source },
      })],
    }));

    return {
      entry: sanitizeWhatsAppEntry(updated),
      accessLink: this.buildAccessLink(token),
    };
  }

  rejectEntry({ entryId, actor, reason, source = 'admin-panel' }) {
    this.expirePendingEntries();
    const entry = this.store.getEntry(entryId);
    if (!entry) throw new Error('ENTRY_NOT_FOUND');
    if (entry.status !== 'pending_admin_validation') throw new Error('ENTRY_NOT_PENDING');
    const safeReason = String(reason || '').trim().slice(0, 180);
    if (!safeReason) throw new Error('REJECTION_REASON_REQUIRED');
    const at = nowIso(this.clock);
    return sanitizeWhatsAppEntry(this.store.updateEntry(entry.entryId, (current) => ({
      ...current,
      status: 'rejected',
      rejectedBy: String(actor || 'admin'),
      rejectedAt: at,
      rejectionReason: safeReason,
      updatedAt: at,
      auditLog: [...current.auditLog, auditEntry({
        action: 'entry_rejected', actor: String(actor || 'admin'), at, details: { reason: safeReason, source },
      })],
    })));
  }

  expireEntry({ entryId, actor, source = 'admin-panel' }) {
    const entry = this.store.getEntry(entryId);
    if (!entry) throw new Error('ENTRY_NOT_FOUND');
    if (entry.status !== 'pending_admin_validation') throw new Error('ENTRY_NOT_PENDING');
    const at = nowIso(this.clock);
    return sanitizeWhatsAppEntry(this.store.updateEntry(entry.entryId, (current) => ({
      ...current,
      status: 'expired',
      updatedAt: at,
      auditLog: [...current.auditLog, auditEntry({
        action: 'entry_expired', actor: String(actor || 'admin'), at, details: { source },
      })],
    })));
  }

  markLinkDelivery(entryId, { sent, error = null } = {}) {
    return sanitizeWhatsAppEntry(this.store.updateEntry(entryId, (current) => {
      if (current.status !== 'approved_for_queue') throw new Error('ENTRY_NOT_APPROVED');
      const at = nowIso(this.clock);
      return {
        ...current,
        linkSentAt: sent ? at : current.linkSentAt,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({
          action: sent ? 'entry_link_sent' : 'entry_link_delivery_failed',
          actor: 'system',
          at,
          details: error ? { error: String(error).slice(0, 180) } : null,
        })],
      };
    }));
  }

  markWhatsAppQueueWaiting(entryId, { actor = 'system', replyTo = null, source = 'whatsapp-queue' } = {}) {
    return sanitizeWhatsAppEntry(this.store.updateEntry(entryId, (current) => {
      if (!['approved_for_queue', 'requeued_after_opponent_cancel'].includes(current.status)) throw new Error('ENTRY_NOT_APPROVED');
      if (current.linkedMatchId || current.queueSocketId || current.playingAt) throw new Error('ENTRY_ALREADY_ACTIVE');
      const at = nowIso(this.clock);
      const alreadyQueued = Boolean(current.queuedAt);
      return {
        ...current,
        queuedAt: current.queuedAt || at,
        whatsappReplyTo: String(replyTo || current.whatsappReplyTo || current.phone || ''),
        updatedAt: at,
        auditLog: alreadyQueued ? current.auditLog : [...current.auditLog, auditEntry({
          action: 'entry_whatsapp_queue_waiting',
          actor: String(actor || 'system'),
          at,
          details: { source },
        })],
      };
    }));
  }

  listWhatsAppQueueEntries({ selectedTable = null, includeSecrets = false } = {}) {
    this.expirePendingEntries();
    const entries = this.store.listEntries()
      .filter((entry) => {
        const isFreshApproved = entry.status === 'approved_for_queue' && !entry.linkSentAt;
        const isRequeued = entry.status === 'requeued_after_opponent_cancel';
        return (
          (isFreshApproved || isRequeued)
          && entry.queuedAt
          && !entry.linkedMatchId
          && !entry.queueSocketId
          && !entry.playingAt
          && (selectedTable === null || Number(entry.selectedTable) === Number(selectedTable))
        );
      })
      .sort((left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt));
    return includeSecrets ? entries : entries.map(sanitizeWhatsAppEntry);
  }

  refreshQueueAccessLink(entryId, { actor = 'system', source = 'whatsapp-queue-match', matchId = null } = {}) {
    const token = this.tokenFactory();
    const at = nowIso(this.clock);
    const accessExpiresAt = new Date(this.clock() + this.accessTtlMs).toISOString();
    const safeMatchId = String(matchId || '').trim();
    const updated = this.store.updateEntry(entryId, (current) => {
      if (!['approved_for_queue', 'requeued_after_opponent_cancel'].includes(current.status)) throw new Error('ENTRY_NOT_APPROVED');
      if (current.linkedMatchId || current.queueSocketId || current.playingAt) throw new Error('ENTRY_ALREADY_ACTIVE');
      return {
        ...current,
        status: 'approved_for_queue',
        accessTokenHash: this.hashToken(token),
        accessExpiresAt,
        whatsappMatchId: safeMatchId || current.whatsappMatchId || null,
        roomUrl: safeMatchId ? `${this.publicGameUrl}/join/${buildSafePathSegment(safeMatchId)}` : current.roomUrl,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({
          action: 'entry_queue_access_refreshed',
          actor: String(actor || 'system'),
          at,
          details: { source, matchId: safeMatchId || null },
        })],
      };
    });

    return {
      entry: sanitizeWhatsAppEntry(updated),
      accessLink: this.buildAccessLink(token, { matchId: safeMatchId }),
    };
  }

  cancelQueueEntry(entryId, { actor = 'system', source = 'whatsapp-queue-cancel', force = false } = {}) {
    return sanitizeWhatsAppEntry(this.store.updateEntry(entryId, (current) => {
      if (current.status !== 'approved_for_queue') throw new Error('ENTRY_CANCEL_NOT_ALLOWED');
      if (!force && (current.linkSentAt || current.linkedMatchId || current.roomUrl)) throw new Error('ENTRY_ALREADY_LINKED');
      if (current.linkedMatchId || current.queueSocketId || current.playingAt) throw new Error('ENTRY_ALREADY_ACTIVE');
      const at = nowIso(this.clock);
      return {
        ...current,
        status: 'expired',
        accessTokenHash: null,
        accessExpiresAt: null,
        queuedAt: null,
        whatsappReplyTo: null,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({
          action: 'entry_queue_cancelled',
          actor: String(actor || 'system'),
          at,
          details: { source },
        })],
      };
    }));
  }

  rollbackApprovalAfterDeliveryFailure(entryId, { error = null } = {}) {
    return sanitizeWhatsAppEntry(this.store.updateEntry(entryId, (current) => {
      if (current.status !== 'approved_for_queue' || current.linkSentAt) throw new Error('ENTRY_APPROVAL_ROLLBACK_BLOCKED');
      const at = nowIso(this.clock);
      return {
        ...current,
        status: 'pending_admin_validation',
        approvedBy: null,
        approvedAt: null,
        accessTokenHash: null,
        accessExpiresAt: null,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({
          action: 'entry_approval_rolled_back',
          actor: 'system',
          at,
          details: error ? { error: String(error).slice(0, 180) } : null,
        })],
      };
    }));
  }

  validateAccessToken(token) {
    if (!token || !this.accessSecret) return null;
    const tokenHash = this.hashToken(token);
    const entry = this.store.listEntries().find((item) => item.accessTokenHash === tokenHash);
    if (!entry || !TOKEN_VALID_STATUSES.has(entry.status)) return null;
    if (entry.status === 'requeued_after_opponent_cancel' && !entry.whatsappMatchId) return null;
    if (entry.accessExpiresAt && Date.parse(entry.accessExpiresAt) <= this.clock()) return null;
    return sanitizeWhatsAppEntry(entry);
  }

  reserveQueueAccess({ entryId, socketId, selectedTable }) {
    return sanitizeWhatsAppEntry(this.store.updateEntry(entryId, (current) => {
      if (!['approved_for_queue', 'queued', 'requeued_after_opponent_cancel'].includes(current.status)) throw new Error('ENTRY_NOT_APPROVED');
      if (current.accessExpiresAt && Date.parse(current.accessExpiresAt) <= this.clock()) throw new Error('ENTRY_ACCESS_EXPIRED');
      if (Number(selectedTable) !== Number(current.selectedTable)) throw new Error('ENTRY_TABLE_MISMATCH');
      if (current.queueSocketId && current.queueSocketId !== socketId) throw new Error('ENTRY_ACCESS_RESERVED');
      const at = nowIso(this.clock);
      return {
        ...current,
        status: 'queued',
        queueSocketId: socketId,
        queuedAt: current.queuedAt || at,
        updatedAt: at,
        auditLog: current.queueSocketId ? current.auditLog : [...current.auditLog, auditEntry({
          action: 'entry_queued', actor: 'system', at, details: { socketId },
        })],
      };
    }));
  }

  releaseQueueAccess({ entryId, socketId, reason = 'queue_left' }) {
    const entry = this.store.getEntry(entryId);
    if (!entry || entry.status !== 'queued' || entry.queueSocketId !== socketId) return sanitizeWhatsAppEntry(entry);
    return sanitizeWhatsAppEntry(this.store.updateEntry(entryId, (current) => {
      const at = nowIso(this.clock);
      return {
        ...current,
        status: 'approved_for_queue',
        queueSocketId: null,
        queuedAt: null,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({ action: 'entry_queue_released', actor: 'system', at, details: { reason } })],
      };
    }));
  }

  linkToMatch({ entryId, socketId, matchId, playerId = null }) {
    return sanitizeWhatsAppEntry(this.store.updateEntry(entryId, (current) => {
      if (current.status !== 'queued') throw new Error('ENTRY_NOT_QUEUED');
      if (current.queueSocketId !== socketId) throw new Error('ENTRY_ACCESS_NOT_RESERVED');
      const at = nowIso(this.clock);
      return {
        ...current,
        status: 'playing',
        linkedMatchId: matchId,
        playerId: playerId || current.playerId || null,
        playingAt: at,
        updatedAt: at,
        auditLog: [...current.auditLog,
          auditEntry({ action: 'entry_linked', actor: 'system', at, details: { matchId, playerId: playerId || null } }),
          auditEntry({ action: 'entry_playing', actor: 'system', at, details: { matchId } }),
        ],
      };
    }));
  }

  finishEntriesForMatch({
    matchId,
    winnerId = null,
    loserId = null,
    reason = 'match_finished',
    includeNotificationTarget = false,
  }) {
    const safeMatchId = String(matchId || '').trim();
    if (!safeMatchId) return [];

    const at = nowIso(this.clock);
    return this.store.listEntries()
      .filter((entry) => entry.linkedMatchId === safeMatchId && ['linked', 'playing'].includes(entry.status))
      .map((entry) => {
        const updated = this.store.updateEntry(entry.entryId, (current) => ({
          ...current,
          status: 'finished',
          queueSocketId: null,
          queuedAt: null,
          finishedAt: current.finishedAt || at,
          updatedAt: at,
          auditLog: [...current.auditLog, auditEntry({
            action: 'entry_finished',
            actor: 'system',
            at,
            details: {
              matchId: safeMatchId,
              winnerId: winnerId || null,
              loserId: loserId || null,
              reason: String(reason || 'match_finished').slice(0, 80),
            },
          })],
        }));
        const safe = sanitizeWhatsAppEntry(updated);
        if (!includeNotificationTarget) return safe;
        return {
          ...safe,
          notifyTo: updated.whatsappReplyTo || updated.phone || null,
        };
      });
  }

  assertValidStatus(status) {
    return WHATSAPP_ENTRY_STATUSES.has(status);
  }
}

export default WhatsAppEntryService;
