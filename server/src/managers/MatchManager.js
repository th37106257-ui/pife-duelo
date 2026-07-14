import { createGameState } from '../game/GameState.js';
import { createTurnState } from '../game/TurnState.js';
import { createDeck, dealCards, finishMatch as finishMatchState, shuffleDeck, validateKnock } from '../game/gameRules.js';
import { config } from '../config.js';
import { createId } from '../utils/createId.js';
import { calculatePrize } from '../../../src/shared/economy.js';
import { createMatchHistory, getMatchAudit, listMatchHistory } from '../matchHistory.js';
import { logError } from '../utils/logger.js';

const REJECTION = {
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
  INVALID_CARD: 'INVALID_CARD',
  ALREADY_DREW: 'ALREADY_DREW',
  MUST_DRAW_FIRST: 'MUST_DRAW_FIRST',
  ACTION_RESOLVING: 'ACTION_RESOLVING',
  DECK_EMPTY: 'DECK_EMPTY',
  DISCARD_EMPTY: 'DISCARD_EMPTY',
  INVALID_KNOCK: 'INVALID_KNOCK',
  MATCH_ALREADY_FINISHED: 'MATCH_ALREADY_FINISHED',
  PLAYER_NOT_IN_MATCH: 'PLAYER_NOT_IN_MATCH',
  INVALID_HAND_SIZE: 'INVALID_HAND_SIZE',
  MATCH_INTEGRITY_ERROR: 'MATCH_INTEGRITY_ERROR',
};

function getTopDiscardCard(discardPile = []) {
  return discardPile[discardPile.length - 1] ?? null;
}

function normalizeOnlinePlayer(player, index) {
  return {
    id: player.playerId ?? player.id,
    name: player.playerName ?? player.name ?? `Jogador ${index + 1}`,
    socketId: player.socketId ?? null,
    position: index === 0 ? 'bottom' : 'top',
    hand: [],
    handCount: 0,
    isConnected: true,
    hasDrawnThisTurn: false,
    hasKnocked: false,
  };
}

function refreshGameCounts(gameState) {
  return {
    ...gameState,
    deckCount: gameState.deck.length,
    topDiscardCard: getTopDiscardCard(gameState.discardPile),
    players: gameState.players.map((player) => ({
      ...player,
      handCount: player.hand.length,
    })),
  };
}

function calculateTurnSecondsLeft(gameState) {
  if (!gameState || gameState.status !== 'playing') return 0;

  const duration = Number(gameState.turnDurationSeconds ?? config.TURN_DURATION_SECONDS);
  const startedAt = Date.parse(gameState.turnStartedAt);
  if (!Number.isFinite(startedAt)) return duration;

  const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
  return Math.max(0, duration - elapsedSeconds);
}

function cloneOnlineGame(gameState) {
  return {
    ...gameState,
    deck: [...gameState.deck],
    discardPile: [...gameState.discardPile],
    matchLog: [...(gameState.matchLog ?? [])],
    players: gameState.players.map((player) => ({
      ...player,
      hand: [...player.hand],
    })),
    result: gameState.result ? { ...gameState.result } : null,
  };
}

function stripDiscardMeta(card) {
  if (!card) return card;
  const { discardedBy, ...cleanCard } = card;
  return cleanCard;
}

function refillDrawPileIfNeeded(gameState) {
  if (gameState.deck.length > 0) {
    return { gameState, blocked: false, recycled: false };
  }

  if (gameState.discardPile.length <= 1) {
    return {
      gameState: {
        ...gameState,
        roundBlocked: true,
        blockReason: 'Sem cartas disponiveis',
        lastAction: {
          type: 'DRAW_PILE_BLOCKED',
          message: 'Nao ha cartas disponiveis para compra.',
        },
      },
      blocked: true,
      recycled: false,
    };
  }

  const topDiscard = gameState.discardPile[gameState.discardPile.length - 1];
  const recycleCards = gameState.discardPile.slice(0, -1).map(stripDiscardMeta);

  return {
    gameState: {
      ...gameState,
      deck: shuffleDeck(recycleCards),
      discardPile: [topDiscard],
      lastAction: {
        type: 'DRAW_PILE_REFILLED',
        message: 'Monte de compra renovado com as cartas do descarte.',
      },
    },
    blocked: false,
    recycled: true,
  };
}

function actionRejected(reason, action, message = 'Acao rejeitada pelo servidor.', extra = {}) {
  return {
    blocked: true,
    reason,
    action,
    message,
    ...extra,
  };
}

function getCardKey(card) {
  return card?.id ?? card?.instanceId ?? null;
}

function summarizeCard(card) {
  if (!card) return null;
  return {
    id: card.id,
    rank: card.rank,
    suit: card.suit,
    symbol: card.symbol,
    color: card.color,
  };
}

function summarizePayload(payload = {}) {
  const summary = {};
  if (payload.cardId) summary.cardId = payload.cardId;
  if (payload.card) summary.card = summarizeCard(payload.card);
  if (payload.source) summary.source = payload.source;
  if (payload.matchId) summary.matchId = payload.matchId;
  if (payload.roomId) summary.roomId = payload.roomId;
  if (Array.isArray(payload.handOrder)) summary.handOrderCount = payload.handOrder.length;
  if (Array.isArray(payload.clientHandOrder)) summary.clientHandOrderCount = payload.clientHandOrder.length;
  return summary;
}

function getWinningGroupType(group) {
  const sameRank = group.every((card) => card.rank === group[0].rank);
  if (sameRank) return 'trinca';
  return 'sequencia';
}

function isValidSequenceGroup(group) {
  if (group.length < 3) return false;
  const sameSuit = group.every((card) => card.suit === group[0].suit);
  if (!sameSuit) return false;

  const values = group.map((card) => card.value).sort((a, b) => a - b);
  if (new Set(values).size !== values.length) return false;

  return values.every((value, index) => index === 0 || value === values[index - 1] + 1);
}

