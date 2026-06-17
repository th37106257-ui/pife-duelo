import { analyzeHandGroups, getWinningHandAnalysis } from '../shared/pifeRules.js';

export function isSet(cards) {
  if (cards.length < 3) return false;

  const naturalCards = cards.filter((card) => !card.isJoker);
  if (naturalCards.length === 0) return true;

  const rank = naturalCards[0].rank;
  const uniqueSuits = new Set(naturalCards.map((card) => card.suit));

  return naturalCards.every((card) => card.rank === rank) && uniqueSuits.size === naturalCards.length;
}

export function isSequence(cards) {
  if (cards.length < 3) return false;

  const naturalCards = cards.filter((card) => !card.isJoker);
  const jokerCount = cards.length - naturalCards.length;

  if (naturalCards.length < 2) return true;

  const suit = naturalCards[0].suit;
  if (!naturalCards.every((card) => card.suit === suit)) return false;

  const values = naturalCards.map((card) => card.value).sort((a, b) => a - b);
  if (new Set(values).size !== values.length) return false;

  let gaps = 0;
  for (let index = 1; index < values.length; index += 1) {
    gaps += values[index] - values[index - 1] - 1;
  }

  return gaps <= jokerCount;
}

function sortCardsForDisplay(cards) {
  return [...cards].sort((a, b) => {
    if (a.isJoker && !b.isJoker) return 1;
    if (!a.isJoker && b.isJoker) return -1;
    if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
    return a.value - b.value;
  });
}

function getSequenceCandidates(cards) {
  const jokers = cards.filter((card) => card.isJoker);
  const naturalCards = cards.filter((card) => !card.isJoker);
  const suits = [...new Set(naturalCards.map((card) => card.suit))];
  const candidates = [];

  suits.forEach((suit) => {
    const suitedCards = naturalCards
      .filter((card) => card.suit === suit)
      .sort((a, b) => a.value - b.value);

    for (let start = 0; start < suitedCards.length; start += 1) {
      for (let end = start + 2; end <= suitedCards.length; end += 1) {
        const slice = suitedCards.slice(start, end);
        const values = slice.map((card) => card.value);
        const neededJokers = values[values.length - 1] - values[0] + 1 - values.length;

        if (neededJokers <= jokers.length && slice.length + neededJokers >= 3) {
          candidates.push({
            type: 'sequence',
            cards: [...slice, ...jokers.slice(0, neededJokers)],
          });
        }
      }
    }
  });

  return candidates.filter((candidate) => isSequence(candidate.cards));
}

function getSetCandidates(cards) {
  const jokers = cards.filter((card) => card.isJoker);
  const naturalCards = cards.filter((card) => !card.isJoker);
  const ranks = [...new Set(naturalCards.map((card) => card.rank))];
  const candidates = [];

  ranks.forEach((rank) => {
    const sameRank = naturalCards.filter((card) => card.rank === rank);
    const neededJokers = Math.max(0, 3 - sameRank.length);

    if (sameRank.length + jokers.length >= 3) {
      const candidateCards = [...sameRank, ...jokers.slice(0, neededJokers)].slice(0, 4);
      candidates.push({ type: 'set', cards: candidateCards });
    }
  });

  return candidates.filter((candidate) => isSet(candidate.cards));
}

function candidateKey(candidate) {
  return candidate.cards
    .map((card) => card.id)
    .sort()
    .join('|');
}

