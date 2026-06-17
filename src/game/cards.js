const SUITS = [
  { id: 'hearts', symbol: '\u2665', label: 'Copas', color: 'red' },
  { id: 'diamonds', symbol: '\u2666', label: 'Ouros', color: 'red' },
  { id: 'clubs', symbol: '\u2663', label: 'Paus', color: 'black' },
  { id: 'spades', symbol: '\u2660', label: 'Espadas', color: 'black' },
];

const RANKS = [
  { label: 'A', value: 1 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
  { label: '9', value: 9 },
  { label: '10', value: 10 },
  { label: 'J', value: 11 },
  { label: 'Q', value: 12 },
  { label: 'K', value: 13 },
];

function stripDiscardMeta(card) {
  const { discardedBy, ...cleanCard } = card;
  return cleanCard;
}

export function createDeck() {
  const cards = [1, 2].flatMap((deckNumber) =>
    SUITS.flatMap((suit) =>
      RANKS.map((rank) => ({
        id: `deck${deckNumber}-${rank.label}-${suit.id}`,
        instanceId: `deck${deckNumber}-${rank.label}-${suit.id}`,
        deckNumber,
        logicalId: `${rank.label}-${suit.id}`,
        rank: rank.label,
        value: rank.value,
        suit: suit.id,
        suitLabel: suit.label,
        symbol: suit.symbol,
        color: suit.color,
        isJoker: false,
      })),
    ),
  );

  return cards;
}

export function validateDeck(deck = createDeck()) {
  const errors = [];
  const suitById = new Map(SUITS.map((suit) => [suit.id, suit]));
  const rankByLabel = new Map(RANKS.map((rank) => [rank.label, rank]));
  const expectedCards = new Set(
    [1, 2].flatMap((deckNumber) =>
      SUITS.flatMap((suit) => RANKS.map((rank) => `deck${deckNumber}-${rank.label}-${suit.id}`)),
    ),
  );
  const seenIds = new Set();
  const logicalCardCounts = new Map();
  if (!Array.isArray(deck)) {
    return { valid: false, errors: ['O baralho precisa ser uma lista de cartas.'] };
  }

  if (deck.length !== 104) {
    errors.push(`Baralho deve ter 104 cartas, mas tem ${deck.length}.`);
  }

  deck.forEach((card, index) => {
    if (!card || typeof card !== 'object') {
      errors.push(`Carta invalida na posicao ${index}.`);
      return;
    }

    if (!card.id) {
      errors.push(`Carta sem id na posicao ${index}.`);
    } else if (seenIds.has(card.id)) {
      errors.push(`Carta duplicada por id: ${card.id}.`);
    } else {
      seenIds.add(card.id);
    }

    if (card.isJoker) {
      errors.push(`Coringa nao permitido no baralho: ${card.id ?? index}.`);
      return;
    }

    const suit = suitById.get(card.suit);
    const rank = rankByLabel.get(card.rank);
    const logicalId = `${card.rank}-${card.suit}`;
    const expectedDeckNumber = Number(card.deckNumber);
    const expectedId = `deck${expectedDeckNumber}-${logicalId}`;

    if (!suit) {
      errors.push(`Naipe invalido em ${card.id ?? index}: ${card.suit}.`);
    } else {
      if (card.symbol !== suit.symbol) errors.push(`Simbolo incorreto em ${logicalId}.`);
      if (card.suitLabel !== suit.label) errors.push(`Nome de naipe incorreto em ${logicalId}.`);
      if (card.color !== suit.color) errors.push(`Cor incorreta em ${logicalId}.`);
    }

    if (!rank) {
      errors.push(`Numero/rank invalido em ${card.id ?? index}: ${card.rank}.`);
    } else if (card.value !== rank.value) {
      errors.push(`Valor incorreto em ${logicalId}.`);
    }

    if (![1, 2].includes(expectedDeckNumber)) {
      errors.push(`Numero de baralho invalido em ${card.id ?? index}: ${card.deckNumber}.`);
    }

    if (suit && rank && [1, 2].includes(expectedDeckNumber) && card.id !== expectedId) {
      errors.push(`Id incorreto em ${card.id}; esperado ${expectedId}.`);
    }

    logicalCardCounts.set(logicalId, (logicalCardCounts.get(logicalId) ?? 0) + 1);
  });

  expectedCards.forEach((cardId) => {
    if (!seenIds.has(cardId)) errors.push(`Carta faltando: ${cardId}.`);
  });

  SUITS.flatMap((suit) => RANKS.map((rank) => `${rank.label}-${suit.id}`)).forEach((logicalId) => {
    const count = logicalCardCounts.get(logicalId) ?? 0;
    if (count !== 2) errors.push(`Carta logica ${logicalId} deve aparecer 2 vezes, mas aparece ${count}.`);
  });

  return { valid: errors.length === 0, errors };
}

export function shuffleDeck(deck) {
  const copy = [...deck];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }

  return copy;
}

export function recycleDiscardPile(drawPile = [], discardPile = []) {
  if (drawPile.length > 0 || discardPile.length <= 1) {
    return { drawPile, discardPile, recycled: false };
  }

  const topDiscard = discardPile[discardPile.length - 1];
  const recycledCards = shuffleDeck(discardPile.slice(0, -1).map(stripDiscardMeta));

  return {
    drawPile: recycledCards,
    discardPile: [topDiscard],
    recycled: true,
  };
}

export function sortHand(hand) {
  return [...hand].sort((a, b) => {
    if (a.isJoker && !b.isJoker) return 1;
    if (!a.isJoker && b.isJoker) return -1;
    if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
    return a.value - b.value;
  });
}

export function dealInitialHands() {
  const baseDeck = createDeck();
  const validation = validateDeck(baseDeck);

  if (!validation.valid) {
    throw new Error(`Baralho invalido: ${validation.errors.join(' ')}`);
  }

  const shuffledDeck = shuffleDeck(baseDeck);
  const playerHand = sortHand(shuffledDeck.slice(0, 9));
  const opponentHand = sortHand(shuffledDeck.slice(9, 18));
  const drawPile = shuffledDeck.slice(18);

  return {
    playerHand,
    opponentHand,
    drawPile,
    discardPile: [],
  };
}
