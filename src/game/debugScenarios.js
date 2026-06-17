import { createDeck } from './cards.js';

export const DEBUG_COMMANDS = {
  DEBUG_WIN_HAND: 'winning-player',
  DEBUG_RECYCLE: 'recycle',
  DEBUG_TIMEOUT: 'timeout',
  DEBUG_INVALID_HAND: 'invalid',
  DEBUG_BOT_WIN: 'bot-winning',
};

function cardMap() {
  const map = new Map();
  createDeck().forEach((card) => {
    map.set(card.id, card);
    if (card.deckNumber === 1) {
      map.set(card.logicalId, card);
    }
  });
  return map;
}

function pickCards(ids, cardsById) {
  return ids.map((id) => {
    const card = cardsById.get(id);
    if (!card) throw new Error(`Carta de debug nao encontrada: ${id}`);
    return card;
  });
}

function resolveIds(ids = [], cardsById) {
  return ids.map((id) => {
    const card = cardsById.get(id);
    if (!card) throw new Error(`Carta de debug nao encontrada: ${id}`);
    return card.id;
  });
}

function buildGameFromIds({ playerHand, opponentHand, drawPile, discardPile = [] }) {
  const cardsById = cardMap();
  const customDrawPile = Array.isArray(drawPile);
  const resolvedPlayerHand = resolveIds(playerHand, cardsById);
  const resolvedOpponentHand = resolveIds(opponentHand, cardsById);
  const resolvedDrawPile = customDrawPile ? resolveIds(drawPile, cardsById) : [];
  const resolvedDiscardPile = discardPile.map((card) => ({
    id: resolveIds([card.id], cardsById)[0],
    discardedBy: card.discardedBy,
  }));
  const pickedIds = new Set([
    ...resolvedPlayerHand,
    ...resolvedOpponentHand,
    ...resolvedDrawPile,
    ...resolvedDiscardPile.map((card) => card.id),
  ]);

  const remainingDeck = createDeck().filter((card) => !pickedIds.has(card.id));

  return {
    playerHand: pickCards(resolvedPlayerHand, cardsById),
    opponentHand: pickCards(resolvedOpponentHand, cardsById),
    drawPile: customDrawPile ? pickCards(resolvedDrawPile, cardsById) : remainingDeck,
    discardPile: resolvedDiscardPile.map((card) => ({
      ...cardsById.get(card.id),
      discardedBy: card.discardedBy,
    })),
  };
}

