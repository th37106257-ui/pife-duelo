import { createId } from '../utils/createId.js';
import { calculatePrize } from '../../../src/shared/economy.js';
import { maskPhone, normalizePhone } from '../payments/PaymentService.js';

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
    clock = Date.now,
    logInfo = () => {},
    logWarn = () => {},
    logError = () => {},
  } = {}) {
    this.entryService = entryService;
    this.clock = clock;
    this.logInfo = logInfo;
    this.logWarn = logWarn;
    this.logError = logError;
    this.queues = new Map([...TABLE_QUEUE_IDS.values()].map((id) => [id, []]));
    this.activeMatchesByPhone = new Map();
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
    const existing = this.entryService.getActiveEntryForPhone(phone);
    let entry = existing ?? this.createFreshEntry({ phone, tableValue });

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
    this.syncQueueFromStore();
    console.log('[5.3] estado atual das filas:', queueSnapshot(this.queues));

    const existingQueue = this.findPlayerQueue(phone);
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
      if (!player.accessLink) {
        const refreshed = this.entryService?.refreshQueueAccessLink?.(player.entryId, {
          actor: 'whatsapp-queue',
          source: 'whatsapp-queue-match',
        });
        player.accessLink = refreshed?.accessLink ?? player.accessLink;
      }
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
      });
    });

    console.log('[5.3] estado atual das filas:', queueSnapshot(this.queues));
    this.logInfo('Match criada:', {
      matchId,
      roomId: match.roomId,
      tableId: queueId,
      tableValue,
      players: players.map((player) => player.phoneMasked),
      queueSizeAfterMatch: queue.length,
      linkGenerated: Boolean(roomUrl),
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

    return match;
  }
}

export { TABLE_QUEUE_IDS, tableQueueId };
export default MatchQueue;
