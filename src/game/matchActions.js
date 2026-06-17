import {
  arrangePlayerHand,
  createMatchState,
  discardFromPlayerHand,
  drawFromStock,
  getPlayerKnockResult,
  playerKnock,
  takeFromDiscard,
} from './matchEngine.js';
import { detectValidCombinations } from './rules.js';
import { createMatchId } from './matchTelemetry.js';

export function startMatch({ scenarioKey = null, startedAt = Date.now() } = {}) {
  return {
    game: createMatchState({ scenarioKey }),
    meta: {
      matchId: createMatchId(),
      startedAt,
      finishedAt: null,
      turnsPlayed: 0,
    },
  };
}

export function restartMatch(options = {}) {
  return startMatch(options);
}

export function drawCard(game, playerId = 'player', options = {}) {
  if (playerId !== 'player') {
    return { blocked: true, reason: 'unsupported-player', game };
  }

  return drawFromStock(game, options);
}

export function takeDiscardCard(game, playerId = 'player', options = {}) {
  if (playerId !== 'player') {
    return { blocked: true, reason: 'unsupported-player', game };
  }

  return takeFromDiscard(game, options);
}

export function discardCard(game, playerId = 'player', cardId, options = {}) {
  if (playerId !== 'player') {
    return { blocked: true, reason: 'unsupported-player', game };
  }

  return discardFromPlayerHand(game, cardId, options);
}

export function changeTurn(game, nextPlayerId) {
  return {
    ...game,
    currentTurn: nextPlayerId,
  };
}

export function validateKnock(playerHandGame) {
  return getPlayerKnockResult(playerHandGame);
}

export function finishMatch(game, reason, winnerId) {
  return {
    ...game,
    result: {
      type: winnerId === 'player' ? 'win' : 'loss',
      winner: winnerId,
      message: reason === 'timeout'
        ? 'Partida encerrada por tempo.'
        : winnerId === 'player'
          ? 'Voce bateu com combinacoes validas.'
          : 'Oponente bateu com combinacoes validas.',
    },
  };
}

export function resetTurnTimer(turnSeconds) {
  return turnSeconds;
}

export function rebuildHandLayout(game) {
  return arrangePlayerHand(game, { handMode: 'manual' });
}

export function knockMatch(game) {
  return playerKnock(game);
}

export { detectValidCombinations };
