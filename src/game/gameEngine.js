import { createDeck, dealInitialHands, recycleDiscardPile, sortHand } from './cards.js';
import { buildDebugGame } from './debugScenarios.js';
import {
  chooseBotDiscard,
  findThreeCombinationResult,
  organizeHandByPifeRules,
  shouldBotTakeDiscard,
} from './rules.js';
import { getWinningHandAnalysis } from '../shared/pifeRules.js';

export const TURNS = {
  PLAYER: 'player',
  BOT: 'bot',
};

export const TURN_STAGES = {
  DRAW: 'awaiting-draw',
  DISCARD: 'awaiting-discard',
};

const OFFICIAL_CARD_IDS = new Set(createDeck().map((card) => card.id));
const VALID_TURNS = new Set(Object.values(TURNS));
const VALID_STAGES = new Set(Object.values(TURN_STAGES));
const HAND_KEY_BY_TURN = {
  [TURNS.PLAYER]: 'playerHand',
  [TURNS.BOT]: 'opponentHand',
};

function arrangeForMode(hand, handMode = 'auto') {
  return handMode === 'manual' ? hand : organizeHandByPifeRules(hand);
}

function getActorHandKey(actor) {
  return HAND_KEY_BY_TURN[actor];
}

function getOpponentActor(actor) {
  return actor === TURNS.PLAYER ? TURNS.BOT : TURNS.PLAYER;
}

function getActorLabel(actor) {
  return actor === TURNS.PLAYER ? 'Voce' : 'Jogador B';
}

function stripDiscardMeta(card) {
  const { discardedBy, ...cleanCard } = card;
  return cleanCard;
}

function blocked(reason, game, extra = {}) {
  return {
    blocked: true,
    reason,
    game,
    ...extra,
  };
}

function allowed(action, game, extra = {}) {
  const validation = validateGameState(game);

  if (!validation.valid) {
    return blocked('invalid-state-after-action', extra.previousGame ?? game, {
      errors: validation.errors,
    });
  }

  return {
    blocked: false,
    action,
    game,
    ...extra,
  };
}

function normalizeGameState(game, defaults = {}) {
  return {
    playerHand: [],
    opponentHand: [],
    drawPile: [],
    discardPile: [],
    currentTurn: defaults.currentTurn ?? TURNS.PLAYER,
    turnStage: defaults.turnStage ?? TURN_STAGES.DRAW,
    result: null,
    ...game,
    currentTurn: game?.currentTurn ?? defaults.currentTurn ?? TURNS.PLAYER,
    turnStage: game?.turnStage ?? defaults.turnStage ?? TURN_STAGES.DRAW,
    result: game?.result ?? null,
  };
}

function allCardZones(game) {
  return [
    ['playerHand', game.playerHand],
    ['opponentHand', game.opponentHand],
    ['drawPile', game.drawPile],
    ['discardPile', game.discardPile],
  ];
}

