import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createDeck, dealInitialHands, recycleDiscardPile, validateDeck } from '../src/game/cards.js';
import { calculatePrize } from '../src/shared/economy.js';
import {
  DEBUG_COMMANDS,
  buildDebugGame,
  getDebugScenarioConfig,
  resolveDebugScenarioKey,
} from '../src/game/debugScenarios.js';
import {
  createMatchState,
  discardFromHandForActor,
  discardFromPlayerHand,
  drawFromStockForActor,
  drawFromStock,
  getKnockResultForActor,
  getPlayerKnockResult,
  knockForActor,
  playerKnock,
  playerTimeout,
  planBotTurn,
  playBotTurn,
  takeFromDiscardForActor,
  takeFromDiscard,
  timeoutForActor,
  validateGameState,
} from '../src/game/matchEngine.js';
import {
  chooseBotDiscard,
  canKnock,
  detectValidCombinations,
  findThreeCombinationResult,
  isSequence,
  isSet,
  shouldBotTakeDiscard,
} from '../src/game/rules.js';
import { MatchManager } from '../server/src/managers/MatchManager.js';
import { buildClientGameState } from '../server/src/game/clientState.js';

const shouldWriteReport = process.argv.includes('--report') || process.env.WRITE_TEST_REPORT === '1';
const reportPath = new URL('../RELATORIO_TESTES.md', import.meta.url);
const results = [];
const deck = createDeck();
const cards = Object.fromEntries(deck.flatMap((card) => {
  const entries = [[card.id, card]];
  if (card.deckNumber === 1) entries.push([card.logicalId, card]);
  return entries;
}));

runTest('economia calcula premios oficiais por mesa', () => {
  assert.deepEqual(calculatePrize(2), {
    tableValue: 2,
    playerEntry: 2,
    totalPot: 4,
    platformFeePercent: 10,
    platformFeeAmount: 0.4,
    winnerPrize: 3.6,
  });
  assert.deepEqual(calculatePrize(5), {
    tableValue: 5,
    playerEntry: 5,
    totalPot: 10,
    platformFeePercent: 10,
    platformFeeAmount: 1,
    winnerPrize: 9,
  });
  assert.deepEqual(calculatePrize(10), {
    tableValue: 10,
    playerEntry: 10,
    totalPot: 20,
    platformFeePercent: 15,
    platformFeeAmount: 3,
    winnerPrize: 17,
  });
  assert.deepEqual(calculatePrize(20), {
    tableValue: 20,
    playerEntry: 20,
    totalPot: 40,
    platformFeePercent: 18,
    platformFeeAmount: 7.2,
    winnerPrize: 32.8,
  });
});

function cardsInGame(game) {
  return [
    ...game.playerHand,
    ...game.opponentHand,
    ...game.drawPile,
    ...game.discardPile,
  ];
}

function assertUniqueCards(cardsToCheck, label) {
  assert.equal(
    new Set(cardsToCheck.map((card) => card.id)).size,
    cardsToCheck.length,
    `${label}: carta duplicada`,
  );
}

function assertStableCardSet(beforeGame, afterGame, label) {
  const beforeIds = cardsInGame(beforeGame).map((card) => card.id).sort();
  const afterIds = cardsInGame(afterGame).map((card) => card.id).sort();

  assert.deepEqual(afterIds, beforeIds, `${label}: carta sumiu ou apareceu indevidamente`);
  assertUniqueCards(cardsInGame(afterGame), label);
}

function makeTakeDiscardGame(discardCardId, discardedBy = 'bot') {
  const baseGame = createMatchState({ scenarioKey: 'invalid' });
  const discardCard = cards[discardCardId];

  return {
    ...baseGame,
    drawPile: baseGame.drawPile.filter((card) => card.id !== discardCard.id),
    discardPile: [{ ...discardCard, discardedBy }],
  };
}

function cardIds(ids) {
  return ids.map((id) => cards[id].id);
}

function runTest(name, testFn) {
  try {
    testFn();
    results.push({ name, status: 'PASS', detail: 'ok' });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: error.message });
    console.error(`FAIL ${name}`);
    console.error(`  ${error.message}`);
  }
}

function createOnlineSecurityMatch() {
  const manager = new MatchManager();
  const match = manager.createOnlineMatch('room-security', [
    { playerId: 'player-a', playerName: 'Jogador A', socketId: 'socket-a' },
    { playerId: 'player-b', playerName: 'Jogador B', socketId: 'socket-b' },
  ], 2);
  manager.clearTurnTimer(match.matchId);
  return {
    manager,
    match: manager.getOnlineMatch(match.matchId),
    playerA: 'player-a',
    playerB: 'player-b',
  };
}

function getOnlineCards(match) {
  return [
    ...match.players.flatMap((player) => player.hand),
    ...match.deck,
    ...match.discardPile,
  ];
}

function findOnlineCard(cardsToSearch, rank, suit) {
  const card = cardsToSearch.find((item) => item.rank === rank && item.suit === suit);
  assert.ok(card, `Carta online nao encontrada: ${rank} ${suit}`);
  return card;
}

function setOnlineHands(manager, matchId, {
  playerAHand,
  playerBHand,
  discardPile,
  currentTurnPlayerId = 'player-a',
  playerAHasDrawn = false,
}) {
  const match = manager.getOnlineMatch(matchId);
  const usedIds = new Set([
    ...playerAHand,
    ...playerBHand,
    ...discardPile,
  ].map((card) => card.id));
  const deck = getOnlineCards(match).filter((card) => !usedIds.has(card.id));
  const nextMatch = {
    ...match,
    players: match.players.map((player) => {
      const isPlayerA = player.id === 'player-a';
      const hand = isPlayerA ? playerAHand : playerBHand;
      return {
        ...player,
        hand,
        handCount: hand.length,
        hasDrawnThisTurn: isPlayerA ? playerAHasDrawn : false,
      };
    }),
    deck,
    deckCount: deck.length,
    discardPile,
    topDiscardCard: discardPile[discardPile.length - 1] ?? null,
    currentTurnPlayerId,
  };
  manager.matches.set(matchId, nextMatch);
  return nextMatch;
}