function buildWinningReveal(hand = []) {
  const groups = [];
  const usedCardIds = new Set();

  for (let index = 0; index < hand.length; index += 1) {
    if (usedCardIds.has(hand[index].id)) continue;

    let sequence = null;
    let endIndex = index;

    for (let end = hand.length; end >= index + 3; end -= 1) {
      const group = hand.slice(index, end);
      const alreadyUsed = group.some((card) => usedCardIds.has(card.id));
      if (!alreadyUsed && isValidSequenceGroup(group)) {
        sequence = group;
        endIndex = end - 1;
        break;
      }
    }

    if (sequence) {
      sequence.forEach((card) => usedCardIds.add(card.id));
      groups.push({
        type: 'sequencia',
        cards: sequence,
      });
      index = endIndex;
    }
  }

  for (let index = 0; index < hand.length; index += 1) {
    if (usedCardIds.has(hand[index].id)) continue;

    const set = [hand[index]];
    while (
      index + set.length < hand.length &&
      !usedCardIds.has(hand[index + set.length].id) &&
      hand[index + set.length].rank === set[0].rank
    ) {
      set.push(hand[index + set.length]);
    }

    if (set.length >= 3) {
      set.forEach((card) => usedCardIds.add(card.id));
      groups.push({
        type: getWinningGroupType(set),
        cards: set,
      });
      index += set.length - 1;
    }
  }

  return {
    winningGroups: groups,
    remainingCards: hand.filter((card) => !usedCardIds.has(card.id)),
  };
}

function createLogEntry({ playerId = null, action, payload = {}, accepted = true, reasonIfRejected = null }) {
  return {
    timestamp: new Date().toISOString(),
    playerId,
    action,
    payloadResumo: summarizePayload(payload),
    accepted,
    reasonIfRejected,
  };
}

function chooseAutoDiscard(playerHand = []) {
  const knockInfo = validateKnock(playerHand);
  const preservedIds = new Set(knockInfo.combinationIds ?? []);
  const candidates = playerHand.filter((card) => !preservedIds.has(card.id));
  return (candidates.length > 0 ? candidates : playerHand).at(-1) ?? null;
}

export class MatchManager {
  constructor() {
    this.matches = new Map();
    this.matchResults = new Map();
    this.turnTimers = new Map();
    this.disconnectTimers = new Map();
    this.actionLocks = new Set();
    this.onTurnTick = null;
    this.onMatchTimeout = null;
    this.onDisconnectTimeout = null;
  }

  setTurnTimerHandlers({ onTick, onTimeout, onDisconnectTimeout } = {}) {
    this.onTurnTick = typeof onTick === 'function' ? onTick : null;
    this.onMatchTimeout = typeof onTimeout === 'function' ? onTimeout : null;
    this.onDisconnectTimeout = typeof onDisconnectTimeout === 'function' ? onDisconnectTimeout : null;
  }

  getActionLockKey(matchId, playerId, action) {
    const match = this.getOnlineMatch(matchId);
    return `${matchId}:${match?.turnNumber ?? 0}:${playerId}:${action}`;
  }

  acquireActionLock(matchId, playerId, action) {
    const key = this.getActionLockKey(matchId, playerId, action);
    if (this.actionLocks.has(key)) return null;
    this.actionLocks.add(key);
    return key;
  }

  releaseActionLock(key) {
    if (key) this.actionLocks.delete(key);
  }

  recordMatchLog(matchId, entry = {}) {
    const match = this.getOnlineMatch(matchId);
    if (!match) return null;

    const nextMatch = {
      ...match,
      matchLog: [
        ...(match.matchLog ?? []),
        {
          timestamp: new Date().toISOString(),
          playerId: entry.playerId ?? null,
          action: entry.action ?? 'unknown',
          payloadResumo: summarizePayload(entry.payload ?? {}),
          accepted: Boolean(entry.accepted),
          reasonIfRejected: entry.reasonIfRejected ?? null,
        },
      ].slice(-300),
    };
    this.matches.set(matchId, nextMatch);
    return nextMatch;
  }

  rejectAndLog(matchId, playerId, action, reason, message, extra = {}) {
    const loggedMatch = this.recordMatchLog(matchId, {
      playerId,
      action,
      payload: extra.payload,
      accepted: false,
      reasonIfRejected: reason,
    });

    return actionRejected(reason, action, message, {
      ...extra,
      gameState: extra.gameState ?? loggedMatch ?? undefined,
    });
  }

  validateMatchIntegrity(gameState) {
    if (!gameState) {
      return { valid: false, errors: ['MATCH_NOT_FOUND'] };
    }
    if (gameState.status === 'finished') {
      return { valid: true, errors: [] };
    }

    const errors = [];
    const allCards = [
      ...gameState.players.flatMap((player) => player.hand ?? []),
      ...(gameState.deck ?? []),
      ...(gameState.discardPile ?? []),
    ];
    const cardIds = allCards.map(getCardKey).filter(Boolean);
    if (new Set(cardIds).size !== cardIds.length) {
      errors.push('DUPLICATED_CARD');
    }
    if (cardIds.length !== 104) {
      errors.push('INVALID_CARD_TOTAL');
    }
    if (!gameState.players.some((player) => player.id === gameState.currentTurnPlayerId)) {
      errors.push('INVALID_TURN_PLAYER');
    }

    gameState.players.forEach((player) => {
      const handSize = player.hand?.length ?? 0;
      const canHaveTen = player.id === gameState.currentTurnPlayerId && player.hasDrawnThisTurn;
      if (handSize !== 9 && !(handSize === 10 && canHaveTen)) {
        errors.push(`INVALID_HAND_SIZE:${player.id}:${handSize}`);
      }
    });

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  pauseInvalidMatch(matchId, errors = []) {
    const match = this.getOnlineMatch(matchId);
    if (!match) return null;

    const pausedMatch = refreshGameCounts({
      ...match,
      status: 'paused',
      isResolvingAction: false,
      blockReason: 'Estado invalido detectado pelo servidor.',
      integrityErrors: errors,
    });
    this.matches.set(matchId, pausedMatch);
    this.clearTurnTimer(matchId);
    this.recordMatchLog(matchId, {
      action: 'integrity_failed',
      accepted: false,
      reasonIfRejected: errors.join('|'),
    });
    logError('MATCH_INTEGRITY_ERROR', {
      matchId,
      roomId: match.roomId,
      message: 'Estado invalido detectado pelo servidor.',
      errors,
    });
    const errorMatch = this.getOnlineMatch(matchId);
    createMatchHistory({
      ...errorMatch,
      finishedAt: new Date().toISOString(),
      result: {
        ...(errorMatch?.result ?? {}),
        reason: 'integrity_error',
      },
      economicResult: errorMatch?.economicResult ?? errorMatch?.economy,
    });
    return errorMatch;
  }

  clearDisconnectTimer(playerId) {
    const timer = this.disconnectTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(playerId);
    }
  }

