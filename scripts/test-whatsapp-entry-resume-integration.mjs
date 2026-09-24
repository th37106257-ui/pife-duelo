import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';
import { PostgresWhatsAppEntryAccessRepository } from '../server/src/entries/PostgresWhatsAppEntryAccessRepository.js';

const port = 3216;
const baseUrl = `http://127.0.0.1:${port}`;
const firstLobbyEnabled = process.env.PIFE_TEST_FIRST_LOBBY_ENABLED ?? 'true';
const databaseUrl = process.env.PIFE_SAFE_ENTRY_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('PIFE_SAFE_ENTRY_TEST_DATABASE_URL_REQUIRED');
const database = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '55432'
  || database.pathname !== '/pife_safe_entry_test' || database.username !== 'pife_test') {
  throw new Error('SAFE_ENTRY_INTEGRATION_TEST_REQUIRES_ISOLATED_LOCAL_POSTGRES');
}
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pife-entry-resume-'));
const entryStorePath = join(temporaryDirectory, 'entries.json');
const accessSecret = 'entry-resume-integration-secret';
const seedRepository = new PostgresWhatsAppEntryAccessRepository({ connectionString: databaseUrl });
await seedRepository.initialize();
await seedRepository.pool.query('TRUNCATE TABLE whatsapp_safe_entries');
const seedService = new WhatsAppEntryService({
  store: new WhatsAppEntryStore({ filePath: entryStorePath }),
  accessSecret,
  publicGameUrl: baseUrl,
  sharedAccessRepository: seedRepository,
  requireSharedAccessRepository: true,
});

async function createApprovedEntry(phone) {
  const entry = seedService.createEntry({ phone, selectedTable: 5, source: 'resume-integration-test' });
  return seedService.approveEntry({ entryId: entry.entryId, actor: 'resume-integration-test' });
}

const playerAEntry = await createApprovedEntry('5511888881212');
const playerBEntry = await createApprovedEntry('5511777773434');
const playerAToken = new URL(playerAEntry.accessLink).searchParams.get('entry');
const playerBToken = new URL(playerBEntry.accessLink).searchParams.get('entry');
const unrelatedEntry = await createApprovedEntry('5511666665656');
const unrelatedMatchId = 'whatsapp_match_unrelated_recovery';
const unrelatedAccess = await seedService.refreshQueueAccessLink(unrelatedEntry.entry.entryId, { matchId: unrelatedMatchId });
const unrelatedToken = new URL(unrelatedAccess.accessLink).searchParams.get('entry');
const raceEntry = await createApprovedEntry('5511666667878');
const raceMatchId = 'whatsapp_match_claim_race';
const raceAccess = await seedService.refreshQueueAccessLink(raceEntry.entry.entryId, { matchId: raceMatchId });
const raceToken = new URL(raceAccess.accessLink).searchParams.get('entry');
const crossSessionEntry = await createApprovedEntry('5511666669890');
const crossSessionMatchId = 'whatsapp_match_cross_session';
const crossSessionAccess = await seedService.refreshQueueAccessLink(crossSessionEntry.entry.entryId, { matchId: crossSessionMatchId });
const crossSessionToken = new URL(crossSessionAccess.accessLink).searchParams.get('entry');

const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    FINANCIAL_MODE: 'sandbox',
    PAYMENT_PROVIDER: 'mock',
    FINANCIAL_WALLET_ENABLED: 'false',
    PIX_DEPOSITS_ENABLED: 'false',
    REAL_MONEY_GAMES_ENABLED: 'false',
    WITHDRAWALS_ENABLED: 'false',
    AUTO_WITHDRAWALS_ENABLED: 'false',
    ASAAS_API_KEY: '',
    ASAAS_WEBHOOK_TOKEN: '',
    PORT: String(port),
    WHATSAPP_PROVIDER: 'evolution',
    ADMIN_PASSWORD: 'entry-resume-test-admin',
    CLIENT_URL: baseUrl,
    FRONTEND_URL: baseUrl,
    ALLOWED_CLIENT_URLS: baseUrl,
    PAYMENT_GATE_ENABLED: 'false',
    WHATSAPP_PAYMENTS_ENABLED: 'false',
    WHATSAPP_SAFE_ENTRY_ENABLED: 'true',
    WHATSAPP_FIRST_LOBBY_ENABLED: firstLobbyEnabled,
    WHATSAPP_ENTRY_STORE_PATH: entryStorePath,
    WHATSAPP_ENTRY_ACCESS_SECRET: accessSecret,
    PUBLIC_GAME_URL: baseUrl,
    ADMIN_WHATSAPP_NUMBERS: '5511999998888',
    EVOLUTION_API_URL: 'http://127.0.0.1:9',
    EVOLUTION_API_KEY: 'local-integration-placeholder',
    EVOLUTION_INSTANCE_NAME: 'local-integration-test',
    EVOLUTION_WEBHOOK_SECRET: 'local-integration-secret',
  },
  stdio: 'ignore',
});