runTest('createDeck cria 104 cartas em dois baralhos sem coringas', () => {
  assert.equal(deck.length, 104);
  assertUniqueCards(deck, 'createDeck');
  assert.equal(deck.some((card) => card.isJoker || card.suit === 'joker'), false);
  assert.deepEqual(validateDeck(deck), { valid: true, errors: [] });
  assert.ok(cards['deck1-7-hearts']);
  assert.ok(cards['deck2-7-hearts']);
  assert.notEqual(cards['deck1-7-hearts'].id, cards['deck2-7-hearts'].id);

  const invalidDeck = [...deck, cards['A-hearts']];
  assert.equal(validateDeck(invalidDeck).valid, false);
});

runTest('distribuicao inicial preserva baralho sem duplicar', () => {
  const initialGame = dealInitialHands();

  assert.equal(initialGame.playerHand.length, 9);
  assert.equal(initialGame.opponentHand.length, 9);
  assert.equal(initialGame.drawPile.length, 86);
  assert.equal(initialGame.discardPile.length, 0);
  assertUniqueCards(cardsInGame(initialGame), 'dealInitialHands');
  assert.equal(cardsInGame(initialGame).length, 104);
});

runTest('recycleDiscardPile recicla descarte mantendo topo visivel', () => {
  const recycled = recycleDiscardPile([], [
    cards['A-hearts'],
    { ...cards['2-hearts'], discardedBy: 'player' },
    { ...cards['3-hearts'], discardedBy: 'bot' },
  ]);

  assert.equal(recycled.recycled, true);
  assert.equal(recycled.drawPile.length, 2);
  assert.equal(recycled.discardPile.length, 1);
  assert.equal(recycled.discardPile[0].id, cards['3-hearts'].id);
  assert.equal(recycled.drawPile.some((card) => card.discardedBy), false);
  assertUniqueCards([...recycled.drawPile, ...recycled.discardPile], 'recycleDiscardPile');
});

runTest('validacao de trincas aceita valor igual com naipes diferentes', () => {
  assert.equal(isSet([cards['7-spades'], cards['7-hearts'], cards['7-clubs']]), true);
  assert.equal(isSet([cards['7-spades'], cards['7-spades'], cards['7-clubs']]), false);
});

runTest('validacao de sequencias exige mesmo naipe em ordem', () => {
  assert.equal(isSequence([cards['4-hearts'], cards['5-hearts'], cards['6-hearts']]), true);
  assert.equal(isSequence([cards['6-hearts'], cards['5-hearts'], cards['4-hearts']]), true);
  assert.equal(isSequence([cards['4-hearts'], cards['5-clubs'], cards['6-hearts']]), false);
});

runTest('destaque automatico detecta combinacoes na mao', () => {
  const hand = [
    cards['5-hearts'],
    cards['6-hearts'],
    cards['7-hearts'],
    cards['2-spades'],
    cards['2-hearts'],
    cards['2-diamonds'],
    cards['9-clubs'],
    cards['10-clubs'],
    cards['J-clubs'],
  ];
  const { validGroups } = detectValidCombinations(hand);
  const highlightedIds = validGroups.flatMap((group) => group.cards.map((card) => card.id)).sort();

  assert.deepEqual(highlightedIds, cardIds([
    '5-hearts',
    '6-hearts',
    '7-hearts',
    '2-diamonds',
    '2-hearts',
    '2-spades',
    '9-clubs',
    '10-clubs',
    'J-clubs',
  ]).sort());
  assert.equal(validGroups.length, 3);
});

runTest('destaque automatico exige grupos lado a lado, mas aceita ordem interna livre', () => {
  const separatedSequence = [
    cards['5-hearts'],
    cards['K-diamonds'],
    cards['6-hearts'],
    cards['7-hearts'],
    cards['2-spades'],
    cards['9-clubs'],
    cards['2-diamonds'],
    cards['2-hearts'],
    cards['10-clubs'],
  ];
  const unorderedSequence = [
    cards['5-hearts'],
    cards['7-hearts'],
    cards['6-hearts'],
    cards['2-spades'],
    cards['2-hearts'],
    cards['2-diamonds'],
    cards['9-clubs'],
    cards['10-clubs'],
    cards['J-clubs'],
  ];
  const separatedSet = [
    cards['2-spades'],
    cards['K-diamonds'],
    cards['2-hearts'],
    cards['5-hearts'],
    cards['2-diamonds'],
    cards['6-hearts'],
    cards['9-clubs'],
    cards['7-hearts'],
    cards['10-clubs'],
  ];

  assert.deepEqual(detectValidCombinations(separatedSequence).validGroups, []);
  assert.deepEqual(
    detectValidCombinations(unorderedSequence).validGroups.flatMap((group) => group.cards.map((card) => card.id)).sort(),
    cardIds([
      '5-hearts',
      '6-hearts',
      '7-hearts',
      '2-diamonds',
      '2-hearts',
      '2-spades',
      '9-clubs',
      '10-clubs',
      'J-clubs',
    ]).sort(),
  );
  assert.deepEqual(detectValidCombinations(separatedSet).validGroups, []);
  assert.deepEqual(detectValidCombinations([
    cards['2-spades'],
    cards['2-hearts'],
    cards['2-diamonds'],
    cards['5-hearts'],
    cards['6-hearts'],
    cards['7-hearts'],
    cards['9-clubs'],
    cards['10-clubs'],
    cards['J-clubs'],
  ]).validGroups.flatMap((group) => group.cards.map((card) => card.id)).sort(), [
    ...cardIds([
      '2-diamonds',
      '2-hearts',
      '2-spades',
      '5-hearts',
      '6-hearts',
      '7-hearts',
      '9-clubs',
      '10-clubs',
      'J-clubs',
    ]),
  ].sort());
});

