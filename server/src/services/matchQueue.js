import { createId } from '../utils/createId.js';
import { calculatePrize } from '../../../src/shared/economy.js';
import { maskPhone, normalizePhone } from '../payments/PaymentService.js';
import { config } from '../config.js';
import { createRateLimiter } from '../security/rateLimiter.js';
import { buildPublicMatchReference } from './publicMatchReference.js';

const TABLE_QUEUE_IDS = new Map([
  [2, 'mesa_2'],
  [5, 'mesa_5'],
  [10, 'mesa_10'],
  [20, 'mesa_20'],
]);

const REAL_ACTIVE_ENTRY_STATUSES = new Set(['queued', 'linked', 'playing']);

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function tableQueueId(tableId) {
  const tableValue = Number(tableId);
  return TABLE_QUEUE_IDS.get(tableValue) ?? null;
}

function maskAccessLink(link) {
  const value = String(link || '');
  if (!value) return '';
  return value.replace(/([?&]entry=)[^&]+/i, '$1***');
}

function queueSnapshot(queues) {
  return Object.fromEntries([...queues.entries()].map(([queueId, queue]) => [
    queueId,
    queue.map((entry) => ({
      jogador: entry.phoneMasked,
      mesa: entry.tableValue,
      entryId: entry.entryId,
    })),
  ]));
}

function createQueueEntry({ phone, replyTo, tableId, entryId, accessLink, clock }) {
  const economy = calculatePrize(tableId);
  return {
    playerPhone: phone,
    phoneMasked: maskPhone(phone),
    replyTo: String(replyTo || phone),
    tableId: tableQueueId(tableId),
    tableValue: economy.tableValue,
    tableAmount: economy.playerEntry,
    prizeAmount: economy.winnerPrize,
    entryId,
    accessLink,
    queuedAt: nowIso(clock),
  };
}

function createQueueEntryFromStoredEntry(entry) {
  const economy = calculatePrize(entry.selectedTable);
  if (!economy) return null;
  return {
    playerPhone: normalizePhone(entry.phone),
    phoneMasked: maskPhone(entry.phone),
    replyTo: String(entry.whatsappReplyTo || entry.phone || ''),
    tableId: tableQueueId(economy.tableValue),
    tableValue: economy.tableValue,
    tableAmount: economy.playerEntry,
    prizeAmount: economy.winnerPrize,
    entryId: entry.entryId,
    accessLink: null,
    queuedAt: entry.queuedAt || entry.createdAt,
  };
}

export class MatchQueue {
  constructor({
    entryService,
    paymentsEnabled = false,
    releaseOnlineQueueEntry = () => ({ removed: false }),
    preMatchTimeoutSeconds = config.MATCH_JOIN_TIMEOUT_SECONDS,
    onPendingMatchTerminal = null,
    clock = Date.now,
    logInfo = () => {},
    logWarn = () => {},
    logError = () => {},
  } = {}) {
    this.entryService = entryService;
    this.paymentsEnabled = Boolean(paymentsEnabled);
    this.releaseOnlineQueueEntry = releaseOnlineQueueEntry;
    this.preMatchTimeoutSeconds = Number(preMatchTimeoutSeconds) || 60;
    this.onPendingMatchTerminal = onPendingMatchTerminal;
    this.clock = clock;
    this.logInfo = logInfo;
    this.logWarn = logWarn;
    this.logError = logError;
    this.queues = new Map([...TABLE_QUEUE_IDS.values()].map((id) => [id, []]));
    this.activeMatchesByPhone = new Map();
    this.pendingMatchTimeouts = new Map();
    this.pendingTerminalResults = new Map();
    this.rateLimiter = createRateLimiter({ clock });
  }

  isConfigured() {
    return Boolean(this.entryService?.isConfigured?.());
  }

  normalizeTable(tableId) {
    const economy = calculatePrize(tableId);
    return economy ? economy.tableValue : null;
  }

  syncQueueFromStore(tableId = null) {
    if (!this.entryService?.listWhatsAppQueueEntries) return;
    const tables = tableId === null ? [...TABLE_QUEUE_IDS.keys()] : [this.normalizeTable(tableId)];
    tables.filter(Boolean).forEach((tableValue) => {
      const queueId = tableQueueId(tableValue);
      const queue = this.queues.get(queueId);
      const persistedEntries = this.entryService.listWhatsAppQueueEntries({
        selectedTable: tableValue,
        includeSecrets: true,
      });
      persistedEntries.forEach((entry) => {
        const phone = normalizePhone(entry.phone);
        if (!phone || queue.some((item) => item.playerPhone === phone)) return;
        const queueEntry = createQueueEntryFromStoredEntry(entry);
        if (!queueEntry) return;
        queue.push(queueEntry);
        queue.sort((left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt));
        this.logInfo('WHATSAPP_QUEUE_RESTORED_FROM_STORE', {
          tableId: queueId,
          tableValue,
          phone: queueEntry.phoneMasked,
          entryId: queueEntry.entryId,
          queueSize: queue.length,
        });
      });
      this.logInfo('WHATSAPP_QUEUE_SYNCED', {
        tableValue,
        tableId: queueId,
        persistedCount: persistedEntries.length,
        memoryQueueSize: queue.length,
      });
    });
  }

  findPlayerQueue(playerPhone) {
    const phone = normalizePhone(playerPhone);
    if (!phone) return null;

    for (const [queueId, queue] of this.queues.entries()) {
      const entry = queue.find((item) => item.playerPhone === phone);
      if (entry) {
        return {
          tableId: queueId,
          tableValue: entry.tableValue,
          entry,
          position: queue.findIndex((item) => item.playerPhone === phone) + 1,
        };
      }
    }

    return null;
  }

