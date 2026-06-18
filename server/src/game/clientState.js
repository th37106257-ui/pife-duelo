function sanitizePublicLogEntry(entry = {}) {
  const payload = entry.payloadResumo ?? {};
  return {
    timestamp: entry.timestamp,
    playerId: entry.playerId ?? null,
    action: entry.action ?? 'unknown',
    accepted: Boolean(entry.accepted),
    reasonIfRejected: entry.reasonIfRejected ?? null,
    payload: {
      source: payload.source ?? null,
      cardId: payload.cardId ?? payload.card?.id ?? null,
      card: payload.card
        ? {
            id: payload.card.id,
            rank: payload.card.rank,
            suit: payload.card.suit,
            symbol: payload.card.symbol,
            color: payload.card.color,
          }
        : null,
    },
  };
}

export function buildClientGameState(gameState, viewerPlayerId) {
  const viewer = gameState.players.find((player) => player.id === viewerPlayerId);
  const opponent = gameState.players.find((player) => player.id !== viewerPlayerId);
  const topDiscardCard = gameState.discardPile[gameState.discardPile.length - 1] ?? null;

  return {
    serverNow: Date.now(),
    matchId: gameState.matchId,
    roomId: gameState.roomId,
    status: gameState.status,
    mode: gameState.mode,
    tableValue: gameState.tableValue,
    economy: gameState.economy,
    paymentStatus: gameState.paymentStatus,
    you: viewer
      ? {
          playerId: viewer.id,
          name: viewer.name,
          position: 'bottom',
          hand: viewer.hand,
          handCount: viewer.hand.length,
          hasDrawnThisTurn: viewer.hasDrawnThisTurn,
          hasKnocked: viewer.hasKnocked,
        }
      : null,
    opponent: opponent
      ? {
          playerId: opponent.id,
          name: opponent.name,
          position: 'top',
          handCount: opponent.hand.length,
          isConnected: opponent.isConnected,
          hasKnocked: opponent.hasKnocked,
        }
      : null,
    deckCount: gameState.deck.length,
    discardCount: gameState.discardPile.length,
    canRecycleDrawPile: gameState.deck.length > 0 || gameState.discardPile.length > 1,
    topDiscardCard,
    currentTurnPlayerId: gameState.currentTurnPlayerId,
    isYourTurn: gameState.currentTurnPlayerId === viewerPlayerId,
    turnNumber: gameState.turnNumber,
    turnStartedAt: gameState.turnStartedAt,
    turnDurationMs: Number(gameState.turnDurationSeconds ?? 60) * 1000,
    turnDurationSeconds: gameState.turnDurationSeconds,
    isResolvingAction: gameState.isResolvingAction,
    result: gameState.result,
    economicResult: gameState.economicResult ?? gameState.result?.economicResult ?? null,
    matchLog: (gameState.matchLog ?? []).slice(-2).map(sanitizePublicLogEntry),
    winnerId: gameState.result?.winnerId ?? null,
    loserId: gameState.result?.loserId ?? null,
    reason: gameState.result?.reason ?? null,
  };
}

export default buildClientGameState;
