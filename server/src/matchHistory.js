import { createId } from './utils/createId.js';

const matchHistory = new Map();
const MAX_MATCH_HISTORY_RECORDS = 1000;

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getDurationSeconds(match, finishedAt) {
  const started = Date.parse(match?.startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, Math.round((finished - started) / 1000));
}

function getFinishReason(match) {
  const rawReason = match?.economicResult?.finishReason ?? match?.result?.reason ?? match?.finishReason;
  if (rawReason === 'knock') return 'beat';
  return rawReason ?? 'integrity_error';
}

function getHistoryStatus(match) {
  if (match?.status === 'finished') return 'finished';
  if (match?.status === 'canceled') return 'canceled';
  return 'error';
}

function sanitizeLogEntry(entry = {}) {
  return {
    timestamp: entry.timestamp,
    playerId: entry.playerId ?? null,
    action: entry.action ?? 'unknown',
    payloadResumo: entry.payloadResumo ?? {},
    accepted: Boolean(entry.accepted),
    reasonIfRejected: entry.reasonIfRejected ?? null,
  };
}

function sanitizePublicPlayerName(value, fallback, record) {
  if (typeof value !== 'string') return fallback;
  const name = value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!name) return fallback;
  const digits = name.replace(/\D/g, '').length;
  if (digits >= 10 && digits <= 15 && /^[+\d\s().-]+$/.test(name)) return fallback;
  if (/^(player|room|socket|entry|match|public_match)[-_][a-z\d_-]+$/i.test(name)) return fallback;
  const sensitiveIds = [record.matchId, record.roomId, record.player1Id, record.player2Id, record.winnerId, record.loserId]
    .filter((id) => typeof id === 'string' && id.length >= 8)
    .map((id) => id.toLowerCase());
  if (sensitiveIds.some((id) => name.toLowerCase().includes(id))) return fallback;
  return name;
}

function getPublicWinnerName(record) {
  if (record.winnerId && record.winnerId === record.player1Id) {
    return sanitizePublicPlayerName(record.player1Name, 'Vencedor', record);
  }
  if (record.winnerId && record.winnerId === record.player2Id) {
    return sanitizePublicPlayerName(record.player2Name, 'Vencedor', record);
  }
  return 'Vencedor';
}

function getPublicLoserName(record) {
  if (record.loserId && record.loserId === record.player1Id) {
    return sanitizePublicPlayerName(record.player1Name, 'Adversário', record);
  }
  if (record.loserId && record.loserId === record.player2Id) {
    return sanitizePublicPlayerName(record.player2Name, 'Adversário', record);
  }
  return 'Adversário';
}

function buildHistoryRecord(match) {
  const economy = match?.economicResult ?? match?.result?.economicResult ?? match?.economy ?? {};
  const players = Array.isArray(match?.players) ? match.players : [];
  const winnerId = match?.result?.winnerId ?? economy?.winnerId ?? null;
  const loserId = match?.result?.loserId ?? economy?.loserId ?? null;
  const winner = players.find((player) => player.id === winnerId);
  const loser = players.find((player) => player.id === loserId);
  const finishedAt = match?.finishedAt ?? new Date().toISOString();

  return {
    matchId: match?.matchId,
    publicId: matchHistory.get(match?.matchId)?.publicId ?? createId('public_match'),
    roomId: match?.roomId,
    tableValue: economy?.tableValue ?? match?.tableValue ?? null,
    totalPot: toNumber(economy?.totalPot),
    platformFeePercent: toNumber(economy?.platformFeePercent),
    platformFeeAmount: toNumber(economy?.platformFeeAmount),
    winnerPrize: toNumber(economy?.winnerPrize),
    player1Id: players[0]?.id ?? null,
    player2Id: players[1]?.id ?? null,
    player1Name: players[0]?.name ?? 'Jogador 1',
    player2Name: players[1]?.name ?? 'Jogador 2',
    winnerId,
    loserId,
    winnerName: winner?.name ?? winnerId ?? '-',
    loserName: loser?.name ?? loserId ?? '-',
    finishReason: getFinishReason(match),
    status: getHistoryStatus(match),
    startedAt: match?.startedAt ?? null,
    finishedAt,
    durationSeconds: getDurationSeconds(match, finishedAt),
    createdAt: matchHistory.get(match?.matchId)?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: (match?.matchLog ?? []).map(sanitizeLogEntry),
  };
}

export function createMatchHistory(match) {
  if (!match?.matchId) return null;

  const record = buildHistoryRecord(match);
  matchHistory.set(record.matchId, record);
  while (matchHistory.size > MAX_MATCH_HISTORY_RECORDS) {
    const oldestMatchId = matchHistory.keys().next().value;
    if (oldestMatchId === undefined) break;
    matchHistory.delete(oldestMatchId);
  }
  return record;
}

function toPublicHistoryRecord(record) {
  return {
    matchId: record.publicId,
    tableValue: record.tableValue,
    totalPot: record.totalPot,
    platformFeePercent: record.platformFeePercent,
    platformFeeAmount: record.platformFeeAmount,
    winnerPrize: record.winnerPrize,
    player1Name: sanitizePublicPlayerName(record.player1Name, 'Jogador 1', record),
    player2Name: sanitizePublicPlayerName(record.player2Name, 'Jogador 2', record),
    winnerName: getPublicWinnerName(record),
    loserName: getPublicLoserName(record),
    finishReason: record.finishReason,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationSeconds: record.durationSeconds,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    logCount: record.logs?.length ?? 0,
  };
}

export function listPublicMatchHistory({ limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  return [...matchHistory.values()]
    .sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt))
    .slice(0, safeLimit)
    .map(toPublicHistoryRecord);
}

export function getPublicMatchAudit(publicId) {
  const record = [...matchHistory.values()].find((entry) => entry.publicId === String(publicId || ''));
  if (!record) return null;

  const logs = (record.logs ?? []).map((entry) => ({
    timestamp: entry.timestamp,
    action: entry.action,
    accepted: Boolean(entry.accepted),
  }));
  return {
    ...toPublicHistoryRecord(record),
    logs,
    acceptedActions: logs.filter((entry) => entry.accepted).length,
    rejectedActions: logs.filter((entry) => !entry.accepted).length,
  };
}

export function listMatchHistory({ limit = 50 } = {}) {
  return [...matchHistory.values()]
    .sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt))
    .slice(0, limit)
    .map(({ logs, ...record }) => ({
      ...record,
      logCount: logs.length,
    }));
}

export function getMatchAudit(matchId) {
  const record = matchHistory.get(matchId);
  if (!record) return null;

  const logs = record.logs ?? [];
  return {
    ...record,
    logs,
    acceptedActions: logs.filter((entry) => entry.accepted).length,
    rejectedActions: logs.filter((entry) => !entry.accepted).length,
    rejectionReasons: logs
      .filter((entry) => !entry.accepted && entry.reasonIfRejected)
      .map((entry) => entry.reasonIfRejected),
  };
}

export function clearMatchHistory() {
  matchHistory.clear();
}

export default {
  createMatchHistory,
  listMatchHistory,
  getMatchAudit,
  clearMatchHistory,
};
