import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFinancialConfig } from '../server/src/financial/financialConfig.js';
import { PostgresFinancialRepository } from '../server/src/financial/PostgresFinancialRepository.js';
import { FinancialWalletService } from '../server/src/financial/FinancialWalletService.js';
import { MockPaymentProvider } from '../server/src/financial/paymentProviders/MockPaymentProvider.js';
import { PostgresWhatsAppEntryAccessRepository } from '../server/src/entries/PostgresWhatsAppEntryAccessRepository.js';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';
import { PaymentStore } from '../server/src/payments/PaymentStore.js';
import { PaymentService } from '../server/src/payments/PaymentService.js';
import { WhatsAppPaymentBot } from '../server/src/payments/WhatsAppPaymentBot.js';
import { MatchQueue } from '../server/src/services/matchQueue.js';
import { createPostMatchFlow } from '../server/src/services/postMatchFlow.js';
import { RoomManager } from '../server/src/managers/RoomManager.js';
import { MatchManager } from '../server/src/managers/MatchManager.js';
import { PlayerManager } from '../server/src/managers/PlayerManager.js';
import { QueueManager } from '../server/src/managers/QueueManager.js';
import { SocketManager } from '../server/src/managers/SocketManager.js';
import { setupSocketServer } from '../server/src/socket/index.js';
import { io as connectSocket } from 'socket.io-client';