  clearTurnTimer(matchId) {
    const timer = this.turnTimers.get(matchId);
    if (timer) {
      clearInterval(timer);
      this.turnTimers.delete(matchId);
    }
  }

  hasActiveTurnTimer(matchId) {
    return this.turnTimers.has(matchId);
  }

  resetTurnTimer(matchId) {
    this.clearTurnTimer(matchId);
    const match = this.getOnlineMatch(matchId);
    if (!match || match.status !== 'playing' || !match.currentTurnPlayerId) return match;

    const nextMatch = refreshGameCounts({
      ...match,
      turnSecondsLeft: config.TURN_DURATION_SECONDS,
      turn: {
        ...match.turn,
        turnSecondsLeft: config.TURN_DURATION_SECONDS,
      },
    });
    this.matches.set(matchId, nextMatch);
    this.onTurnTick?.(nextMatch);

    const timer = setInterval(() => {
      const currentMatch = this.getOnlineMatch(matchId);
      if (!currentMatch || currentMatch.status !== 'playing') {
        this.clearTurnTimer(matchId);
        return;
      }

      const secondsLeft = calculateTurnSecondsLeft(currentMatch);
      if (secondsLeft <= 0) {
        const autoPlayedGame = this.autoPlayTurn(matchId, currentMatch.currentTurnPlayerId);
        if (autoPlayedGame) {
          this.onMatchTimeout?.(autoPlayedGame);
        }
        return;
      }

      const updatedMatch = refreshGameCounts({
        ...currentMatch,
        turnSecondsLeft: secondsLeft,
        turn: {
          ...currentMatch.turn,
          turnSecondsLeft: secondsLeft,
        },
      });
      this.matches.set(matchId, updatedMatch);
      this.onTurnTick?.(updatedMatch);
    }, 1000);
    timer.unref?.();
    this.turnTimers.set(matchId, timer);

    return nextMatch;
  }

  expireTurnIfNeeded(matchId) {
    const match = this.getOnlineMatch(matchId);
    if (!match || match.status !== 'playing') return null;
    if (calculateTurnSecondsLeft(match) > 0) return null;

    const autoPlayedGame = this.autoPlayTurn(matchId, match.currentTurnPlayerId);
    if (autoPlayedGame) {
      this.onMatchTimeout?.(autoPlayedGame);
    }
    return autoPlayedGame;
  }

  autoPlayTurn(matchId, playerId) {
    const match = this.getOnlineMatch(matchId);
    if (!match || match.status !== 'playing' || match.currentTurnPlayerId !== playerId) return null;

    const lockKey = this.acquireActionLock(matchId, playerId, 'autoPlayTurn');
    if (!lockKey) return this.getOnlineMatch(matchId);

    this.clearTurnTimer(matchId);

    try {
      let game = cloneOnlineGame(match);
      const player = game.players.find((item) => item.id === playerId);
      if (!player) return null;

      const logEntries = [
        createLogEntry({
          playerId,
          action: 'timeout_started',
          payload: { source: 'turn_timeout' },
          accepted: true,
        }),
      ];

      if (!player.hasDrawnThisTurn) {
        if (player.hand.length !== 9) {
          const paused = this.pauseInvalidMatch(matchId, [`INVALID_TIMEOUT_HAND_SIZE:${playerId}:${player.hand.length}`]);
          return paused;
        }

        const refill = refillDrawPileIfNeeded(game);
        game = refill.gameState;
        if (refill.recycled) {
          logEntries.push(createLogEntry({
            playerId,
            action: 'draw_pile_recycled',
            payload: { source: 'turn_timeout' },
            accepted: true,
          }));
        }

        if (refill.blocked || game.deck.length === 0) {
          const paused = this.pauseInvalidMatch(matchId, ['AUTO_TURN_EMPTY_DECK']);
          return paused;
        }

        const drawnCard = game.deck.shift();
        player.hand.push(drawnCard);
        player.hasDrawnThisTurn = true;
        logEntries.push(createLogEntry({
          playerId,
          action: 'auto_draw_from_deck',
          payload: { source: 'deck', card: drawnCard },
          accepted: true,
        }));
      }

      if (player.hand.length !== 10) {
        const paused = this.pauseInvalidMatch(matchId, [`INVALID_AUTO_DISCARD_HAND_SIZE:${playerId}:${player.hand.length}`]);
        return paused;
      }

      if (validateKnock(player.hand).valid) {
        logEntries.push(createLogEntry({
          playerId,
          action: 'auto_turn_player_had_winning_hand',
          accepted: true,
        }));
      }

      const card = chooseAutoDiscard(player.hand);
      if (!card) {
        const paused = this.pauseInvalidMatch(matchId, ['AUTO_DISCARD_CARD_NOT_FOUND']);
        return paused;
      }

      const cardIndex = player.hand.findIndex((item) => item.id === card.id || item.instanceId === card.id);
      if (cardIndex < 0) {
        const paused = this.pauseInvalidMatch(matchId, ['AUTO_DISCARD_CARD_NOT_IN_HAND']);
        return paused;
      }

      const [discardedCard] = player.hand.splice(cardIndex, 1);
      game.discardPile.push({ ...discardedCard, discardedBy: playerId });
      player.hasDrawnThisTurn = false;

      const currentIndex = game.players.findIndex((item) => item.id === playerId);
      const nextPlayer = game.players[(currentIndex + 1) % game.players.length];
      const turnStartedAt = new Date().toISOString();
      game.currentTurnPlayerId = nextPlayer.id;
      game.turnNumber += 1;
      game.turnStartedAt = turnStartedAt;
      game.turnSecondsLeft = config.TURN_DURATION_SECONDS;
      game.players = game.players.map((item) => ({
        ...item,
        hasDrawnThisTurn: false,
      }));
      game.turn = createTurnState({
        currentPlayerId: nextPlayer.id,
        turnStartedAt,
        turnDurationSeconds: config.TURN_DURATION_SECONDS,
        turnSecondsLeft: config.TURN_DURATION_SECONDS,
        canDraw: true,
        canDiscard: false,
        canKnock: false,
      });

      logEntries.push(
        createLogEntry({
          playerId,
          action: 'auto_discard',
          payload: { card: discardedCard, source: 'turn_timeout' },
          accepted: true,
        }),
        createLogEntry({
          playerId,
          action: 'auto_turn_completed',
          payload: { source: 'turn_timeout' },
          accepted: true,
        }),
      );

      const nextGame = refreshGameCounts({
        ...game,
        isResolvingAction: false,
        lastAction: {
          type: 'AUTO_TURN_TIMEOUT',
          message: 'Tempo esgotado. Jogada automatica realizada.',
          playerId,
          card: summarizeCard(discardedCard),
        },
        matchLog: [...(game.matchLog ?? []), ...logEntries].slice(-300),
      });

      const integrity = this.validateMatchIntegrity(nextGame);
      if (!integrity.valid) {
        return this.pauseInvalidMatch(matchId, integrity.errors);
      }

      this.matches.set(matchId, nextGame);
      return this.resetTurnTimer(matchId) ?? nextGame;
    } finally {
      this.releaseActionLock(lockKey);
      const latest = this.matches.get(matchId);
      if (latest?.isResolvingAction) {
        this.matches.set(matchId, { ...latest, isResolvingAction: false });
      }
    }
  }

