const RANK_VALUES = new Map([
  ['A', 1],
  ['J', 11],
  ['Q', 12],
  ['K', 13],
]);

export function getCardValue(card) {
  const rawValue = card?.rankValue ?? card?.value ?? card?.rank;
  const mappedValue = RANK_VALUES.get(String(rawValue).toUpperCase());
  return Number(mappedValue ?? rawValue);
}

export function getCardSuit(card) {
  return card?.suit ?? card?.naipe;
}

function getCardId(card) {
  return card?.id;
}

function buildGroup(type, cards, indices = []) {
  return { type, cards, indices };
}

export function isValidSequence(cards = []) {
  if (!Array.isArray(cards) || cards.length < 3) return false;
  if (cards.some((card) => card?.isJoker)) return false;

  const suit = getCardSuit(cards[0]);
  if (!suit || !cards.every((card) => getCardSuit(card) === suit)) return false;

  const values = cards.map(getCardValue).sort((a, b) => a - b);
  if (values.some((value) => !Number.isFinite(value))) return false;
  if (new Set(values).size !== values.length) return false;

  return values.every((value, index) => index === 0 || value === values[index - 1] + 1);
}

export function isValidSet(cards = []) {
  if (!Array.isArray(cards) || cards.length !== 3) return false;
  if (cards.some((card) => card?.isJoker)) return false;

  const value = getCardValue(cards[0]);
  if (!Number.isFinite(value)) return false;
  if (!cards.every((card) => getCardValue(card) === value)) return false;

  const suits = new Set(cards.map(getCardSuit));
  return suits.size === 3;
}

function testVisualGroup(cards, start, end) {
  const group = cards.slice(start, end);
  if (isValidSet(group)) return buildGroup('trinca', group, group.map((_, offset) => start + offset));
  if (isValidSequence(group)) return buildGroup('sequencia', group, group.map((_, offset) => start + offset));
  return null;
}

function findVisualGroups(cards) {
  const groups = [];

  for (let index = 0; index < cards.length; index += 1) {
    let found = null;
    for (let end = cards.length; end >= index + 3; end -= 1) {
      found = testVisualGroup(cards, index, end);
      if (found) break;
    }

    if (found) {
      groups.push(found);
      index += found.cards.length - 1;
    }
  }

  return groups;
}

function combinations(items, size, start = 0, selected = [], output = []) {
  if (selected.length === size) {
    output.push([...selected]);
    return output;
  }

  for (let index = start; index <= items.length - (size - selected.length); index += 1) {
    selected.push(items[index]);
    combinations(items, size, index + 1, selected, output);
    selected.pop();
  }

  return output;
}

function getLogicalCandidates(cards) {
  const candidates = [];

  const byRank = new Map();
  const bySuit = new Map();

  cards.forEach((card, index) => {
    const value = getCardValue(card);
    const suit = getCardSuit(card);
    if (!Number.isFinite(value) || !suit || card?.isJoker) return;

    const rankCards = byRank.get(value) ?? [];
    rankCards.push({ card, index });
    byRank.set(value, rankCards);

    const suitCards = bySuit.get(suit) ?? [];
    suitCards.push({ card, index });
    bySuit.set(suit, suitCards);
  });

  [...byRank.values()].forEach((rankCards) => {
    if (rankCards.length < 3) return;
    combinations(rankCards, 3).forEach((combo) => {
      const cardsInGroup = combo.map((item) => item.card);
      if (isValidSet(cardsInGroup)) {
        candidates.push(buildGroup('trinca', cardsInGroup, combo.map((item) => item.index)));
      }
    });
  });

  [...bySuit.values()].forEach((suitCards) => {
    const sorted = [...suitCards].sort((a, b) => getCardValue(a.card) - getCardValue(b.card));

    for (let start = 0; start < sorted.length; start += 1) {
      const run = [sorted[start]];
      for (let index = start + 1; index < sorted.length; index += 1) {
        const previous = run[run.length - 1];
        const current = sorted[index];

        if (getCardValue(current.card) === getCardValue(previous.card)) continue;
        if (getCardValue(current.card) !== getCardValue(previous.card) + 1) break;

        run.push(current);
        if (run.length >= 3) {
          const cardsInGroup = run.map((item) => item.card);
          candidates.push(buildGroup('sequencia', cardsInGroup, run.map((item) => item.index)));
        }
      }
    }
  });

  return candidates.sort((a, b) => {
    if (a.cards.length !== b.cards.length) return b.cards.length - a.cards.length;
    return Math.min(...a.indices) - Math.min(...b.indices);
  });
}

