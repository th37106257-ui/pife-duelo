import { createMatchResult } from './MatchResult.js';
import { createTurnState } from './TurnState.js';
import { config } from '../config.js';
import { analyzeHandGroups, getWinningHandAnalysis } from '../../../src/shared/pifeRules.js';

const SUITS = [
  { suit: 'hearts', symbol: '♥', color: 'red' },
  { suit: 'diamonds', symbol: '♦', color: 'red' },
  { suit: 'clubs', symbol: '♣', color: 'black' },
  { suit: 'spades', symbol: '♠', color: 'black' },
];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_VALUE = new Map(RANKS.map((rank, index) => [rank, index + 1]));

function cloneGame(gameState) {
  return {
    ...gameState,
    players: gameState.players.map((player) => ({
      ...player,
      hand: [...player.hand],
    })),
    deck: [...gameState.deck],
    discardPile: [...gameState.discardPile],
    turn: { ...gameState.turn },
  };
}

export function createDeck() {
  return [1, 2].flatMap((deckNumber) =>
    SUITS.flatMap((suit) =>
      RANKS.map((rank) => ({
        id: `deck${deckNumber}-${rank}-${suit.suit}`,
        instanceId: `deck${deckNumber}-${rank}-${suit.suit}`,
        deckNumber,
        logicalId: `${rank}-${suit.suit}`,
        rank,
        value: RANK_VALUE.get(rank),
        suit: suit.suit,
        symbol: suit.symbol,
        color: suit.color,
      })),
    ),
  );
}

export function shuffleDeck(deck) {
  const nextDeck = [...deck];

  for (let index = nextDeck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [nextDeck[index], nextDeck[swapIndex]] = [nextDeck[swapIndex], nextDeck[index]];
  }

  return nextDeck;
}

export function dealCards(deck, players) {
  const nextDeck = [...deck];
  const nextPlayers = players.map((player) => ({ ...player, hand: [] }));

  for (let cardIndex = 0; cardIndex < 9; cardIndex += 1) {
    nextPlayers.forEach((player) => {
      const card = nextDeck.shift();
      if (card) player.hand.push(card);
    });
  }

  return {
    deck: nextDeck,
    players: nextPlayers,
  };
}

export function dealInitialCards(gameState) {
  const dealt = dealCards(gameState.deck, gameState.players);
  const discardPile = [...(gameState.discardPile ?? [])];
  const topDiscardCard = dealt.deck.shift();

  if (topDiscardCard) {
    discardPile.push({ ...topDiscardCard, discardedBy: 'server' });
  }

  return {
    ...gameState,
    players: dealt.players.map((player) => ({
      ...player,
      handCount: player.hand.length,
    })),
    deck: dealt.deck,
    deckCount: dealt.deck.length,
    discardPile,
    topDiscardCard: discardPile[discardPile.length - 1] ?? null,
  };
}

export function drawCard(gameState, playerId) {
  if (gameState.status !== 'playing') return { blocked: true, reason: 'match-not-playing', gameState };
  if (gameState.currentTurnPlayerId !== playerId) return { blocked: true, reason: 'not-player-turn', gameState };

  const nextGame = cloneGame(gameState);
  const player = nextGame.players.find((item) => item.id === playerId);
  const card = nextGame.deck.shift();

  if (!player) return { blocked: true, reason: 'player-not-found', gameState };
  if (!card) return { blocked: true, reason: 'empty-deck', gameState };
  if (player.hasDrawnThisTurn) return { blocked: true, reason: 'already-drawn', gameState };

  player.hand.push(card);
  player.hasDrawnThisTurn = true;
  nextGame.turn = createTurnState({
    currentPlayerId: playerId,
    turnStartedAt: nextGame.turn.turnStartedAt,
    turnDurationSeconds: config.TURN_DURATION_SECONDS,
    canDraw: false,
    canDiscard: true,
    canKnock: validateKnock(player.hand).valid,
  });

  return { blocked: false, gameState: nextGame, card };
}

export function discardCard(gameState, playerId, cardId) {
  if (gameState.status !== 'playing') return { blocked: true, reason: 'match-not-playing', gameState };
  if (gameState.currentTurnPlayerId !== playerId) return { blocked: true, reason: 'not-player-turn', gameState };

  const nextGame = cloneGame(gameState);
  const player = nextGame.players.find((item) => item.id === playerId);

  if (!player) return { blocked: true, reason: 'player-not-found', gameState };
  if (!player.hasDrawnThisTurn) return { blocked: true, reason: 'draw-required-before-discard', gameState };

  const cardIndex = player.hand.findIndex((card) => card.id === cardId || card.instanceId === cardId);
  if (cardIndex < 0) return { blocked: true, reason: 'card-not-found', gameState };

  const [card] = player.hand.splice(cardIndex, 1);
  nextGame.discardPile.push({ ...card, discardedBy: playerId });

  return {
    blocked: false,
    gameState: changeTurn(nextGame),
    card,
  };
}

export function changeTurn(gameState) {
  const nextGame = cloneGame(gameState);
  const currentIndex = Math.max(0, nextGame.players.findIndex((player) => player.id === nextGame.currentTurnPlayerId));
  const nextPlayer = nextGame.players[(currentIndex + 1) % Math.max(nextGame.players.length, 1)];

  nextGame.players = nextGame.players.map((player) => ({
    ...player,
    hasDrawnThisTurn: false,
  }));
  nextGame.currentTurnPlayerId = nextPlayer?.id ?? null;
  nextGame.turn = createTurnState({
    currentPlayerId: nextGame.currentTurnPlayerId,
    turnStartedAt: new Date().toISOString(),
    turnDurationSeconds: config.TURN_DURATION_SECONDS,
    canDraw: true,
    canDiscard: false,
    canKnock: false,
  });

  return nextGame;
}

export function detectValidCombinations(cards) {
  return analyzeHandGroups(cards).markedCardIds;
}

export function validateKnock(hand) {
  const analysis = getWinningHandAnalysis(hand);
  const combinationIds = [...analysis.usedCardIds];

  return {
    valid: analysis.valid,
    combinationIds,
    validGroups: analysis.validGroups,
    reason: analysis.reason,
  };
}

export function finishMatch(gameState, reason, winnerId) {
  const finishedAt = new Date().toISOString();
  const startedAt = gameState.startedAt ? new Date(gameState.startedAt).getTime() : Date.now();
  const finishedTime = new Date(finishedAt).getTime();
  const loser = gameState.players.find((player) => player.id !== winnerId);

  return {
    ...cloneGame(gameState),
    status: 'finished',
    finishedAt,
    result: createMatchResult({
      winnerId,
      loserId: loser?.id ?? null,
      reason,
      durationSeconds: Math.max(0, Math.round((finishedTime - startedAt) / 1000)),
      finishedAt,
    }),
  };
}