runTest('destaque automatico nao marca pares ou sequencias incompletas', () => {
  const hand = [
    cards['K-spades'],
    cards['K-hearts'],
    cards['3-diamonds'],
    cards['3-clubs'],
    cards['9-spades'],
    cards['9-hearts'],
    cards['A-clubs'],
  ];

  assert.deepEqual(detectValidCombinations(hand).validGroups, []);
  assert.deepEqual(detectValidCombinations([cards['5-clubs'], cards['6-clubs']]).validGroups, []);
});

runTest('destaque e bater aceitam sequencia decrescente na mao', () => {
  const hand = [
    cards['9-hearts'],
    cards['8-hearts'],
    cards['7-hearts'],
    cards['3-hearts'],
    cards['3-spades'],
    cards['3-diamonds'],
    cards['6-diamonds'],
    cards['6-spades'],
    cards['6-clubs'],
  ];
  const { validGroups } = detectValidCombinations(hand);
  const highlightedIds = validGroups.flatMap((group) => group.cards.map((card) => card.id)).sort();

  assert.deepEqual(highlightedIds, hand.map((card) => card.id).sort());
  assert.deepEqual(validGroups.map((group) => group.indices), [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
  ]);
  assert.equal(canKnock(hand).valid, true);
});

runTest('bater aceita 10 cartas quando a mao inteira esta coberta', () => {
  const hand = [
    cards['7-hearts'],
    cards['8-hearts'],
    cards['9-hearts'],
    cards['10-hearts'],
    cards['3-hearts'],
    cards['3-spades'],
    cards['3-diamonds'],
    cards['6-diamonds'],
    cards['6-spades'],
    cards['6-clubs'],
  ];

  const validation = canKnock(hand);
  const highlightedIds = detectValidCombinations(hand)
    .validGroups
    .flatMap((group) => group.cards.map((card) => card.id));

  assert.equal(validation.valid, true);
  assert.equal(new Set(highlightedIds).size, 10);
  assert.deepEqual(validation.deadwood, []);
});

runTest('bater aceita os cenarios oficiais em tres blocos de tres', () => {
  const allSets = [
    cards['3-diamonds'],
    cards['3-hearts'],
    cards['3-clubs'],
    cards['8-diamonds'],
    cards['8-clubs'],
    cards['8-hearts'],
    cards['6-spades'],
    cards['6-clubs'],
    cards['6-hearts'],
  ];
  const mixedGroups = [
    cards['4-clubs'],
    cards['4-hearts'],
    cards['4-spades'],
    cards['8-clubs'],
    cards['7-clubs'],
    cards['9-clubs'],
    cards['5-diamonds'],
    cards['7-diamonds'],
    cards['6-diamonds'],
  ];

  assert.equal(canKnock(allSets).valid, true);
  assert.equal(canKnock(mixedGroups).valid, true);
  assert.equal(detectValidCombinations(allSets).markedCardIds.length, 9);
  assert.equal(detectValidCombinations(mixedGroups).markedCardIds.length, 9);
});

runTest('bater exige tres grupos e nao usa carta visivel no descarte', () => {
  const twoGroupsInHand = [
    cards['5-clubs'],
    cards['7-clubs'],
    cards['6-clubs'],
    cards['K-hearts'],
    cards['K-clubs'],
    cards['K-spades'],
  ];
  const completedAfterDiscardDraw = [
    ...twoGroupsInHand,
    cards['2-diamonds'],
    cards['3-diamonds'],
    cards['4-diamonds'],
  ];

  assert.equal(canKnock(twoGroupsInHand).valid, false);
  assert.equal(canKnock(completedAfterDiscardDraw).valid, true);
});

runTest('validacao de mao vencedora e mao invalida', () => {
  const winningHand = [
    cards['7-spades'],
    cards['7-hearts'],
    cards['7-clubs'],
    cards['4-hearts'],
    cards['5-hearts'],
    cards['6-hearts'],
    cards['9-diamonds'],
    cards['10-diamonds'],
    cards['J-diamonds'],
  ];
  const invalidHand = [
    cards['A-hearts'],
    cards['3-clubs'],
    cards['8-diamonds'],
    cards['K-spades'],
    cards['2-hearts'],
    cards['5-clubs'],
    cards['9-spades'],
    cards['J-diamonds'],
    cards['Q-clubs'],
  ];

  assert.equal(findThreeCombinationResult(winningHand).valid, true);
  assert.equal(findThreeCombinationResult(invalidHand).valid, false);
});

runTest('comandos debug iniciam maos controladas', () => {
  assert.equal(DEBUG_COMMANDS.DEBUG_WIN_HAND, 'winning-player');
  assert.equal(resolveDebugScenarioKey('DEBUG_WIN_HAND'), 'winning-player');
  assert.equal(resolveDebugScenarioKey('DEBUG_RECYCLE'), 'recycle');
  assert.equal(resolveDebugScenarioKey('DEBUG_TIMEOUT'), 'timeout');
  assert.equal(resolveDebugScenarioKey('DEBUG_INVALID_HAND'), 'invalid');

  const debugWinning = createMatchState({ scenarioKey: 'DEBUG_WIN_HAND' });
  const debugInvalid = createMatchState({ scenarioKey: 'DEBUG_INVALID_HAND' });
  const debugRecycle = buildDebugGame('DEBUG_RECYCLE');
  const timeoutConfig = getDebugScenarioConfig('DEBUG_TIMEOUT');

  assert.equal(getPlayerKnockResult(debugWinning).valid, true);
  assert.equal(getPlayerKnockResult(debugInvalid).valid, false);
  assert.equal(debugRecycle.drawPile.length, 0);
  assert.equal(timeoutConfig.timerSeconds, 5);
});

