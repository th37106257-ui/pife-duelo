import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const port = 3198;
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'online-sync-test',
    CLIENT_URL: baseUrl,
    ALLOWED_CLIENT_URLS: baseUrl,
  },
  stdio: 'ignore',
});

function once(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Evento ${eventName} nao recebido.`)), timeoutMs);
    socket.once(eventName, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

function onceWhere(socket, eventName, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Evento ${eventName} filtrado nao recebido.`));
    }, timeoutMs);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.off(eventName, handler);
      resolve(payload);
    };
    socket.on(eventName, handler);
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

async function connectClient() {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: false,
  });
  const connected = once(socket, 'connect');
  const identity = once(socket, 'connection:success');
  socket.connect();
  await connected;
  const connection = await identity;
  return { socket, connection };
}

function emitAction(socket, eventName, payload) {
  const actionId = `${eventName}-${Date.now()}`;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`ACK ${eventName} nao recebido.`)), 3000);
    socket.emit(eventName, { ...payload, actionId }, (ack) => {
      clearTimeout(timeout);
      resolve({ ack, latencyMs: Date.now() - startedAt });
    });
  });
}

const clients = [];
try {
  await waitForHealth();
  const first = await connectClient();
  const second = await connectClient();
  clients.push(first.socket, second.socket);

  const firstStartedPromise = once(first.socket, 'matchStarted');
  const secondStartedPromise = once(second.socket, 'matchStarted');
  const firstSyncPromise = once(first.socket, 'time_sync');
  const secondSyncPromise = once(second.socket, 'time_sync');
  first.socket.emit('joinQueue', { playerName: 'Tempo A', tableValue: 2 });
  second.socket.emit('joinQueue', { playerName: 'Tempo B', tableValue: 2 });

  const [firstState, secondState, firstSync, secondSync] = await Promise.all([
    firstStartedPromise,
    secondStartedPromise,
    firstSyncPromise,
    secondSyncPromise,
  ]);
  assert.equal(firstState.matchId, secondState.matchId);
  assert.equal(firstSync.turnStartedAt, secondSync.turnStartedAt);
  assert.equal(firstSync.currentPlayerId, secondSync.currentPlayerId);
  assert.ok(Math.abs((firstSync.serverNow - firstSync.turnStartedAt) - (secondSync.serverNow - secondSync.turnStartedAt)) < 1000);
  assert.equal(firstSync.turnDurationMs, 60000);
  assert.equal(first.socket.io.engine.transport.name, 'websocket');
  assert.equal(second.socket.io.engine.transport.name, 'websocket');
  assert.equal('hand' in firstState.opponent, false);
  assert.ok(firstState.matchLog.length <= 2);
  assert.ok(JSON.stringify(firstState).length < 10000);

  const actor = firstState.isYourTurn ? first : second;
  const actorState = firstState.isYourTurn ? firstState : secondState;
  const drawFirstUpdate = once(first.socket, 'gameStateUpdated');
  const drawSecondUpdate = once(second.socket, 'gameStateUpdated');
  const drawResult = await emitAction(actor.socket, 'playerDrawFromDeck', { matchId: actorState.matchId });
  assert.equal(drawResult.ack.ok, true);
  assert.equal(drawResult.ack.actionId.startsWith('playerDrawFromDeck-'), true);
  assert.ok(drawResult.latencyMs < 2000);
  const [firstAfterDraw, secondAfterDraw] = await Promise.all([drawFirstUpdate, drawSecondUpdate]);
  const actorAfterDraw = firstAfterDraw.you.playerId === actorState.you.playerId ? firstAfterDraw : secondAfterDraw;
  assert.equal(actorAfterDraw.you.hand.length, 10);

  const discardCard = actorAfterDraw.you.hand.at(-1);
  const discardFirstUpdate = once(first.socket, 'gameStateUpdated');
  const discardSecondUpdate = once(second.socket, 'gameStateUpdated');
  const discardFirstSync = onceWhere(first.socket, 'time_sync', (payload) => payload.currentPlayerId !== actorState.you.playerId);
  const discardSecondSync = onceWhere(second.socket, 'time_sync', (payload) => payload.currentPlayerId !== actorState.you.playerId);
  const discardResult = await emitAction(actor.socket, 'playerDiscardCard', {
    matchId: actorState.matchId,
    cardId: discardCard.id,
  });
  assert.equal(discardResult.ack.ok, true);
  assert.ok(discardResult.latencyMs < 2000);
  const [firstAfterDiscard, secondAfterDiscard, syncAfterA, syncAfterB] = await Promise.all([
    discardFirstUpdate,
    discardSecondUpdate,
    discardFirstSync,
    discardSecondSync,
  ]);
  assert.notEqual(firstAfterDiscard.currentTurnPlayerId, actorState.you.playerId);
  assert.equal(firstAfterDiscard.currentTurnPlayerId, secondAfterDiscard.currentTurnPlayerId);
  assert.equal(syncAfterA.turnStartedAt, syncAfterB.turnStartedAt);
  assert.ok(Math.abs(syncAfterA.serverNow - syncAfterB.serverNow) < 1000);

  const reconnectPlayerId = firstAfterDiscard.you.playerId;
  const reconnectRoomId = firstAfterDiscard.roomId;
  first.socket.disconnect();
  const resumed = await connectClient();
  clients.push(resumed.socket);
  const resumedStatePromise = once(resumed.socket, 'gameStateUpdated');
  const resumedSyncPromise = once(resumed.socket, 'time_sync');
  resumed.socket.emit('resumeOnlineMatch', {
    matchId: firstAfterDiscard.matchId,
    roomId: reconnectRoomId,
    playerId: reconnectPlayerId,
  });
  const [resumedState, resumedSync] = await Promise.all([resumedStatePromise, resumedSyncPromise]);
  assert.equal(resumedState.matchId, firstAfterDiscard.matchId);
  assert.equal(resumedSync.turnStartedAt, syncAfterA.turnStartedAt);

  console.log('PASS timer sincronizado, payload leve, WebSocket, ACK e reconexao');
} finally {
  clients.forEach((socket) => socket.connected && socket.disconnect());
  server.kill();
}
