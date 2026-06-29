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
]);

const ACTIVE_STATUSES = new Set([
  'pending_admin_validation',
  'approved_for_queue',
  'queued',
  'linked',
  'playing',
]);

const TOKEN_VALID_STATUSES = new Set(['approved_for_queue', 'queued', 'linked', 'playing']);

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function auditEntry({ action, actor, at, details = null }) {
  return { action, actor, at, details };
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
      accessLink: `${this.publicGameUrl}/?online=1&entry=${encodeURIComponent(token)}`,
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
      if (current.status !== 'approved_for_queue') throw new Error('ENTRY_NOT_APPROVED');
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
      .filter((entry) => (
        entry.status === 'approved_for_queue'
        && entry.queuedAt
        && !entry.linkSentAt
        && !entry.linkedMatchId
        && !entry.queueSocketId
        && !entry.playingAt
        && (selectedTable === null || Number(entry.selectedTable) === Number(selectedTable))
      ))
      .sort((left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt));
    return includeSecrets ? entries : entries.map(sanitizeWhatsAppEntry);
  }

  refreshQueueAccessLink(entryId, { actor = 'system', source = 'whatsapp-queue-match' } = {}) {
    const token = this.tokenFactory();
    const at = nowIso(this.clock);
    const accessExpiresAt = new Date(this.clock() + this.accessTtlMs).toISOString();
    const updated = this.store.updateEntry(entryId, (current) => {
      if (current.status !== 'approved_for_queue') throw new Error('ENTRY_NOT_APPROVED');
      if (current.linkedMatchId || current.queueSocketId || current.playingAt) throw new Error('ENTRY_ALREADY_ACTIVE');
      return {
        ...current,
        accessTokenHash: this.hashToken(token),
        accessExpiresAt,
        updatedAt: at,
        auditLog: [...current.auditLog, auditEntry({
          action: 'entry_queue_access_refreshed',
          actor: String(actor || 'system'),
          at,
          details: { source },
        })],
      };
    });

    return {
      entry: sanitizeWhatsAppEntry(updated),
      accessLink: `${this.publicGameUrl}/?online=1&entry=${encodeURIComponent(token)}`,
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
    if (entry.accessExpiresAt && Date.parse(entry.accessExpiresAt) <= this.clock()) return null;
    return sanitizeWhatsAppEntry(entry);
  }

  reserveQueueAccess({ entryId, socketId, selectedTable }) {
    return sanitizeWhatsAppEntry(this.store.updateEntry(entryId, (current) => {
      if (!['approved_for_queue', 'queued'].includes(current.status)) throw new Error('ENTRY_NOT_APPROVED');
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

  linkToMatch({ entryId, socketId, matchId }) {
    return sanitizeWhatsAppEntry(this.store.updateEntry(entryId, (current) => {
      if (current.status !== 'queued') throw new Error('ENTRY_NOT_QUEUED');
      if (current.queueSocketId !== socketId) throw new Error('ENTRY_ACCESS_NOT_RESERVED');
      const at = nowIso(this.clock);
      return {
        ...current,
        status: 'playing',
        linkedMatchId: matchId,
        playingAt: at,
        updatedAt: at,
        auditLog: [...current.auditLog,
          auditEntry({ action: 'entry_linked', actor: 'system', at, details: { matchId } }),
          auditEntry({ action: 'entry_playing', actor: 'system', at, details: { matchId } }),
        ],
      };
    }));
  }

  assertValidStatus(status) {
    return WHATSAPP_ENTRY_STATUSES.has(status);
  }
}

export default WhatsAppEntryService;