  findActiveMatch(playerPhone) {
    const phone = normalizePhone(playerPhone);
    if (!phone) return null;
    const activeMatch = this.activeMatchesByPhone.get(phone);
    if (activeMatch) {
      this.logInfo('WHATSAPP_ACTIVE_MATCH_CHECK', {
        phone: maskPhone(phone),
        active: false,
        source: 'memory_reservation_not_real_match',
        matchId: activeMatch.matchId ?? null,
        entryId: activeMatch.entryId ?? null,
        status: activeMatch.status ?? null,
      });
    }

    const activeEntry = this.entryService?.getActiveEntryForPhone?.(phone);
    if (!activeEntry) {
      this.logInfo('WHATSAPP_ACTIVE_MATCH_CHECK', {
        phone: maskPhone(phone),
        active: false,
        source: 'no_active_entry',
      });
      return null;
    }

    const isRealActiveEntry = REAL_ACTIVE_ENTRY_STATUSES.has(activeEntry.status)
      || Boolean(activeEntry.linkedMatchId)
      || Boolean(activeEntry.queueSocketId)
      || Boolean(activeEntry.playingAt);

    if (isRealActiveEntry) {
      this.logInfo('WHATSAPP_ACTIVE_MATCH_CHECK', {
        phone: maskPhone(phone),
        active: true,
        source: 'entry_status',
        entryId: activeEntry.entryId,
        matchId: activeEntry.linkedMatchId ?? null,
        status: activeEntry.status,
        hasQueueSocket: Boolean(activeEntry.queueSocketId),
      });
      return {
        matchId: activeEntry.linkedMatchId ?? null,
        entryId: activeEntry.entryId,
        tableValue: activeEntry.selectedTable,
        status: activeEntry.status,
      };
    }

    this.logInfo('WHATSAPP_ACTIVE_MATCH_CHECK', {
      phone: maskPhone(phone),
      active: false,
      source: 'entry_not_real_match',
      entryId: activeEntry.entryId,
      status: activeEntry.status,
      hasLinkSent: Boolean(activeEntry.linkSentAt),
      hasLinkedMatch: Boolean(activeEntry.linkedMatchId),
      hasQueueSocket: Boolean(activeEntry.queueSocketId),
    });
    return null;
  }

