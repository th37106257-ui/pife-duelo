import { createId } from './utils/createId.js';

const MAX_LOGS = 500;
const SENSITIVE_KEY = /password|token|authorization|cookie|secret/i;
const serverErrorLogs = [];
const clientErrorLogs = [];
const productionEvents = [];
const dailyCounters = new Map();
const queueStartedAt = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getCounters() {
  const key = todayKey();
  if (!dailyCounters.has(key)) {
    dailyCounters.clear();
    dailyCounters.set(key, {
      startedMatchesToday: 0,
      finishedMatchesToday: 0,
      reconnectCountToday: 0,
      disconnectCountToday: 0,
      autoTimeoutTurnsToday: 0,
      adminClosedMatchesToday: 0,
      integrityErrorsToday: 0,
      queueWaitTotalMs: 0,
      queueWaitSamples: 0,
    });
  }
  return dailyCounters.get(key);
}

function sanitize(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value !== 'object') return String(value);

  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_KEY.test(key))
    .map(([key, item]) => [key, sanitize(item, depth + 1)]));
}

function pushBounded(target, entry) {
  target.push(entry);
  if (target.length > MAX_LOGS) target.splice(0, target.length - MAX_LOGS);
  return entry;
}

function inferSource(event = '') {
  if (/QUEUE|MATCHMAKING/.test(event)) return 'queue';
  if (/SOCKET|PLAYER_CONNECTED|PLAYER_DISCONNECTED|RECONNECT/.test(event)) return 'socket';
  if (/ADMIN/.test(event)) return 'admin';
  if (/MATCH|DRAW|DISCARD|KNOCK|TIMEOUT|INTEGRITY|ACTION_REJECTED/.test(event)) return 'match';
  return 'server';
}

function updateMetrics(event, data) {
  const counters = getCounters();
  if (event === 'ONLINE_MATCH_CREATED' || event === 'MATCH_STARTED') counters.startedMatchesToday += event === 'ONLINE_MATCH_CREATED' ? 1 : 0;
  if (event === 'MATCH_FINISHED') counters.finishedMatchesToday += 1;
  if (event === 'PLAYER_RECONNECTED') counters.reconnectCountToday += 1;
  if (event === 'PLAYER_DISCONNECTED') counters.disconnectCountToday += 1;
  if (event === 'AUTO_TURN_TIMEOUT') counters.autoTimeoutTurnsToday += 1;
  if (event === 'ADMIN_MATCH_CLOSED') counters.adminClosedMatchesToday += 1;
  if (event === 'MATCH_INTEGRITY_ERROR' || event === 'INTEGRITY_FAILED') counters.integrityErrorsToday += 1;

  if (event === 'QUEUE_JOINED' && data?.playerId) queueStartedAt.set(data.playerId, Date.now());
  if ((event === 'QUEUE_LEFT' || event === 'QUEUE_TIMEOUT') && data?.playerId) queueStartedAt.delete(data.playerId);
  if (event === 'MATCH_FOUND' && Array.isArray(data?.players)) {
    data.players.forEach((playerId) => {
      const startedAt = queueStartedAt.get(playerId);
      if (startedAt) {
        counters.queueWaitTotalMs += Math.max(0, Date.now() - startedAt);
        counters.queueWaitSamples += 1;
        queueStartedAt.delete(playerId);
      }
    });
  }
}

export function recordServerLog({ level = 'info', source, message, event, stack = null, ...data } = {}) {
  const safeData = sanitize(data);
  const entry = {
    id: createId('log'),
    timestamp: new Date().toISOString(),
    level,
    source: source ?? inferSource(event),
    message: String(message ?? event ?? 'server-event').slice(0, 500),
    event: event ?? null,
    matchId: safeData.matchId ?? null,
    playerId: safeData.playerId ?? null,
    roomId: safeData.roomId ?? null,
    stack: stack ? String(stack).slice(0, 4000) : null,
    context: safeData,
  };
  updateMetrics(event, safeData);
  pushBounded(productionEvents, entry);
  if (level === 'error' || level === 'warn') pushBounded(serverErrorLogs, entry);
  return entry;
}

export function recordClientError(payload = {}) {
  const safe = sanitize(payload);
  return pushBounded(clientErrorLogs, {
    id: createId('client-log'),
    timestamp: new Date().toISOString(),
    level: safe.level === 'warn' || safe.level === 'info' ? safe.level : 'error',
    source: 'frontend',
    message: String(safe.message || 'client-error').slice(0, 500),
    matchId: safe.matchId ?? null,
    playerId: safe.playerId ?? null,
    roomId: safe.roomId ?? null,
    stack: safe.stack ? String(safe.stack).slice(0, 4000) : null,
    context: {
      source: safe.source ?? null,
      url: safe.url ?? null,
      userAgent: safe.userAgent ?? null,
    },
  });
}

export function listObservabilityLogs({ limit = 500 } = {}) {
  const safeLimit = Math.max(1, Math.min(MAX_LOGS, Number(limit) || MAX_LOGS));
  return {
    server: [...serverErrorLogs].reverse().slice(0, safeLimit),
    client: [...clientErrorLogs].reverse().slice(0, safeLimit),
    events: [...productionEvents].reverse().slice(0, safeLimit),
  };
}

export function getErrorCountSince(since) {
  const threshold = Number(since) || 0;
  return [...serverErrorLogs, ...clientErrorLogs]
    .filter((entry) => entry.level === 'error' && Date.parse(entry.timestamp) >= threshold).length;
}

export function getDailyObservabilityMetrics() {
  const counters = getCounters();
  return {
    ...counters,
    averageQueueTimeSeconds: counters.queueWaitSamples
      ? Math.round(counters.queueWaitTotalMs / counters.queueWaitSamples / 1000)
      : 0,
  };
}

export function clearObservabilityForTests() {
  serverErrorLogs.length = 0;
  clientErrorLogs.length = 0;
  productionEvents.length = 0;
  dailyCounters.clear();
  queueStartedAt.clear();
}

export { MAX_LOGS, serverErrorLogs };