  finishOnlineMatchByTimeout(matchId) {
    const match = this.getOnlineMatch(matchId);
    return this.autoPlayTurn(matchId, match?.currentTurnPlayerId);
  }

  finishOnlineMatchByDisconnect(matchId, loserId) {
    const match = this.getOnlineMatch(matchId);
    if (!match || match.status !== 'playing') return null;

    const winner = match.players.find((player) => player.id !== loserId);
    if (!winner) return null;

    this.clearTurnTimer(matchId);
    this.clearDisconnectTimer(loserId);
    match.players.forEach((player) => this.clearDisconnectTimer(player.id));
    const disconnectMatch = finishMatchState(match, 'disconnect', winner.id);
    const economicResult = this.createEconomicResult({
      gameState: disconnectMatch,
      winnerId: winner.id,
      loserId,
      finishReason: 'disconnect',
      finishedAt: disconnectMatch.finishedAt,
    });
    const finishedGame = refreshGameCounts({
      ...disconnectMatch,
      currentTurnPlayerId: match.currentTurnPlayerId,
      isResolvingAction: false,
      economicResult,
      result: {
        ...disconnectMatch.result,
        winnerId: winner.id,
        loserId,
        reason: 'disconnect',
        turnsPlayed: match.turnNumber,
        economy: match.economy,
        economicResult,
      },
      matchLog: [
        ...(match.matchLog ?? []),
        {
          timestamp: new Date().toISOString(),
          playerId: loserId,
          action: 'disconnect_loss',
          payloadResumo: {},
          accepted: true,
          reasonIfRejected: null,
        },
      ].slice(-300),
      turn: {
        ...match.turn,
        canDraw: false,
        canDiscard: false,
        canKnock: false,
      },
    });
    this.matches.set(matchId, finishedGame);
    this.matchResults.set(matchId, economicResult);
    this.createMatchHistory(finishedGame);

    return finishedGame;
  }

  surrenderOnlineMatch(matchId, loserId) {
    const match = this.getOnlineMatch(matchId);
    if (!match || match.status !== 'playing') {
      return actionRejected(REJECTION.MATCH_NOT_FOUND, 'playerSurrender', 'Partida ativa nao encontrada.');
    }

    const loser = match.players.find((player) => player.id === loserId);
    const winner = match.players.find((player) => player.id !== loserId);
    if (!loser || !winner) {
      return actionRejected(REJECTION.PLAYER_NOT_IN_MATCH, 'playerSurrender', 'Jogador nao pertence a partida.');
    }

    this.clearTurnTimer(matchId);
    match.players.forEach((player) => this.clearDisconnectTimer(player.id));
    const surrenderMatch = finishMatchState(match, 'player_forfeit', winner.id);
    const economicResult = this.createEconomicResult({
      gameState: surrenderMatch,
      winnerId: winner.id,
      loserId,
      finishReason: 'player_forfeit',
      finishedAt: surrenderMatch.finishedAt,
    });
    const finishedGame = refreshGameCounts({
      ...surrenderMatch,
      isResolvingAction: false,
      economicResult,
      result: {
        ...surrenderMatch.result,
        winnerId: winner.id,
        loserId,
        reason: 'player_forfeit',
        turnsPlayed: match.turnNumber,
        economy: match.economy,
        economicResult,
      },
      matchLog: [
        ...(match.matchLog ?? []),
        {
          timestamp: new Date().toISOString(),
          playerId: loserId,
          action: 'player_surrender',
          payloadResumo: {},
          accepted: true,
          reasonIfRejected: null,
        },
      ].slice(-300),
      turn: {
        ...match.turn,
        canDraw: false,
        canDiscard: false,
        canKnock: false,
      },
    });
    this.matches.set(matchId, finishedGame);
    this.matchResults.set(matchId, economicResult);
    this.createMatchHistory(finishedGame);

    return { blocked: false, gameState: finishedGame };
  }

  createMatch(roomId, players = []) {
    const deck = shuffleDeck(createDeck());
    const dealt = dealCards(deck, players);
    const matchId = createId('match');
    const currentTurnPlayerId = dealt.players[0]?.id ?? null;
    const gameState = createGameState({
      matchId,
      roomId,
      status: 'waiting',
      players: dealt.players,
      deck: dealt.deck,
      currentTurnPlayerId,
      turn: createTurnState({
        currentPlayerId: currentTurnPlayerId,
        turnDurationSeconds: config.TURN_DURATION_SECONDS,
      }),
    });

    this.matches.set(matchId, gameState);
    return gameState;
  }

  createOnlineMatch(roomId, players = [], tableValue = null) {
    const deck = shuffleDeck(createDeck());
    const normalizedPlayers = players.slice(0, 2).map(normalizeOnlinePlayer);
    const dealt = dealCards(deck, normalizedPlayers);
    const discardPile = [];
    const initialDiscard = dealt.deck.shift();
    if (initialDiscard) {
      discardPile.push({ ...initialDiscard, discardedBy: 'server' });
    }

    const matchId = createId('match');
    const startedAt = new Date().toISOString();
    const currentTurnPlayerId = dealt.players[0]?.id ?? null;
    const economy = calculatePrize(tableValue);
    const gameState = refreshGameCounts(createGameState({
      matchId,
      roomId,
      status: 'playing',
      mode: 'online_1v1',
      tableValue: economy?.tableValue ?? tableValue,
      economy,
      paymentStatus: 'confirmed',
      players: dealt.players,
      deck: dealt.deck,
      discardPile,
      currentTurnPlayerId,
      turnNumber: 1,
      turnStartedAt: startedAt,
      turnDurationSeconds: config.TURN_DURATION_SECONDS,
      isResolvingAction: false,
      startedAt,
      matchLog: dealt.players.map((player) => ({
        timestamp: startedAt,
        playerId: player.id,
        action: 'joined_match',
        payloadResumo: { roomId },
        accepted: true,
        reasonIfRejected: null,
      })),
      turn: createTurnState({
        currentPlayerId: currentTurnPlayerId,
        turnStartedAt: startedAt,
        turnDurationSeconds: config.TURN_DURATION_SECONDS,
        canDraw: true,
        canDiscard: false,
        canKnock: false,
      }),
    }));

    this.matches.set(matchId, gameState);
    return this.resetTurnTimer(matchId) ?? gameState;
  }