runTest('debug de vitoria rapida e derrota rapida sao consistentes', () => {
  const nearPlayer = createMatchState({ scenarioKey: 'near-win-player' });
  const nearBot = createMatchState({ scenarioKey: 'near-win-bot' });
  const botWinning = createMatchState({ scenarioKey: 'DEBUG_BOT_WIN' });

  assert.equal(nearPlayer.drawPile[0].id, cards['J-diamonds'].id);
  assert.equal(nearBot.drawPile[0].id, cards['J-diamonds'].id);
  assert.equal(findThreeCombinationResult(botWinning.opponentHand).valid, true);
});

runTest('compra do monte exige turno correto e preserva cartas', () => {
  const game = createMatchState({ scenarioKey: 'invalid' });
  const drawAction = drawFromStock(game, { handMode: 'manual' });

  assert.equal(drawAction.blocked, false);
  assert.equal(drawAction.game.playerHand.length, 10);
  assert.equal(drawAction.game.currentTurn, 'player');
  assert.equal(drawAction.game.turnStage, 'awaiting-discard');
  assertStableCardSet(game, drawAction.game, 'drawFromStock');
});

runTest('compra dupla e acao fora do turno sao bloqueadas', () => {
  const game = createMatchState({ scenarioKey: 'invalid' });
  const drawAction = drawFromStock(game, { handMode: 'manual' });
  const doubleDraw = drawFromStock(drawAction.game);
  const outOfTurnDraw = drawFromStock({ ...game, currentTurn: 'bot' });

  assert.equal(doubleDraw.blocked, true);
  assert.equal(doubleDraw.reason, 'invalid-turn-stage');
  assert.equal(outOfTurnDraw.blocked, true);
  assert.equal(outOfTurnDraw.reason, 'out-of-turn');
});

runTest('descarte obrigatorio apos compra alterna turno', () => {
  const game = createMatchState({ scenarioKey: 'invalid' });
  const drawAction = drawFromStock(game, { handMode: 'manual' });
  const discardAction = discardFromPlayerHand(drawAction.game, drawAction.game.playerHand[0].id, {
    handMode: 'manual',
  });

  assert.equal(discardAction.blocked, false);
  assert.equal(discardAction.game.playerHand.length, 9);
  assert.equal(discardAction.game.discardPile.at(-1).discardedBy, 'player');
  assert.equal(discardAction.game.currentTurn, 'bot');
  assert.equal(discardAction.game.turnStage, 'awaiting-draw');
  assertStableCardSet(drawAction.game, discardAction.game, 'discardFromPlayerHand');
});

runTest('descarte sem compra e carta inexistente sao bloqueados', () => {
  const game = createMatchState({ scenarioKey: 'invalid' });
  const drawAction = drawFromStock(game, { handMode: 'manual' });

  assert.equal(discardFromPlayerHand(game, game.playerHand[0].id).blocked, true);
  assert.equal(discardFromPlayerHand(drawAction.game, 'carta-inexistente').blocked, true);
});

runTest('compra do descarte aceita carta do bot e bloqueia carta propria', () => {
  const takeDiscardGame = makeTakeDiscardGame('4-clubs', 'bot');
  const takeAction = takeFromDiscard(takeDiscardGame, { handMode: 'manual' });
  const blockedOwnDiscardTake = takeFromDiscard(makeTakeDiscardGame('4-clubs', 'player'));

  assert.equal(takeAction.blocked, false);
  assert.equal(takeAction.game.playerHand.length, 10);
  assert.equal(takeAction.game.discardPile.length, 0);
  assert.equal(takeAction.game.turnStage, 'awaiting-discard');
  assertStableCardSet(takeDiscardGame, takeAction.game, 'takeFromDiscard');
  assert.equal(blockedOwnDiscardTake.blocked, true);
});

runTest('motor detecta carta duplicada e bloqueia estado invalido', () => {
  const game = createMatchState({ scenarioKey: 'invalid' });
  const duplicateState = {
    ...game,
    drawPile: [game.playerHand[0], ...game.drawPile],
  };

  assert.equal(validateGameState(duplicateState).valid, false);
  assert.equal(drawFromStock(duplicateState).blocked, true);
});

runTest('bot escolhe descarte util e evita descartar sequencia pronta', () => {
  assert.equal(
    shouldBotTakeDiscard(
      [cards['7-hearts'], cards['7-clubs'], cards['4-spades'], cards['9-diamonds']],
      { ...cards['7-spades'], discardedBy: 'player' },
    ),
    true,
  );
  assert.equal(
    shouldBotTakeDiscard(
      [cards['4-hearts'], cards['5-hearts'], cards['9-diamonds'], cards['K-spades']],
      { ...cards['6-hearts'], discardedBy: 'player' },
    ),
    true,
  );
  assert.equal(
    shouldBotTakeDiscard(
      [cards['A-hearts'], cards['5-clubs'], cards['9-diamonds'], cards['K-spades']],
      { ...cards['3-spades'], discardedBy: 'player' },
    ),
    false,
  );
  assert.notEqual(
    chooseBotDiscard([cards['4-hearts'], cards['5-hearts'], cards['6-hearts'], cards['K-spades']]).id,
    '5-hearts',
  );
});