function findLogicalCover(cards) {
  const targetCount = cards.length;
  const candidates = getLogicalCandidates(cards);
  let bestGroups = [];
  let bestUsedIds = new Set();

  function search(candidateIndex, groups, usedIds) {
    if (usedIds.size > bestUsedIds.size) {
      bestGroups = groups;
      bestUsedIds = usedIds;
    }
    if (usedIds.size === targetCount) return groups;

    for (let index = candidateIndex; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const candidateIds = candidate.cards.map(getCardId);
      if (candidateIds.some((id) => usedIds.has(id))) continue;

      const nextUsedIds = new Set(usedIds);
      candidateIds.forEach((id) => nextUsedIds.add(id));

      const result = search(index + 1, [...groups, candidate], nextUsedIds);
      if (result) return result;
    }

    return null;
  }

  const cover = search(0, [], new Set());
  return cover ?? bestGroups;
}

export function validatePifeHand(handCards = []) {
  const cards = Array.isArray(handCards) ? handCards.filter(Boolean) : [];
  const groups = findVisualGroups(cards);
  const markedCardIds = groups.flatMap((group) => group.cards.map(getCardId));
  const groupedCardIds = new Set(markedCardIds);
  const remainingCards = cards.filter((card) => !groupedCardIds.has(getCardId(card)));
  const remainingCardIds = remainingCards.map(getCardId);

  if (cards.length < 9) {
    return {
      canBeat: false,
      groups,
      validGroups: groups,
      logicalGroups: groups,
      markedCardIds,
      groupedCardIds: [...groupedCardIds],
      groupedCardCount: groupedCardIds.size,
      remainingCards,
      remainingCardIds,
      remainingCardCount: remainingCards.length,
      validGroupCount: groups.length,
      reason: 'HAND_TOO_SHORT',
    };
  }

  const validGroupCount = groups.length;
  const groupedCardCount = groupedCardIds.size;
  const remainingCardCount = remainingCards.length;
  const canBeat = (
    cards.length === 10
    && validGroupCount === 3
    && groups.every((group) => group.cards.length >= 3)
    && groupedCardCount === 9
    && remainingCardCount === 1
  );

  return {
    canBeat,
    groups,
    validGroups: groups,
    logicalGroups: groups,
    markedCardIds,
    groupedCardIds: [...groupedCardIds],
    groupedCardCount,
    remainingCards,
    remainingCardIds,
    remainingCardCount,
    validGroupCount,
    reason: canBeat ? 'VALID_HAND' : 'INVALID_HAND',
  };
}

export function analyzeHandGroups(handCards = []) {
  const validation = validatePifeHand(handCards);
  return {
    canKnock: validation.canBeat,
    validGroups: validation.validGroups,
    logicalGroups: validation.validGroups,
    markedCardIds: validation.markedCardIds,
    groupedCardCount: validation.groupedCardCount,
    remainingCards: validation.remainingCards,
    remainingCardCount: validation.remainingCardCount,
    validGroupCount: validation.validGroupCount ?? validation.validGroups?.length ?? 0,
    reason: validation.reason,
  };
}

export function findValidGroups(hand = []) {
  return validatePifeHand(hand).groups;
}

export function getWinningHandAnalysis(hand = []) {
  const validation = validatePifeHand(hand);
  return {
    validGroups: validation.validGroups,
    usedCardIds: new Set(validation.validGroups.flatMap((group) => group.cards.map(getCardId))),
    remainingCards: validation.remainingCards,
    allCardsUsed: validation.canBeat,
    valid: validation.canBeat,
    canKnock: validation.canBeat,
    reason: validation.reason,
  };
}

export function isWinningHand(hand = []) {
  return validatePifeHand(hand).canBeat;
}

export function canPlayerKnock(hand = [], isMyTurn = true) {
  return Boolean(isMyTurn && validatePifeHand(hand).canBeat);
}

export function canPlayerBeat(hand = [], isMyTurn = false) {
  return canPlayerKnock(hand, isMyTurn);
}
