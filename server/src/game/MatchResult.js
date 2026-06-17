export function createMatchResult({
  winnerId,
  loserId = null,
  reason,
  turnsPlayed = 0,
  durationSeconds = 0,
  finishedAt = new Date().toISOString(),
} = {}) {
  return {
    winnerId,
    loserId,
    reason,
    turnsPlayed,
    durationSeconds,
    finishedAt,
  };
}

export default createMatchResult;
