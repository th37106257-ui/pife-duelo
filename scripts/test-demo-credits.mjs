import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DemoCreditsRepository } from '../server/src/demoCredits/DemoCreditsRepository.js';
import { DemoCreditsService } from '../server/src/demoCredits/DemoCreditsService.js';
import { assertBetaFakeMoneySafety } from '../server/src/demoCredits/betaFakeMoneySafety.js';
import { resolveFinancialConfig } from '../server/src/financial/financialConfig.js';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';
import { MatchQueue } from '../server/src/services/matchQueue.js';
import { createPostMatchFlow } from '../server/src/services/postMatchFlow.js';
import { WhatsAppPaymentBot } from '../server/src/payments/WhatsAppPaymentBot.js';
import { RoomManager } from '../server/src/managers/RoomManager.js';
import { MatchManager } from '../server/src/managers/MatchManager.js';
import { PlayerManager } from '../server/src/managers/PlayerManager.js';
import { QueueManager } from '../server/src/managers/QueueManager.js';
import { SocketManager } from '../server/src/managers/SocketManager.js';
import { setupSocketServer } from '../server/src/socket/index.js';
import { io as connectSocket } from 'socket.io-client';
import {
  demoCreditsExplanation,
  mainMenu,
  tablesMenu,
  waitingForOpponent,
} from '../server/src/services/whatsappMessages.js';

const phones = [
  '5521990000001',
  '5521990000002',
  '5521990000003',
  '5521990000004',
  '5521990000005',
  '5521990000006',
  '5521990000007',
  '5521990000008',
];

function createService({ repository = new DemoCreditsRepository(), enabled = true, startingBalance = 100 } = {}) {
  return new DemoCreditsService({ repository, enabled, startingBalance, historyLimit: 50 });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.message === code);
}

const service = createService();

// Concessão inicial e consulta idempotente.
const initial = service.getBalance(phones[0]);
assert.equal(initial.availableBalance, 100);
assert.equal(initial.initialGrantApplied, true);
assert.equal(service.getBalance(phones[0]).initialGrantApplied, false);
assert.equal(service.getHistory(phones[0]).filter((event) => event.type === 'DEMO_INITIAL_GRANT').length, 1);

// Reserva, duplicidade, bloqueio simultâneo e liberação.
const referenceOne = { publicReference: 'DEMO-ENTRY-E1', entryId: 'E1', tableId: 5 };
const reserved = service.reserveCredits(phones[0], 5, referenceOne);
assert.equal(reserved.account.availableBalance, 95);
assert.equal(reserved.account.reservedBalance, 5);
assert.equal(service.reserveCredits(phones[0], 5, referenceOne).duplicate, true);
expectCode(() => service.reserveCredits(phones[0], 10, {
  publicReference: 'DEMO-ENTRY-E2', entryId: 'E2', tableId: 10,
}), 'DEMO_ACTIVE_RESERVATION_EXISTS');
assert.equal(service.releaseReservation(phones[0], referenceOne, 'queue_cancelled').released, true);
assert.equal(service.releaseReservation(phones[0], referenceOne, 'queue_cancelled').duplicate, true);
assert.equal(service.getBalance(phones[0]).availableBalance, 100);
assert.equal(service.getBalance(phones[0]).reservedBalance, 0);

// Saldo insuficiente nunca produz valor negativo.
const lowBalance = createService({ startingBalance: 2 });
expectCode(() => lowBalance.reserveCredits(phones[1], 5, {
  publicReference: 'DEMO-LOW', entryId: 'LOW', tableId: 5,
}), 'DEMO_INSUFFICIENT_CREDITS');
assert.equal(lowBalance.getBalance(phones[1]).availableBalance, 2);