runTest('turno do bot compra, descarta e preserva cartas', () => {
  const game = {
    playerHand: [
      cards['A-hearts'],
      cards['3-clubs'],
      cards['8-diamonds'],
      cards['K-spades'],
      cards['2-hearts'],
      cards['5-clubs'],
      cards['9-spades'],
      cards['J-diamonds'],
      cards['Q-clubs'],
    ],
    opponentHand: [
      cards['4-hearts'],
      cards['5-hearts'],
      cards['9-diamonds'],
      cards['A-clubs'],
      cards['2-diamonds'],
      cards['7-spades'],
      cards['10-clubs'],
      cards['6-spades'],
      cards['8-spades'],
    ],
    drawPile: [cards['A-spades']],
    discardPile: [{ ...cards['6-hearts'], discardedBy: 'player' }],
    currentTurn: 'bot',
    turnStage: 'awaiting-draw',
    result: null,
  };
  const botPlan = planBotTurn(game);
  const botTurn = playBotTurn({ ...createMatchState({ scenarioKey: 'invalid' }), currentTurn: 'bot' });

  assert.equal(botPlan.drawSource, 'discard');
  assert.equal(botPlan.drawnCard.id, cards['6-hearts'].id);
  assert.equal(['bot-discard', 'bot-knock', 'wait'].includes(botTurn.action), true);
  assertStableCardSet(game, botPlan.game, 'planBotTurn');
});

runTest('multiplayer local alterna Jogador A e Jogador B sem bot obrigatorio', () => {
  const game = createMatchState({ scenarioKey: 'invalid' });
  const playerADraw = drawFromStockForActor(game, 'player', { handMode: 'manual' });
  const playerADiscard = discardFromHandForActor(
    playerADraw.game,
    'player',
    playerADraw.game.playerHand[0].id,
    { handMode: 'manual' },
  );
  const playerBDraw = drawFromStockForActor(playerADiscard.game, 'bot', { handMode: 'manual' });
  const playerBDiscard = discardFromHandForActor(
    playerBDraw.game,
    'bot',
    playerBDraw.game.opponentHand[0].id,
    { handMode: 'manual' },
  );

  assert.equal(playerADraw.blocked, false);
  assert.equal(playerADiscard.game.currentTurn, 'bot');
  assert.equal(playerBDraw.blocked, false);
  assert.equal(playerBDraw.game.opponentHand.length, 10);
  assert.equal(drawFromStockForActor(playerBDraw.game, 'player').blocked, true);
  assert.equal(playerBDiscard.blocked, false);
  assert.equal(playerBDiscard.game.currentTurn, 'player');
  assert.equal(playerBDiscard.game.playerHand.length, 9);
  assert.equal(playerBDiscard.game.opponentHand.length, 9);
  assertStableCardSet(game, playerBDiscard.game, 'multiplayer local');
});

runTest('multiplayer local permite Jogador B pegar descarte do Jogador A', () => {
  const game = createMatchState({ scenarioKey: 'invalid' });
  const playerADraw = drawFromStockForActor(game, 'player', { handMode: 'manual' });
  const playerADiscard = discardFromHandForActor(
    playerADraw.game,
    'player',
    playerADraw.game.playerHand[0].id,
    { handMode: 'manual' },
  );
  const playerBTakeDiscard = takeFromDiscardForActor(playerADiscard.game, 'bot', { handMode: 'manual' });

  assert.equal(playerBTakeDiscard.blocked, false);
  assert.equal(playerBTakeDiscard.game.currentTurn, 'bot');
  assert.equal(playerBTakeDiscard.game.turnStage, 'awaiting-discard');
  assert.equal(playerBTakeDiscard.game.opponentHand.length, 10);
  assertStableCardSet(playerADiscard.game, playerBTakeDiscard.game, 'multiplayer local descarte');
});

runTest('multiplayer local valida bater e timeout por ator', () => {
  const botWinning = { ...createMatchState({ scenarioKey: 'DEBUG_BOT_WIN' }), currentTurn: 'bot' };
  const botKnockResult = getKnockResultForActor(botWinning, 'bot');
  const botKnock = knockForActor(botWinning, 'bot');
  const botTimeout = timeoutForActor({ ...createMatchState({ scenarioKey: 'invalid' }), currentTurn: 'bot' }, 'bot');

  assert.equal(botKnockResult.valid, true);
  assert.equal(botKnock.blocked, false);
  assert.equal(botKnock.game.result.winner, 'bot');
  assert.equal(botTimeout.blocked, false);
  assert.equal(botTimeout.game.result, null);
  assert.equal(botTimeout.game.currentTurn, 'player');
  assert.equal(botTimeout.game.turnStage, 'awaiting-draw');
});

runTest('bater invalido nao gera vitoria e bater valido nasce no motor', () => {
  const invalidGame = createMatchState({ scenarioKey: 'invalid' });
  const winningGame = createMatchState({ scenarioKey: 'DEBUG_WIN_HAND' });
  const invalidKnock = playerKnock(invalidGame);
  const winningKnock = playerKnock(winningGame);

  assert.equal(invalidKnock.blocked, true);
  assert.equal(invalidKnock.game.result, null);
  assert.equal(winningKnock.blocked, false);
  assert.equal(winningKnock.game.result.winner, 'player');
});

runTest('timeout gera jogada automatica sem encerrar a partida', () => {
  const timeoutAction = playerTimeout(createMatchState({ scenarioKey: 'DEBUG_TIMEOUT' }));

  assert.equal(timeoutAction.blocked, false);
  assert.equal(timeoutAction.game.result, null);
  assert.equal(timeoutAction.game.playerHand.length, 9);
  assert.equal(timeoutAction.game.currentTurn, 'bot');
  assert.equal(timeoutAction.game.turnStage, 'awaiting-draw');
  assert.ok(timeoutAction.discardedCard);
});

runTest('compra que completa jogo libera bater mesmo com carta solta', () => {
  const game = createMatchState({ scenarioKey: 'near-win-player' });
  const drawAction = drawFromStock(game, { handMode: 'auto' });
  const knockValidation = getPlayerKnockResult(drawAction.game);
  const knockAction = playerKnock(drawAction.game);

  assert.equal(drawAction.blocked, false);
  assert.equal(drawAction.drawnCard.id, cards['J-diamonds'].id);
  assert.equal(drawAction.game.playerHand.length, 10);
  assert.equal(drawAction.game.turnStage, 'awaiting-discard');
  assert.equal(knockValidation.valid, true);
  assert.equal(knockAction.blocked, false);
  assert.equal(knockAction.game.result.winner, 'player');
  assertStableCardSet(game, drawAction.game, 'loop completo compra');
});

