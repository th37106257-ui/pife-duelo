import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import { resolveAuthorizedMatchPlayer } from '../server/src/socket/authorization.js';

const port = 3214;
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'authorization-test-admin',
    CLIENT_URL: baseUrl,
    ALLOWED_CLIENT_URLS: baseUrl,
  },
  stdio: 'ignore',
});

const clients = [];
const findings = [];
const visibleMatchSnapshots = new Map();
let monitoredMatchId = null;

const authorizationMatch = {
  matchId: 'match-authorized-fixture',
  players: [
    { id: 'player-authorized-fixture', socketId: 'old-socket' },
    { id: 'player-other-fixture', socketId: 'other-socket' },
  ],
};
const authorizedEntryService = {
  getEntry: () => ({
    entryId: 'entry-authorized-fixture',
    playerId: 'player-authorized-fixture',
    linkedMatchId: 'match-authorized-fixture',
    status: 'playing',
  }),
};
assert.equal(resolveAuthorizedMatchPlayer({
  socket: { id: 'new-socket', entryAccess: { entryId: 'entry-authorized-fixture', linkedMatchId: 'match-authorized-fixture' } },
  match: authorizationMatch,
  socketManager: { getPlayerBySocket: () => null },
  entryService: authorizedEntryService,
  requestedPlayerId: 'player-authorized-fixture',
}), 'player-authorized-fixture', 'Credencial de sessão válida deve permitir retomada apenas do jogador vinculado.');
assert.equal(resolveAuthorizedMatchPlayer({
  socket: { id: 'new-socket', entryAccess: { entryId: 'entry-authorized-fixture', linkedMatchId: 'match-authorized-fixture' } },
  match: authorizationMatch,
  socketManager: { getPlayerBySocket: () => null },
  entryService: authorizedEntryService,
  requestedPlayerId: 'player-other-fixture',
}), null, 'Sessão válida não pode ser usada para assumir o adversário.');
assert.equal(resolveAuthorizedMatchPlayer({
  socket: { id: 'new-payment-socket', paymentAccess: { paymentId: 'payment-authorized-fixture', linkedMatchId: 'match-authorized-fixture' } },
  match: authorizationMatch,
  socketManager: { getPlayerBySocket: () => null },
  paymentService: {
    getPayment: () => ({
      status: 'confirmed',
      linkedMatchId: 'match-authorized-fixture',
      accessUsedAt: '2026-09-22T12:00:00.000Z',
      accessReservedBy: 'old-socket',
    }),
  },
  requestedPlayerId: 'player-authorized-fixture',
}), 'player-authorized-fixture', 'Sessão de pagamento consumida deve identificar somente o assento que a originou.');

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

async function connectClient() {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(socket);
  const connected = once(socket, 'connect');
  const identity = once(socket, 'connection:success');
  socket.connect();
  await connected;
  return { socket, playerId: (await identity).playerId };
}

function emitAction(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`ACK ${eventName} nao recebido.`)), 3000);
    socket.emit(eventName, payload, (ack) => {
      clearTimeout(timeout);
      resolve(ack);
    });
  });
}

