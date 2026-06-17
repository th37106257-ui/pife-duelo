export const MATCH_EVENTS = {
  MATCH_STARTED: 'MATCH_STARTED',
  CARD_DRAWN: 'CARD_DRAWN',
  CARD_DISCARDED: 'CARD_DISCARDED',
  TURN_CHANGED: 'TURN_CHANGED',
  PLAYER_TIMEOUT: 'PLAYER_TIMEOUT',
  PLAYER_KNOCKED: 'PLAYER_KNOCKED',
  MATCH_FINISHED: 'MATCH_FINISHED',
  MATCH_RESTARTED: 'MATCH_RESTARTED',
  INVALID_ACTION_BLOCKED: 'INVALID_ACTION_BLOCKED',
};

export function createMatchId() {
  return `match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getActorHand(game, actor) {
  return actor === 'bot' ? game?.opponentHand ?? [] : game?.playerHand ?? [];
}

export function logMatchEvent(eventName, { matchId, game, actor = game?.currentTurn, reason, extra = {} } = {}) {
  if (!eventName || typeof console === 'undefined') return;

  console.log(`[${eventName}]`, {
    matchId,
    player: actor,
    currentTurn: game?.currentTurn,
    handCount: getActorHand(game, actor).length,
    reason,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}