  startMatch(matchId) {
    const match = this.getMatch(matchId);
    if (!match) return null;

    const startedAt = new Date().toISOString();
    const currentTurnPlayerId = match.currentTurnPlayerId ?? match.players[0]?.id ?? null;
    const nextMatch = {
      ...match,
      status: 'playing',
      startedAt,
      currentTurnPlayerId,
      turn: createTurnState({
        currentPlayerId: currentTurnPlayerId,
        turnStartedAt: startedAt,
        turnDurationSeconds: config.TURN_DURATION_SECONDS,
      }),
    };
    this.matches.set(matchId, nextMatch);
    return nextMatch;
  }

  getMatch(matchId) {
    return this.matches.get(matchId) ?? null;
  }

  listMatches() {
    return [...this.matches.values()];
  }

  listEconomicResults() {
    return [...this.matchResults.values()];
  }

  getEconomicResult(matchId) {
    return this.matchResults.get(matchId) ?? null;
  }

  createEconomicResult({ gameState, winnerId, loserId, finishReason, finishedAt }) {
    const players = gameState.players ?? [];
    const economy = gameState.economy ?? calculatePrize(gameState.tableValue);

    return {
      matchId: gameState.matchId,
      roomId: gameState.roomId,
      player1Id: players[0]?.id ?? null,
      player2Id: players[1]?.id ?? null,
      winnerId,
      loserId,
      tableValue: economy?.tableValue ?? gameState.tableValue ?? null,
      totalPot: economy?.totalPot ?? 0,
      platformFeePercent: economy?.platformFeePercent ?? 0,
      platformFeeAmount: economy?.platformFeeAmount ?? 0,
      winnerPrize: economy?.winnerPrize ?? 0,
      paymentStatus: gameState.paymentStatus ?? 'confirmed',
      finishReason,
      startedAt: gameState.startedAt,
      finishedAt,
    };
  }

  createMatchHistory(match) {
    return createMatchHistory(match);
  }

  listMatchHistory(options) {
    return listMatchHistory(options);
  }

  getMatchAudit(matchId) {
    return getMatchAudit(matchId);
  }

  adminEndMatch(matchId, reason = 'admin_closed') {
    const match = this.getOnlineMatch(matchId) ?? this.getMatch(matchId);
    if (!match) {
      return actionRejected(REJECTION.MATCH_NOT_FOUND, 'adminEndMatch', 'Partida nao encontrada.');
    }

    this.clearTurnTimer(matchId);
    match.players?.forEach((player) => this.clearDisconnectTimer(player.id));

    const finishedAt = new Date().toISOString();
    const economicResult = this.createEconomicResult({
      gameState: match,
      winnerId: null,
      loserId: null,
      finishReason: reason,
      finishedAt,
    });
    const nextMatch = refreshGameCounts({
      ...match,
      status: 'finished',
      finishedAt,
      isResolvingAction: false,
      economicResult,
      result: {
        ...(match.result ?? {}),
        winnerId: null,
        loserId: null,
        reason,
        turnsPlayed: match.turnNumber,
        economy: match.economy,
        economicResult,
        finishedAt,
      },
      matchLog: [
        ...(match.matchLog ?? []),
        {
          timestamp: finishedAt,
          playerId: null,
          action: 'admin_end_match',
          payloadResumo: { reason },
          accepted: true,
          reasonIfRejected: null,
        },
      ].slice(-300),
      turn: {
        ...(match.turn ?? {}),
        canDraw: false,
        canDiscard: false,
        canKnock: false,
      },
    });
    this.matches.set(matchId, nextMatch);
    this.matchResults.set(matchId, economicResult);
    this.createMatchHistory(nextMatch);

    return { blocked: false, gameState: nextMatch };
  }

  adminForceWinner(matchId, winnerId, reason = 'admin_decision') {
    const match = this.getOnlineMatch(matchId) ?? this.getMatch(matchId);
    if (!match) {
      return actionRejected(REJECTION.MATCH_NOT_FOUND, 'adminForceWinner', 'Partida nao encontrada.');
    }

    const winner = match.players?.find((player) => player.id === winnerId);
    if (!winner) {
      return actionRejected(REJECTION.PLAYER_NOT_IN_MATCH, 'adminForceWinner', 'Vencedor nao pertence a partida.');
    }

    const loser = match.players.find((player) => player.id !== winnerId);
    this.clearTurnTimer(matchId);
    match.players.forEach((player) => this.clearDisconnectTimer(player.id));

    const finishedAt = new Date().toISOString();
    const startedAt = match.startedAt ? new Date(match.startedAt).getTime() : Date.now();
    const economicResult = this.createEconomicResult({
      gameState: match,
      winnerId,
      loserId: loser?.id ?? null,
      finishReason: 'admin_decision',
      finishedAt,
    });
    const nextMatch = refreshGameCounts({
      ...match,
      status: 'finished',
      finishedAt,
      isResolvingAction: false,
      economicResult,
      result: {
        winnerId,
        loserId: loser?.id ?? null,
        reason: 'admin_decision',
        adminReason: reason,
        turnsPlayed: match.turnNumber,
        durationSeconds: Math.max(0, Math.round((new Date(finishedAt).getTime() - startedAt) / 1000)),
        finishedAt,
        economy: match.economy,
        economicResult,
      },
      matchLog: [
        ...(match.matchLog ?? []),
        {
          timestamp: finishedAt,
          playerId: winnerId,
          action: 'admin_force_winner',
          payloadResumo: { reason },
          accepted: true,
          reasonIfRejected: null,
        },
      ].slice(-300),
      turn: {
        ...(match.turn ?? {}),
        canDraw: false,
        canDiscard: false,
        canKnock: false,
      },
    });
    this.matches.set(matchId, nextMatch);
    this.matchResults.set(matchId, economicResult);
    this.createMatchHistory(nextMatch);

    return { blocked: false, gameState: nextMatch };
  }