// Consumo atômico dos dois participantes no MATCH_STARTED.
for (const [phone, entryId] of [[phones[2], 'E3'], [phones[3], 'E4']]) {
  service.reserveCredits(phone, 5, { publicReference: `DEMO-${entryId}`, entryId, tableId: 5 });
}
const participants = [
  { playerId: phones[2], entryId: 'E3', matchPlayerId: 'P3' },
  { playerId: phones[3], entryId: 'E4', matchPlayerId: 'P4' },
];
assert.equal(service.consumeMatchReservations(participants, { matchId: 'MATCH-1', tableId: 5 }).operations.length, 2);
assert.equal(service.getBalance(phones[2]).reservedBalance, 0);
assert.equal(service.getBalance(phones[2]).availableBalance, 95);
assert.equal(service.consumeMatchReservations(participants, { matchId: 'MATCH-1', tableId: 5 }).duplicate, true);

// Recompensa fictícia e resultado duplicado.
const rewardReference = { publicReference: 'DEMO-MATCH-1', matchId: 'MATCH-1', tableId: 5, entryId: 'E3' };
assert.equal(service.rewardWinner(phones[2], 9, rewardReference, { platformFee: 1 }).account.availableBalance, 104);
assert.equal(service.rewardWinner(phones[2], 9, rewardReference).duplicate, true);
assert.equal(service.getBalance(phones[2]).availableBalance, 104);
assert.equal(service.getHistory(phones[2]).filter((event) => event.type === 'DEMO_PLATFORM_FEE').length, 1);

// SYSTEM_ABORT compensa os dois uma única vez.
for (const [phone, entryId] of [[phones[4], 'E5'], [phones[5], 'E6']]) {
  service.reserveCredits(phone, 10, { publicReference: `DEMO-${entryId}`, entryId, tableId: 10 });
}
const abortedParticipants = [
  { playerId: phones[4], entryId: 'E5', matchPlayerId: 'P5' },
  { playerId: phones[5], entryId: 'E6', matchPlayerId: 'P6' },
];
service.consumeMatchReservations(abortedParticipants, { matchId: 'MATCH-ABORT', tableId: 10 });
const compensated = service.settleMatchResult({
  matchId: 'MATCH-ABORT', tableId: 10, reason: 'SYSTEM_ABORT', participants: abortedParticipants,
});
assert.equal(compensated.compensated.length, 2);
assert.equal(service.getBalance(phones[4]).availableBalance, 100);
assert.equal(service.getBalance(phones[5]).availableBalance, 100);
assert.ok(service.settleMatchResult({
  matchId: 'MATCH-ABORT', tableId: 10, reason: 'SYSTEM_ABORT', participants: abortedParticipants,
}).compensated.every((item) => item.duplicate));
expectCode(() => service.rewardWinner(phones[0], 9, {
  publicReference: 'DEMO-UNAUTHORIZED-REWARD',
  matchId: 'MATCH-NOT-CONSUMED',
  tableId: 5,
  entryId: 'UNKNOWN',
}), 'DEMO_MATCH_REWARD_NOT_AUTHORIZED');

// Encerramento sem vencedor também compensa, mesmo com outro motivo administrativo/sistêmico.
for (const [phone, entryId] of [[phones[6], 'E7'], [phones[7], 'E8']]) {
  service.reserveCredits(phone, 20, { publicReference: `DEMO-${entryId}`, entryId, tableId: 20 });
}
const noWinnerParticipants = [
  { playerId: phones[6], entryId: 'E7', matchPlayerId: 'P7' },
  { playerId: phones[7], entryId: 'E8', matchPlayerId: 'P8' },
];
service.consumeMatchReservations(noWinnerParticipants, { matchId: 'MATCH-NO-WINNER', tableId: 20 });
const noWinnerSettlement = service.settleMatchResult({
  matchId: 'MATCH-NO-WINNER',
  tableId: 20,
  reason: 'admin_closed',
  participants: noWinnerParticipants,
});
assert.equal(noWinnerSettlement.compensated.length, 2);
assert.equal(service.getBalance(phones[6]).availableBalance, 100);
assert.equal(service.getBalance(phones[7]).availableBalance, 100);

