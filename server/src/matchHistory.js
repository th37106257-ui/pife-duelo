const matchHistory = new Map();

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
  return record;
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