  finishMatch(matchId, result) {
    const match = this.getMatch(matchId);
    if (!match) return null;

    const nextMatch = result?.winnerId
      ? finishMatchState(match, result.reason, result.winnerId)
      : {
          ...match,
          status: 'finished',
          result,
          finishedAt: new Date().toISOString(),
        };
    this.matches.set(matchId, nextMatch);
    this.clearTurnTimer(matchId);

    return nextMatch;
  }

  restartMatch(matchId) {
    const match = this.getMatch(matchId);
    if (!match) return null;

    this.clearTurnTimer(matchId);
    const nextMatch = this.createMatch(match.roomId, match.players.map((player) => ({
      ...player,
      hand: [],
      hasDrawnThisTurn: false,
      hasKnocked: false,
    })));
    this.matches.delete(matchId);

    return nextMatch;
  }

  getOnlineMatch(matchId) {
    const match = this.getMatch(matchId);
    return match?.mode === 'online_1v1' ? match : null;
  }

  reconnectOnlinePlayer(matchId, playerId, socketId) {
    const gameState = this.getOnlineMatch(matchId);
    if (!gameState) return null;

    const game = cloneOnlineGame(gameState);
    const player = game.players.find((item) => item.id === playerId);
    if (!player) return null;

    this.clearDisconnectTimer(playerId);
    player.socketId = socketId;
    player.isConnected = true;
    player.disconnectedAt = null;
    const nextGame = refreshGameCounts({
      ...game,
      matchLog: [
        ...(game.matchLog ?? []),
        {
          timestamp: new Date().toISOString(),
          playerId,
          action: 'reconnected',
          payloadResumo: {},
          accepted: true,
          reasonIfRejected: null,
        },
      ].slice(-300),
    });
    this.matches.set(matchId, nextGame);
    return nextGame;
  }

  setOnlinePlayerConnection(playerId, isConnected, socketId = null) {
    let updatedMatch = null;

    this.matches.forEach((match, matchId) => {
      if (match.mode !== 'online_1v1') return;
      const playerIndex = match.players.findIndex((item) => item.id === playerId);
      if (playerIndex < 0) return;

      const game = cloneOnlineGame(match);
      game.players[playerIndex] = {
        ...game.players[playerIndex],
        isConnected,
        socketId: socketId ?? game.players[playerIndex].socketId,
        disconnectedAt: isConnected ? null : new Date().toISOString(),
      };
      if (isConnected) this.clearDisconnectTimer(playerId);
      updatedMatch = refreshGameCounts(game);
      this.matches.set(matchId, updatedMatch);
    });

    return updatedMatch;
  }

  handleOnlineDisconnect(playerId) {
    const updatedMatch = this.setOnlinePlayerConnection(playerId, false);
    if (!updatedMatch || updatedMatch.status !== 'playing') return updatedMatch;

    this.recordMatchLog(updatedMatch.matchId, {
      playerId,
      action: 'disconnected',
      accepted: true,
    });

    if (!this.disconnectTimers.has(playerId)) {
      const timer = setTimeout(() => {
        const currentMatch = [...this.matches.values()].find((match) =>
          match.mode === 'online_1v1' &&
          match.status === 'playing' &&
          match.players.some((player) => player.id === playerId && !player.isConnected),
        );
        if (!currentMatch) {
          this.clearDisconnectTimer(playerId);
          return;
        }

        const finishedGame = this.finishOnlineMatchByDisconnect(currentMatch.matchId, playerId);
        this.clearDisconnectTimer(playerId);
        if (finishedGame) this.onDisconnectTimeout?.(finishedGame);
      }, config.DISCONNECT_GRACE_SECONDS * 1000);
      timer.unref?.();
      this.disconnectTimers.set(playerId, timer);
    }

    return this.getOnlineMatch(updatedMatch.matchId);
  }

  validateOnlineAction(gameState, playerId, action) {
    if (!gameState) return actionRejected(REJECTION.MATCH_NOT_FOUND, action, 'Partida nao encontrada.');
    if (gameState.status === 'finished') {
      return this.rejectAndLog(gameState.matchId, playerId, action, REJECTION.MATCH_ALREADY_FINISHED, 'Partida ja encerrada.');
    }
    if (gameState.status !== 'playing') {
      return this.rejectAndLog(gameState.matchId, playerId, action, REJECTION.MATCH_NOT_FOUND, 'Partida nao esta ativa.');
    }
    if (!gameState.players.some((player) => player.id === playerId)) {
      return this.rejectAndLog(gameState.matchId, playerId, action, REJECTION.PLAYER_NOT_IN_MATCH, 'Jogador nao pertence a esta partida.');
    }

    const integrity = this.validateMatchIntegrity(gameState);
    if (!integrity.valid) {
      const pausedGame = this.pauseInvalidMatch(gameState.matchId, integrity.errors);
      return actionRejected(
        REJECTION.MATCH_INTEGRITY_ERROR,
        action,
        'Partida pausada por inconsistencia interna.',
        { gameState: pausedGame },
      );
    }
    const timeoutGameState = this.expireTurnIfNeeded(gameState.matchId);
    if (timeoutGameState) {
      return actionRejected(
        timeoutGameState.status === 'playing' ? REJECTION.NOT_YOUR_TURN : REJECTION.MATCH_ALREADY_FINISHED,
        action,
        timeoutGameState.status === 'playing'
          ? 'Tempo esgotado. Jogada automatica realizada.'
          : 'Partida encerrada por timeout.',
        { gameState: timeoutGameState },
      );
    }
    if (gameState.isResolvingAction) {
      return this.rejectAndLog(gameState.matchId, playerId, action, REJECTION.ACTION_RESOLVING, 'Aguarde a acao atual terminar.');
    }
    if (gameState.currentTurnPlayerId !== playerId) {
      return this.rejectAndLog(gameState.matchId, playerId, action, REJECTION.NOT_YOUR_TURN, 'Ainda nao e sua vez.');
    }

    return null;
  }

