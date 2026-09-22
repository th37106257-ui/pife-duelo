import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';

const port = 3216;
const baseUrl = `http://127.0.0.1:${port}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pife-entry-resume-'));
const entryStorePath = join(temporaryDirectory, 'entries.json');
const accessSecret = 'entry-resume-integration-secret';
const seedService = new WhatsAppEntryService({
  store: new WhatsAppEntryStore({ filePath: entryStorePath }),
  accessSecret,
  publicGameUrl: baseUrl,
});

function createApprovedEntry(phone) {
  const entry = seedService.createEntry({ phone, selectedTable: 5, source: 'resume-integration-test' });
  return seedService.approveEntry({ entryId: entry.entryId, actor: 'resume-integration-test' });
}

const playerAEntry = createApprovedEntry('5511888881212');
const playerBEntry = createApprovedEntry('5511777773434');
const playerAToken = new URL(playerAEntry.accessLink).searchParams.get('entry');
const playerBToken = new URL(playerBEntry.accessLink).searchParams.get('entry');

const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'entry-resume-test-admin',
    CLIENT_URL: baseUrl,
    FRONTEND_URL: baseUrl,
    ALLOWED_CLIENT_URLS: baseUrl,
    PAYMENT_GATE_ENABLED: 'false',
    WHATSAPP_PAYMENTS_ENABLED: 'false',
    WHATSAPP_SAFE_ENTRY_ENABLED: 'true',
    WHATSAPP_FIRST_LOBBY_ENABLED: 'true',
    WHATSAPP_ENTRY_STORE_PATH: entryStorePath,
    WHATSAPP_ENTRY_ACCESS_SECRET: accessSecret,
    PUBLIC_GAME_URL: baseUrl,
    ADMIN_WHATSAPP_NUMBERS: '5511999998888',
    EVOLUTION_API_URL: 'https://evolution.example',
    EVOLUTION_API_KEY: 'integration-placeholder',
    EVOLUTION_INSTANCE_NAME: 'pife-entry-resume-test',
    EVOLUTION_WEBHOOK_SECRET: 'integration-webhook-secret',
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

async function connectClient({ entryToken = '', sessionKey = null } = {}) {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    auth: {
      ...(entryToken ? { entryToken } : {}),
      ...(sessionKey ? { entrySessionKey: sessionKey } : {}),
    },
  });
  sockets.push(socket);
  const connected = once(socket, 'connect');
  const identity = once(socket, 'connection:success');
  socket.connect();
  await connected;
  return { socket, connection: await identity };
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

function resume(socket, { matchId, playerId }) {
  socket.emit('resumeOnlineMatch', { matchId, playerId });
}

function assertPrivateView(state, { matchId, playerId, opponentPlayerId }) {
  assert.equal(state.matchId, matchId);
  assert.equal(state.you.playerId, playerId);
  assert.ok([9, 10].includes(state.you.hand.length));
  assert.equal(state.opponent.playerId, opponentPlayerId);
  assert.equal('hand' in state.opponent, false);
  assert.equal('deck' in state, false);
}

try {
  await waitForHealth();

  const playerA = await connectClient({ entryToken: playerAToken });
  const playerB = await connectClient({ entryToken: playerBToken });
  const sessionKeyA = playerA.connection.entryAccess.sessionKey;
  assert.ok(sessionKeyA, 'O handshake inicial deve emitir a entrySessionKey do jogador A.');
  assert.equal(playerA.connection.entryAccess.entryId, playerAEntry.entry.entryId);

  assert.equal((await joinQueue(playerA.socket, 'Sessao A')).ok, true);
  const startedA = once(playerA.socket, 'matchStarted');
  const startedB = once(playerB.socket, 'matchStarted');
  assert.equal((await joinQueue(playerB.socket, 'Sessao B')).ok, true);
  const [initialA, initialB] = await Promise.all([startedA, startedB]);
  assert.equal(initialA.matchId, initialB.matchId);
  const matchId = initialA.matchId;
  const playerAId = initialA.you.playerId;
  const playerBId = initialB.you.playerId;
  assert.equal(initialA.currentTurnPlayerId, playerAId, 'A deve iniciar, permitindo testar ação autenticada e tentativa do socket antigo no mesmo turno.');
  assertPrivateView(initialA, { matchId, playerId: playerAId, opponentPlayerId: playerBId });

  // Primeiro substitui A mantendo o socket antigo aberto: ele deve perder autorização para agir.
  const staleReplacement = await connectClient({ entryToken: playerAToken, sessionKey: sessionKeyA });
  assert.equal(staleReplacement.connection.entryAccess.entryId, playerAEntry.entry.entryId);
  const replacementViewPromise = once(staleReplacement.socket, 'gameStateUpdated');
  resume(staleReplacement.socket, { matchId, playerId: playerAId });
  const replacementView = await replacementViewPromise;
  assertPrivateView(replacementView, { matchId, playerId: playerAId, opponentPlayerId: playerBId });

  const replacementUpdateAfterOldAction = once(staleReplacement.socket, 'gameStateUpdated');
  const staleAction = await emitAction(playerA.socket, 'playerDrawFromDeck', { matchId });
  const unchangedView = await replacementUpdateAfterOldAction;
  assert.equal(staleAction.ok, false, 'Socket A antigo não pode jogar após a substituição válida.');
  assert.equal(unchangedView.deckCount, replacementView.deckCount);
  assert.equal(unchangedView.turnNumber, replacementView.turnNumber);
  assert.deepEqual(unchangedView.you.hand.map((card) => card.id), replacementView.you.hand.map((card) => card.id));

  // Executa o ciclo de desconexão e recuperação real com um terceiro socket e a mesma sessionKey.
  playerA.socket.disconnect();
  staleReplacement.socket.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const resumedA = await connectClient({ entryToken: playerAToken, sessionKey: sessionKeyA });
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
  const ownAction = await emitAction(resumedA.socket, 'playerDrawFromDeck', { matchId });
  const [ownActionState, opponentActionState] = await Promise.all([ownActionStatePromise, opponentActionStatePromise]);
  assert.equal(ownAction.ok, true, 'Socket A recuperado deve poder agir quando é sua vez.');
  assertPrivateView(ownActionState, { matchId, playerId: playerAId, opponentPlayerId: playerBId });
  assert.equal(opponentActionState.you.playerId, playerBId);
  assert.equal('hand' in opponentActionState.opponent, false);

  console.log('PASS handshake entryToken + entrySessionKey, retomada real, visão privada, ação autorizada e bloqueio de impersonação/socket substituído');
} finally {
  sockets.forEach((socket) => socket.connected && socket.disconnect());
  server.kill();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