  abortMatchAndReleaseParticipants({ matchId, reason = 'pre_start_match_aborted', cancelledBy = null } = {}) {
    const safeMatchId = String(matchId || '').trim();
    const normalizedCancelledBy = normalizePhone(cancelledBy);
    if (!safeMatchId) return { aborted: false, reason: 'missing_match_id', participants: [] };
    const previousTerminal = this.pendingTerminalResults.get(safeMatchId);
    if (previousTerminal) {
      const repeatedResult = { ...previousTerminal, alreadyProcessed: true };
      void Promise.resolve(this.onPendingMatchTerminal?.(repeatedResult)).catch((error) => {
        this.logError('ADMIN_MATCH_SUMMARY_FAILED', {
          publicReference: buildPublicMatchReference(safeMatchId),
          reason: 'pending_match_terminal_retry_failed',
          message: error?.message ?? String(error),
        });
      });
      return repeatedResult;
    }

    this.logInfo('MATCH_ABORT_REQUESTED', {
      matchId: safeMatchId,
      reason,
      cancelledBy: normalizedCancelledBy ? maskPhone(normalizedCancelledBy) : null,
    });

    const result = this.entryService?.abortPreStartMatchAndReleaseParticipants?.({
      matchId: safeMatchId,
      reason,
      cancelledBy: normalizedCancelledBy,
      actor: normalizedCancelledBy || 'system',
      forceFreeMode: !this.paymentsEnabled,
    }) ?? { aborted: false, reason: 'entry_service_unavailable', participants: [] };

    if (!result.aborted) return result;

    const pendingTimeout = this.pendingMatchTimeouts.get(safeMatchId);
    if (pendingTimeout) clearTimeout(pendingTimeout);
    this.pendingMatchTimeouts.delete(safeMatchId);
    this.pendingTerminalResults.set(safeMatchId, result);

    if (result.alreadyProcessed) {
      for (const [phone, activeMatch] of this.activeMatchesByPhone.entries()) {
        if (String(activeMatch?.matchId || '') === safeMatchId) this.activeMatchesByPhone.delete(phone);
      }
      this.logInfo('MATCH_ABORTED_BEFORE_START', {
        matchId: safeMatchId,
        reason: result.reason,
        cancelledBy: normalizedCancelledBy ? maskPhone(normalizedCancelledBy) : null,
        participantCount: result.participants?.length ?? 0,
        alreadyProcessed: true,
      });
      const alreadyProcessedResult = {
        ...result,
        removedFromQueues: 0,
        onlineQueueReleases: [],
      };
      void Promise.resolve(this.onPendingMatchTerminal?.(alreadyProcessedResult)).catch(() => {});
      return alreadyProcessedResult;
    }

    const participantEntryIds = new Set((result.participants ?? []).map((entry) => entry.entryId).filter(Boolean));
    const participantPhones = new Set((result.participants ?? []).map((entry) => normalizePhone(entry.playerPhone)).filter(Boolean));
    let removedFromQueues = 0;

    for (const [, queue] of this.queues.entries()) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const queued = queue[index];
        if (!participantEntryIds.has(queued.entryId) && !participantPhones.has(queued.playerPhone)) continue;
        queue.splice(index, 1);
        removedFromQueues += 1;
      }
    }

    for (const [phone, activeMatch] of this.activeMatchesByPhone.entries()) {
      if (String(activeMatch?.matchId || '') !== safeMatchId) continue;
      this.activeMatchesByPhone.delete(phone);
    }

    this.logInfo('MATCH_PARTICIPANT_RELEASE_STARTED', {
      matchId: safeMatchId,
      reason,
      participants: (result.participants ?? []).map((entry) => entry.phoneMasked),
    });

    const onlineQueueReleases = (result.participants ?? []).map((entry) => {
      this.logInfo('MATCH_ABORT_STATE_SNAPSHOT', {
        matchId: safeMatchId,
        reason,
        cancelledBy: normalizedCancelledBy ? maskPhone(normalizedCancelledBy) : null,
        playerId: entry.phoneMasked,
        playerStatus: entry.previousStatus ?? null,
        activeMatchId: entry.previousMatchId ?? null,
        activeRoomId: entry.previousMatchId ?? null,
        queueEntry: Boolean(entry.previousQueueSocketId),
        activeSession: Boolean(entry.previousQueueSocketId),
        linkTokenActive: Boolean(entry.previousLinkTokenActive),
      });
      const onlineRelease = this.releaseOnlineQueueEntry({
        entryId: entry.entryId,
        matchId: safeMatchId,
        reason,
        previousQueueSocketId: entry.previousQueueSocketId ?? null,
        paidEntryPreserved: Boolean(entry.paidConfirmed),
      }) ?? { removed: false };
      this.logInfo('MATCH_LINK_INVALIDATED', {
        matchId: safeMatchId,
        playerId: entry.phoneMasked,
        entryId: entry.entryId,
        invalidated: Boolean(entry.linkInvalidated),
      });
      this.logInfo('PLAYER_RELEASED_AFTER_MATCH_ABORT', {
        matchId: safeMatchId,
        playerId: entry.phoneMasked,
        entryId: entry.entryId,
        previousStatus: entry.previousStatus ?? null,
        newStatus: entry.status,
        previousActiveMatchId: safeMatchId,
        newActiveMatchId: null,
        queueState: 'removed',
        sessionState: onlineRelease.removed ? 'released' : 'not_active',
      });
      return onlineRelease;
    });

    this.logInfo('MATCH_ABORTED_BEFORE_START', {
      matchId: safeMatchId,
      reason,
      cancelledBy: normalizedCancelledBy ? maskPhone(normalizedCancelledBy) : null,
      participantCount: result.participants?.length ?? 0,
      alreadyProcessed: Boolean(result.alreadyProcessed),
    });
    this.logInfo('MATCH_PARTICIPANT_RELEASE_COMPLETED', {
      matchId: safeMatchId,
      reason,
      participantCount: result.participants?.length ?? 0,
      removedFromQueues,
      releasedOnlineSessions: onlineQueueReleases.filter((item) => item?.removed).length,
    });

    const completedResult = {
      ...result,
      removedFromQueues,
      onlineQueueReleases,
    };
    this.pendingTerminalResults.set(safeMatchId, completedResult);
    void Promise.resolve(this.onPendingMatchTerminal?.(completedResult)).catch((error) => {
      this.logError('ADMIN_MATCH_SUMMARY_FAILED', {
        publicReference: buildPublicMatchReference(safeMatchId),
        reason: 'pending_match_terminal_handler_failed',
        message: error?.message ?? String(error),
      });
    });
    return completedResult;
  }

  setPendingMatchTerminalHandler(handler) {
    this.onPendingMatchTerminal = typeof handler === 'function' ? handler : null;
  }

  schedulePendingMatchTimeout({ matchId, preMatchDeadline }) {
    const safeMatchId = String(matchId || '').trim();
    const deadlineMs = Date.parse(preMatchDeadline);
    if (!safeMatchId || !Number.isFinite(deadlineMs)) return false;
    const previous = this.pendingMatchTimeouts.get(safeMatchId);
    if (previous) clearTimeout(previous);
    const timeout = setTimeout(() => {
      this.pendingMatchTimeouts.delete(safeMatchId);
      this.abortMatchAndReleaseParticipants({
        matchId: safeMatchId,
        reason: 'queue_timeout_before_start',
        cancelledBy: null,
      });
    }, Math.max(0, deadlineMs - this.clock()));
    timeout.unref?.();
    this.pendingMatchTimeouts.set(safeMatchId, timeout);
    return true;
  }

  restorePendingMatchTimeouts() {
    const restored = new Set();
    const entries = this.entryService?.listEntries?.() ?? [];
    entries.forEach((entry) => {
      if (!entry.whatsappMatchId || entry.linkedMatchId || !entry.preMatchDeadline) return;
      if (restored.has(entry.whatsappMatchId)) return;
      restored.add(entry.whatsappMatchId);
      this.schedulePendingMatchTimeout({
        matchId: entry.whatsappMatchId,
        preMatchDeadline: entry.preMatchDeadline,
      });
    });
    this.logInfo('PRE_MATCH_DEADLINES_RESTORED', { count: restored.size });
    return restored.size;
  }

  markMatchStarted(whatsappMatchId, onlineMatchId) {
    const safeMatchId = String(whatsappMatchId || '').trim();
    if (!safeMatchId) return false;
    const timeout = this.pendingMatchTimeouts.get(safeMatchId);
    if (timeout) clearTimeout(timeout);
    this.pendingMatchTimeouts.delete(safeMatchId);
    for (const activeMatch of this.activeMatchesByPhone.values()) {
      if (String(activeMatch?.matchId || '') !== safeMatchId) continue;
      activeMatch.whatsappMatchId = safeMatchId;
      activeMatch.matchId = onlineMatchId || safeMatchId;
      activeMatch.status = 'playing';
      activeMatch.onlineMatchId = onlineMatchId || null;
    }
    return true;
  }

  clearPlayerState(playerPhone, { actor = null, reason = 'player_requested_cancel' } = {}) {
    const phone = normalizePhone(playerPhone);
    if (!phone) return { cleared: false, reason: 'invalid_phone' };
    this.syncQueueFromStore();

    const beforeEntries = this.entryService?.getClearableStateForPhone?.(phone) ?? {
      activeEntries: [],
      pendingEntries: [],
    };
    this.logInfo('WHATSAPP_CLEAR_PLAYER_STATE_BEFORE', {
      playerId: maskPhone(phone),
      filas: queueSnapshot(this.queues),
      activeEntries: beforeEntries.activeEntries,
      pendingEntries: beforeEntries.pendingEntries,
    });

    const preStartMatch = this.entryService?.getPreStartMatchForPhone?.(phone);
    const preStartCancellation = preStartMatch
      ? this.abortMatchAndReleaseParticipants({
          matchId: preStartMatch.matchId,
          reason,
          cancelledBy: phone,
        })
      : this.entryService?.cancelPreStartMatchForPhone?.(phone, {
          actor: actor || phone,
          source: reason,
        });
    if (preStartCancellation?.aborted) {
      const afterEntries = this.entryService?.getClearableStateForPhone?.(phone) ?? {
        activeEntries: [],
        pendingEntries: [],
      };
      this.logInfo('WHATSAPP_CLEAR_PLAYER_STATE_AFTER', {
        playerId: maskPhone(phone),
        filas: queueSnapshot(this.queues),
        activeEntries: afterEntries.activeEntries,
        pendingEntries: afterEntries.pendingEntries,
        removedFromQueues: preStartCancellation.removedFromQueues ?? 0,
        removedEntries: (preStartCancellation.participants ?? []).map((entry) => ({
          tableValue: entry.selectedTable,
          entryId: entry.entryId,
        })),
        preStartCancellation: {
          aborted: true,
          matchId: preStartCancellation.matchId,
          reason: preStartCancellation.reason,
          paidEntryPreserved: Boolean(preStartCancellation.paidEntryPreserved),
          participants: (preStartCancellation.participants ?? []).map((entry) => ({
            entryId: entry.entryId,
            phoneMasked: entry.phoneMasked,
            previousStatus: entry.previousStatus,
            status: entry.status,
          })),
        },
        realMatchPreserved: false,
      });
      return {
        cleared: true,
        removedFromQueues: preStartCancellation.removedFromQueues ?? 0,
        removedEntries: preStartCancellation.participants ?? [],
        preStartCancellation,
        releasedParticipants: preStartCancellation.participants ?? [],
        requeuedOpponents: [],
        paidEntryPreserved: Boolean(preStartCancellation.paidEntryPreserved),
        realMatchPreserved: false,
        activeMatch: null,
      };
    }
    if (preStartCancellation?.paidCancelBlocked) {
      this.logWarn('PLAYER_CANCEL_BLOCKED_AFTER_PAYMENT', {
        playerId: maskPhone(phone),
        table: preStartCancellation.table,
        entryId: preStartCancellation.entry?.entryId ?? null,
        status: preStartCancellation.entry?.status ?? null,
        matchId: preStartCancellation.matchId ?? null,
        paidConfirmed: true,
      });
      this.logInfo('WHATSAPP_CLEAR_PLAYER_STATE_AFTER', {
        playerId: maskPhone(phone),
        filas: queueSnapshot(this.queues),
        activeEntries: beforeEntries.activeEntries,
        pendingEntries: beforeEntries.pendingEntries,
        removedFromQueues: 0,
        removedEntries: [],
        paidCancelBlocked: true,
        realMatchPreserved: true,
      });
      return {
        cleared: false,
        removedFromQueues: 0,
        removedEntries: [],
        paidEntryPreserved: true,
        paidCancelBlocked: true,
        blockedEntry: preStartCancellation.entry,
        realMatchPreserved: true,
        activeMatch: null,
      };
    }
    const realActiveMatch = this.findActiveMatch(phone);
    let removedFromQueues = 0;
    const removedEntries = [];
    for (const [, queue] of this.queues.entries()) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const entry = queue[index];
        if (entry.playerPhone !== phone) continue;
        queue.splice(index, 1);
        removedFromQueues += 1;
        removedEntries.push({
          tableValue: entry.tableValue,
          entryId: entry.entryId,
        });
      }
    }

    if (preStartCancellation?.cancelled) {
      this.syncQueueFromStore(preStartCancellation.table);
      preStartCancellation.requeued.forEach((entry) => {
        this.logWarn('OPPONENT_CANCELLED_BEFORE_START', {
          cancelledPlayerId: preStartCancellation.cancelledEntry?.phoneMasked ?? maskPhone(phone),
          remainingPlayerId: entry.phoneMasked,
          table: entry.selectedTable,
          entryId: entry.entryId,
          matchId: preStartCancellation.matchId,
          remainingStatus: entry.status,
          paidConfirmed: true,
          action: 'requeued',
        });
        this.logInfo('PLAYER_REQUEUED_AFTER_OPPONENT_CANCEL', {
          playerId: entry.phoneMasked,
          table: entry.selectedTable,
          entryId: entry.entryId,
          paidConfirmed: true,
        });
        this.logInfo('PAID_ENTRY_PRESERVED', {
          playerId: entry.phoneMasked,
          table: entry.selectedTable,
          entryId: entry.entryId,
          reason: 'opponent_cancelled_before_start',
        });
      });
      this.logInfo('PLAYER_CANCELLED_BEFORE_MATCH_START', {
        playerId: preStartCancellation.cancelledEntry?.phoneMasked ?? maskPhone(phone),
        table: preStartCancellation.table,
        entryId: preStartCancellation.cancelledEntry?.entryId ?? null,
        matchId: preStartCancellation.matchId,
        status: preStartCancellation.cancelledEntry?.status ?? null,
        paidConfirmed: preStartCancellation.cancelledPaidConfirmed,
      });
      const afterEntries = this.entryService?.getClearableStateForPhone?.(phone) ?? {
        activeEntries: [],
        pendingEntries: [],
      };
      this.logInfo('WHATSAPP_CLEAR_PLAYER_STATE_AFTER', {
        playerId: maskPhone(phone),
        filas: queueSnapshot(this.queues),
        activeEntries: afterEntries.activeEntries,
        pendingEntries: afterEntries.pendingEntries,
        removedFromQueues,
        removedEntries,
        preStartCancellation: {
          cancelled: true,
          matchId: preStartCancellation.matchId,
          table: preStartCancellation.table,
          cancelledEntryId: preStartCancellation.cancelledEntry?.entryId ?? null,
          requeuedEntryIds: preStartCancellation.requeued.map((entry) => entry.entryId),
        },
        realMatchPreserved: false,
      });
      return {
        cleared: true,
        removedFromQueues,
        removedEntries,
        preStartCancellation,
        requeuedOpponents: preStartCancellation.requeued,
        paidEntryPreserved: preStartCancellation.requeued.length > 0,
        realMatchPreserved: false,
        activeMatch: null,
      };
    }

    let clearedEntries = { cleared: 0, skipped: 0, entries: [] };
    if (!realActiveMatch) {
      this.activeMatchesByPhone.delete(phone);
      clearedEntries = this.entryService?.clearPlayerEntries?.(phone, {
        actor: actor || phone,
        source: reason,
        forceFreeMode: !this.paymentsEnabled,
      }) ?? clearedEntries;
      if (clearedEntries.paidEntryPreserved) {
        this.syncQueueFromStore();
        this.logWarn('RESET_PAID_ENTRY_WARNING', {
          playerId: maskPhone(phone),
          actor: actor ? maskPhone(actor) : null,
          reason,
          entries: clearedEntries.entries,
          action: 'admin_review_required',
        });
      }
    }

    const afterEntries = this.entryService?.getClearableStateForPhone?.(phone) ?? {
      activeEntries: [],
      pendingEntries: [],
    };
    this.logInfo('WHATSAPP_CLEAR_PLAYER_STATE_AFTER', {
      playerId: maskPhone(phone),
      filas: queueSnapshot(this.queues),
      activeEntries: afterEntries.activeEntries,
      pendingEntries: afterEntries.pendingEntries,
      removedFromQueues,
      removedEntries,
      clearedEntries,
      realMatchPreserved: Boolean(realActiveMatch),
    });

    return {
      cleared: removedFromQueues > 0 || clearedEntries.cleared > 0,
      removedFromQueues,
      removedEntries,
      clearedEntries,
      paidEntryPreserved: Boolean(clearedEntries.paidEntryPreserved),
      realMatchPreserved: Boolean(realActiveMatch),
      activeMatch: realActiveMatch,
    };
  }

  removeFromQueue(playerPhone, { cancelEntry = true, reason = 'queue_cancelled' } = {}) {
    const phone = normalizePhone(playerPhone);
    if (!phone) return { removed: false };
    this.syncQueueFromStore();

    for (const [queueId, queue] of this.queues.entries()) {
      const index = queue.findIndex((entry) => entry.playerPhone === phone);
      if (index >= 0) {
        const [entry] = queue.splice(index, 1);
        if (cancelEntry && entry.entryId) {
          try {
            this.entryService?.cancelQueueEntry?.(entry.entryId, {
              actor: phone,
              source: reason,
            });
          } catch (error) {
            this.logWarn('WHATSAPP_QUEUE_ENTRY_CANCEL_FAILED', {
              tableId: queueId,
              tableValue: entry.tableValue,
              phone: entry.phoneMasked,
              entryId: entry.entryId,
              reason: error.message,
            });
          }
        }
        this.logInfo('WHATSAPP_QUEUE_LEFT', {
          tableId: queueId,
          tableValue: entry.tableValue,
          phone: entry.phoneMasked,
          entryId: entry.entryId,
          reason,
        });
        return { removed: true, entry };
      }
    }

    return { removed: false };
  }

  getQueueStatus(tableId) {
    const queueId = tableQueueId(tableId);
    const queue = queueId ? this.queues.get(queueId) ?? [] : [];
    return {
      tableId: queueId,
      tableValue: this.normalizeTable(tableId),
      waitingPlayers: queue.length,
      players: queue.map((entry, index) => ({
        position: index + 1,
        phoneMasked: entry.phoneMasked,
        entryId: entry.entryId,
        queuedAt: entry.queuedAt,
      })),
    };
  }

  createFreshEntry({ phone, tableValue }) {
    return this.entryService.createEntry({
      phone,
      selectedTable: tableValue,
      source: 'whatsapp-queue',
    });
  }

  ensureEntryAccess({ phone, tableValue }) {
    let existing = this.entryService.getActiveEntryForPhone(phone);
    const expiredPreStartMatch = Boolean(
      existing?.whatsappMatchId
      && !existing.linkedMatchId
      && !existing.playingAt
      && existing.accessExpiresAt
      && Date.parse(existing.accessExpiresAt) <= this.clock(),
    );
    if (expiredPreStartMatch) {
      const expiredMatchId = existing.whatsappMatchId;
      const expirationResult = this.abortMatchAndReleaseParticipants({
        matchId: expiredMatchId,
        reason: 'pre_start_match_link_expired',
        cancelledBy: null,
      });
      this.logInfo('PRE_START_MATCH_EXPIRED', {
        matchId: expiredMatchId,
        playerId: maskPhone(phone),
        table: existing.selectedTable,
        aborted: Boolean(expirationResult?.aborted),
        paidEntryPreserved: Boolean(expirationResult?.paidEntryPreserved),
      });
      existing = this.entryService.getActiveEntryForPhone(phone);
    }
    const staleFreeEntry = !this.paymentsEnabled
      && existing?.mode === 'safe_test_without_pix'
      && ['requeued_after_opponent_cancel', 'admin_review'].includes(existing.status);
    if (staleFreeEntry) {
      this.entryService.clearPlayerEntries(phone, {
        actor: phone,
        source: 'stale-free-entry-released-on-table-selection',
        forceFreeMode: true,
      });
      this.activeMatchesByPhone.delete(normalizePhone(phone));
      this.logInfo('STALE_FREE_ENTRY_RELEASED_ON_SELECTION', {
        playerId: maskPhone(phone),
        previousEntryId: existing.entryId,
        previousStatus: existing.status,
        previousTable: existing.selectedTable,
        attemptedTable: tableValue,
      });
    }
    let entry = staleFreeEntry ? null : existing;
    entry ??= this.createFreshEntry({ phone, tableValue });

    if (Number(entry.selectedTable) !== Number(tableValue)) {
      throw new Error('ENTRY_TABLE_LOCKED');
    }

    if (entry.status === 'pending_admin_validation') {
      return this.entryService.approveEntry({
        entryId: entry.entryId,
        actor: 'whatsapp-queue',
        source: 'whatsapp-queue-auto-match-without-pix',
      });
    }

    if (
      entry.status === 'approved_for_queue'
      && (entry.linkSentAt || entry.whatsappMatchId || entry.roomUrl)
      && !entry.linkedMatchId
      && !entry.queueSocketId
      && !entry.playingAt
    ) {
      this.logInfo('PAID_ENTRY_PRESERVED', {
        playerId: maskPhone(phone),
        table: tableValue,
        entryId: entry.entryId,
        reason: 'reuse_valid_manual_entry_waiting_opponent',
      });
      return {
        entry,
        accessLink: entry.roomUrl || null,
      };
    }

    if (
      entry.status === 'requeued_after_opponent_cancel'
      && !entry.linkedMatchId
      && !entry.queueSocketId
      && !entry.playingAt
    ) {
      return {
        entry,
        accessLink: entry.roomUrl || null,
      };
    }

    if (
      entry.status === 'approved_for_queue'
      && !entry.linkedMatchId
      && !entry.queueSocketId
      && !entry.playingAt
    ) {
      this.logWarn('WHATSAPP_QUEUE_STALE_APPROVED_ENTRY_RECYCLED', {
        phone: maskPhone(phone),
        tableValue,
        entryId: entry.entryId,
        status: entry.status,
        hasLinkSent: Boolean(entry.linkSentAt),
        reason: 'approved_entry_without_real_match',
      });
      this.entryService.cancelQueueEntry(entry.entryId, {
        actor: phone,
        source: 'stale-approved-entry-recycled',
        force: true,
      });
      entry = this.createFreshEntry({ phone, tableValue });
      return this.entryService.approveEntry({
        entryId: entry.entryId,
        actor: 'whatsapp-queue',
        source: 'whatsapp-queue-auto-match-without-pix',
      });
    }

    if (REAL_ACTIVE_ENTRY_STATUSES.has(entry.status) || entry.linkedMatchId || entry.queueSocketId || entry.playingAt) {
      throw new Error('PLAYER_ALREADY_ACTIVE_MATCH');
    }

    throw new Error('ENTRY_NOT_AVAILABLE');
  }

  joinQueue(playerPhone, tableId, { replyTo = null } = {}) {
    if (!this.isConfigured()) {
      return { blocked: true, reason: 'queue_not_configured' };
    }

    const phone = normalizePhone(playerPhone);
    const tableValue = this.normalizeTable(tableId);
    const queueId = tableQueueId(tableValue);
    console.log('[5.3] mesa recebida:', tableValue);
    console.log('[5.3] fila usada:', queueId);
    console.log('[5.3] jogador:', maskPhone(phone));
    this.logInfo('WHATSAPP_QUEUE_JOIN_REQUEST', {
      tableValueReceived: tableId,
      tableValue,
      tableId: queueId,
      phone: maskPhone(phone),
    });
    if (!phone) return { blocked: true, reason: 'invalid_phone' };
    if (!tableValue || !queueId) return { blocked: true, reason: 'invalid_table' };
    const rate = this.rateLimiter.consume(`queue:${phone}`, { limit: 8, windowMs: 60_000 });
    if (!rate.allowed) {
      this.logWarn('WHATSAPP_QUEUE_RATE_LIMITED', { phone: maskPhone(phone), tableValue });
      return { blocked: true, reason: 'rate_limited' };
    }
    this.syncQueueFromStore();
    console.log('[5.3] estado atual das filas:', queueSnapshot(this.queues));

    const existingQueue = this.findPlayerQueue(phone);
    const currentEntry = this.entryService?.getActiveEntryForPhone?.(phone) ?? null;
    const currentReservation = this.activeMatchesByPhone.get(phone) ?? null;
    this.logInfo('TABLE_SELECTION_ATTEMPT', {
      playerId: maskPhone(phone),
      tableId: queueId,
      tableValue,
      allowed: null,
      blockReason: null,
      playerStatus: currentEntry?.status ?? 'idle',
      activeMatchId: currentEntry?.linkedMatchId ?? currentReservation?.matchId ?? null,
      queueEntry: existingQueue?.entry?.entryId ?? currentEntry?.queueSocketId ?? null,
      activeSession: Boolean(currentEntry?.queueSocketId),
    });
    if (existingQueue) {
      const existingQueueState = this.queues.get(existingQueue.tableId) ?? [];
      console.log('[5.3] quantidade na fila:', existingQueueState.length);
      console.log('[5.3] estado atual das filas:', queueSnapshot(this.queues));
      this.logInfo('WHATSAPP_QUEUE_DUPLICATE_MATCH_CHECK', {
        phone: maskPhone(phone),
        requestedTable: tableValue,
        currentTable: existingQueue.tableValue,
        tableId: existingQueue.tableId,
        entryId: existingQueue.entry.entryId,
        queueSize: existingQueueState.length,
      });
      const recoveredMatch = this.tryCreateMatch(existingQueue.tableValue);
      if (recoveredMatch) {
        this.logInfo('WHATSAPP_QUEUE_DUPLICATE_RECOVERED_MATCH', {
          phone: maskPhone(phone),
          requestedTable: tableValue,
          recoveredTable: existingQueue.tableValue,
          matchId: recoveredMatch.matchId,
          players: recoveredMatch.players.map((player) => player.phoneMasked),
        });
        return {
          blocked: false,
          entry: existingQueue.entry,
          queueStatus: this.getQueueStatus(existingQueue.tableValue),
          match: recoveredMatch,
          recoveredFromDuplicate: true,
        };
      }
      this.logInfo('WHATSAPP_QUEUE_DUPLICATE', {
        phone: maskPhone(phone),
        requestedTable: tableValue,
        currentTable: existingQueue.tableValue,
        entryId: existingQueue.entry.entryId,
      });
      if (existingQueue.tableValue !== tableValue) {
        this.logWarn('PLAYER_BLOCKED_ACTIVE_QUEUE', {
          playerId: maskPhone(phone),
          currentTable: existingQueue.tableValue,
          attemptedTable: tableValue,
          entryId: existingQueue.entry.entryId,
        });
      }
      this.logWarn('TABLE_SELECTION_BLOCKED', {
        playerId: maskPhone(phone),
        tableId: queueId,
        tableValue,
        allowed: false,
        blockReason: existingQueue.tableValue === tableValue ? 'ALREADY_QUEUED' : 'ACTIVE_QUEUE',
        playerStatus: 'queued',
        activeMatchId: null,
        queueEntry: existingQueue.entry.entryId,
        activeSession: false,
      });
      return {
        blocked: true,
        reason: existingQueue.tableValue === tableValue ? 'already_in_queue' : 'already_in_other_queue',
        queue: existingQueue,
      };
    }

    const activeMatch = this.findActiveMatch(phone);
    if (activeMatch) {
      this.logWarn('WHATSAPP_QUEUE_BLOCKED_ACTIVE_MATCH', {
        phone: maskPhone(phone),
        tableValue,
        entryId: activeMatch.entryId ?? null,
        matchId: activeMatch.matchId ?? null,
        status: activeMatch.status ?? null,
      });
      this.logWarn('PLAYER_BLOCKED_ACTIVE_MATCH', {
        playerId: maskPhone(phone),
        matchId: activeMatch.matchId ?? null,
        attemptedTable: tableValue,
        entryId: activeMatch.entryId ?? null,
        status: activeMatch.status ?? null,
      });
      this.logWarn('TABLE_SELECTION_BLOCKED', {
        playerId: maskPhone(phone),
        tableId: queueId,
        tableValue,
        allowed: false,
        blockReason: 'ACTIVE_MATCH',
        playerStatus: activeMatch.status ?? null,
        activeMatchId: activeMatch.matchId ?? null,
        queueEntry: activeMatch.entryId ?? null,
        activeSession: true,
      });
      return { blocked: true, reason: 'already_in_active_match', activeMatch };
    }

    let approval;
    try {
      approval = this.ensureEntryAccess({ phone, tableValue });
    } catch (error) {
      this.logWarn('WHATSAPP_QUEUE_ENTRY_REJECTED', {
        phone: maskPhone(phone),
        tableValue,
        reason: error.message,
      });
      this.logWarn('TABLE_SELECTION_BLOCKED', {
        playerId: maskPhone(phone),
        tableId: queueId,
        tableValue,
        allowed: false,
        blockReason: error.message || 'UNKNOWN',
        playerStatus: this.entryService?.getActiveEntryForPhone?.(phone)?.status ?? null,
        activeMatchId: this.entryService?.getActiveEntryForPhone?.(phone)?.linkedMatchId ?? null,
        queueEntry: this.entryService?.getActiveEntryForPhone?.(phone)?.entryId ?? null,
        activeSession: Boolean(this.entryService?.getActiveEntryForPhone?.(phone)?.queueSocketId),
      });
      return { blocked: true, reason: error.message };
    }

    const queueEntry = createQueueEntry({
      phone,
      replyTo,
      tableId: tableValue,
      entryId: approval.entry.entryId,
      accessLink: approval.accessLink,
      clock: this.clock,
    });
    this.entryService?.markWhatsAppQueueWaiting?.(queueEntry.entryId, {
      actor: phone,
      replyTo: queueEntry.replyTo,
      source: 'whatsapp-queue',
    });
    const queue = this.queues.get(queueId);
    queue.push(queueEntry);
    console.log('[5.3] quantidade na fila:', queue.length);
    console.log('[5.3] estado atual das filas:', queueSnapshot(this.queues));

    this.logInfo('WHATSAPP_QUEUE_JOINED', {
      tableId: queueId,
      tableValue,
      phone: queueEntry.phoneMasked,
      entryId: queueEntry.entryId,
      queueSize: queue.length,
    });
    this.logInfo('WHATSAPP_QUEUE_JOIN', {
      tableId: queueId,
      tableValue,
      phone: queueEntry.phoneMasked,
      entryId: queueEntry.entryId,
      queueSize: queue.length,
    });
    this.logInfo('TABLE_SELECTION_ALLOWED', {
      playerId: queueEntry.phoneMasked,
      tableId: queueId,
      tableValue,
      allowed: true,
      blockReason: null,
      playerStatus: 'queued',
      activeMatchId: null,
      queueEntry: queueEntry.entryId,
      activeSession: false,
    });
    this.logInfo('WHATSAPP_QUEUE_STATE', {
      tableId: queueId,
      tableValue,
      queues: queueSnapshot(this.queues),
      queueSize: queue.length,
    });

    const match = this.tryCreateMatch(tableValue);
    if (!match) {
      this.logInfo('WHATSAPP_QUEUE_WAITING', {
        tableId: queueId,
        tableValue,
        phone: queueEntry.phoneMasked,
        entryId: queueEntry.entryId,
        queueSize: queue.length,
      });
    }

    return {
      blocked: false,
      entry: queueEntry,
      queueStatus: this.getQueueStatus(tableValue),
      match,
    };
  }

  tryCreateMatch(tableId) {
    const tableValue = this.normalizeTable(tableId);
    const queueId = tableQueueId(tableValue);
    if (!queueId) return null;

    const queue = this.queues.get(queueId);
    console.log('[5.3] tentando parear jogadores...');
    console.log('[5.3] mesa recebida:', tableValue);
    console.log('[5.3] fila usada:', queueId);
    console.log('[5.3] quantidade na fila:', queue?.length ?? 0);
    this.logInfo('Tentando criar partida para mesa:', {
      tableValueReceived: tableId,
      tableValue,
      tableId: queueId,
      queueSize: queue?.length ?? 0,
    });
    this.logInfo('WHATSAPP_QUEUE_MATCH_ATTEMPT', {
      tableValueReceived: tableId,
      tableValue,
      tableId: queueId,
      queueSize: queue?.length ?? 0,
    });
    if (!queue || queue.length < 2) return null;

    const players = queue.splice(0, 2);
    const matchId = createId('whatsapp_match');
    const preMatchDeadline = new Date(this.clock() + this.preMatchTimeoutSeconds * 1000).toISOString();
    const publicReference = buildPublicMatchReference(matchId);
    console.log('[5.3] jogadores pareados:', players[0]?.phoneMasked, players[1]?.phoneMasked);
    this.logInfo('Jogadores pareados:', {
      tableValue,
      tableId: queueId,
      matchId,
      players: players.map((player) => ({
        phone: player.phoneMasked,
        entryId: player.entryId,
      })),
    });
    players.forEach((player) => {
      const refreshed = this.entryService?.refreshQueueAccessLink?.(player.entryId, {
        actor: 'whatsapp-queue',
        source: 'whatsapp-queue-match',
        matchId,
        preMatchDeadline,
      });
      player.accessLink = refreshed?.accessLink ?? player.accessLink;
      console.log('[5.3] link gerado:', maskAccessLink(player.accessLink));
      this.logInfo('Link gerado:', {
        matchId,
        tableValue,
        entryId: player.entryId,
        phone: player.phoneMasked,
        linkGenerated: Boolean(player.accessLink),
      });
    });
    const roomUrl = players[0].accessLink;
    console.log('[5.3] sala criada:', matchId);
    this.logInfo('Room ID gerado:', {
      matchId,
      roomId: matchId,
      tableValue,
      roomUrlGenerated: Boolean(roomUrl),
    });
    const match = {
      matchId,
      roomId: matchId,
      tableId: queueId,
      tableValue,
      roomUrl,
      createdAt: nowIso(this.clock),
      preMatchDeadline,
      publicReference,
      players: players.map((player) => ({
        phoneMasked: player.phoneMasked,
        sendTo: player.playerPhone,
        entryId: player.entryId,
        accessLink: player.accessLink,
        matchLinkMasked: maskAccessLink(player.accessLink),
        replyTo: player.replyTo,
      })),
    };

    players.forEach((player) => {
      this.activeMatchesByPhone.set(player.playerPhone, {
        matchId,
        tableValue,
        entryId: player.entryId,
        status: 'approved_for_queue',
        preMatchDeadline,
      });
    });
    this.schedulePendingMatchTimeout({ matchId, preMatchDeadline });

    console.log('[5.3] estado atual das filas:', queueSnapshot(this.queues));
    this.logInfo('Match criada:', {
      matchId,
      publicReference,
      roomId: match.roomId,
      tableId: queueId,
      tableValue,
      players: players.map((player) => player.phoneMasked),
      queueSizeAfterMatch: queue.length,
      linkGenerated: Boolean(roomUrl),
    });
    this.logInfo('MATCH CRIADA:', {
      matchId,
      players: players.map((player) => player.phoneMasked),
      linkEnviado: players.map((player) => maskAccessLink(player.accessLink)),
    });
    this.logInfo('WHATSAPP_MATCH_CREATED', {
      matchId,
      tableId: queueId,
      tableValue,
      queueSizeAfterMatch: queue.length,
      accessLinksGenerated: players.every((player) => Boolean(player.accessLink)),
      entryIds: players.map((player) => player.entryId),
      players: players.map((player) => player.phoneMasked),
    });
    this.logInfo('MATCH_CREATED', {
      matchId,
      roomId: match.roomId,
      table: tableValue,
      tableId: queueId,
      players: players.map((player) => player.phoneMasked),
      links: players.map((player) => maskAccessLink(player.accessLink)),
      preMatchDeadline,
      queueSizeAfterMatch: queue.length,
    });
    this.logInfo('WHATSAPP_QUEUE_STATE', {
      tableId: queueId,
      tableValue,
      queues: queueSnapshot(this.queues),
      queueSize: queue.length,
    });

    return match;
  }

  releaseActiveMatch(matchId) {
    const safeMatchId = String(matchId || '').trim();
    if (!safeMatchId) return [];

    const released = [];
    for (const [phone, activeMatch] of this.activeMatchesByPhone.entries()) {
      if (String(activeMatch?.matchId || '') !== safeMatchId) continue;
      this.activeMatchesByPhone.delete(phone);
      const item = {
        playerId: maskPhone(phone),
        phoneMasked: maskPhone(phone),
        matchId: safeMatchId,
        table: activeMatch.tableValue ?? null,
        entryId: activeMatch.entryId ?? null,
        status: activeMatch.status ?? null,
      };
      released.push(item);
      this.logInfo('PLAYER_QUEUE_REMOVED_AFTER_MATCH', item);
    }

    return released;
  }
}

export { TABLE_QUEUE_IDS, tableQueueId };
export default MatchQueue;