export const DEBUG_SCENARIOS = {
  'winning-player': {
    label: 'Mao vencedora do jogador',
    game: {
      playerHand: [
        '7-spades',
        '7-diamonds',
        '7-clubs',
        '4-hearts',
        '5-hearts',
        '6-hearts',
        '9-diamonds',
        '10-diamonds',
        'J-diamonds',
      ],
      opponentHand: [
        'A-clubs',
        '2-clubs',
        '5-diamonds',
        '8-hearts',
        '10-spades',
        'Q-clubs',
        'K-hearts',
        '3-spades',
        '6-clubs',
      ],
    },
  },
  'near-win-player': {
    label: 'Jogador quase batendo',
    game: {
      playerHand: [
        '7-spades',
        '7-hearts',
        '7-clubs',
        '4-hearts',
        '5-hearts',
        '6-hearts',
        '9-diamonds',
        '10-diamonds',
        '2-clubs',
      ],
      opponentHand: [
        'A-clubs',
        '2-diamonds',
        '5-diamonds',
        '8-hearts',
        '10-spades',
        'Q-clubs',
        'K-hearts',
        '3-spades',
        '6-clubs',
      ],
      drawPile: ['J-diamonds', 'A-hearts', '3-clubs', '8-diamonds'],
    },
  },
  'near-win-bot': {
    label: 'Bot quase batendo',
    game: {
      playerHand: [
        'A-hearts',
        '3-clubs',
        '8-diamonds',
        'K-spades',
        '2-hearts',
        '5-clubs',
        '9-spades',
        'J-clubs',
        'Q-clubs',
      ],
      opponentHand: [
        '7-spades',
        '7-hearts',
        '7-clubs',
        '4-hearts',
        '5-hearts',
        '6-hearts',
        '9-diamonds',
        '10-diamonds',
        '2-clubs',
      ],
      drawPile: ['J-diamonds', 'A-clubs', '2-diamonds', '5-diamonds'],
    },
  },
  'bot-winning': {
    label: 'Derrota por batida do bot',
    game: {
      playerHand: [
        'A-hearts',
        '3-clubs',
        '8-diamonds',
        'K-spades',
        '2-hearts',
        '5-clubs',
        '9-spades',
        'J-clubs',
        'Q-clubs',
      ],
      opponentHand: [
        '7-spades',
        '7-hearts',
        '7-clubs',
        '4-hearts',
        '5-hearts',
        '6-hearts',
        '9-diamonds',
        '10-diamonds',
        'J-diamonds',
      ],
      drawPile: ['A-clubs', '2-diamonds', '5-diamonds'],
    },
  },
  invalid: {
    label: 'Mao invalida do jogador',
    game: {
      playerHand: [
        'A-hearts',
        '3-clubs',
        '8-diamonds',
        'K-spades',
        '2-hearts',
        '5-clubs',
        '9-spades',
        'J-diamonds',
        'Q-clubs',
      ],
      opponentHand: [
        '7-spades',
        '7-hearts',
        '4-hearts',
        '5-hearts',
        '10-diamonds',
        'J-clubs',
        'A-spades',
        '3-diamonds',
        '6-spades',
      ],
    },
  },
  timeout: {
    label: 'Timeout rapido',
    timerSeconds: 5,
    game: {
      playerHand: [
        'A-hearts',
        '3-clubs',
        '8-diamonds',
        'K-spades',
        '2-hearts',
        '5-clubs',
        '9-spades',
        'J-diamonds',
        'Q-clubs',
      ],
      opponentHand: [
        '7-spades',
        '7-hearts',
        '4-hearts',
        '5-hearts',
        '10-diamonds',
        'J-clubs',
        'A-spades',
        '3-diamonds',
        '6-spades',
      ],
    },
  },
  recycle: {
    label: 'Monte vazio com reciclagem pronta',
    game: {
      playerHand: [
        'A-hearts',
        '3-clubs',
        '8-diamonds',
        'K-spades',
        '2-hearts',
        '5-clubs',
        '9-spades',
        'J-diamonds',
        'Q-clubs',
      ],
      opponentHand: [
        '7-spades',
        '7-hearts',
        '4-hearts',
        '5-hearts',
        '10-diamonds',
        'J-clubs',
        'A-spades',
        '3-diamonds',
        '6-spades',
      ],
      drawPile: [],
      discardPile: [
        { id: '2-clubs', discardedBy: 'player' },
        { id: '4-clubs', discardedBy: 'bot' },
        { id: '8-hearts', discardedBy: 'bot' },
      ],
    },
  },
};

export function resolveDebugScenarioKey(rawKey) {
  if (!rawKey) return null;
  if (DEBUG_SCENARIOS[rawKey]) return rawKey;
  if (DEBUG_COMMANDS[rawKey]) return DEBUG_COMMANDS[rawKey];
  return null;
}

export function getDebugScenarioConfig(scenarioKey) {
  const resolvedKey = resolveDebugScenarioKey(scenarioKey);
  if (!resolvedKey) return null;

  const { game, ...config } = DEBUG_SCENARIOS[resolvedKey];
  return {
    key: resolvedKey,
    ...config,
  };
}

export function buildDebugGame(scenarioKey) {
  const resolvedKey = resolveDebugScenarioKey(scenarioKey);
  const scenario = DEBUG_SCENARIOS[resolvedKey];
  if (!scenario) return null;
  return buildGameFromIds(scenario.game);
}

export function readDebugScenarioKey() {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search);
  const directKey = params.get('audit') || params.get('debug');
  const resolvedKey = resolveDebugScenarioKey(directKey);
  if (resolvedKey) return resolvedKey;
  if (directKey === 'true') return 'near-win-player';

  if (params.get('mode') === 'audit') return 'winning-player';
  return null;
}
