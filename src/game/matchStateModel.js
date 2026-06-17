export function createPlayerState({ id, name, type, position, hand, currentTurn, hasKnocked = false }) {
  return {
    id,
    name,
    type,
    position,
    hand,
    isConnected: true,
    isActiveTurn: currentTurn === id,
    hasKnocked,
  };
}

export function createMatchResult({ game, startedAt, finishedAt = Date.now(), turnsPlayed = 0 }) {
  if (!game?.result) return null;

  const winnerId = game.result.winner === 'timeout'
    ? game.currentTurn === 'bot' ? 'player' : 'bot'
    : game.result.winner;
  const loserId = winnerId === 'player' ? 'bot' : 'player';

  return {
    winnerId,
    loserId,
    reason: game.result.winner === 'timeout' ? 'timeout' : winnerId === 'bot' ? 'bot_win' : 'player_win',
    duration: Math.max(0, finishedAt - startedAt),
    turnsPlayed,
  };
}

export function createTurnState({
  game,
  turnStartedAt,
  turnDuration,
  isResolvingAction = false,
  isDragging = false,
  canDraw = false,
  canDiscard = false,
  canKnock = false,
}) {
  return {
    currentPlayerId: game.currentTurn,
    turnStartedAt,
    turnDuration,
    isResolvingAction,
    isDragging,
    canDraw,
    canDiscard,
    canKnock,
  };
}

export function createGameStateSnapshot({
  game,
  matchId,
  startedAt,
  finishedAt = null,
  turnsPlayed = 0,
  turnState,
}) {
  const result = createMatchResult({ game, startedAt, finishedAt: finishedAt ?? Date.now(), turnsPlayed });

  return {
    matchId,
    status: game.result ? 'finished' : 'playing',
    currentTurnPlayerId: game.currentTurn,
    deck: game.drawPile,
    discardPile: game.discardPile,
    players: [
      createPlayerState({
        id: 'player',
        name: 'Voce',
        type: 'human',
        position: 'bottom',
        hand: game.playerHand,
        currentTurn: game.currentTurn,
        hasKnocked: result?.winnerId === 'player' && result.reason !== 'timeout',
      }),
      createPlayerState({
        id: 'bot',
        name: 'Oponente',
        type: 'bot',
        position: 'top',
        hand: game.opponentHand,
        currentTurn: game.currentTurn,
        hasKnocked: result?.winnerId === 'bot',
      }),
    ],
    winnerId: result?.winnerId ?? null,
    finishReason: result?.reason ?? null,
    startedAt,
    finishedAt,
    result,
    turn: turnState,
  };
}