// Operações administrativas sempre passam pelo ledger.
const grant = service.adminGrantCredits(phones[1], 50, 'beta fechado', phones[0], 'whatsapp:grant-1');
assert.equal(grant.previousBalance, 100);
assert.equal(grant.account.availableBalance, 150);
const repeatedGrant = service.adminGrantCredits(phones[1], 50, 'beta fechado', phones[0], 'whatsapp:grant-1');
assert.equal(repeatedGrant.duplicate, true);
assert.equal(repeatedGrant.account.availableBalance, 150);
const testCreditEvent = service.getHistory(phones[1]).find((event) => event.type === 'DEMO_ADMIN_GRANT');
assert.equal(testCreditEvent.origin, 'TEST_CREDIT');
assert.equal(testCreditEvent.withdrawable, false);
assert.equal(testCreditEvent.convertibleToRealMoney, false);
expectCode(() => service.adminGrantCredits(phones[1], -1, 'inválido', phones[0]), 'DEMO_INVALID_AMOUNT');
expectCode(() => service.adminGrantCredits(phones[1], 1.5, 'inválido', phones[0]), 'DEMO_AMOUNT_MUST_BE_INTEGER');
expectCode(() => service.adminGrantCredits(phones[1], 1, '', phones[0]), 'DEMO_ADMIN_REASON_REQUIRED');
const ledgerBeforeReset = service.getHistory(phones[1]).length;
assert.equal(service.adminResetDemoAccount(phones[1], 'reinício controlado', phones[0]).account.availableBalance, 100);
assert.ok(service.getHistory(phones[1]).length > ledgerBeforeReset);

// Reset é bloqueado enquanto existe reserva ativa.
const resetReference = { publicReference: 'DEMO-RESET-BLOCK', entryId: 'RESET-BLOCK', tableId: 2 };
service.reserveCredits(phones[1], 2, resetReference);
expectCode(() => service.adminResetDemoAccount(phones[1], 'não pode', phones[0]), 'DEMO_ACCOUNT_HAS_ACTIVE_RESERVATION');
service.releaseReservation(phones[1], resetReference);