const connectionString = String(process.env.PIFE_E2E_DATABASE_URL || '').trim();
if (!connectionString) throw new Error('PIFE_E2E_DATABASE_URL_REQUIRED');
const database = new URL(connectionString);
if (database.protocol !== 'postgresql:' || database.hostname !== '127.0.0.1'
  || database.port !== '55433' || database.pathname !== '/pife_financial_e2e_test'
  || database.username !== 'pife_test') {
  throw new Error('FINANCIAL_E2E_REQUIRES_ISOLATED_LOCAL_POSTGRES');
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pife-financial-e2e-'));
const repository = new PostgresFinancialRepository({ connectionString });
const accessRepository = new PostgresWhatsAppEntryAccessRepository({ connectionString });
const webhookToken = randomBytes(32).toString('hex');
const config = resolveFinancialConfig({
  FINANCIAL_WALLET_ENABLED: 'true',
  FINANCIAL_MODE: 'sandbox',
  PAYMENT_PROVIDER: 'mock',
  PIX_DEPOSITS_ENABLED: 'true',
  REAL_MONEY_GAMES_ENABLED: 'true', // Test process only; never exported to the server environment.
  WITHDRAWALS_ENABLED: 'false',
  AUTO_WITHDRAWALS_ENABLED: 'false',
  DATABASE_URL: connectionString,
  ASAAS_WEBHOOK_TOKEN: webhookToken,
});
assert.equal(config.ready, true);
assert.equal(config.mode, 'sandbox');
assert.equal(config.provider, 'mock');
assert.equal(config.withdrawalsEnabled, false);
assert.equal(config.autoWithdrawalsEnabled, false);

const provider = new MockPaymentProvider({ webhookToken });
const sent = [];
let logicalNow = Date.now();
const financial = new FinancialWalletService({ repository, provider, config });
const entryStore = new WhatsAppEntryStore({ filePath: join(temporaryDirectory, 'entries.json') });
const entryService = new WhatsAppEntryService({
  store: entryStore,
  accessSecret: randomBytes(32).toString('hex'),
  publicGameUrl: 'http://127.0.0.1:3217',
  sharedAccessRepository: accessRepository,
  requireSharedAccessRepository: true,
});
const matchQueue = new MatchQueue({ entryService, financialWalletService: financial });
const paymentService = new PaymentService({
  store: new PaymentStore({ filePath: join(temporaryDirectory, 'payments.json') }),
  adminNumbers: [],
  accessSecret: randomBytes(32).toString('hex'),
  publicGameUrl: 'http://127.0.0.1:3217',
});
const bot = new WhatsAppPaymentBot({
  paymentService,
  entryService,
  matchQueue,
  financialWalletService: financial,
  safeEntryEnabled: true,
  paymentsEnabled: false,
  evolutionClient: {
    isConfigured: () => true,
    sendWhatsAppMessage: async (phone, text) => { sent.push({ phone, text }); return { ok: true }; },
  },
  pixKey: 'TEST-ONLY',
  pixReceiver: 'TEST-ONLY',
  adminNumbers: ['5511999900999'],
  publicGameUrl: 'http://127.0.0.1:3217',
  clock: () => logicalNow,
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {},
});
financial.setPaymentConfirmationSender(({ phone, text }) => bot.send(phone, text));
const postMatchFlow = createPostMatchFlow({
  entryService,
  whatsappBot: bot,
  whatsappMatchQueue: matchQueue,
  financialWalletService: financial,
  whatsappEnabled: true,
});
const roomManager = new RoomManager();
const matchManager = new MatchManager();
const playerManager = new PlayerManager();
const socketManager = new SocketManager({ playerManager });
const queueManager = new QueueManager();
const httpServer = createServer((request, response) => {
  response.writeHead(404);
  response.end();
});
const socketServer = setupSocketServer(httpServer, {
  roomManager, matchManager, playerManager, socketManager, queueManager,
  paymentService, entryService, safeEntryEnabled: true,
  whatsappBot: bot, whatsappMatchQueue: matchQueue,
  financialWalletService: financial, postMatchFlow,
  corsOptions: { origin: 'http://127.0.0.1', methods: ['GET', 'POST'] },
});
const clients = [];
let baseUrl;

function once(socket, eventName, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`SOCKET_EVENT_TIMEOUT:${eventName}`)), timeoutMs);
    socket.once(eventName, (value) => { clearTimeout(timeout); resolve(value); });
  });
}
async function connect({ token = null, sessionKey = null, matchId = null } = {}) {
  const socket = connectSocket(baseUrl, {
    autoConnect: false, transports: ['websocket'], reconnection: false,
    auth: {
      ...(token ? { entryToken: token } : {}),
      ...(sessionKey ? { entrySessionKey: sessionKey } : {}),
      ...(matchId ? { joinMatchId: matchId } : {}),
    },
  });
  clients.push(socket);
  const connection = once(socket, 'connection:success');
  const error = once(socket, 'connect_error').then((event) => { throw event; });
  socket.connect();
  return { socket, connection: await Promise.race([connection, error]) };
}
async function connectDenied(options) {
  const socket = connectSocket(baseUrl, {
    autoConnect: false, transports: ['websocket'], reconnection: false,
    auth: {
      ...(options.token ? { entryToken: options.token } : {}),
      ...(options.sessionKey ? { entrySessionKey: options.sessionKey } : {}),
      ...(options.matchId ? { joinMatchId: options.matchId } : {}),
    },
  });
  clients.push(socket);
  const denied = once(socket, 'connect_error');
  socket.connect();
  const error = await denied;
  socket.close();
  assert.equal(error.data?.code, 'ENTRY_ACCESS_DENIED');
}
function emitAck(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5_000).emit(eventName, payload, (error, value) => (error ? reject(error) : resolve(value)));
  });
}
async function waitFor(predicate, label, timeoutMs = 8_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`WAIT_TIMEOUT:${label}`);
}

const phones = [
  '5511999900101', '5511999900102', '5511999900103', '5511999900104',
  '5511999900105', '5511999900106', '5511999900107', '5511999900108',
  '5511999900109', '5511999900110',
];
let messageNumber = 0;
function webhook(phone, text) {
  messageNumber += 1;
  return {
    event: 'messages.upsert', instance: 'local-e2e',
    data: {
      key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: `e2e-${messageNumber}` },
      message: { conversation: text },
    },
  };
}
async function sendCommand(phone, text) {
  logicalNow += 4_000;
  return bot.handleConnectivityWebhook(webhook(phone, text), { originIp: '127.0.0.1' });
}
async function payMock(phone, amountCents, label) {
  const order = await financial.createDeposit(phone, amountCents, { idempotencyKey: `e2e:${label}:${randomUUID()}` });
  provider.markPaid(order.provider_payment_id);
  const event = { id: `e2e-event-${randomUUID()}`, event: 'PAYMENT_RECEIVED', payment: { id: order.provider_payment_id } };
  const result = await financial.processPaymentWebhook({ headers: { 'asaas-access-token': webhookToken }, payload: event });
  assert.equal(result.credited, true);
  return { order, event, result };
}
async function count(query, values = []) {
  return Number((await repository.query(query, values)).rows[0].total);
}
async function truncateTestTables() {
  const tableResult = await repository.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND (tablename LIKE 'financial_%' OR tablename='whatsapp_safe_entries') ORDER BY tablename`);
  if (!tableResult.rows.length) return;
  if (tableResult.rows.some(({ tablename }) => !/^(financial_[a-z_]+|whatsapp_safe_entries)$/.test(tablename))) {
    throw new Error('FINANCIAL_E2E_UNEXPECTED_TABLE_NAME');
  }
  const tableNames = tableResult.rows.map(({ tablename }) => `"${tablename}"`).join(', ');
  await repository.query(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE`);
}