runTest('loop compra, descarte, troca turno e bot devolve para jogador', () => {
  const game = createMatchState({ scenarioKey: 'invalid' });
  const drawAction = drawFromStock(game, { handMode: 'manual' });
  const discardAction = discardFromPlayerHand(drawAction.game, drawAction.game.playerHand[0].id, {
    handMode: 'manual',
  });
  const botAction = planBotTurn(discardAction.game);

  assert.equal(drawAction.blocked, false);
  assert.equal(discardAction.blocked, false);
  assert.equal(discardAction.game.currentTurn, 'bot');
  assert.equal(discardAction.game.turnStage, 'awaiting-draw');
  assert.equal(botAction.blocked, false);
  assert.equal(botAction.game.currentTurn, 'player');
  assert.equal(botAction.game.turnStage, 'awaiting-draw');
  assert.equal(botAction.game.playerHand.length, 9);
  assert.equal(botAction.game.opponentHand.length, 9);
  assertStableCardSet(game, botAction.game, 'loop com bot');
});

runTest('seguranca online bloqueia compra fora da vez sem alterar estado', () => {
  const { manager, match, playerB } = createOnlineSecurityMatch();
  const beforeDeck = match.deckCount;
  const beforeHand = match.players.find((player) => player.id === playerB).hand.length;
  const result = manager.drawFromDeck(match.matchId, playerB);
  const afterMatch = manager.getOnlineMatch(match.matchId);

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'NOT_YOUR_TURN');
  assert.equal(afterMatch.deckCount, beforeDeck);
  assert.equal(afterMatch.players.find((player) => player.id === playerB).hand.length, beforeHand);
});

runTest('partida online inicia com dois baralhos e descarte inicial', () => {
  const { match } = createOnlineSecurityMatch();
  const allCards = getOnlineCards(match);
  const duplicateLogicalCards = allCards.filter((card) => card.logicalId === '7-hearts');

  assert.equal(allCards.length, 104);
  assert.equal(match.players[0].hand.length, 9);
  assert.equal(match.players[1].hand.length, 9);
  assert.equal(match.discardPile.length, 1);
  assert.equal(match.deck.length, 85);
  assert.equal(new Set(allCards.map((card) => card.id)).size, 104);
  assert.equal(allCards.some((card) => card.isJoker || card.suit === 'joker'), false);
  assert.equal(duplicateLogicalCards.length, 2);
});

runTest('timeout online apos compra descarta automaticamente e passa turno', () => {
  const { manager, match, playerA, playerB } = createOnlineSecurityMatch();
  const draw = manager.drawFromDeck(match.matchId, playerA);
  assert.equal(draw.blocked, false);

  const autoPlayed = manager.finishOnlineMatchByTimeout(match.matchId);
  const logActions = autoPlayed.matchLog.map((entry) => entry.action);

  assert.equal(autoPlayed.status, 'playing');
  assert.equal(autoPlayed.currentTurnPlayerId, playerB);
  assert.equal(autoPlayed.players.find((player) => player.id === playerA).hand.length, 9);
  assert.equal(autoPlayed.discardPile.at(-1).discardedBy, playerA);
  assert.ok(logActions.includes('timeout_started'));
  assert.equal(logActions.includes('auto_draw_from_deck'), false);
  assert.ok(logActions.includes('auto_discard'));
  assert.ok(logActions.includes('auto_turn_completed'));
});

runTest('seguranca online bloqueia descarte de carta inexistente', () => {
  const { manager, match, playerA } = createOnlineSecurityMatch();
  const draw = manager.drawFromDeck(match.matchId, playerA);
  const beforeHand = draw.gameState.players.find((player) => player.id === playerA).hand.length;
  const result = manager.discardOnlineCard(match.matchId, playerA, 'card-forged');
  const afterMatch = manager.getOnlineMatch(match.matchId);

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'INVALID_CARD');
  assert.equal(afterMatch.players.find((player) => player.id === playerA).hand.length, beforeHand);
});

runTest('seguranca online bloqueia compra dupla no mesmo turno', () => {
  const { manager, match, playerA } = createOnlineSecurityMatch();
  const first = manager.drawFromDeck(match.matchId, playerA);
  const second = manager.drawFromDeck(match.matchId, playerA);
  const afterMatch = manager.getOnlineMatch(match.matchId);

  assert.equal(first.blocked, false);
  assert.equal(second.blocked, true);
  assert.ok(['ALREADY_DREW', 'INVALID_HAND_SIZE'].includes(second.reason));
  assert.equal(afterMatch.players.find((player) => player.id === playerA).hand.length, 10);
});

runTest('seguranca online bloqueia bater invalido', () => {
  const { manager, match, playerA } = createOnlineSecurityMatch();
  const cardsOnline = getOnlineCards(match);
  const playerAHand = [
    findOnlineCard(cardsOnline, 'A', 'hearts'),
    findOnlineCard(cardsOnline, '3', 'clubs'),
    findOnlineCard(cardsOnline, '8', 'diamonds'),
    findOnlineCard(cardsOnline, 'K', 'spades'),
    findOnlineCard(cardsOnline, '2', 'hearts'),
    findOnlineCard(cardsOnline, '5', 'clubs'),
    findOnlineCard(cardsOnline, '9', 'spades'),
    findOnlineCard(cardsOnline, 'J', 'diamonds'),
    findOnlineCard(cardsOnline, 'Q', 'clubs'),
    findOnlineCard(cardsOnline, '4', 'spades'),
  ];
  const discard = findOnlineCard(cardsOnline, '10', 'hearts');
  const usedIds = new Set([...playerAHand, discard].map((item) => item.id));
  const playerBHand = getOnlineCards(match)
    .filter((card) => !usedIds.has(card.id))
    .slice(0, 9);
  setOnlineHands(manager, match.matchId, {
    playerAHand,
    playerBHand,
    discardPile: [discard],
    playerAHasDrawn: true,
  });

  const result = manager.knockOnline(match.matchId, playerA);

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'INVALID_KNOCK');
});