const sockets = [];

function once(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Evento ${eventName} nao recebido.`)), timeoutMs);
    socket.once(eventName, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de teste nao iniciou.');
}

async function connectClient({ entryToken = '', sessionKey = null, matchId = '' } = {}) {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    auth: {
      ...(entryToken ? { entryToken } : {}),
      ...(sessionKey ? { entrySessionKey: sessionKey } : {}),
      ...(matchId ? { joinMatchId: matchId } : {}),
    },
  });
  sockets.push(socket);
  const connected = once(socket, 'connect');
  const identity = once(socket, 'connection:success');
  socket.connect();
  await connected;
  return { socket, connection: await identity };
}

function connectClientOutcome({ entryToken = '', sessionKey = null, matchId = '' } = {}) {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    auth: {
      ...(entryToken ? { entryToken } : {}),
      ...(sessionKey ? { entrySessionKey: sessionKey } : {}),
      ...(matchId ? { joinMatchId: matchId } : {}),
    },
  });
  sockets.push(socket);
  const events = [];
  ['queueJoined', 'matchFound', 'matchStarted'].forEach((eventName) => {
    socket.on(eventName, () => events.push(eventName));
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Handshake simultâneo não foi concluído.'));
    }, 5000);
    socket.once('connection:success', (connection) => {
      clearTimeout(timeout);
      resolve({ accepted: true, socket, connection, events });
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      resolve({ accepted: false, socket, error, events });
    });
    socket.connect();
  });
}

async function expectHandshakeDenied({ entryToken = '', sessionKey = null, matchId = '', entryId = null } = {}) {
  const entryCountBefore = new WhatsAppEntryStore({ filePath: entryStorePath }).listEntries().length;
  const entryBefore = entryId
    ? new WhatsAppEntryStore({ filePath: entryStorePath }).getEntry(entryId)
    : null;
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    auth: {
      ...(entryToken ? { entryToken } : {}),
      ...(sessionKey ? { entrySessionKey: sessionKey } : {}),
      ...(matchId ? { joinMatchId: matchId } : {}),
    },
  });
  sockets.push(socket);
  const unexpectedEvents = [];
  ['connection:success', 'queueJoined', 'matchFound', 'matchStarted'].forEach((eventName) => {
    socket.on(eventName, () => unexpectedEvents.push(eventName));
  });
  const denied = once(socket, 'connect_error');
  socket.connect();
  const error = await denied;
  assert.equal(error.message, 'ENTRY_ACCESS_DENIED');
  assert.equal(error.data?.code, 'ENTRY_ACCESS_DENIED');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(unexpectedEvents, [], 'Handshake negado não pode receber acesso nem iniciar fila/partida.');
  assert.equal(new WhatsAppEntryStore({ filePath: entryStorePath }).listEntries().length, entryCountBefore,
    'Handshake negado não pode criar uma nova entrada.');
  if (entryId) {
    assert.deepEqual(new WhatsAppEntryStore({ filePath: entryStorePath }).getEntry(entryId), entryBefore,
      'Handshake negado não pode alterar a entrada/ticket alvo.');
  }
  socket.close();
}

function joinQueue(socket, playerName) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit('joinQueue', { tableValue: 5, playerName }, (error, acknowledgement) => {
      if (error) reject(error);
      else resolve(acknowledgement);
    });
  });
}

function emitAction(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`ACK ${eventName} nao recebido.`)), 5000);
    socket.emit(eventName, payload, (acknowledgement) => {
      clearTimeout(timeout);
      resolve(acknowledgement);
    });
  });
}

function listenForEvents(socket, eventNames) {
  const events = [];
  const listeners = new Map();
  eventNames.forEach((eventName) => {
    const listener = (payload) => events.push({ eventName, payload });
    listeners.set(eventName, listener);
    socket.on(eventName, listener);
  });
  return {
    events,
    stop() {
      listeners.forEach((listener, eventName) => socket.off(eventName, listener));
    },
  };
}

function resume(socket, { matchId, playerId }) {
  socket.emit('resumeOnlineMatch', { matchId, playerId });
}

function requestState(socket, matchId) {
  const statePromise = once(socket, 'gameStateUpdated');
  socket.emit('requestGameState', { matchId });
  return statePromise;
}

function assertPrivateView(state, { matchId, playerId, opponentPlayerId }) {
  assert.equal(state.matchId, matchId);
  assert.equal(state.you.playerId, playerId);
  assert.ok([9, 10].includes(state.you.hand.length));
  assert.equal(state.opponent.playerId, opponentPlayerId);
  assert.equal('hand' in state.opponent, false);
  assert.equal('deck' in state, false);
}

function gameplaySnapshot(state) {
  return {
    matchId: state.matchId,
    status: state.status,
    turnNumber: state.turnNumber,
    currentTurnPlayerId: state.currentTurnPlayerId,
    deckCount: state.deckCount,
    discardCount: state.discardCount,
    topDiscardCardId: state.topDiscardCard?.id ?? null,
    you: {
      playerId: state.you.playerId,
      hand: state.you.hand.map((card) => card.id),
      hasDrawnThisTurn: state.you.hasDrawnThisTurn,
    },
  };
}

try {
  await waitForHealth();

  const anonymousEntryCount = new WhatsAppEntryStore({ filePath: entryStorePath }).listEntries().length;
  const anonymousClient = await connectClientOutcome();
  assert.equal(anonymousClient.accepted, true, 'A compatibilidade do handshake anônimo permanece, mas não deve conceder fila.');
  assert.equal(anonymousClient.connection.entryAccess, null);
  const anonymousQueueResult = await joinQueue(anonymousClient.socket, 'Anônimo sem ticket');
  assert.equal(anonymousQueueResult.ok, false);
  assert.equal(anonymousQueueResult.reason, 'WHATSAPP_ENTRY_REQUIRED',
    'SAFE ENTRY deve bloquear fila anônima mesmo com FIRST_LOBBY=false.');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(anonymousClient.events, [], 'A conexão sem credenciais não pode criar fila ou partida.');
  assert.equal(new WhatsAppEntryStore({ filePath: entryStorePath }).listEntries().length, anonymousEntryCount,
    'A tentativa anônima não pode criar uma nova entrada.');
  anonymousClient.socket.close();

  const raceEntryCountBefore = new WhatsAppEntryStore({ filePath: entryStorePath }).listEntries().length;
  await expectHandshakeDenied({
    entryToken: raceToken,
    sessionKey: 'session-key-of-another-player',
    matchId: raceMatchId,
    entryId: raceEntry.entry.entryId,
  });
  assert.equal(new WhatsAppEntryStore({ filePath: entryStorePath }).getEntry(raceEntry.entry.entryId)?.accessSessionTokenHash, null,
    'SessionKey fornecida pelo cliente não pode reclamar ticket ainda não usado.');

  const raceResults = await Promise.all([
    connectClientOutcome({ entryToken: raceToken, matchId: raceMatchId }),
    connectClientOutcome({ entryToken: raceToken, matchId: raceMatchId }),
  ]);
  assert.deepEqual(raceResults.map((result) => result.accepted).sort(), [false, true],
    'Duas reclamações simultâneas do mesmo ticket devem produzir exatamente um sucesso e uma rejeição.');
  const raceWinner = raceResults.find((result) => result.accepted);
  const raceRejected = raceResults.find((result) => !result.accepted);
  assert.equal(raceWinner.connection.entryAccess.entryId, raceEntry.entry.entryId);
  assert.ok(raceWinner.connection.entryAccess.sessionKey, 'O servidor gera a sessionKey somente no claim vencedor.');
  assert.equal(raceRejected.error.data?.code, 'ENTRY_ACCESS_DENIED');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(raceResults.flatMap((result) => result.events), [], 'Handshake não deve criar fila ou partida automaticamente.');
  const raceEntryAfter = new WhatsAppEntryStore({ filePath: entryStorePath }).getEntry(raceEntry.entry.entryId);
  assert.ok(raceEntryAfter.accessSessionTokenHash);
  const raceDatabaseEntry = await seedRepository.getEntry(raceEntry.entry.entryId);
  assert.ok(raceDatabaseEntry.accessSessionClaimedAt, 'O claim vencedor deve estar persistido na autoridade compartilhada PostgreSQL.');
  assert.ok(raceDatabaseEntry.accessSessionTokenHash, 'PostgreSQL deve persistir um único hash de sessão.');
  assert.equal(await seedRepository.countEntry(raceEntry.entry.entryId), 1,
    'A tentativa concorrente deve manter exatamente uma entrada persistida.');
  assert.equal(new WhatsAppEntryStore({ filePath: entryStorePath }).listEntries().length, raceEntryCountBefore,
    'Claims concorrentes/rejeitados não podem criar entries.');
  raceResults.forEach((result) => result.socket.close());

  const playerA = await connectClient({ entryToken: playerAToken });
  const playerB = await connectClient({ entryToken: playerBToken });
  const sessionKeyA = playerA.connection.entryAccess.sessionKey;
  const sessionKeyB = playerB.connection.entryAccess.sessionKey;
  assert.ok(sessionKeyA, 'O handshake inicial deve emitir a entrySessionKey do jogador A.');
  assert.ok(sessionKeyB, 'O handshake inicial deve emitir a entrySessionKey do jogador B.');
  assert.notEqual(sessionKeyA, sessionKeyB, 'As sessionKeys devem ser distintas entre jogadores.');
  assert.equal(playerA.connection.entryAccess.entryId, playerAEntry.entry.entryId);
  assert.ok(new WhatsAppEntryStore({ filePath: entryStorePath }).getEntry(playerAEntry.entry.entryId)?.accessSessionTokenHash,
    'SAFE ENTRY deve reclamar a sessão no primeiro acesso, independentemente da flag de lobby.');
  await expectHandshakeDenied({
    entryToken: unrelatedToken,
    matchId: 'invented-match-for-entry-token',
    entryId: unrelatedEntry.entry.entryId,
  });
  const unrelatedBootstrap = await connectClient({ entryToken: unrelatedToken, matchId: unrelatedMatchId });
  const unrelatedSessionKey = unrelatedBootstrap.connection.entryAccess.sessionKey;
  assert.ok(unrelatedSessionKey);
  unrelatedBootstrap.socket.disconnect();

  assert.equal((await joinQueue(playerA.socket, 'Sessao A')).ok, true);
  const startedA = once(playerA.socket, 'matchStarted');
  const startedB = once(playerB.socket, 'matchStarted');
  assert.equal((await joinQueue(playerB.socket, 'Sessao B')).ok, true);
  const [initialA, initialB] = await Promise.all([startedA, startedB]);
  assert.equal(initialA.matchId, initialB.matchId);
  const matchId = initialA.matchId;
  const playerAId = initialA.you.playerId;
  const playerBId = initialB.you.playerId;
  const entriesBeforeF5 = new WhatsAppEntryStore({ filePath: entryStorePath }).listEntries().length;
  assert.equal(initialA.currentTurnPlayerId, playerAId, 'A deve iniciar, permitindo testar ação autenticada e tentativa do socket antigo no mesmo turno.');
  assert.equal(JSON.stringify(initialA).includes(sessionKeyA), false, 'Estado privado de jogo não deve redistribuir a credencial de sessão.');
  assert.equal(JSON.stringify(initialB).includes(sessionKeyA), false, 'A sessão de A não pode aparecer na visão de B.');
  assert.equal(JSON.stringify(initialA).includes(playerAToken), false, 'O ticket inicial não deve aparecer no estado de jogo.');
  assertPrivateView(initialA, { matchId, playerId: playerAId, opponentPlayerId: playerBId });

  await expectHandshakeDenied({
    entryToken: crossSessionToken,
    sessionKey: sessionKeyB,
    matchId: crossSessionMatchId,
    entryId: crossSessionEntry.entry.entryId,
  });

  // Primeiro substitui A mantendo o socket antigo aberto: ele deve perder autorização para agir.
  const staleReplacement = await connectClient({ matchId, sessionKey: sessionKeyA });
  assert.equal(staleReplacement.connection.entryAccess.entryId, playerAEntry.entry.entryId);
  assert.equal(staleReplacement.connection.entryAccess.linkedMatchId, matchId);
  assert.equal(staleReplacement.socket.auth.entryToken, undefined, 'F5 usa somente matchId + sessionKey, sem ticket original.');
  assert.equal(staleReplacement.socket.auth.entrySessionKey, sessionKeyA);
  const f5AutomaticFlowEvents = listenForEvents(staleReplacement.socket, ['queueJoined', 'matchFound', 'matchStarted']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(f5AutomaticFlowEvents.events, [], 'Reconectar por sessionKey não deve iniciar fila/partida nova automaticamente.');
  f5AutomaticFlowEvents.stop();
  assert.equal(new WhatsAppEntryStore({ filePath: entryStorePath }).listEntries().length, entriesBeforeF5,
    'F5 não pode criar uma nova entrada WhatsApp.');
  const replacementViewPromise = once(staleReplacement.socket, 'gameStateUpdated');
  resume(staleReplacement.socket, { matchId });
  const replacementView = await replacementViewPromise;
  assertPrivateView(replacementView, { matchId, playerId: playerAId, opponentPlayerId: playerBId });
  assert.equal(replacementView.matchId, initialA.matchId, 'F5 precisa recuperar exatamente o mesmo match.');
  assert.equal(replacementView.you.playerId, initialA.you.playerId, 'F5 precisa recuperar exatamente o mesmo jogador autorizado.');

  await expectHandshakeDenied({ matchId, sessionKey: 'invalid-session-key' });
  await expectHandshakeDenied({ matchId });
  await expectHandshakeDenied({ sessionKey: sessionKeyA });
  await expectHandshakeDenied({ matchId, sessionKey: unrelatedSessionKey });
  await expectHandshakeDenied({ entryToken: playerAToken, sessionKey: sessionKeyB, matchId, entryId: playerAEntry.entry.entryId });
  await expectHandshakeDenied({ entryToken: playerAToken, matchId, entryId: playerAEntry.entry.entryId });

  const recoveredB = await connectClient({ matchId, sessionKey: sessionKeyB });
  assert.equal(recoveredB.connection.entryAccess.entryId, playerBEntry.entry.entryId,
    'Mesmo matchId, sessionKey de B deve recuperar somente a entrada de B.');
  recoveredB.socket.disconnect();

  // Dois clientes autenticados depois do vínculo usam a mesma sessão; o mais novo assume.
  const secondReplacement = await connectClient({ matchId, sessionKey: sessionKeyA });
  assert.equal(secondReplacement.connection.entryAccess.linkedMatchId, matchId);
  const secondReplacementViewPromise = once(secondReplacement.socket, 'gameStateUpdated');
  resume(secondReplacement.socket, { matchId, playerId: playerAId });
  const secondReplacementView = await secondReplacementViewPromise;
  assertPrivateView(secondReplacementView, { matchId, playerId: playerAId, opponentPlayerId: playerBId });

  const staleAction = await emitAction(staleReplacement.socket, 'playerDrawFromDeck', {
    matchId,
    turnNumber: secondReplacementView.turnNumber,
    actionId: `stale-draw-${Date.now()}`,
  });
  const unchangedView = await requestState(secondReplacement.socket, matchId);
  assert.equal(staleAction.ok, false, 'Socket A antigo não pode jogar após a substituição válida.');
  assert.equal(unchangedView.deckCount, secondReplacementView.deckCount);
  assert.equal(unchangedView.turnNumber, secondReplacementView.turnNumber);
  assert.deepEqual(unchangedView.you.hand.map((card) => card.id), secondReplacementView.you.hand.map((card) => card.id));
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Uma aba já substituída não pode retomar usando a credencial ainda válida.
  const staleResumeEvents = listenForEvents(staleReplacement.socket, ['gameStateUpdated', 'actionRejected', 'time_sync']);
  resume(staleReplacement.socket, { matchId, playerId: playerAId });
  await new Promise((resolve) => setTimeout(resolve, 100));
  staleResumeEvents.stop();
  assert.deepEqual(
    staleResumeEvents.events.map(({ eventName, payload }) => eventName === 'actionRejected' ? payload.reason : eventName),
    ['RESUME_NOT_AUTHORIZED'],
    'Socket antigo conectado não pode reassumir a sessão nem receber estado privado.',
  );

  const staleRequestEvents = listenForEvents(staleReplacement.socket, ['gameStateUpdated', 'actionRejected', 'time_sync']);
  staleReplacement.socket.emit('requestGameState', { matchId, playerId: playerAId });
  await new Promise((resolve) => setTimeout(resolve, 100));
  staleRequestEvents.stop();
  assert.deepEqual(
    staleRequestEvents.events.map(({ eventName, payload }) => eventName === 'actionRejected' ? payload.reason : eventName),
    ['MATCH_SESSION_MISMATCH'],
    'Socket antigo não pode pedir novamente o estado privado após ser substituído.',
  );

  const stalePrivateEvents = listenForEvents(staleReplacement.socket, ['gameStateUpdated', 'matchFinished', 'time_sync']);
  const staleOperations = [
    ['playerDrawFromDeck', {}],
    ['playerDrawFromDiscard', {}],
    ['playerDiscardCard', { cardId: 'stale-card' }],
    ['player:reorderHand', { handOrder: [] }],
    ['playerKnock', {}],
    ['player:knock', {}],
    ['playerSurrender', {}],
  ];
  for (const [eventName, extra] of staleOperations) {
    const before = await requestState(secondReplacement.socket, matchId);
    const acknowledgement = await emitAction(staleReplacement.socket, eventName, {
      matchId,
      turnNumber: before.turnNumber,
      actionId: `stale-${eventName}-${Date.now()}`,
      ...extra,
    });
    assert.equal(acknowledgement.ok, false, `${eventName} deve ser recusado no socket substituído.`);
    assert.ok(acknowledgement.reason, `${eventName} precisa retornar razão segura no ACK.`);
    const after = await requestState(secondReplacement.socket, matchId);
    assert.deepEqual(gameplaySnapshot(after), gameplaySnapshot(before), `${eventName} não pode alterar o estado do jogo.`);
  }
  assert.equal(stalePrivateEvents.events.length, 0, 'Socket substituído não deve receber estado/timer/fim privados.');
  stalePrivateEvents.stop();

  const invalidKnockId = `invalid-knock-${Date.now()}`;
  const invalidKnock = await emitAction(secondReplacement.socket, 'playerKnock', {
    matchId,
    turnNumber: secondReplacementView.turnNumber,
    actionId: invalidKnockId,
  });
  const invalidKnockReplay = await emitAction(secondReplacement.socket, 'player:knock', {
    matchId,
    turnNumber: secondReplacementView.turnNumber,
    actionId: invalidKnockId,
  });
  assert.equal(invalidKnock.ok, false, 'Bater com mão inicial deve ser rejeitado.');
  assert.equal(invalidKnockReplay.duplicate, true, 'Alias de Bater com o mesmo actionId deve ser deduplicado.');

  const knockDiscardRace = await Promise.all([
    emitAction(secondReplacement.socket, 'playerKnock', {
      matchId,
      turnNumber: secondReplacementView.turnNumber,
      actionId: `knock-race-${Date.now()}`,
    }),
    emitAction(secondReplacement.socket, 'playerDiscardCard', {
      matchId,
      turnNumber: secondReplacementView.turnNumber,
      cardId: 'not-in-hand',
      actionId: `discard-race-${Date.now()}`,
    }),
  ]);
  assert.ok(knockDiscardRace.every((ack) => !ack.ok && ack.reason), 'KNOCK + DISCARD inválidos simultâneos retornam rejeições seguras.');

  // Executa o ciclo de desconexão e recuperação real com um terceiro socket e a mesma sessionKey.
  playerA.socket.disconnect();
  staleReplacement.socket.disconnect();
  secondReplacement.socket.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const resumedA = await connectClient({ matchId, sessionKey: sessionKeyA });
  assert.equal(resumedA.connection.entryAccess.entryId, playerAEntry.entry.entryId);
  const resumedViewPromise = once(resumedA.socket, 'gameStateUpdated');
  resume(resumedA.socket, { matchId, playerId: playerAId });
  const resumedView = await resumedViewPromise;
  assertPrivateView(resumedView, { matchId, playerId: playerAId, opponentPlayerId: playerBId });

  const wrongIdentityRejection = once(resumedA.socket, 'actionRejected');
  resume(resumedA.socket, { matchId, playerId: playerBId });
  assert.equal((await wrongIdentityRejection).reason, 'RESUME_NOT_AUTHORIZED');

  const ownViewAfterMismatchPromise = once(resumedA.socket, 'gameStateUpdated');
  resumedA.socket.emit('requestGameState', { matchId, playerId: playerBId });
  const ownViewAfterMismatch = await ownViewAfterMismatchPromise;
  assertPrivateView(ownViewAfterMismatch, { matchId, playerId: playerAId, opponentPlayerId: playerBId });

  const anonymous = await connectClient();
  const anonymousRejection = once(anonymous.socket, 'actionRejected');
  resume(anonymous.socket, { matchId, playerId: playerBId });
  assert.equal((await anonymousRejection).reason, 'RESUME_NOT_AUTHORIZED');
  assert.equal((await emitAction(anonymous.socket, 'playerDrawFromDeck', { matchId })).ok, false);

  const ownActionStatePromise = once(resumedA.socket, 'gameStateUpdated');
  const opponentActionStatePromise = once(playerB.socket, 'gameStateUpdated');
  const drawActionId = `draw-replay-${Date.now()}`;
  const concurrentBuys = await Promise.all([
    emitAction(resumedA.socket, 'playerDrawFromDeck', { matchId, turnNumber: resumedView.turnNumber, actionId: drawActionId }),
    emitAction(resumedA.socket, 'playerDrawFromDiscard', { matchId, turnNumber: resumedView.turnNumber, actionId: `buy-race-${Date.now()}` }),
  ]);
  const [ownActionState, opponentActionState] = await Promise.all([ownActionStatePromise, opponentActionStatePromise]);
  assert.equal(concurrentBuys.filter((ack) => ack.ok).length, 1, 'BUY + BUY concorrentes devem realizar exatamente uma compra.');
  const ownAction = concurrentBuys.find((ack) => ack.actionId === drawActionId);
  assert.equal(ownAction.ok, true, 'Socket A recuperado deve poder agir quando é sua vez.');
  assertPrivateView(ownActionState, { matchId, playerId: playerAId, opponentPlayerId: playerBId });
  assert.equal(opponentActionState.you.playerId, playerBId);
  assert.equal('hand' in opponentActionState.opponent, false);

  const duplicateDrawEvents = listenForEvents(resumedA.socket, ['gameStateUpdated', 'time_sync']);
  const duplicateDraw = await emitAction(resumedA.socket, 'playerDrawFromDeck', { matchId, actionId: drawActionId });
  await new Promise((resolve) => setTimeout(resolve, 100));
  duplicateDrawEvents.stop();
  assert.equal(duplicateDraw.ok, true, 'Replay deve devolver o resultado original sem executar de novo.');
  assert.equal(duplicateDraw.duplicate, true, 'ACK deve identificar replay deduplicado.');
  assert.equal(duplicateDraw.actionId, drawActionId);
  assert.equal(duplicateDrawEvents.events.length, 0, 'Replay deduplicado não deve gerar nova transição/broadcast.');

  const discardStateA = once(resumedA.socket, 'gameStateUpdated');
  const discardStateB = once(playerB.socket, 'gameStateUpdated');
  const currentCards = ownActionState.you.hand.map((card) => card.id);
  const concurrentDiscards = await Promise.all([
    emitAction(resumedA.socket, 'playerDiscardCard', { matchId, turnNumber: ownActionState.turnNumber, cardId: currentCards[0], actionId: `discard-a-${Date.now()}` }),
    emitAction(resumedA.socket, 'playerDiscardCard', { matchId, turnNumber: ownActionState.turnNumber, cardId: currentCards[1], actionId: `discard-b-${Date.now()}` }),
  ]);
  assert.equal(concurrentDiscards.filter((ack) => ack.ok).length, 1, 'DISCARD + DISCARD concorrentes devem avançar apenas um turno.');
  const [afterDiscardA, afterDiscardB] = await Promise.all([discardStateA, discardStateB]);
  assert.equal(afterDiscardA.turnNumber, ownActionState.turnNumber + 1);
  assert.equal(afterDiscardB.currentTurnPlayerId, playerBId);
  assert.equal(afterDiscardB.opponent.playerId, playerAId);

  const successfulDiscardIndex = concurrentDiscards.findIndex((ack) => ack.ok);
  const successfulDiscardPayload = {
    matchId,
    turnNumber: ownActionState.turnNumber,
    cardId: currentCards[successfulDiscardIndex],
    actionId: concurrentDiscards[successfulDiscardIndex].actionId,
  };
  const discardReplayEvents = listenForEvents(resumedA.socket, ['gameStateUpdated', 'time_sync']);
  const duplicateDiscard = await emitAction(resumedA.socket, 'playerDiscardCard', successfulDiscardPayload);
  await new Promise((resolve) => setTimeout(resolve, 100));
  discardReplayEvents.stop();
  assert.equal(duplicateDiscard.ok, true);
  assert.equal(duplicateDiscard.duplicate, true, 'Replay do descarte deve reutilizar o resultado original.');
  assert.equal(discardReplayEvents.events.length, 0, 'Replay de descarte não pode gerar outra transição.');
  const stateAfterDiscardReplay = await requestState(resumedA.socket, matchId);
  assert.deepEqual(gameplaySnapshot(stateAfterDiscardReplay), gameplaySnapshot(afterDiscardA));

  const bDrawUpdate = once(playerB.socket, 'gameStateUpdated');
  const bDrawAck = await emitAction(playerB.socket, 'playerDrawFromDeck', {
    matchId,
    turnNumber: afterDiscardB.turnNumber,
    actionId: `player-b-draw-${Date.now()}`,
  });
  assert.equal(bDrawAck.ok, true);
  const bAfterDraw = await bDrawUpdate;
  const bDiscardAck = await emitAction(playerB.socket, 'playerDiscardCard', {
    matchId,
    turnNumber: bAfterDraw.turnNumber,
    cardId: bAfterDraw.you.hand.at(-1).id,
    actionId: `player-b-discard-${Date.now()}`,
  });
  assert.equal(bDiscardAck.ok, true);
  const aAfterBDiscard = await requestState(resumedA.socket, matchId);
  assert.equal(aAfterBDiscard.currentTurnPlayerId, playerAId);

  const staleTurnReplay = await emitAction(resumedA.socket, 'playerDrawFromDeck', {
    matchId,
    turnNumber: ownActionState.turnNumber,
    actionId: `stale-buy-new-id-${Date.now()}`,
  });
  assert.equal(staleTurnReplay.ok, false, 'Ação capturada de turno antigo com actionId novo deve ser recusada.');
  assert.equal(staleTurnReplay.reason, 'STALE_TURN');
  const stateAfterStaleReplay = await requestState(resumedA.socket, matchId);
  assert.deepEqual(gameplaySnapshot(stateAfterStaleReplay), gameplaySnapshot(aAfterBDiscard));

  const surrenderId = `surrender-replay-${Date.now()}`;
  const surrenderActorSocket = aAfterBDiscard.currentTurnPlayerId === playerAId ? resumedA.socket : playerB.socket;
  const surrenderFinishedA = once(resumedA.socket, 'matchFinished');
  const surrenderFinishedB = once(playerB.socket, 'matchFinished');
  const staleEventsAfterFinish = listenForEvents(staleReplacement.socket, ['gameStateUpdated', 'matchFinished', 'time_sync']);
  const surrenderResults = await Promise.all([
    emitAction(surrenderActorSocket, 'playerSurrender', { matchId, turnNumber: aAfterBDiscard.turnNumber, actionId: surrenderId }),
    emitAction(surrenderActorSocket, 'playerSurrender', { matchId, turnNumber: aAfterBDiscard.turnNumber, actionId: surrenderId }),
    emitAction(surrenderActorSocket, 'playerDrawFromDeck', { matchId, turnNumber: aAfterBDiscard.turnNumber, actionId: `draw-during-surrender-${Date.now()}` }),
  ]);
  assert.equal(surrenderResults.filter((ack) => ack.ok && !ack.duplicate).length, 1,
    `Surrender + replay + outra ação devem produzir só uma transição válida. ACKs=${JSON.stringify(surrenderResults)}`);
  assert.ok(surrenderResults.every((ack) => ack.ok || ack.reason), 'Replay deve receber ACK coerente e seguro.');
  const [finishedA, finishedB] = await Promise.all([surrenderFinishedA, surrenderFinishedB]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  staleEventsAfterFinish.stop();
  assert.equal(finishedA.matchId, matchId);
  assert.equal(finishedB.matchId, matchId);
  assert.equal(staleEventsAfterFinish.events.length, 0, 'Socket substituído não pode receber o evento de fim da partida.');

  console.log('PASS bootstrap entryToken, recuperação Socket.IO sem ticket por matchId + sessionKey, isolamento entre jogadores, rejeições inválidas, exclusividade multi-socket, visão privada, replay idempotente, concorrência e bloqueio de impersonação/socket substituído');
} finally {
  sockets.forEach((socket) => socket.connected && socket.disconnect());
  server.kill();
  rmSync(temporaryDirectory, { recursive: true, force: true });
  await seedRepository.pool.query('TRUNCATE TABLE whatsapp_safe_entries').catch(() => {});
  await seedRepository.close();
}