// Persistência e recuperação após reinício.
const directory = mkdtempSync(join(tmpdir(), 'pife-demo-credits-'));
try {
  const filePath = join(directory, 'state.json');
  const firstProcess = createService({ repository: new DemoCreditsRepository({ filePath }) });
  firstProcess.reserveCredits(phones[0], 20, { publicReference: 'DEMO-PERSIST', entryId: 'PERSIST', tableId: 20 });
  const secondProcess = createService({ repository: new DemoCreditsRepository({ filePath }) });
  assert.equal(secondProcess.getBalance(phones[0]).availableBalance, 80);
  assert.equal(secondProcess.getBalance(phones[0]).reservedBalance, 20);
  assert.equal(secondProcess.getHistory(phones[0]).filter((event) => event.type === 'DEMO_ENTRY_RESERVED').length, 1);

  const invalidPath = join(directory, 'invalid.json');
  writeFileSync(invalidPath, '{invalid', 'utf8');
  assert.throws(() => new DemoCreditsRepository({ filePath: invalidPath }), /DEMO_CREDITS_STORE_INVALID/);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

// Flag desligada mantém o estado atual sem conta ou bloqueio.
const disabledRepository = new DemoCreditsRepository();
const disabled = createService({ repository: disabledRepository, enabled: false });
expectCode(() => disabled.getBalance(phones[0]), 'DEMO_CREDITS_DISABLED');
expectCode(() => disabled.reserveCredits(phones[0], 2, { publicReference: 'OFF', entryId: 'OFF', tableId: 2 }), 'DEMO_CREDITS_DISABLED');
assert.equal(Object.keys(disabledRepository.snapshot().accounts).length, 0);
assert.equal(disabledRepository.snapshot().ledger.length, 0);

// A flag beta falha fechada se qualquer capacidade financeira real estiver ativa.
const safeFinancialConfig = resolveFinancialConfig({
  FINANCIAL_WALLET_ENABLED: 'false',
  PIX_DEPOSITS_ENABLED: 'false',
  REAL_MONEY_GAMES_ENABLED: 'false',
  WITHDRAWALS_ENABLED: 'false',
  AUTO_WITHDRAWALS_ENABLED: 'false',
});
assert.equal(assertBetaFakeMoneySafety({ enabled: true, financialConfig: safeFinancialConfig }), true);
for (const unsafe of [
  { realMoneyGamesEnabled: true },
  { withdrawalsEnabled: true },
  { autoWithdrawalsEnabled: true },
  { enabled: true },
  { pixDepositsEnabled: true },
]) {
  assert.throws(() => assertBetaFakeMoneySafety({
    enabled: true,
    financialConfig: { ...safeFinancialConfig, ...unsafe },
  }), /BETA_REQUIRES_/);
}

// Duas partidas simultâneas permanecem isoladas; identidade e vencedor forjados falham fechados.
const parallelService = createService();
const parallelMatches = [
  {
    matchId: 'MATCH-PARALLEL-A',
    participants: [
      { playerId: phones[0], entryId: 'PA1', matchPlayerId: 'PLAYER-A1' },
      { playerId: phones[1], entryId: 'PA2', matchPlayerId: 'PLAYER-A2' },
    ],
  },
  {
    matchId: 'MATCH-PARALLEL-B',
    participants: [
      { playerId: phones[2], entryId: 'PB1', matchPlayerId: 'PLAYER-B1' },
      { playerId: phones[3], entryId: 'PB2', matchPlayerId: 'PLAYER-B2' },
    ],
  },
];
for (const match of parallelMatches) {
  for (const participant of match.participants) {
    parallelService.reserveCredits(participant.playerId, 5, {
      publicReference: `DEMO-${participant.entryId}`,
      entryId: participant.entryId,
      tableId: 5,
    });
  }
  parallelService.consumeMatchReservations(match.participants, { matchId: match.matchId, tableId: 5 });
}
expectCode(() => parallelService.settleMatchResult({
  matchId: parallelMatches[0].matchId,
  tableId: 5,
  winnerMatchPlayerId: 'FORGED-WINNER',
  participants: parallelMatches[0].participants,
}), 'DEMO_FORGED_WINNER_REJECTED');
expectCode(() => parallelService.settleMatchResult({
  matchId: parallelMatches[0].matchId,
  tableId: 5,
  winnerMatchPlayerId: 'PLAYER-A1',
  participants: [
    { ...parallelMatches[0].participants[0], matchPlayerId: 'PLAYER-A2' },
    { ...parallelMatches[0].participants[1], matchPlayerId: 'PLAYER-A1' },
  ],
}), 'DEMO_FORGED_IDENTITY_REJECTED');
const parallelASettlement = parallelService.settleMatchResult({
  matchId: parallelMatches[0].matchId,
  tableId: 5,
  winnerMatchPlayerId: 'PLAYER-A1',
  participants: parallelMatches[0].participants,
});
assert.equal(parallelASettlement.rewardAmount, 9);
assert.equal(parallelASettlement.platformFeeAmount, 1);
assert.equal(parallelService.getBalance(phones[0]).availableBalance, 104);
assert.equal(parallelService.getBalance(phones[2]).availableBalance, 95);
parallelService.settleMatchResult({
  matchId: parallelMatches[1].matchId,
  tableId: 5,
  winnerMatchPlayerId: 'PLAYER-B2',
  participants: parallelMatches[1].participants,
});
const duplicateParallelSettlement = parallelService.settleMatchResult({
  matchId: parallelMatches[0].matchId,
  tableId: 5,
  winnerMatchPlayerId: 'PLAYER-A1',
  participants: parallelMatches[0].participants,
});
assert.equal(duplicateParallelSettlement.rewarded.duplicate, true);
assert.equal(parallelService.getHistory(phones[0]).filter((event) => event.type === 'DEMO_MATCH_REWARD').length, 1);
assert.equal(parallelService.getHistory(phones[0]).filter((event) => event.type === 'DEMO_PLATFORM_FEE').length, 1);

// Integração real da fila: reserva ao entrar e devolução ao cancelar/expirar.
const insufficientQueueCredits = createService({ startingBalance: 2 });
const insufficientEntryService = new WhatsAppEntryService({
  store: new WhatsAppEntryStore(),
  adminNumbers: [phones[0]],
  accessSecret: 'demo-insufficient-entry-secret',
  publicGameUrl: 'https://pife.example',
});
const insufficientQueue = new MatchQueue({
  entryService: insufficientEntryService,
  demoCreditsService: insufficientQueueCredits,
});
const insufficientJoin = await insufficientQueue.joinQueue(phones[0], 5);
assert.equal(insufficientJoin.blocked, true);
assert.equal(insufficientJoin.reason, 'DEMO_INSUFFICIENT_CREDITS');
assert.equal(insufficientJoin.availableBalance, 2);
assert.equal(insufficientEntryService.getActiveEntryForPhone(phones[0]), null);
assert.equal(insufficientQueue.getQueueStatus(5).waitingPlayers, 0);
assert.equal(insufficientQueueCredits.getBalance(phones[0]).reservedBalance, 0);

const failedQueueCredits = createService();
const failedQueueEntryService = new WhatsAppEntryService({
  store: new WhatsAppEntryStore(),
  adminNumbers: [phones[0]],
  accessSecret: 'demo-failed-queue-entry-secret',
  publicGameUrl: 'https://pife.example',
});
failedQueueEntryService.markWhatsAppQueueWaiting = () => {
  throw new Error('ENTRY_STORE_UNAVAILABLE');
};
const failedQueue = new MatchQueue({
  entryService: failedQueueEntryService,
  demoCreditsService: failedQueueCredits,
});
const failedJoin = await failedQueue.joinQueue(phones[0], 5);
assert.equal(failedJoin.blocked, true);
assert.equal(failedJoin.reason, 'ENTRY_STORE_UNAVAILABLE');
assert.equal(failedQueue.getQueueStatus(5).waitingPlayers, 0);
assert.equal(failedQueueCredits.getBalance(phones[0]).availableBalance, 100);
assert.equal(failedQueueCredits.getBalance(phones[0]).reservedBalance, 0);
assert.equal(failedQueueCredits.getHistory(phones[0]).filter((event) => event.type === 'DEMO_ENTRY_RELEASED').length, 1);

let duplicateReleaseCalls = 0;
const duplicateEntryService = new WhatsAppEntryService({
  store: new WhatsAppEntryStore(),
  adminNumbers: [phones[0]],
  accessSecret: 'demo-duplicate-retry-entry-secret',
  publicGameUrl: 'https://pife.example',
});
duplicateEntryService.markWhatsAppQueueWaiting = () => {
  throw new Error('ENTRY_STORE_UNAVAILABLE');
};
const duplicateQueue = new MatchQueue({
  entryService: duplicateEntryService,
  demoCreditsService: {
    isEnabled: () => true,
    getBalance: () => ({ availableBalance: 100 }),
    reserveCredits: () => ({ duplicate: true }),
    releaseReservation: () => { duplicateReleaseCalls += 1; },
  },
});
assert.equal((await duplicateQueue.joinQueue(phones[0], 5)).blocked, true);
assert.equal(duplicateReleaseCalls, 0);
assert.equal(duplicateEntryService.getActiveEntryForPhone(phones[0])?.status, 'approved_for_queue');

const queueCredits = createService();
const entryStore = new WhatsAppEntryStore();
const entryService = new WhatsAppEntryService({
  store: entryStore,
  adminNumbers: [phones[0]],
  accessSecret: 'demo-credits-entry-secret',
  publicGameUrl: 'https://pife.example',
});
const queue = new MatchQueue({ entryService, demoCreditsService: queueCredits, preMatchTimeoutSeconds: 60 });
assert.equal((await queue.joinQueue(phones[0], 5, { replyTo: phones[0] })).blocked, false);
assert.equal(queueCredits.getBalance(phones[0]).availableBalance, 95);
assert.equal(queueCredits.getBalance(phones[0]).reservedBalance, 5);
assert.equal((await queue.clearPlayerState(phones[0], { actor: phones[0], reason: 'test_cancel' })).cleared, true);
assert.equal(queueCredits.getBalance(phones[0]).availableBalance, 100);

const first = await queue.joinQueue(phones[0], 5, { replyTo: phones[0] });
const second = await queue.joinQueue(phones[1], 5, { replyTo: phones[1] });
assert.equal(first.match, null);
assert.ok(second.match?.matchId);
assert.equal(queueCredits.getBalance(phones[0]).reservedBalance, 5);
assert.equal(queueCredits.getBalance(phones[1]).reservedBalance, 5);
assert.equal((await queue.abortMatchAndReleaseParticipants({
  matchId: second.match.matchId, reason: 'queue_timeout_before_start',
})).aborted, true);
assert.equal(queueCredits.getBalance(phones[0]).availableBalance, 100);
assert.equal(queueCredits.getBalance(phones[1]).availableBalance, 100);

// E2E beta: WhatsApp -> Safe Entry -> MATCH_STARTED -> reconnect -> settlement.
const e2eCredits = createService();
const e2eEntryService = new WhatsAppEntryService({
  store: new WhatsAppEntryStore(),
  adminNumbers: [phones[0]],
  accessSecret: 'beta-fake-money-e2e-entry-secret',
  publicGameUrl: 'http://127.0.0.1',
});
const e2eQueue = new MatchQueue({ entryService: e2eEntryService, demoCreditsService: e2eCredits });
const e2eSent = [];
const e2eBot = new WhatsAppPaymentBot({
  entryService: e2eEntryService,
  matchQueue: e2eQueue,
  demoCreditsService: e2eCredits,
  safeEntryEnabled: true,
  paymentsEnabled: false,
  adminNumbers: [phones[0]],
  evolutionClient: {
    isConfigured: () => true,
    sendWhatsAppMessage: async (target, text) => {
      e2eSent.push({ target, text });
      return { ok: true, sent: true };
    },
  },
});
const e2eRoomManager = new RoomManager();
const e2eMatchManager = new MatchManager();
const e2ePlayerManager = new PlayerManager();
const e2eSocketManager = new SocketManager({ playerManager: e2ePlayerManager });
const e2eQueueManager = new QueueManager();
const e2ePostMatchFlow = createPostMatchFlow({
  entryService: e2eEntryService,
  whatsappBot: e2eBot,
  whatsappMatchQueue: e2eQueue,
  demoCreditsService: e2eCredits,
  whatsappEnabled: false,
});
const e2eHttpServer = createServer((request, response) => {
  response.writeHead(404);
  response.end();
});
const e2eSocketServer = setupSocketServer(e2eHttpServer, {
  roomManager: e2eRoomManager,
  matchManager: e2eMatchManager,
  playerManager: e2ePlayerManager,
  socketManager: e2eSocketManager,
  queueManager: e2eQueueManager,
  entryService: e2eEntryService,
  safeEntryEnabled: true,
  whatsappBot: e2eBot,
  whatsappMatchQueue: e2eQueue,
  demoCreditsService: e2eCredits,
  postMatchFlow: e2ePostMatchFlow,
  corsOptions: { origin: 'http://127.0.0.1', methods: ['GET', 'POST'] },
});
const e2eClients = [];
function once(socket, eventName, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`DEMO_E2E_TIMEOUT:${eventName}`)), timeoutMs);
    socket.once(eventName, (value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}
function emitAck(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5_000).emit(eventName, payload, (error, value) => (error ? reject(error) : resolve(value)));
  });
}
async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`DEMO_E2E_WAIT_TIMEOUT:${label}`);
}
try {
  await new Promise((resolve, reject) => {
    e2eHttpServer.once('error', reject);
    e2eHttpServer.listen(0, '127.0.0.1', resolve);
  });
  const e2eBaseUrl = `http://127.0.0.1:${e2eHttpServer.address().port}`;
  e2eEntryService.publicGameUrl = e2eBaseUrl;
  e2eBot.publicGameUrl = e2eBaseUrl;
  const firstE2e = await e2eQueue.joinQueue(phones[4], 5, { replyTo: phones[4] });
  const secondE2e = await e2eQueue.joinQueue(phones[5], 5, { replyTo: phones[5] });
  assert.equal(firstE2e.blocked, false);
  assert.ok(secondE2e.match?.matchId);
  const tokenFor = (phone) => {
    const player = secondE2e.match.players.find((item) => item.sendTo === phone);
    return new URL(player.accessLink).searchParams.get('entry');
  };
  const connect = async ({ token = null, sessionKey = null, matchId }) => {
    const socket = connectSocket(e2eBaseUrl, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      auth: {
        ...(token ? { entryToken: token } : {}),
        ...(sessionKey ? { entrySessionKey: sessionKey } : {}),
        joinMatchId: matchId,
      },
    });
    e2eClients.push(socket);
    const connected = once(socket, 'connection:success');
    socket.connect();
    return { socket, connection: await connected };
  };
  const e2eA = await connect({ token: tokenFor(phones[4]), matchId: secondE2e.match.matchId });
  const e2eB = await connect({ token: tokenFor(phones[5]), matchId: secondE2e.match.matchId });
  const startedA = once(e2eA.socket, 'matchStarted');
  const startedB = once(e2eB.socket, 'matchStarted');
  assert.equal((await emitAck(e2eA.socket, 'joinQueue', { tableValue: 5, playerName: 'Beta A' })).ok, true);
  assert.equal((await emitAck(e2eB.socket, 'joinQueue', { tableValue: 5, playerName: 'Beta B' })).ok, true);
  const [stateA, stateB] = await Promise.all([startedA, startedB]);
  assert.equal(stateA.matchId, stateB.matchId);
  assert.equal(e2eCredits.getBalance(phones[4]).availableBalance, 95);
  assert.equal(e2eCredits.getBalance(phones[4]).reservedBalance, 0);
  const sessionKeyA = e2eA.connection.entryAccess.sessionKey;
  e2eA.socket.disconnect();
  const recoveredA = await connect({ sessionKey: sessionKeyA, matchId: stateA.matchId });
  const resumedState = once(recoveredA.socket, 'gameStateUpdated');
  recoveredA.socket.emit('resumeOnlineMatch', {
    matchId: stateA.matchId,
    roomId: stateA.roomId,
    playerId: stateA.you.playerId,
  });
  assert.equal((await resumedState).you.playerId, stateA.you.playerId);
  assert.equal(e2eCredits.getBalance(phones[4]).availableBalance, 95);
  const forgedIdentity = once(e2eB.socket, 'actionRejected');
  e2eB.socket.emit('resumeOnlineMatch', {
    matchId: stateA.matchId,
    roomId: stateA.roomId,
    playerId: stateA.you.playerId,
  });
  assert.equal((await forgedIdentity).reason, 'RESUME_NOT_AUTHORIZED');
  const liveMatch = e2eMatchManager.getOnlineMatch(stateA.matchId);
  const surrender = await emitAck(e2eB.socket, 'playerSurrender', {
    matchId: stateA.matchId,
    roomId: liveMatch.roomId,
    playerId: stateB.you.playerId,
    turnNumber: liveMatch.turnNumber,
    actionId: randomUUID(),
    winnerId: stateB.you.playerId,
    prize: 999_999,
  });
  assert.equal(surrender.ok, true);
  await waitFor(() => e2eCredits.getBalance(phones[4]).availableBalance === 104, 'settlement');
  assert.equal(e2eCredits.getBalance(phones[5]).availableBalance, 95);
  assert.equal(e2eCredits.getHistory(phones[4]).filter((event) => event.type === 'DEMO_MATCH_REWARD').length, 1);
  assert.equal(e2eCredits.getHistory(phones[4]).filter((event) => event.type === 'DEMO_PLATFORM_FEE').length, 1);
} finally {
  for (const timeout of e2eQueue.pendingMatchTimeouts.values()) clearTimeout(timeout);
  e2eClients.forEach((socket) => socket.disconnect());
  await new Promise((resolve) => e2eSocketServer.close(resolve));
  if (e2eHttpServer.listening) await new Promise((resolve) => e2eHttpServer.close(resolve));
}