runTest('seguranca online aceita bater valido uma vez e bloqueia duplicado', () => {
  const { manager, match, playerA } = createOnlineSecurityMatch();
  const cardsOnline = getOnlineCards(match);
  const playerAHand = [
    findOnlineCard(cardsOnline, '3', 'diamonds'),
    findOnlineCard(cardsOnline, '3', 'hearts'),
    findOnlineCard(cardsOnline, '3', 'clubs'),
    findOnlineCard(cardsOnline, '8', 'diamonds'),
    findOnlineCard(cardsOnline, '8', 'clubs'),
    findOnlineCard(cardsOnline, '8', 'hearts'),
    findOnlineCard(cardsOnline, '6', 'spades'),
    findOnlineCard(cardsOnline, '6', 'clubs'),
    findOnlineCard(cardsOnline, '6', 'hearts'),
    findOnlineCard(cardsOnline, 'A', 'spades'),
  ];
  const usedIds = new Set(playerAHand.map((item) => item.id));
  const playerBHand = cardsOnline.filter((card) => !usedIds.has(card.id)).slice(0, 9);
  const discard = cardsOnline.find((card) => !usedIds.has(card.id) && !playerBHand.some((item) => item.id === card.id));
  setOnlineHands(manager, match.matchId, {
    playerAHand,
    playerBHand,
    discardPile: [discard],
    playerAHasDrawn: true,
  });

  const first = manager.knockOnline(match.matchId, playerA);
  const second = manager.knockOnline(match.matchId, playerA);
  const finishedMatch = manager.getOnlineMatch(match.matchId);

  assert.equal(first.blocked, false);
  assert.equal(finishedMatch.status, 'finished');
  assert.equal(finishedMatch.result.winnerId, playerA);
  assert.equal(finishedMatch.economicResult.finishReason, 'beat');
  assert.equal(second.blocked, true);
  assert.equal(second.reason, 'MATCH_ALREADY_FINISHED');
});

runTest('seguranca online registra vitoria por abandono', () => {
  const { manager, match, playerA, playerB } = createOnlineSecurityMatch();
  const finished = manager.finishOnlineMatchByDisconnect(match.matchId, playerB);

  assert.equal(finished.status, 'finished');
  assert.equal(finished.result.winnerId, playerA);
  assert.equal(finished.result.loserId, playerB);
  assert.equal(finished.result.reason, 'disconnect');
  assert.equal(finished.economicResult.finishReason, 'disconnect');
});

runTest('seguranca online detecta carta duplicada e pausa partida', () => {
  const { manager, match, playerA } = createOnlineSecurityMatch();
  const game = manager.getOnlineMatch(match.matchId);
  const duplicate = game.players[0].hand[0];
  const corrupted = {
    ...game,
    players: game.players.map((player, index) => ({
      ...player,
      hand: index === 1 ? [duplicate, ...player.hand.slice(1)] : player.hand,
      handCount: player.hand.length,
    })),
  };
  manager.matches.set(match.matchId, corrupted);

  const result = manager.drawFromDeck(match.matchId, playerA);
  const paused = manager.getOnlineMatch(match.matchId);

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'MATCH_INTEGRITY_ERROR');
  assert.equal(paused.status, 'paused');
});

runTest('historico online salva partida finalizada sem duplicar', () => {
  const { manager, match, playerA } = createOnlineSecurityMatch();
  const cardsOnline = getOnlineCards(match);
  const playerAHand = [
    findOnlineCard(cardsOnline, '3', 'diamonds'),
    findOnlineCard(cardsOnline, '3', 'hearts'),
    findOnlineCard(cardsOnline, '3', 'clubs'),
    findOnlineCard(cardsOnline, '8', 'diamonds'),
    findOnlineCard(cardsOnline, '8', 'clubs'),
    findOnlineCard(cardsOnline, '8', 'hearts'),
    findOnlineCard(cardsOnline, '6', 'spades'),
    findOnlineCard(cardsOnline, '6', 'clubs'),
    findOnlineCard(cardsOnline, '6', 'hearts'),
    findOnlineCard(cardsOnline, 'A', 'spades'),
  ];
  const usedIds = new Set(playerAHand.map((item) => item.id));
  const playerBHand = cardsOnline.filter((card) => !usedIds.has(card.id)).slice(0, 9);
  const discard = cardsOnline.find((card) => !usedIds.has(card.id) && !playerBHand.some((item) => item.id === card.id));
  setOnlineHands(manager, match.matchId, {
    playerAHand,
    playerBHand,
    discardPile: [discard],
    playerAHasDrawn: true,
  });

  const knock = manager.knockOnline(match.matchId, playerA);
  const firstHistory = manager.listMatchHistory().filter((record) => record.matchId === match.matchId);
  manager.createMatchHistory(knock.gameState);
  const secondHistory = manager.listMatchHistory().filter((record) => record.matchId === match.matchId);
  const audit = manager.getMatchAudit(match.matchId);

  assert.equal(knock.blocked, false);
  assert.equal(firstHistory.length, 1);
  assert.equal(secondHistory.length, 1);
  assert.equal(firstHistory[0].finishReason, 'beat');
  assert.equal(firstHistory[0].winnerId, playerA);
  assert.equal(firstHistory[0].winnerPrize, 3.6);
  assert.ok(audit.logs.length >= 1);
  assert.equal('hand' in audit.logs[0].payloadResumo, false);
});