try {
  await waitForHealth();

  const createResponse = await fetch(`${baseUrl}/api/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ autoStart: false }),
  });
  const createPayload = await createResponse.json();
  findings.push({
    check: 'POST /api/matches blocked or projected',
    passed: createResponse.status === 404
      || (!createPayload.match?.deck && !createPayload.match?.players?.some((player) => player.hand)),
  });

  const first = await connectClient();
  const second = await connectClient();
  const attacker = await connectClient();
  [first, second].forEach((client) => {
    client.socket.on('gameStateUpdated', (state) => {
      if (!monitoredMatchId || state?.matchId !== monitoredMatchId) return;
      visibleMatchSnapshots.set(client.socket.id, JSON.stringify({
        ownPlayerId: state.you?.playerId,
        ownHand: state.you?.hand?.map((card) => card.id),
        opponentHandCount: state.opponent?.handCount,
        deckCount: state.deckCount,
        currentTurnPlayerId: state.currentTurnPlayerId,
        turnNumber: state.turnNumber,
      }));
    });
  });
  const firstStarted = once(first.socket, 'matchStarted');
  const secondStarted = once(second.socket, 'matchStarted');
  const firstQueue = emitAction(first.socket, 'joinQueue', { playerName: 'Auth A', tableValue: 2 });
  const secondQueue = emitAction(second.socket, 'joinQueue', { playerName: 'Auth B', tableValue: 2 });
  const [stateA, stateB] = await Promise.all([firstStarted, secondStarted]);
  await Promise.all([firstQueue, secondQueue]);
  assert.equal(stateA.matchId, stateB.matchId);
  const matchId = stateA.matchId;
  monitoredMatchId = matchId;
  const playerA = stateA.you.playerId;
  const playerB = stateB.you.playerId;

  const listResponse = await fetch(`${baseUrl}/api/matches`);
  const listPayload = await listResponse.json();
  findings.push({
    check: 'GET /api/matches blocked or projected with an active match',
    passed: listResponse.status === 404
      || !listPayload.matches?.some((match) => match.deck || match.players?.some((player) => player.hand)),
  });

  const getResponse = await fetch(`${baseUrl}/api/matches/${encodeURIComponent(matchId)}`);
  const getPayload = await getResponse.json();
  findings.push({
    check: 'GET /api/matches/:matchId blocked or projected',
    passed: getResponse.status === 404
      || (!getPayload.match?.deck && !getPayload.match?.players?.some((player) => player.hand)),
  });

  const forgedState = once(first.socket, 'gameStateUpdated');
  first.socket.emit('requestGameState', { matchId, playerId: playerB });
  const forgedView = await forgedState;
  findings.push({
    check: 'requestGameState identity bound to socket',
    passed: forgedView.you?.playerId === playerA && forgedView.you?.playerId !== playerB,
  });

  const legitimateResumeState = once(first.socket, 'gameStateUpdated');
  first.socket.emit('resumeOnlineMatch', { matchId, playerId: playerA });
  const legitimateView = await legitimateResumeState;
  findings.push({
    check: 'resume keeps server-bound socket identity',
    passed: legitimateView.you?.playerId === playerA,
  });

  const secondOwnViewPromise = once(second.socket, 'gameStateUpdated');
  second.socket.emit('requestGameState', { matchId, playerId: playerB });
  const secondOwnView = await secondOwnViewPromise;
  findings.push({
    check: 'legitimate requestGameState retains own hand view',
    passed: secondOwnView.you?.playerId === playerB,
  });
  const snapshotsBeforeImpersonation = new Map(visibleMatchSnapshots);

  let attackerReceivedPrivateState = false;
  attacker.socket.on('gameStateUpdated', (state) => {
    if (state?.matchId === matchId) attackerReceivedPrivateState = true;
  });
  const activePlayerId = stateA.currentTurnPlayerId;
  assert.ok([playerA, playerB].includes(activePlayerId));
  attacker.socket.emit('resumeOnlineMatch', { matchId, playerId: activePlayerId });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const forgedActions = await Promise.all([
    emitAction(attacker.socket, 'playerDrawFromDeck', { matchId }),
    emitAction(attacker.socket, 'playerDiscardCard', { matchId, cardId: 'forged-card' }),
    emitAction(attacker.socket, 'playerKnock', { matchId }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  findings.push({
    check: 'unauthorized resume cannot bind socket or mutate match actions',
    passed: !attackerReceivedPrivateState
      && forgedActions.every((result) => result?.ok === false)
      && [...snapshotsBeforeImpersonation].every(([socketId, snapshot]) => visibleMatchSnapshots.get(socketId) === snapshot),
  });

  if (findings.some((finding) => !finding.passed)) {
    console.error('Authorization hardening findings:', JSON.stringify(findings));
  }
  assert.ok(findings.every((finding) => finding.passed), 'Uma ou mais protecoes de autorizacao falharam.');
  console.log('PASS rotas internas bloqueadas, identidade socket-bound e recuperacao nao forjavel');
} finally {
  clients.forEach((socket) => socket.connected && socket.disconnect());
  server.kill();
}