// Mensagens demo nunca apresentam dinheiro real e não inventam saldo ausente.
const forbiddenFinancialLanguage = /R\$|\bPix\b|\bsaque\b|pr[eê]mio real/i;
const demoMenu = mainMenu({ paymentsEnabled: false, demoCreditsEnabled: true });
const demoTables = tablesMenu({ paymentsEnabled: false, demoCreditsEnabled: true, demoBalance: 100 });
assert.doesNotMatch(demoMenu, /Créditos de Teste/i);
assert.match(demoTables, /Mesa 1/);
assert.match(demoTables, /2 Créditos de Teste/);
assert.doesNotMatch(demoMenu, forbiddenFinancialLanguage);
assert.doesNotMatch(demoTables, forbiddenFinancialLanguage);
assert.doesNotMatch(demoCreditsExplanation(), forbiddenFinancialLanguage);
const waitingWithoutBalance = waitingForOpponent({
  table: 5,
  demoCreditsEnabled: true,
  availableBalance: null,
  reservedAmount: 5,
});
assert.doesNotMatch(waitingWithoutBalance, /Saldo disponível:/i);
assert.match(waitingWithoutBalance, /Créditos reservados: 5/i);

// Atalho secundário 6, histórico, explicação e proteção administrativa no fluxo do bot.
let demoMessageSequence = 0;
function demoWebhook(phone, text) {
  demoMessageSequence += 1;
  return {
    event: 'messages.upsert',
    instance: 'pife-duelo-bot',
    data: {
      key: {
        remoteJid: `${phone}@s.whatsapp.net`,
        fromMe: false,
        id: `demo-credits-${demoMessageSequence}`,
      },
      sender: `${phone}@s.whatsapp.net`,
      message: { conversation: text },
    },
  };
}