let ownsTestDatabase = false;
try {
  await repository.initialize();
  await accessRepository.initialize();
  const tables = await repository.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND (tablename LIKE 'financial_%' OR tablename='whatsapp_safe_entries') ORDER BY tablename`);
  if (!tables.rows.length || tables.rows.some(({ tablename }) => !/^(financial_[a-z_]+|whatsapp_safe_entries)$/.test(tablename))) {
    throw new Error('FINANCIAL_E2E_UNEXPECTED_SCHEMA');
  }
  for (const { tablename } of tables.rows) {
    if (await count(`SELECT count(*)::int AS total FROM "${tablename}"`)) {
      throw new Error('FINANCIAL_E2E_DATABASE_NOT_EMPTY');
    }
  }
  ownsTestDatabase = true;
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  entryService.publicGameUrl = baseUrl;
  bot.publicGameUrl = baseUrl;
  await payMock(phones[0], 2_000, 'initial-a');
  await payMock(phones[1], 2_000, 'initial-b');
  assert.equal(Number((await financial.getAccount(phones[0])).available_balance_cents), 2_000);
  assert.equal(Number((await financial.getAccount(phones[1])).available_balance_cents), 2_000);
  assert.equal((await sendCommand(phones[0], 'menu')).type, 'whatsapp_menu_sent');
  assert.equal((await sendCommand(phones[0], 'jogar')).type, 'whatsapp_tables_sent');
  const aSelection = await sendCommand(phones[0], '2');
  assert.equal(aSelection.type, 'whatsapp_queue_joined');
  const aQueue = matchQueue.findPlayerQueue(phones[0]);
  assert.ok(aQueue?.entry?.entryId);
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE entry_id=$1 AND status='RESERVED'", [aQueue.entry.entryId]), 1);
  assert.equal((await sendCommand(phones[1], 'jogar')).type, 'whatsapp_tables_sent');
  const bSelection = await sendCommand(phones[1], '2');
  assert.equal(bSelection.type, 'whatsapp_match_created');
  const whatsappMatchId = bSelection.matchId;
  assert.ok(whatsappMatchId);
  const bEntry = entryService.getActiveEntryForPhone(phones[1]);
  assert.ok(bEntry?.entryId);
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE entry_id IN ($1,$2) AND status='RESERVED'", [aQueue.entry.entryId, bEntry.entryId]), 2);
  const accessLink = (phone) => {
    const message = sent.findLast((item) => item.phone === phone && item.text.includes('/join/'));
    const link = message?.text.match(/https?:\/\/[^\s]+/)?.[0];
    assert.ok(link, 'Safe Entry link must be delivered over the simulated WhatsApp transport.');
    return new URL(link);
  };
  const aToken = accessLink(phones[0]).searchParams.get('entry');
  const bToken = accessLink(phones[1]).searchParams.get('entry');
  const aClient = await connect({ token: aToken, matchId: whatsappMatchId });
  const bClient = await connect({ token: bToken, matchId: whatsappMatchId });
  const aMatchStarted = once(aClient.socket, 'matchStarted');
  const bMatchStarted = once(bClient.socket, 'matchStarted');
  assert.equal((await emitAck(aClient.socket, 'joinQueue', { tableValue: 20, playerName: 'E2E A' })).reason, 'ENTRY_TABLE_MISMATCH');
  assert.equal((await emitAck(aClient.socket, 'joinQueue', { tableValue: 5, playerName: 'E2E A' })).ok, true);
  assert.equal((await emitAck(bClient.socket, 'joinQueue', { tableValue: 5, playerName: 'E2E B' })).ok, true);
  const [aStart, bStart] = await Promise.all([aMatchStarted, bMatchStarted]);
  assert.equal(aStart.matchId, bStart.matchId);
  const onlineMatchId = aStart.matchId;
  const match = matchManager.getOnlineMatch(onlineMatchId);
  assert.ok(match);
  assert.equal(match.players.length, 2);
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE match_id=$1 AND status='COMMITTED'", [onlineMatchId]), 2);
  assert.equal(aStart.you.hand.length, 9);
  assert.equal(bStart.you.hand.length, 9);
  assert.equal('hand' in aStart.opponent, false);
  assert.equal('hand' in bStart.opponent, false);
  const aSessionKey = aClient.connection.entryAccess.sessionKey;
  const bSessionKey = bClient.connection.entryAccess.sessionKey;
  assert.ok(aSessionKey && bSessionKey);
  const balanceBeforeRecovery = await financial.getAccount(phones[0]);
  aClient.socket.disconnect();
  const aRecovered = await connect({ sessionKey: aSessionKey, matchId: onlineMatchId });
  assert.equal(aRecovered.connection.entryAccess.entryId, aQueue.entry.entryId);
  const resumedState = once(aRecovered.socket, 'gameStateUpdated');
  aRecovered.socket.emit('resumeOnlineMatch', { matchId: onlineMatchId, roomId: match.roomId, playerId: aStart.you.playerId });
  const resumed = await resumedState;
  assert.equal(resumed.you.playerId, aStart.you.playerId);
  assert.deepEqual(resumed.you.hand, aStart.you.hand);
  assert.equal('hand' in resumed.opponent, false);
  await connectDenied({ token: aToken, matchId: whatsappMatchId });
  await connectDenied({ sessionKey: 'incorrect-session-key', matchId: onlineMatchId });
  const crossClient = await connect({ sessionKey: bSessionKey, matchId: onlineMatchId });
  const crossRejected = once(crossClient.socket, 'actionRejected');
  crossClient.socket.emit('resumeOnlineMatch', { matchId: onlineMatchId, roomId: match.roomId, playerId: aStart.you.playerId });
  assert.equal((await crossRejected).reason, 'RESUME_NOT_AUTHORIZED');
  crossClient.socket.disconnect();
  assert.equal(Number((await financial.getAccount(phones[0])).available_balance_cents), Number(balanceBeforeRecovery.available_balance_cents));
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE match_id=$1", [onlineMatchId]), 2);
  assert.equal((await sendCommand(phones[0], 'cancelar')).type, 'whatsapp_cancel_blocked_match_started');
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE match_id=$1 AND status='COMMITTED'", [onlineMatchId]), 2);
  const surrender = await emitAck(bClient.socket, 'playerSurrender', {
    matchId: onlineMatchId, roomId: match.roomId, playerId: bStart.you.playerId,
    turnNumber: match.turnNumber, actionId: randomUUID(),
    winnerId: bStart.you.playerId, platformFeeCents: 0, prizeCents: 999_999,
  });
  assert.equal(surrender.ok, true);
  await waitFor(async () => await count("SELECT count(*)::int AS total FROM financial_match_settlements WHERE match_id=$1 AND status='SETTLED'", [onlineMatchId]) === 1, 'financial-settlement');
  await waitFor(() => sent.some((item) => item.phone === phones[0] && /venceu|vit.ria/i.test(item.text))
    && sent.some((item) => item.phone === phones[1] && /derrota|perdeu/i.test(item.text)), 'whatsapp-result');
  const aFinal = await financial.getAccount(phones[0]);
  const bFinal = await financial.getAccount(phones[1]);
  assert.equal(Number(aFinal.available_balance_cents), 2_400);
  assert.equal(Number(bFinal.available_balance_cents), 1_500);
  assert.equal(Number(aFinal.reserved_balance_cents), 0);
  assert.equal(Number(bFinal.reserved_balance_cents), 0);
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key=$1", [`match:settle:${onlineMatchId}`]), 1);
  const doubleSettlement = await financial.settleMatch({ matchId: onlineMatchId, winnerPhone: phones[0], platformFeeCents: 100 });
  assert.equal(doubleSettlement.duplicate, true);
  assert.equal(Number((await financial.getAccount(phones[0])).available_balance_cents), 2_400);
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key=$1", [`match:settle:${onlineMatchId}`]), 1);

  assert.equal((await sendCommand(phones[2], 'carteira')).type, 'financial_menu');
  assert.equal(Number((await financial.getAccount(phones[2])).available_balance_cents), 0);
  assert.equal((await sendCommand(phones[2], 'jogar')).type, 'whatsapp_tables_sent');
  assert.equal((await sendCommand(phones[2], '2')).type, 'financial_insufficient_balance');
  assert.equal(await count('SELECT count(*)::int AS total FROM financial_match_reservations WHERE account_id=(SELECT account_id FROM financial_accounts WHERE phone_normalized=$1)', [phones[2]]), 0);
  const pixMessageResult = await sendCommand(phones[2], 'depositar 5');
  assert.equal(pixMessageResult.type, 'financial_deposit_created');
  const pixOrder = (await repository.query('SELECT * FROM financial_deposits WHERE public_reference=$1', [pixMessageResult.publicReference])).rows[0];
  assert.equal(pixOrder.status, 'PENDING');
  assert.equal(Number(pixOrder.amount_cents), 500);
  assert.ok(provider.payments.has(pixOrder.provider_payment_id));
  provider.markPaid(pixOrder.provider_payment_id);
  const pixEvent = { id: `e2e-pix-${randomUUID()}`, event: 'PAYMENT_RECEIVED', payment: { id: pixOrder.provider_payment_id } };
  const confirmationsBefore = sent.filter((item) => item.phone === phones[2] && /Pagamento confirmado/i.test(item.text)).length;
  assert.equal((await financial.processPaymentWebhook({ headers: { 'asaas-access-token': webhookToken }, payload: pixEvent })).credited, true);
  assert.equal((await financial.processPaymentWebhook({ headers: { 'asaas-access-token': webhookToken }, payload: pixEvent })).duplicate, true);
  assert.equal((await financial.processPaymentWebhook({
    headers: { 'asaas-access-token': webhookToken },
    payload: { ...pixEvent, id: `e2e-pix-duplicate-${randomUUID()}` },
  })).duplicate, true);
  assert.equal(Number((await financial.getAccount(phones[2])).available_balance_cents), 500);
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_transactions WHERE transaction_type='DEPOSIT_CREDITED' AND metadata->>'depositId'=$1", [pixOrder.deposit_id]), 1);
  assert.equal(await count('SELECT count(*)::int AS total FROM financial_payment_notifications WHERE deposit_id=$1', [pixOrder.deposit_id]), 1);
  assert.equal(sent.filter((item) => item.phone === phones[2] && /Pagamento confirmado/i.test(item.text)).length - confirmationsBefore, 1);
  assert.equal((await sendCommand(phones[2], 'jogar')).type, 'whatsapp_tables_sent');
  assert.equal((await sendCommand(phones[2], '2')).type, 'whatsapp_queue_joined');
  const cQueued = matchQueue.findPlayerQueue(phones[2]);
  assert.ok(cQueued?.entry?.entryId);
  assert.equal(Number((await financial.getAccount(phones[2])).available_balance_cents), 0);
  assert.equal(Number((await financial.getAccount(phones[2])).reserved_balance_cents), 500);
  assert.equal((await sendCommand(phones[2], 'cancelar')).type, 'whatsapp_cancel_confirmation');
  assert.equal((await sendCommand(phones[2], '2')).type, 'whatsapp_queue_cancelled');
  assert.equal(Number((await financial.getAccount(phones[2])).available_balance_cents), 500);
  assert.equal(Number((await financial.getAccount(phones[2])).reserved_balance_cents), 0);
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE entry_id=$1 AND status='RELEASED'", [cQueued.entry.entryId]), 1);

  await payMock(phones[3], 500, 'double-reserve');
  const secondRepository = new PostgresFinancialRepository({ connectionString });
  const secondFinancial = new FinancialWalletService({ repository: secondRepository, provider, config });
  try {
    const raceIds = [`e2e-race-${randomUUID()}`, `e2e-race-${randomUUID()}`];
    const reservationRace = await Promise.allSettled([
      financial.reserveStake(phones[3], { amountCents: 500, entryId: raceIds[0], tableId: 5 }),
      secondFinancial.reserveStake(phones[3], { amountCents: 500, entryId: raceIds[1], tableId: 5 }),
    ]);
    assert.equal(reservationRace.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(reservationRace.filter((item) => item.status === 'rejected').length, 1);
    assert.match(reservationRace.find((item) => item.status === 'rejected').reason.message, /FINANCIAL_INSUFFICIENT_BALANCE/);
    assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE entry_id IN ($1,$2) AND status='RESERVED'", raceIds), 1);
    const winnerReservation = reservationRace.find((item) => item.status === 'fulfilled').value;
    await financial.releaseStake(winnerReservation.entry_id, 'e2e-race-cleanup');
    assert.equal(Number((await financial.getAccount(phones[3])).available_balance_cents), 500);
  } finally {
    await secondRepository.close();
  }

  await payMock(phones[8], 500, 'prestart-first');
  await payMock(phones[9], 500, 'prestart-second');
  assert.equal((await sendCommand(phones[8], 'jogar')).type, 'whatsapp_tables_sent');
  assert.equal((await sendCommand(phones[8], '2')).type, 'whatsapp_queue_joined');
  assert.equal((await sendCommand(phones[9], 'jogar')).type, 'whatsapp_tables_sent');
  const pendingPair = await sendCommand(phones[9], '2');
  assert.equal(pendingPair.type, 'whatsapp_match_created');
  const abandonedToken = accessLink(phones[8]).searchParams.get('entry');
  const pendingEntryIds = [entryService.getActiveEntryForPhone(phones[8]).entryId, entryService.getActiveEntryForPhone(phones[9]).entryId];
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE entry_id IN ($1,$2) AND status='RESERVED'", pendingEntryIds), 2);
  const matchCountBeforeAbort = matchManager.listMatches().length;
  const aborted = await matchQueue.abortMatchAndReleaseParticipants({
    matchId: pendingPair.matchId, reason: 'e2e-prestart-cancel', cancelledBy: phones[8],
  });
  assert.equal(aborted.aborted, true);
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE entry_id IN ($1,$2) AND status='RELEASED'", pendingEntryIds), 2);
  assert.equal(Number((await financial.getAccount(phones[8])).available_balance_cents), 500);
  assert.equal(Number((await financial.getAccount(phones[9])).available_balance_cents), 500);
  assert.equal(matchManager.listMatches().length, matchCountBeforeAbort);
  assert.equal(await count('SELECT count(*)::int AS total FROM financial_match_settlements WHERE match_id=$1', [pendingPair.matchId]), 0);
  await connectDenied({ token: abandonedToken, matchId: pendingPair.matchId });

  const failedRepository = {
    query: (...args) => repository.query(...args),
    transaction: async () => { throw new Error('E2E_CONTROLLED_DATABASE_UNAVAILABLE'); },
  };
  const failedFinancial = new FinancialWalletService({ repository: failedRepository, provider, config });
  const failedReserveId = `e2e-unavailable-${randomUUID()}`;
  await assert.rejects(
    failedFinancial.reserveStake(phones[2], { amountCents: 500, entryId: failedReserveId, tableId: 5 }),
    /E2E_CONTROLLED_DATABASE_UNAVAILABLE/,
  );
  assert.equal(await count('SELECT count(*)::int AS total FROM financial_match_reservations WHERE entry_id=$1', [failedReserveId]), 0);
  assert.equal(Number((await financial.getAccount(phones[2])).available_balance_cents), 500);
  const recoveryMatchId = `e2e-failure-${randomUUID()}`;
  const failureEntries = [`e2e-failure-${randomUUID()}`, `e2e-failure-${randomUUID()}`];
  await financial.reserveStake(phones[2], { amountCents: 500, entryId: failureEntries[0], tableId: 5 });
  await financial.reserveStake(phones[3], { amountCents: 500, entryId: failureEntries[1], tableId: 5 });
  await assert.rejects(
    failedFinancial.commitMatchReservations(failureEntries, recoveryMatchId),
    /E2E_CONTROLLED_DATABASE_UNAVAILABLE/,
  );
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE entry_id IN ($1,$2) AND status='RESERVED'", failureEntries), 2);
  await financial.commitMatchReservations(failureEntries, recoveryMatchId);
  const settlementFailure = new FinancialWalletService({
    repository, provider, config,
    faultInjector: (stage) => {
      if (stage === 'before_match_financial_mutation') throw new Error('E2E_CONTROLLED_SETTLEMENT_FAILURE');
    },
  });
  await assert.rejects(
    settlementFailure.settleMatch({ matchId: recoveryMatchId, winnerPhone: phones[2], platformFeeCents: 100 }),
    /E2E_CONTROLLED_SETTLEMENT_FAILURE/,
  );
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE match_id=$1 AND status='COMMITTED'", [recoveryMatchId]), 2);
  assert.equal(await count('SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key=$1', [`match:settle:${recoveryMatchId}`]), 0);
  assert.equal(Number((await financial.getAccount(phones[2])).reserved_balance_cents), 500);
  assert.equal((await financial.settleMatch({ matchId: recoveryMatchId, winnerPhone: phones[2], platformFeeCents: 100 })).status, 'SETTLED');
  assert.equal(await count('SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key=$1', [`match:settle:${recoveryMatchId}`]), 1);

  async function startPair(firstPhone, secondPhone, label) {
    await payMock(firstPhone, 1_000, `${label}-first`);
    await payMock(secondPhone, 1_000, `${label}-second`);
    assert.equal((await sendCommand(firstPhone, 'jogar')).type, 'whatsapp_tables_sent');
    assert.equal((await sendCommand(firstPhone, '2')).type, 'whatsapp_queue_joined');
    assert.equal((await sendCommand(secondPhone, 'jogar')).type, 'whatsapp_tables_sent');
    const paired = await sendCommand(secondPhone, '2');
    assert.equal(paired.type, 'whatsapp_match_created');
    const first = await connect({ token: accessLink(firstPhone).searchParams.get('entry'), matchId: paired.matchId });
    const second = await connect({ token: accessLink(secondPhone).searchParams.get('entry'), matchId: paired.matchId });
    const firstStarted = once(first.socket, 'matchStarted');
    const secondStarted = once(second.socket, 'matchStarted');
    assert.equal((await emitAck(first.socket, 'joinQueue', { tableValue: 5, playerName: `${label} A` })).ok, true);
    assert.equal((await emitAck(second.socket, 'joinQueue', { tableValue: 5, playerName: `${label} B` })).ok, true);
    const [firstState, secondState] = await Promise.all([firstStarted, secondStarted]);
    assert.equal(firstState.matchId, secondState.matchId);
    assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE match_id=$1 AND status='COMMITTED'", [firstState.matchId]), 2);
    return { first, second, firstState, secondState, match: matchManager.getOnlineMatch(firstState.matchId) };
  }
  const firstConcurrent = await startPair(phones[4], phones[5], 'PAIR-1');
  const secondConcurrent = await startPair(phones[6], phones[7], 'PAIR-2');
  assert.notEqual(firstConcurrent.match.matchId, secondConcurrent.match.matchId);
  assert.equal(matchManager.getOnlineMatch(firstConcurrent.match.matchId).status, 'playing');
  assert.equal(matchManager.getOnlineMatch(secondConcurrent.match.matchId).status, 'playing');
  const secondPairAccountBefore = await financial.getAccount(phones[6]);
  assert.equal((await emitAck(firstConcurrent.second.socket, 'playerSurrender', {
    matchId: firstConcurrent.match.matchId, roomId: firstConcurrent.match.roomId,
    playerId: firstConcurrent.secondState.you.playerId,
    turnNumber: firstConcurrent.match.turnNumber, actionId: randomUUID(),
  })).ok, true);
  await waitFor(async () => await count("SELECT count(*)::int AS total FROM financial_match_settlements WHERE match_id=$1 AND status='SETTLED'", [firstConcurrent.match.matchId]) === 1, 'first-concurrent-settlement');
  assert.equal(await count("SELECT count(*)::int AS total FROM financial_match_reservations WHERE match_id=$1 AND status='COMMITTED'", [secondConcurrent.match.matchId]), 2);
  const secondPairAccountAfter = await financial.getAccount(phones[6]);
  assert.equal(secondPairAccountAfter.available_balance_cents, secondPairAccountBefore.available_balance_cents);
  assert.equal(secondPairAccountAfter.reserved_balance_cents, secondPairAccountBefore.reserved_balance_cents);
  assert.equal((await emitAck(secondConcurrent.second.socket, 'playerSurrender', {
    matchId: secondConcurrent.match.matchId, roomId: secondConcurrent.match.roomId,
    playerId: secondConcurrent.secondState.you.playerId,
    turnNumber: secondConcurrent.match.turnNumber, actionId: randomUUID(),
  })).ok, true);
  await waitFor(async () => await count("SELECT count(*)::int AS total FROM financial_match_settlements WHERE match_id=$1 AND status='SETTLED'", [secondConcurrent.match.matchId]) === 1, 'second-concurrent-settlement');

  const unbalanced = await count(`SELECT count(*)::int AS total FROM (
    SELECT transaction_id FROM financial_ledger_entries GROUP BY transaction_id HAVING sum(amount_cents)<>0
  ) AS bad`);
  assert.equal(unbalanced, 0);
  const wrongAccountBalances = await count(`SELECT count(*)::int AS total FROM financial_accounts AS a WHERE
    a.available_balance_cents <> COALESCE((SELECT sum(amount_cents) FROM financial_ledger_entries
      WHERE account_id=a.account_id AND ledger_account='PLAYER_AVAILABLE'),0)
    OR a.reserved_balance_cents <> COALESCE((SELECT sum(amount_cents) FROM financial_ledger_entries
      WHERE account_id=a.account_id AND ledger_account='PLAYER_RESERVED'),0)`);
  assert.equal(wrongAccountBalances, 0);
  const mainSettlement = (await repository.query('SELECT * FROM financial_match_settlements WHERE match_id=$1', [onlineMatchId])).rows[0];
  assert.equal(Number(mainSettlement.total_stakes_cents), 1_000);
  assert.equal(Number(mainSettlement.platform_fee_cents), 100);
  assert.equal(Number(mainSettlement.winner_prize_cents), 900);
  assert.equal(await count(`SELECT count(*)::int AS total FROM financial_ledger_entries
    WHERE transaction_id=$1 AND ledger_account='PLATFORM_REVENUE' AND amount_cents=100`, [mainSettlement.transaction_id]), 1);
  assert.ok(sent.some((item) => item.phone === phones[0] && /jogar/i.test(item.text)));
  assert.ok(sent.some((item) => item.phone === phones[0] && /mesa/i.test(item.text)));
  assert.ok(sent.some((item) => item.phone === phones[2] && /Saldo insuficiente/i.test(item.text)));
  assert.ok(sent.some((item) => item.phone === phones[2] && /Pix gerado/i.test(item.text)));
  assert.ok(sent.some((item) => item.phone === phones[2] && /Pagamento confirmado/i.test(item.text)));
  assert.ok(sent.some((item) => item.phone === phones[0] && /aguardando|advers.rio/i.test(item.text)));
  assert.ok(sent.some((item) => item.phone === phones[0] && item.text.includes('/join/')));
  assert.ok(sent.some((item) => item.phone === phones[0] && /venceu|vit.ria/i.test(item.text)));
  console.log(JSON.stringify({
    status: 'MAIN_FINANCIAL_E2E_PASS', tableCents: 500, initialTotalCents: 4_000,
    prizeCents: 900, feeCents: 100, playerAFinalCents: 2_400,
    playerBFinalCents: 1_500, finalTotalCents: 3_900,
    safeEntryReconnect: true, mockPixIdempotent: true, preStartCancellation: true,
    preMatchedCancellation: true, postStartCancellationBlocked: true, doubleSettlementIdempotent: true,
    doubleReservationPrevented: true, databaseFailureFailClosed: true,
    simultaneousMatchesIsolated: true, browserVisualTest: 'NOT_EXECUTED',
  }));
} finally {
  for (const timeout of matchQueue.pendingMatchTimeouts.values()) clearTimeout(timeout);
  for (const client of clients) client.close();
  await new Promise((resolve) => socketServer.close(resolve));
  if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
  if (ownsTestDatabase) await truncateTestTables();
  await accessRepository.close();
  await repository.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
