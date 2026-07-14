import { config } from '../config.js';

const VALID_TABLE_VALUES = [2, 5, 10, 20];

function normalizeTableValue(value) {
  const tableValue = Number(value);
  return VALID_TABLE_VALUES.includes(tableValue) ? tableValue : null;
}

export class QueueManager {
  constructor({ timeoutSeconds = config.QUEUE_TIMEOUT_SECONDS, onTimeout } = {}) {
    this.queues = new Map(VALID_TABLE_VALUES.map((value) => [value, []]));
    this.playerEntries = new Map();
    this.socketEntries = new Map();
    this.timeouts = new Map();
    this.timeoutSeconds = timeoutSeconds;
    this.onTimeout = onTimeout;
  }

  joinQueue(player) {
    const tableValue = normalizeTableValue(player.tableValue);
    if (!tableValue) {
      return { blocked: true, reason: 'invalid-table-value' };
    }
    if (!player.playerId || !player.socketId) {
      return { blocked: true, reason: 'invalid-player' };
    }
    if (this.playerEntries.has(player.playerId) || this.socketEntries.has(player.socketId)) {
      return {
        blocked: true,
        reason: 'player-already-queued',
        entry: this.playerEntries.get(player.playerId) ?? this.socketEntries.get(player.socketId),
      };
    }

    const entry = {
      playerId: player.playerId,
      socketId: player.socketId,
      playerName: player.playerName,
      tableValue,
      paymentId: player.paymentId ?? null,
      entryId: player.entryId ?? null,
      joinedAt: new Date().toISOString(),
    };
    const queue = this.queues.get(tableValue);
    queue.push(entry);
    this.playerEntries.set(entry.playerId, entry);
    this.socketEntries.set(entry.socketId, entry);
    this.scheduleTimeout(entry);

    return {
      blocked: false,
      entry,
      queuePosition: queue.findIndex((item) => item.playerId === entry.playerId) + 1,
    };
  }

  leaveQueue(playerId) {
    const entry = this.playerEntries.get(playerId);
    if (!entry) return { removed: false };

    this.removeEntry(entry);
    return { removed: true, entry };
  }

  leaveQueueBySocket(socketId) {
    const entry = this.socketEntries.get(socketId);
    if (!entry) return { removed: false };

    this.removeEntry(entry);
    return { removed: true, entry };
  }

  leaveQueueByEntryId(entryId) {
    const safeEntryId = String(entryId || '').trim();
    if (!safeEntryId) return { removed: false };
    const entry = this.getQueue().find((item) => String(item.entryId || '') === safeEntryId);
    if (!entry) return { removed: false };

    this.removeEntry(entry);
    return { removed: true, entry };
  }

  getQueue(tableValue = null) {
    const normalizedTable = tableValue === null ? null : normalizeTableValue(tableValue);
    if (normalizedTable) {
      return [...this.queues.get(normalizedTable)];
    }

    return [...this.queues.values()].flatMap((queue) => [...queue]);
  }

  findMatch(tableValue) {
    const normalizedTable = normalizeTableValue(tableValue);
    if (!normalizedTable) return null;

    const queue = this.queues.get(normalizedTable);
    while (queue.length >= 2) {
      const first = queue.shift();
      const secondIndex = queue.findIndex((entry) => entry.playerId !== first.playerId);
      if (secondIndex < 0) {
        queue.unshift(first);
        return null;
      }

      const [second] = queue.splice(secondIndex, 1);
      this.removeEntryIndexes(first);
      this.removeEntryIndexes(second);
      return [first, second];
    }

    return null;
  }

  clearQueue() {
    this.timeouts.forEach((timeout) => clearTimeout(timeout));
    this.queues = new Map(VALID_TABLE_VALUES.map((value) => [value, []]));
    this.playerEntries.clear();
    this.socketEntries.clear();
    this.timeouts.clear();
  }

  getQueueSize(tableValue = null) {
    if (tableValue === null) {
      return this.getQueue().length;
    }

    const normalizedTable = normalizeTableValue(tableValue);
    return normalizedTable ? this.queues.get(normalizedTable).length : 0;
  }

  getQueueStatus(tableValue) {
    const normalizedTable = normalizeTableValue(tableValue);
    if (!normalizedTable) {
      return {
        tableValue: null,
        queueSize: 0,
        waitingPlayers: 0,
        maxWaitSeconds: this.timeoutSeconds,
      };
    }

    const queueSize = this.getQueueSize(normalizedTable);
    return {
      tableValue: normalizedTable,
      queueSize,
      waitingPlayers: queueSize,
      maxWaitSeconds: this.timeoutSeconds,
    };
  }

  isValidTableValue(value) {
    return Boolean(normalizeTableValue(value));
  }

  setTimeoutHandler(onTimeout) {
    this.onTimeout = onTimeout;
  }

  scheduleTimeout(entry) {
    const timeout = setTimeout(() => {
      const currentEntry = this.playerEntries.get(entry.playerId);
      if (!currentEntry) return;

      this.removeEntry(currentEntry);
      this.onTimeout?.(currentEntry);
    }, this.timeoutSeconds * 1000);
    timeout.unref?.();

    this.timeouts.set(entry.playerId, timeout);
  }

  removeEntry(entry) {
    const queue = this.queues.get(entry.tableValue);
    if (queue) {
      const index = queue.findIndex((item) => item.playerId === entry.playerId);
      if (index >= 0) queue.splice(index, 1);
    }
    this.removeEntryIndexes(entry);
  }

  removeEntryIndexes(entry) {
    const timeout = this.timeouts.get(entry.playerId);
    if (timeout) {
      clearTimeout(timeout);
    }
    this.playerEntries.delete(entry.playerId);
    this.socketEntries.delete(entry.socketId);
    this.timeouts.delete(entry.playerId);
  }
}

export { VALID_TABLE_VALUES, normalizeTableValue };
export default QueueManager;