  drawFromDeck(matchId, playerId) {
    const action = 'playerDrawFromDeck';
    const gameState = this.getOnlineMatch(matchId);
    const rejection = this.validateOnlineAction(gameState, playerId, action);
    if (rejection) return rejection;
    const lockKey = this.acquireActionLock(matchId, playerId, action);
    if (!lockKey) {
      return this.rejectAndLog(matchId, playerId, action, REJECTION.ACTION_RESOLVING, 'Acao duplicada ignorada.');
    }

    try {
      let game = cloneOnlineGame(gameState);
      const player = game.players.find((item) => item.id === playerId);
      if (player.hand.length !== 9) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.INVALID_HAND_SIZE, 'A compra exige mao com 9 cartas.');
      }
      if (player.hasDrawnThisTurn) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.ALREADY_DREW, 'Voce ja comprou neste turno.');
      }

      const refill = refillDrawPileIfNeeded(game);
      game = refill.gameState;
      if (refill.blocked) {
        const blockedGame = refreshGameCounts(game);
        this.matches.set(matchId, blockedGame);
        return this.rejectAndLog(matchId, playerId, action, REJECTION.DECK_EMPTY, 'Nao ha cartas disponiveis para compra.', {
          gameState: blockedGame,
        });
      }
      if (game.deck.length === 0) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.DECK_EMPTY, 'Nao ha cartas disponiveis para compra.');
      }

      game.isResolvingAction = true;
      const card = game.deck.shift();
      player.hand.push(card);
      player.hasDrawnThisTurn = true;
      game.turn = createTurnState({
        currentPlayerId: playerId,
        turnStartedAt: game.turnStartedAt,
        turnDurationSeconds: config.TURN_DURATION_SECONDS,
        turnSecondsLeft: game.turnSecondsLeft ?? config.TURN_DURATION_SECONDS,
        canDraw: false,
        canDiscard: true,
        canKnock: validateKnock(player.hand).valid,
      });
      const nextGame = refreshGameCounts({
        ...game,
        isResolvingAction: false,
      });
      const integrity = this.validateMatchIntegrity(nextGame);
      if (!integrity.valid) {
        return actionRejected(REJECTION.MATCH_INTEGRITY_ERROR, action, 'Partida pausada por inconsistencia interna.', {
          gameState: this.pauseInvalidMatch(matchId, integrity.errors),
        });
      }
      this.matches.set(matchId, nextGame);
      const loggedGame = this.recordMatchLog(matchId, {
        playerId,
        action,
        payload: { source: 'deck' },
        accepted: true,
      });
      return { blocked: false, gameState: loggedGame ?? nextGame, card };
    } finally {
      this.releaseActionLock(lockKey);
      const latest = this.matches.get(matchId);
      if (latest?.isResolvingAction) {
        this.matches.set(matchId, { ...latest, isResolvingAction: false });
      }
    }
  }

  drawFromDiscard(matchId, playerId) {
    const action = 'playerDrawFromDiscard';
    const gameState = this.getOnlineMatch(matchId);
    const rejection = this.validateOnlineAction(gameState, playerId, action);
    if (rejection) return rejection;
    const lockKey = this.acquireActionLock(matchId, playerId, action);
    if (!lockKey) {
      return this.rejectAndLog(matchId, playerId, action, REJECTION.ACTION_RESOLVING, 'Acao duplicada ignorada.');
    }

    try {
      const game = cloneOnlineGame(gameState);
      const player = game.players.find((item) => item.id === playerId);
      if (player.hand.length !== 9) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.INVALID_HAND_SIZE, 'A compra exige mao com 9 cartas.');
      }
      if (player.hasDrawnThisTurn) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.ALREADY_DREW, 'Voce ja comprou neste turno.');
      }
      if (game.discardPile.length === 0) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.DISCARD_EMPTY, 'O descarte esta vazio.');
      }

      game.isResolvingAction = true;
      const card = game.discardPile.pop();
      player.hand.push(card);
      player.hasDrawnThisTurn = true;
      game.turn = createTurnState({
        currentPlayerId: playerId,
        turnStartedAt: game.turnStartedAt,
        turnDurationSeconds: config.TURN_DURATION_SECONDS,
        turnSecondsLeft: game.turnSecondsLeft ?? config.TURN_DURATION_SECONDS,
        canDraw: false,
        canDiscard: true,
        canKnock: validateKnock(player.hand).valid,
      });
      const nextGame = refreshGameCounts({
        ...game,
        isResolvingAction: false,
      });
      const integrity = this.validateMatchIntegrity(nextGame);
      if (!integrity.valid) {
        return actionRejected(REJECTION.MATCH_INTEGRITY_ERROR, action, 'Partida pausada por inconsistencia interna.', {
          gameState: this.pauseInvalidMatch(matchId, integrity.errors),
        });
      }
      this.matches.set(matchId, nextGame);
      const loggedGame = this.recordMatchLog(matchId, {
        playerId,
        action,
        payload: { source: 'discard' },
        accepted: true,
      });
      return { blocked: false, gameState: loggedGame ?? nextGame, card };
    } finally {
      this.releaseActionLock(lockKey);
      const latest = this.matches.get(matchId);
      if (latest?.isResolvingAction) {
        this.matches.set(matchId, { ...latest, isResolvingAction: false });
      }
    }
  }

  discardOnlineCard(matchId, playerId, cardId) {
    const action = 'playerDiscardCard';
    const gameState = this.getOnlineMatch(matchId);
    const rejection = this.validateOnlineAction(gameState, playerId, action);
    if (rejection) return rejection;
    const lockKey = this.acquireActionLock(matchId, playerId, action);
    if (!lockKey) {
      return this.rejectAndLog(matchId, playerId, action, REJECTION.ACTION_RESOLVING, 'Acao duplicada ignorada.', {
        payload: { cardId },
      });
    }

    try {
      const game = cloneOnlineGame(gameState);
      const player = game.players.find((item) => item.id === playerId);
      if (!player.hasDrawnThisTurn) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.MUST_DRAW_FIRST, 'Compre uma carta antes de descartar.', {
          payload: { cardId },
        });
      }
      if (player.hand.length !== 10) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.INVALID_HAND_SIZE, 'O descarte exige mao com 10 cartas.', {
          payload: { cardId },
        });
      }
      const cardIndex = player.hand.findIndex((card) => card.id === cardId || card.instanceId === cardId);
      if (cardIndex < 0) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.INVALID_CARD, 'Carta nao encontrada na sua mao.', {
          payload: { cardId },
        });
      }

      game.isResolvingAction = true;
      const [card] = player.hand.splice(cardIndex, 1);
      if (player.hand.length !== 9) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.INVALID_HAND_SIZE, 'Descarte deixaria a mao em estado invalido.', {
          payload: { cardId },
        });
      }
      game.discardPile.push({ ...card, discardedBy: playerId });
      player.hasDrawnThisTurn = false;
      const currentIndex = game.players.findIndex((item) => item.id === playerId);
      const nextPlayer = game.players[(currentIndex + 1) % game.players.length];
      const turnStartedAt = new Date().toISOString();
      game.currentTurnPlayerId = nextPlayer.id;
      game.turnNumber += 1;
      game.turnStartedAt = turnStartedAt;
      game.turnSecondsLeft = config.TURN_DURATION_SECONDS;
      game.players = game.players.map((item) => ({
        ...item,
        hasDrawnThisTurn: false,
      }));
      game.turn = createTurnState({
        currentPlayerId: nextPlayer.id,
        turnStartedAt,
        turnDurationSeconds: config.TURN_DURATION_SECONDS,
        turnSecondsLeft: config.TURN_DURATION_SECONDS,
        canDraw: true,
        canDiscard: false,
        canKnock: false,
      });
      const nextGame = refreshGameCounts({
        ...game,
        isResolvingAction: false,
      });
      const integrity = this.validateMatchIntegrity(nextGame);
      if (!integrity.valid) {
        return actionRejected(REJECTION.MATCH_INTEGRITY_ERROR, action, 'Partida pausada por inconsistencia interna.', {
          gameState: this.pauseInvalidMatch(matchId, integrity.errors),
        });
      }
      this.matches.set(matchId, nextGame);
      const loggedGame = this.recordMatchLog(matchId, {
        playerId,
        action,
        payload: { cardId, card },
        accepted: true,
      });
      const timedLoggedGame = this.resetTurnTimer(matchId) ?? loggedGame ?? nextGame;
      return { blocked: false, gameState: timedLoggedGame, card };
    } finally {
      this.releaseActionLock(lockKey);
      const latest = this.matches.get(matchId);
      if (latest?.isResolvingAction) {
        this.matches.set(matchId, { ...latest, isResolvingAction: false });
      }
    }
  }

  reorderOnlineHand(matchId, playerId, handOrder = []) {
    const gameState = this.getOnlineMatch(matchId);
    if (!gameState || gameState.status !== 'playing') return actionRejected(REJECTION.MATCH_NOT_FOUND, 'playerReorderHand', 'Partida nao encontrada.');

    const game = cloneOnlineGame(gameState);
    const player = game.players.find((item) => item.id === playerId);
    if (!player || !Array.isArray(handOrder)) {
      return this.rejectAndLog(matchId, playerId, 'playerReorderHand', REJECTION.INVALID_CARD, 'Ordem de cartas invalida.');
    }

    const reordered = handOrder
      .map((cardId) => player.hand.find((card) => card.id === cardId || card.instanceId === cardId))
      .filter(Boolean);
    const uniqueIds = new Set(reordered.map((card) => card.id));

    if (reordered.length !== player.hand.length || uniqueIds.size !== player.hand.length) {
      return this.rejectAndLog(matchId, playerId, 'playerReorderHand', REJECTION.INVALID_CARD, 'Ordem de cartas invalida.', {
        payload: { handOrder },
      });
    }

    player.hand = reordered;
    const nextGame = refreshGameCounts(game);
    this.matches.set(matchId, nextGame);
    this.recordMatchLog(matchId, {
      playerId,
      action: 'playerReorderHand',
      payload: { handOrder },
      accepted: true,
    });
    return { blocked: false, gameState: nextGame };
  }

  knockOnline(matchId, playerId) {
    const action = 'playerKnock';
    const gameState = this.getOnlineMatch(matchId);
    const rejection = this.validateOnlineAction(gameState, playerId, action);
    if (rejection) return rejection;
    const lockKey = this.acquireActionLock(matchId, playerId, action);
    if (!lockKey) {
      return this.rejectAndLog(matchId, playerId, action, REJECTION.ACTION_RESOLVING, 'Acao duplicada ignorada.');
    }

    try {
      const game = cloneOnlineGame(gameState);
      const player = game.players.find((item) => item.id === playerId);
      if (player.hand.length !== 10) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.INVALID_HAND_SIZE, 'Bater exige mao com 10 cartas.');
      }
      const knockResult = validateKnock(player.hand);
      if (!knockResult.valid) {
        return this.rejectAndLog(matchId, playerId, action, REJECTION.INVALID_KNOCK, 'Sua mao ainda nao pode bater.', {
          debugReason: knockResult.reason,
        });
      }

      game.isResolvingAction = true;
      player.hasKnocked = true;
      const usedCardIds = new Set(knockResult.combinationIds);
      const reveal = {
        winningGroups: knockResult.validGroups.map((group) => ({
          type: group.type,
          cards: group.cards,
        })),
        remainingCards: player.hand.filter((card) => !usedCardIds.has(card.id)),
      };
      const finishedAt = new Date().toISOString();
      const startedAt = game.startedAt ? new Date(game.startedAt).getTime() : Date.now();
      const loser = game.players.find((item) => item.id !== playerId);
      const economicResult = this.createEconomicResult({
        gameState: game,
        winnerId: playerId,
        loserId: loser?.id ?? null,
        finishReason: 'beat',
        finishedAt,
      });
      const nextGame = refreshGameCounts({
        ...game,
        status: 'finished',
        finishedAt,
        isResolvingAction: false,
        economicResult,
        result: {
          winnerId: playerId,
          loserId: loser?.id ?? null,
          reason: 'knock',
          turnsPlayed: game.turnNumber,
          durationSeconds: Math.max(0, Math.round((new Date(finishedAt).getTime() - startedAt) / 1000)),
          finishedAt,
          winningGroups: reveal.winningGroups,
          remainingCards: reveal.remainingCards,
          economy: game.economy,
          economicResult,
        },
      });
      this.matches.set(matchId, nextGame);
      this.matchResults.set(matchId, economicResult);
      this.clearTurnTimer(matchId);
      game.players.forEach((item) => this.clearDisconnectTimer(item.id));
      const loggedGame = this.recordMatchLog(matchId, {
        playerId,
        action,
        accepted: true,
      });
      this.createMatchHistory(loggedGame ?? nextGame);
      return { blocked: false, gameState: loggedGame ?? nextGame, knockResult };
    } finally {
      this.releaseActionLock(lockKey);
      const latest = this.matches.get(matchId);
      if (latest?.isResolvingAction) {
        this.matches.set(matchId, { ...latest, isResolvingAction: false });
      }
    }
  }
}

export default MatchManager;