runTest('historico online registra jogada automatica por timeout e abandono com motivo correto', () => {
  const timeoutSetup = createOnlineSecurityMatch();
  const timeoutMatch = timeoutSetup.manager.finishOnlineMatchByTimeout(timeoutSetup.match.matchId);
  const timeoutRecord = timeoutSetup.manager.listMatchHistory()
    .find((record) => record.matchId === timeoutSetup.match.matchId);
  const timeoutLog = timeoutMatch.matchLog.map((entry) => entry.action);

  const disconnectSetup = createOnlineSecurityMatch();
  const disconnectMatch = disconnectSetup.manager.finishOnlineMatchByDisconnect(
    disconnectSetup.match.matchId,
    disconnectSetup.playerB,
  );
  const disconnectRecord = disconnectSetup.manager.listMatchHistory()
    .find((record) => record.matchId === disconnectSetup.match.matchId);

  assert.equal(timeoutMatch.status, 'playing');
  assert.equal(timeoutRecord, undefined);
  assert.ok(timeoutLog.includes('timeout_started'));
  assert.ok(timeoutLog.includes('auto_draw_from_deck'));
  assert.ok(timeoutLog.includes('auto_discard'));
  assert.ok(timeoutLog.includes('auto_turn_completed'));
  assert.equal(disconnectMatch.status, 'finished');
  assert.equal(disconnectRecord.finishReason, 'disconnect');
});

runTest('admin encerra partida e salva historico com auditoria', () => {
  const { manager, match } = createOnlineSecurityMatch();
  const result = manager.adminEndMatch(match.matchId, 'stuck_match');
  const record = manager.listMatchHistory().find((item) => item.matchId === match.matchId);
  const audit = manager.getMatchAudit(match.matchId);

  assert.equal(result.blocked, false);
  assert.equal(result.gameState.status, 'finished');
  assert.equal(record.finishReason, 'stuck_match');
  assert.equal(audit.logs.some((entry) => entry.action === 'admin_end_match'), true);
});

runTest('admin forca vencedor valido e rejeita vencedor externo', () => {
  const { manager, match, playerA } = createOnlineSecurityMatch();
  const invalid = manager.adminForceWinner(match.matchId, 'player-forged', 'admin_decision');
  const valid = manager.adminForceWinner(match.matchId, playerA, 'admin_decision');
  const record = manager.listMatchHistory().find((item) => item.matchId === match.matchId);

  assert.equal(invalid.blocked, true);
  assert.equal(invalid.reason, 'PLAYER_NOT_IN_MATCH');
  assert.equal(valid.blocked, false);
  assert.equal(valid.gameState.result.winnerId, playerA);
  assert.equal(record.finishReason, 'admin_decision');
});

runTest('sair da partida online registra abandono e vencedor adversario', () => {
  const { manager, match, playerA, playerB } = createOnlineSecurityMatch();
  const result = manager.surrenderOnlineMatch(match.matchId, playerA);
  const record = manager.listMatchHistory().find((item) => item.matchId === match.matchId);
  const audit = manager.getMatchAudit(match.matchId);

  assert.equal(result.blocked, false);
  assert.equal(result.gameState.status, 'finished');
  assert.equal(result.gameState.result.winnerId, playerB);
  assert.equal(result.gameState.result.loserId, playerA);
  assert.equal(result.gameState.result.reason, 'surrender');
  assert.equal(record.finishReason, 'surrender');
  assert.equal(audit.logs.some((entry) => entry.action === 'player_surrender'), true);
});

runTest('historico da partida atual envia apenas acoes publicas ao cliente', () => {
  const { manager, match, playerA } = createOnlineSecurityMatch();
  const draw = manager.drawFromDeck(match.matchId, playerA);
  const drawnCard = draw.gameState.players.find((player) => player.id === playerA).hand[9];
  const discard = manager.discardOnlineCard(match.matchId, playerA, drawnCard.id);
  const payload = buildClientGameState(discard.gameState, playerA);

  assert.equal(payload.matchLog.some((entry) => entry.action === 'playerDrawFromDeck'), true);
  const discardEntry = payload.matchLog.find((entry) => entry.action === 'playerDiscardCard');
  assert.ok(discardEntry);
  assert.equal(discardEntry.payload.card.rank, drawnCard.rank);
  assert.equal('hand' in discardEntry.payload, false);
  assert.equal(JSON.stringify(payload.matchLog).includes('deck'), true);
});

const passed = results.filter((result) => result.status === 'PASS').length;
const failed = results.length - passed;

if (shouldWriteReport) {
  const rows = results
    .map((result) => `| ${result.status} | ${result.name} | ${result.detail.replaceAll('|', '/')} |`)
    .join('\n');
  const report = [
    '# Relatorio de Testes - Pife Duelo',
    '',
    `Gerado em: ${new Date().toLocaleString('pt-BR')}`,
    '',
    `Resumo: ${passed} passando, ${failed} falhando.`,
    '',
    '| Status | Teste | Detalhe |',
    '| --- | --- | --- |',
    rows,
    '',
    'Comandos debug disponiveis:',
    '- npm run DEBUG_WIN_HAND',
    '- npm run DEBUG_BOT_WIN',
    '- npm run DEBUG_RECYCLE',
    '- npm run DEBUG_TIMEOUT',
    '- npm run DEBUG_INVALID_HAND',
    '- npm run MULTIPLAYER_LOCAL',
    '',
  ].join('\n');

  await writeFile(reportPath, report, 'utf8');
}

if (failed > 0) {
  console.error(`${failed} teste(s) falharam.`);
  process.exit(1);
}

console.log(`Todos os testes automatizados do Pife Duelo passaram. (${passed}/${results.length})`);
if (shouldWriteReport) {
  console.log(`Relatorio gerado em ${reportPath.pathname}`);
}