export function validateGameState(game) {
  const state = normalizeGameState(game);
  const errors = [];
  const seenCardIds = new Map();

  if (!VALID_TURNS.has(state.currentTurn)) {
    errors.push(`Turno invalido: ${state.currentTurn}.`);
  }

  if (!VALID_STAGES.has(state.turnStage)) {
    errors.push(`Etapa de turno invalida: ${state.turnStage}.`);
  }

  allCardZones(state).forEach(([zone, cards]) => {
    if (!Array.isArray(cards)) {
      errors.push(`${zone} precisa ser uma lista.`);
      return;
    }

    cards.forEach((card, index) => {
      if (!card || typeof card !== 'object') {
        errors.push(`${zone}[${index}] nao e uma carta valida.`);
        return;
      }

      if (!card.id || !OFFICIAL_CARD_IDS.has(card.id)) {
        errors.push(`${zone}[${index}] possui carta inexistente: ${card.id ?? 'sem-id'}.`);
        return;
      }

      if (seenCardIds.has(card.id)) {
        errors.push(`Carta duplicada: ${card.id} em ${seenCardIds.get(card.id)} e ${zone}.`);
      } else {
        seenCardIds.set(card.id, zone);
      }

      if (zone !== 'discardPile' && card.discardedBy) {
        errors.push(`${zone}[${index}] nao pode manter metadado de descarte.`);
      }

      if (zone === 'discardPile' && card.discardedBy && !VALID_TURNS.has(card.discardedBy)) {
        errors.push(`Descarte ${card.id} possui origem invalida: ${card.discardedBy}.`);
      }
    });
  });

  if (state.playerHand.length < 9 || state.playerHand.length > 10) {
    errors.push(`Mao do jogador deve ter 9 ou 10 cartas, mas tem ${state.playerHand.length}.`);
  }

  if (state.opponentHand.length < 9 || state.opponentHand.length > 10) {
    errors.push(`Mao do oponente deve ter 9 ou 10 cartas, mas tem ${state.opponentHand.length}.`);
  }

  if (!state.result && state.currentTurn === TURNS.PLAYER) {
    if (state.turnStage === TURN_STAGES.DRAW && state.playerHand.length > 9) {
      errors.push('Jogador nao pode aguardar compra com 10 cartas.');
    }

    if (state.turnStage === TURN_STAGES.DISCARD && state.playerHand.length !== 10) {
      errors.push('Jogador so pode aguardar descarte com 10 cartas.');
    }
  }

  if (!state.result && state.currentTurn === TURNS.BOT) {
    if (state.turnStage === TURN_STAGES.DRAW && state.opponentHand.length > 9) {
      errors.push('Bot nao pode aguardar compra com 10 cartas.');
    }

    if (state.turnStage === TURN_STAGES.DISCARD && state.opponentHand.length !== 10) {
      errors.push('Bot so pode aguardar descarte com 10 cartas.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function guardAction(game, actor, stage = null, defaults = {}) {
  const state = normalizeGameState(game, defaults);
  const validation = validateGameState(state);

  if (!validation.valid) {
    return blocked('invalid-state', state, { errors: validation.errors });
  }

  if (state.result) {
    return blocked('match-finished', state);
  }

  if (state.currentTurn !== actor) {
    return blocked('out-of-turn', state);
  }

  if (stage && state.turnStage !== stage) {
    return blocked('invalid-turn-stage', state);
  }

  return { blocked: false, game: state };
}

export function createGameEngineState({ scenarioKey = null, handMode = 'auto' } = {}) {
  const initialGame = buildDebugGame(scenarioKey) ?? dealInitialHands();
  const game = normalizeGameState({
    ...initialGame,
    playerHand: arrangeForMode(initialGame.playerHand, handMode),
    currentTurn: TURNS.PLAYER,
    turnStage: TURN_STAGES.DRAW,
    result: null,
  });
  const validation = validateGameState(game);

  if (!validation.valid) {
    throw new Error(`Estado inicial invalido: ${validation.errors.join(' ')}`);
  }

  return game;
}

export function getOpponentDiscards(discardPile = []) {
  return discardPile.filter((card) => card.discardedBy === TURNS.BOT || !card.discardedBy);
}

export function getPlayerKnockResult(game) {
  return getKnockResultForActor(game, TURNS.PLAYER);
}

export function getKnockResultForActor(game, actor = game?.currentTurn ?? TURNS.PLAYER) {
  const state = normalizeGameState(game, { currentTurn: actor });
  const validation = validateGameState(state);
  const handKey = getActorHandKey(actor);

  if (!handKey || !validation.valid || state.currentTurn !== actor || state.result) {
    return {
      valid: false,
      groups: [],
      usedExtraCards: [],
      errors: validation.errors,
    };
  }

  const analysis = getWinningHandAnalysis(state[handKey]);

  return {
    valid: analysis.valid,
    groups: analysis.validGroups.map((group) => group.cards),
    validGroups: analysis.validGroups,
    usedExtraCards: [],
  };
}

export function playerDrawFromStock(game, { handMode = 'auto' } = {}) {
  return drawFromStockForActor(game, TURNS.PLAYER, { handMode });
}

export function drawFromStockForActor(game, actor = TURNS.PLAYER, { handMode = 'auto' } = {}) {
  const handKey = getActorHandKey(actor);
  if (!handKey) return blocked('invalid-actor', normalizeGameState(game));

  const guard = guardAction(game, actor, TURN_STAGES.DRAW, { currentTurn: actor });
  if (guard.blocked) return guard;

  const state = guard.game;
  if (state[handKey].length >= 10) return blocked('actor-hand-full', state);

  const recycledState = recycleDiscardPile(state.drawPile, state.discardPile);

  if (recycledState.drawPile.length === 0) {
    return blocked('empty-stock', {
      ...state,
      discardPile: recycledState.discardPile,
    }, {
      recycled: recycledState.recycled,
    });
  }

  const [drawnCard, ...drawPile] = recycledState.drawPile;
  const nextHand = [...state[handKey], drawnCard];
  const nextGame = {
    ...state,
    [handKey]: arrangeForMode(nextHand, handMode),
    drawPile,
    discardPile: recycledState.discardPile,
    currentTurn: actor,
    turnStage: TURN_STAGES.DISCARD,
  };

  return allowed(`${actor}-draw-stock`, nextGame, {
    previousGame: state,
    recycled: recycledState.recycled,
    drawnCard,
  });
}

export function playerTakeFromDiscard(game, { handMode = 'auto' } = {}) {
  return takeFromDiscardForActor(game, TURNS.PLAYER, { handMode });
}

export function takeFromDiscardForActor(game, actor = TURNS.PLAYER, { handMode = 'auto' } = {}) {
  const handKey = getActorHandKey(actor);
  if (!handKey) return blocked('invalid-actor', normalizeGameState(game));

  const guard = guardAction(game, actor, TURN_STAGES.DRAW, { currentTurn: actor });
  if (guard.blocked) return guard;

  const state = guard.game;
  const topDiscard = state.discardPile[state.discardPile.length - 1];

  if (state[handKey].length >= 10) return blocked('actor-hand-full', state);
  if (!topDiscard) return blocked('empty-discard', state);
  if (topDiscard.discardedBy === actor) return blocked('own-discard', state);

  const cleanCard = stripDiscardMeta(topDiscard);
  const nextGame = {
    ...state,
    [handKey]: arrangeForMode([...state[handKey], cleanCard], handMode),
    discardPile: state.discardPile.slice(0, -1),
    currentTurn: actor,
    turnStage: TURN_STAGES.DISCARD,
  };

  return allowed(`${actor}-take-discard`, nextGame, {
    previousGame: state,
    takenCard: cleanCard,
  });
}

export function playerDiscardFromHand(game, cardId, { handMode = 'auto' } = {}) {
  return discardFromHandForActor(game, TURNS.PLAYER, cardId, { handMode });
}

export function discardFromHandForActor(game, actor = TURNS.PLAYER, cardId, { handMode = 'auto' } = {}) {
  const handKey = getActorHandKey(actor);
  if (!handKey) return blocked('invalid-actor', normalizeGameState(game));

  const guard = guardAction(game, actor, TURN_STAGES.DISCARD, { currentTurn: actor });
  if (guard.blocked) return guard;

  const state = guard.game;
  const discardedCard = state[handKey].find((card) => card.id === cardId);

  if (!discardedCard) return blocked('missing-card', state);
  if (state[handKey].length !== 10) return blocked('discard-requires-drawn-card', state);

  const nextHand = state[handKey].filter((card) => card.id !== cardId);
  const nextGame = {
    ...state,
    [handKey]: arrangeForMode(nextHand, handMode),
    discardPile: [...state.discardPile, { ...discardedCard, discardedBy: actor }],
    currentTurn: getOpponentActor(actor),
    turnStage: TURN_STAGES.DRAW,
  };

  return allowed(`${actor}-discard`, nextGame, {
    previousGame: state,
    discardedCard,
  });
}

export function playerKnock(game) {
  return knockForActor(game, TURNS.PLAYER);
}

export function knockForActor(game, actor = TURNS.PLAYER) {
  const guard = guardAction(game, actor, null, { currentTurn: actor });
  if (guard.blocked) return guard;

  const state = guard.game;
  const validation = getKnockResultForActor(state, actor);

  if (!validation.valid) {
    return blocked('invalid-knock', state, { validation });
  }

  const actorLabel = getActorLabel(actor);
  const result = {
    type: 'win',
    winner: actor,
    message:
      validation.usedExtraCards.length > 0
        ? `${actorLabel} bateu usando ${validation.usedExtraCards.length} carta(s) do descarte do adversario.`
        : `${actorLabel} bateu com ${validation.groups.length} combinacoes validas.`,
  };

  return allowed(`${actor}-knock`, { ...state, result }, {
    previousGame: state,
    validation,
    result,
  });
}

export function playerTimeout(game) {
  return timeoutForActor(game, TURNS.PLAYER);
}

export function timeoutForActor(game, actor = TURNS.PLAYER) {
  const guard = guardAction(game, actor, null, { currentTurn: actor });
  if (guard.blocked) return guard;

  let state = guard.game;
  const handKey = getActorHandKey(actor);

  if (state.turnStage === TURN_STAGES.DRAW) {
    const drawAction = drawFromStockForActor(state, actor, { handMode: 'auto' });
    if (drawAction.blocked) return drawAction;
    state = drawAction.game;
  }

  const winningBeforeAutoDiscard = getKnockResultForActor(state, actor).valid;
  const discardedCard = chooseBotDiscard(state[handKey]);
  if (!discardedCard) return blocked('missing-auto-discard-card', state);

  const discardAction = discardFromHandForActor(state, actor, discardedCard.id, { handMode: 'auto' });
  if (discardAction.blocked) return discardAction;

  return allowed(`${actor}-timeout-auto-turn`, discardAction.game, {
    previousGame: guard.game,
    discardedCard,
    winningBeforeAutoDiscard,
    message: 'Tempo esgotado. Jogada automatica realizada.',
  });
}

export function reorderPlayerHand(game, cardId, targetIndex) {
  return reorderHandForActor(game, TURNS.PLAYER, cardId, targetIndex);
}

export function reorderHandForActor(game, actor = TURNS.PLAYER, cardId, targetIndex) {
  const handKey = getActorHandKey(actor);
  if (!handKey) return blocked('invalid-actor', normalizeGameState(game));

  const guard = guardAction(game, actor, null, { currentTurn: actor });
  if (guard.blocked) return guard;

  const state = guard.game;
  const currentIndex = state[handKey].findIndex((card) => card.id === cardId);
  if (currentIndex < 0) return blocked('missing-card', state);

  const nextHand = [...state[handKey]];
  const [movedCard] = nextHand.splice(currentIndex, 1);
  const safeTargetIndex = Math.max(0, Math.min(Number(targetIndex) || 0, nextHand.length));
  nextHand.splice(safeTargetIndex, 0, movedCard);

  return allowed(`${actor}-reorder-hand`, { ...state, [handKey]: nextHand }, {
    previousGame: state,
  });
}

export function arrangePlayerHand(game, { handMode = 'auto' } = {}) {
  return arrangeHandForActor(game, TURNS.PLAYER, { handMode });
}

export function arrangeHandForActor(game, actor = TURNS.PLAYER, { handMode = 'auto' } = {}) {
  const handKey = getActorHandKey(actor);
  if (!handKey) return blocked('invalid-actor', normalizeGameState(game));

  const guard = guardAction(game, actor, null, { currentTurn: actor });
  if (guard.blocked) return guard;

  const state = guard.game;
  return allowed(`${actor}-arrange-hand`, {
    ...state,
    [handKey]: arrangeForMode(state[handKey], handMode),
  }, {
    previousGame: state,
  });
}

export function botPlanTurn(game) {
  const guard = guardAction(game, TURNS.BOT, TURN_STAGES.DRAW, { currentTurn: TURNS.BOT });
  if (guard.blocked) {
    return {
      ...guard,
      action: 'blocked',
    };
  }

  const state = guard.game;
  const recycledState = recycleDiscardPile(state.drawPile, state.discardPile);
  const topDiscard = recycledState.discardPile[recycledState.discardPile.length - 1];
  const takeDiscard = shouldBotTakeDiscard(state.opponentHand, topDiscard);
  let drawnCard = null;
  let drawSource = 'stock';
  let drawPile = recycledState.drawPile;
  let discardPile = recycledState.discardPile;

  if (takeDiscard) {
    drawnCard = stripDiscardMeta(topDiscard);
    drawSource = 'discard';
    discardPile = recycledState.discardPile.slice(0, -1);
  } else if (recycledState.drawPile.length > 0) {
    [drawnCard, ...drawPile] = recycledState.drawPile;
  }

  if (!drawnCard) {
    const waitGame = {
      ...state,
      drawPile,
      discardPile,
      currentTurn: TURNS.PLAYER,
      turnStage: TURN_STAGES.DRAW,
    };

    return allowed('wait', waitGame, {
      previousGame: state,
      recycled: recycledState.recycled,
    });
  }

  const updatedHand = sortHand([...state.opponentHand, drawnCard]);
  const afterDrawGame = {
    ...state,
    opponentHand: updatedHand,
    drawPile,
    discardPile,
    currentTurn: TURNS.BOT,
    turnStage: TURN_STAGES.DISCARD,
  };
  const botValidation = findThreeCombinationResult(updatedHand);

  if (botValidation.valid) {
    const result = {
      type: 'loss',
      winner: TURNS.BOT,
      message: 'Oponente bateu com combinacoes validas.',
    };

    return allowed('bot-knock', { ...afterDrawGame, result }, {
      previousGame: state,
      recycled: recycledState.recycled,
      drawSource,
      drawnCard,
      validation: botValidation,
      result,
      afterDrawGame,
    });
  }

  const discardedCard = chooseBotDiscard(updatedHand);
  const nextGame = {
    ...state,
    opponentHand: updatedHand.filter((card) => card.id !== discardedCard.id),
    drawPile,
    discardPile: [...discardPile, { ...discardedCard, discardedBy: TURNS.BOT }],
    currentTurn: TURNS.PLAYER,
    turnStage: TURN_STAGES.DRAW,
  };

  return allowed('bot-discard', nextGame, {
    previousGame: state,
    recycled: recycledState.recycled,
    drawSource,
    drawnCard,
    discardedCard,
    afterDrawGame,
  });
}