function getCombinationCandidates(cards) {
  const seen = new Set();
  const candidates = [
    ...getSequenceCandidates(cards),
    ...getSetCandidates(cards),
  ].filter((candidate) => candidate.cards.length >= 3);

  return candidates
    .filter((candidate) => {
      const key = candidateKey(candidate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      if (a.cards.length !== b.cards.length) return a.cards.length - b.cards.length;
      const priority = { sequence: 0, set: 1 };
      return priority[a.type] - priority[b.type];
    });
}

export function detectValidCombinations(cards) {
  const analysis = analyzeHandGroups(cards);
  return {
    validGroups: analysis.validGroups,
    markedCardIds: analysis.markedCardIds,
    canKnock: analysis.canKnock,
  };
}

function findBestGroup(cards) {
  const candidates = getCombinationCandidates(cards);

  candidates.sort((a, b) => {
    if (a.cards.length !== b.cards.length) return b.cards.length - a.cards.length;
    if (a.type !== b.type) return a.type === 'sequence' ? -1 : 1;
    return 0;
  });

  return candidates[0]?.cards ?? [];
}

function findCombinationGroups(cards, targetCount = 3) {
  function search(remaining, groups) {
    if (groups.length >= targetCount) return groups;
    if (remaining.length < (targetCount - groups.length) * 3) return null;

    const candidates = getCombinationCandidates(remaining).slice(0, 64);

    for (const candidate of candidates) {
      const candidateIds = new Set(candidate.cards.map((card) => card.id));
      const nextRemaining = remaining.filter((card) => !candidateIds.has(card.id));
      const result = search(nextRemaining, [...groups, candidate]);

      if (result) return result;
    }

    return null;
  }

  return search([...cards], []);
}

export function canKnock(hand) {
  const analysis = getWinningHandAnalysis(hand);
  const usedCardIds = analysis.usedCardIds;

  return {
    valid: analysis.valid,
    groups: analysis.validGroups.map((group) => group.cards),
    validGroups: analysis.validGroups,
    deadwood: hand.filter((card) => !usedCardIds.has(card.id)),
  };
}

function getRankCount(hand, card) {
  if (card.isJoker) return 0;
  return hand.filter((item) => !item.isJoker && item.id !== card.id && item.rank === card.rank).length;
}

function getSuitValues(hand, card) {
  if (card.isJoker) return [];
  return hand
    .filter((item) => !item.isJoker && item.id !== card.id && item.suit === card.suit)
    .map((item) => item.value);
}

export function scoreBotCardUsefulness(hand, card) {
  if (card.isJoker) return 100;

  const sameRankCount = getRankCount(hand, card);
  const suitValues = getSuitValues(hand, card);
  const hasValue = (value) => suitValues.includes(value);
  const adjacentCount = suitValues.filter((value) => Math.abs(value - card.value) === 1).length;
  const nearCount = suitValues.filter((value) => Math.abs(value - card.value) === 2).length;
  const closesSequence =
    (hasValue(card.value - 2) && hasValue(card.value - 1)) ||
    (hasValue(card.value - 1) && hasValue(card.value + 1)) ||
    (hasValue(card.value + 1) && hasValue(card.value + 2));

  let score = 0;

  if (sameRankCount >= 2) score += 32;
  else if (sameRankCount === 1) score += 12;

  if (closesSequence) score += 30;
  score += adjacentCount * 10;
  score += nearCount * 4;

  return score;
}

export function shouldBotTakeDiscard(hand, discardCard) {
  if (!discardCard || discardCard.discardedBy === 'bot') return false;

  const { discardedBy, ...cleanCard } = discardCard;
  const usefulness = scoreBotCardUsefulness(hand, cleanCard);

  return usefulness >= 10;
}

export function chooseBotDiscard(hand) {
  const { deadwood } = canKnock(hand);
  const candidates = deadwood.length > 0 ? deadwood : hand;

  return [...candidates]
    .sort((a, b) => {
      const scoreDiff = scoreBotCardUsefulness(hand, a) - scoreBotCardUsefulness(hand, b);
      if (scoreDiff !== 0) return scoreDiff;
      if (a.isJoker && !b.isJoker) return 1;
      if (!a.isJoker && b.isJoker) return -1;
      return b.value - a.value;
    })[0];
}

export function findThreeCombinationResult(hand, extraCards = []) {
  const groups = findCombinationGroups([...hand, ...extraCards], 3);
  const extraIds = new Set(extraCards.map((card) => card.id));
  const usedExtraCards = groups
    ? groups.flatMap((group) => group.cards).filter((card) => extraIds.has(card.id))
    : [];

  return {
    valid: Boolean(groups),
    groups: groups ?? [],
    usedExtraCards,
  };
}

export function arrangeHandByCombinations(hand) {
  const remaining = [...hand];
  const groups = [];

  // Organiza a mao colocando sequencias/trincas na frente e sobras ao final.
  while (remaining.length >= 3) {
    const group = findBestGroup(remaining);
    if (group.length < 3) break;

    groups.push(sortCardsForDisplay(group));
    group.forEach((card) => {
      const index = remaining.findIndex((item) => item.id === card.id);
      if (index >= 0) remaining.splice(index, 1);
    });
  }

  return [...groups.flat(), ...sortCardsForDisplay(remaining)];
}

export function organizeHandByPifeRules(hand) {
  const remaining = [...hand];
  const groups = [];

  while (remaining.length >= 3) {
    const group = findBestGroup(remaining);
    if (group.length < 3) break;

    groups.push(sortCardsForDisplay(group));
    const groupIds = new Set(group.map((card) => card.id));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (groupIds.has(remaining[index].id)) {
        remaining.splice(index, 1);
      }
    }
  }

  const looseCards = [...remaining].sort((a, b) => {
    const scoreDiff = scoreBotCardUsefulness(hand, b) - scoreBotCardUsefulness(hand, a);
    if (scoreDiff !== 0) return scoreDiff;
    if (a.isJoker && !b.isJoker) return 1;
    if (!a.isJoker && b.isJoker) return -1;
    if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
    return a.value - b.value;
  });

  return [...groups.flat(), ...looseCards];
}