const sentMessages = [];
const botCredits = createService();
const bot = new WhatsAppPaymentBot({
  demoCreditsService: botCredits,
  paymentsEnabled: false,
  adminNumbers: [phones[0]],
  evolutionClient: {
    isConfigured: () => true,
    sendWhatsAppMessage: async (target, text) => {
      sentMessages.push({ target, text });
      return { ok: true, sent: true };
    },
  },
});
assert.equal((await bot.handleConnectivityWebhook(demoWebhook(phones[1], 'menu'))).type, 'whatsapp_menu_sent');
assert.doesNotMatch(sentMessages.at(-1).text, /Créditos de Teste/i);
assert.equal((await bot.handleConnectivityWebhook(demoWebhook(phones[1], '6'))).type, 'demo_credits_balance_sent');
assert.match(sentMessages.at(-1).text, /MEUS CRÉDITOS DE TESTE/i);
assert.equal((await bot.handleConnectivityWebhook(demoWebhook(phones[1], '1'))).type, 'demo_credits_history_sent');
assert.match(sentMessages.at(-1).text, /HISTÓRICO RECENTE/i);
assert.equal((await bot.handleConnectivityWebhook(demoWebhook(phones[1], '2'))).type, 'demo_credits_explanation_sent');
assert.match(sentMessages.at(-1).text, /COMO FUNCIONAM OS CRÉDITOS DE TESTE/i);
const adminGrantWebhook = demoWebhook(phones[0], `admin demo conceder ${phones[3]} 10 retry-controlado`);
assert.equal((await bot.handleConnectivityWebhook(adminGrantWebhook)).duplicate, false);
assert.equal((await bot.handleConnectivityWebhook(adminGrantWebhook)).duplicate, true);
assert.equal(botCredits.getBalance(phones[3]).availableBalance, 110);
assert.equal((await bot.handleConnectivityWebhook(demoWebhook(
  phones[1],
  'sacar 5 EMAIL jogador@example.com | Jogador Teste',
))).type, 'demo_withdrawal_blocked');
assert.match(sentMessages.at(-1).text, /não podem ser sacados/i);
const denied = await bot.handleSafeEntryAdminCommand(
  phones[2],
  `admin demo conceder ${phones[4]} 10 tentativa`,
  { replyTo: phones[2] },
);
assert.equal(denied.reason, 'admin_not_authorized');
assert.match(sentMessages.at(-1).text, /não autorizado/i);
assert.equal(botCredits.getBalance(phones[4]).availableBalance, 100);
assert.equal(sentMessages.every(({ text }) => !forbiddenFinancialLanguage.test(text)), true);

console.log('Demo Credits: conta, ledger, idempotência, persistência, fila, mensagens, admin e rollback por flag validados.');
