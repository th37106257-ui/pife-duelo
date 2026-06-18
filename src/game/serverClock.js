export function normalizeTimeSync(payload = {}, receivedAt = Date.now()) {
  const serverNow = Number(payload.serverNow);
  const turnStartedAt = Number.isFinite(Number(payload.turnStartedAt))
    ? Number(payload.turnStartedAt)
    : Date.parse(payload.turnStartedAt);
  const turnDurationMs = Number(payload.turnDurationMs);

  return {
    matchId: payload.matchId ?? null,
    serverNow: Number.isFinite(serverNow) ? serverNow : receivedAt,
    receivedAt,
    turnStartedAt: Number.isFinite(turnStartedAt) ? turnStartedAt : receivedAt,
    turnDurationMs: Number.isFinite(turnDurationMs) ? turnDurationMs : 60000,
    currentPlayerId: payload.currentPlayerId ?? null,
  };
}

export function getRemainingMs(sync, clientNow = Date.now()) {
  if (!sync) return 0;
  const estimatedServerNow = sync.serverNow + Math.max(0, clientNow - sync.receivedAt);
  return Math.max(0, sync.turnDurationMs - (estimatedServerNow - sync.turnStartedAt));
}

export function getRemainingSeconds(sync, clientNow = Date.now()) {
  return Math.ceil(getRemainingMs(sync, clientNow) / 1000);
}
