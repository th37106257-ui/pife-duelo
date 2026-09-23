import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { io } from 'socket.io-client';
import { createRateLimiter } from '../server/src/security/rateLimiter.js';
import { MatchManager } from '../server/src/managers/MatchManager.js';
import { QueueManager } from '../server/src/managers/QueueManager.js';
import * as matchHistory from '../server/src/matchHistory.js';
import { readFileSync } from 'node:fs';
import { buildAllowedClientOrigins } from '../server/src/security/clientOrigins.js';
import { getHttpClientIp, getSocketClientIp } from '../server/src/socket/clientIp.js';

const serverSource = readFileSync(new URL('../server/src/index.js', import.meta.url), 'utf8');
assert.match(serverSource, /!config\.EVOLUTION_WEBHOOK_SECRET\s*\|\|\s*!secureEquals\(getWebhookSecret\(request\), config\.EVOLUTION_WEBHOOK_SECRET\)/,
  'Evolution deve rejeitar explicitamente configuração de segredo ausente');
const socketSource = readFileSync(new URL('../server/src/socket/index.js', import.meta.url), 'utf8');
assert.match(socketSource, /connect:\$\{getSocketClientIp\(socket\)\}/);
assert.match(socketSource, /queue-ip:\$\{getSocketClientIp\(socket\)\}/);
assert.match(socketSource, /recover-ip:\$\{getSocketClientIp\(socket\)\}/);
assert.equal(socketSource.includes('socket.handshake.address'), false, 'rate limits não devem usar IP bruto do handshake diretamente');

const limiter = createRateLimiter({ maxBuckets: 2 });
assert.equal(limiter.consume('first', { limit: 1, windowMs: 1000 }).allowed, true);
assert.equal(limiter.consume('second', { limit: 1, windowMs: 1000 }).allowed, true);
assert.equal(limiter.consume('third', { limit: 1, windowMs: 1000 }).allowed, true);
assert.equal(limiter.consume('first', { limit: 1, windowMs: 1000 }).allowed, true, 'limiter bounded deve expulsar a chave mais antiga');

const httpRequest = (realIp, requestIp = '152.233.23.193') => ({
  get: (name) => name === 'x-real-ip' ? realIp : undefined,
  headers: realIp ? { 'x-real-ip': realIp } : {},
  ip: requestIp,
  socket: { remoteAddress: requestIp },
});
assert.equal(getHttpClientIp(httpRequest('179.42.141.163')), '179.42.141.163', 'HTTP deve priorizar X-Real-IP validado');
assert.equal(getHttpClientIp(httpRequest('invalid-ip')), '152.233.23.193', 'X-Real-IP invalido deve usar fallback seguro');

const socketIp = (address, forwardedFor, realIp) => getSocketClientIp({
  handshake: { address, headers: { ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}), ...(realIp ? { 'x-real-ip': realIp } : {}) } },
});
assert.equal(socketIp('10.0.0.2', '198.51.100.200, 203.0.113.10', '179.42.141.163'), '179.42.141.163', 'Socket deve priorizar X-Real-IP validado');
const socketIpA = socketIp('10.0.0.2', '198.51.100.200, 203.0.113.10');
const socketIpB = socketIp('10.0.0.2', '192.0.2.250, 203.0.113.11');
const socketIpSameAsA = socketIp('10.0.0.2', '192.0.2.251, 203.0.113.10');
assert.equal(socketIpA, '203.0.113.10');
assert.equal(socketIpB, '203.0.113.11', 'clientes distintos atrás do mesmo proxy têm buckets diferentes');
assert.equal(socketIpSameAsA, socketIpA, 'prefixo X-Forwarded-For forjado à esquerda não troca o IP considerado');
const socketIpLimiter = createRateLimiter();
assert.equal(socketIpLimiter.consume(`connect:${socketIpA}`, { limit: 1, windowMs: 1000 }).allowed, true);
assert.equal(socketIpLimiter.consume(`connect:${socketIpB}`, { limit: 1, windowMs: 1000 }).allowed, true);
assert.equal(socketIpLimiter.consume(`connect:${socketIpSameAsA}`, { limit: 1, windowMs: 1000 }).allowed, false,
  'sockets do mesmo IP compartilham bucket');
assert.equal(socketIp('10.0.0.7', 'spoofed-left, invalid-ip'), '10.0.0.7', 'header inválido usa endereço do handshake');

const configuredOrigins = buildAllowedClientOrigins({
  frontendUrl: 'https://pife-duelo-production-4f73.up.railway.app/app/path',
  clientUrl: 'http://localhost:5173/game',
  allowedClientUrls: 'https://preview.pife.example/path',
  publicGameUrl: 'https://pife-duelo-production-4f73.up.railway.app/join',
});
assert.ok(configuredOrigins.includes('https://pife-duelo-production-4f73.up.railway.app'));
assert.ok(configuredOrigins.includes('http://localhost:5173'));
assert.ok(configuredOrigins.includes('https://preview.pife.example'));
assert.equal(configuredOrigins.includes('https://untrusted.up.railway.app'), false);
assert.equal(configuredOrigins.includes('https://attacker.example'), false);

const matchManager = new MatchManager({ maxRetainedFinishedMatches: 2 });
const testMatch = matchManager.createOnlineMatch('room-payload-test', [
  { id: 'player-payload-a', name: 'A' },
  { id: 'player-payload-b', name: 'B' },
], 5);
let oversizedArrayEnumerated = false;
const oversizedHandOrder = new Proxy(Array(10_000).fill('not-a-card'), {
  get(target, property, receiver) {
    if (property === 'map') oversizedArrayEnumerated = true;
    return Reflect.get(target, property, receiver);
  },
});
const oversizedHandResult = matchManager.reorderOnlineHand(testMatch.matchId, 'player-payload-a', oversizedHandOrder);
assert.equal(oversizedHandResult.blocked, true);
assert.equal(oversizedArrayEnumerated, false, 'ordem de mão fora do tamanho permitido deve ser rejeitada sem percorrer o array');
const finishedMatchIds = [];
for (let index = 0; index < 3; index += 1) {
  const match = matchManager.createOnlineMatch(`retention-room-${index}`, [
    { id: `retention-a-${index}`, name: 'A' },
    { id: `retention-b-${index}`, name: 'B' },
  ], 5);
  finishedMatchIds.push(match.matchId);
  assert.equal(matchManager.adminEndMatch(match.matchId).blocked, false);
}
assert.equal(matchManager.getMatch(finishedMatchIds[0]), null, 'registros finalizados antigos devem ser podados');
assert.ok(matchManager.getMatch(finishedMatchIds[1]));
assert.ok(matchManager.getMatch(finishedMatchIds[2]));

const boundedQueue = new QueueManager({ maxEntriesPerTable: 1, timeoutSeconds: 60 });
const queueEntry = (playerId) => ({ playerId, socketId: `socket-${playerId}`, tableValue: 5 });
assert.equal(boundedQueue.joinQueue(queueEntry('queue-a')).blocked, false);
assert.deepEqual(boundedQueue.joinQueue(queueEntry('queue-b')), { blocked: true, reason: 'queue-full' });
assert.equal(boundedQueue.getQueueSize(5), 1, 'fila cheia deve recusar nova reserva sem crescer');
boundedQueue.clearQueue();

matchHistory.clearMatchHistory();
matchHistory.createMatchHistory({
  matchId: 'match-internal-sensitive-id',
  roomId: 'room-internal-sensitive-id',
  status: 'finished',
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  finishedAt: new Date().toISOString(),
  players: [
    { id: 'player-private-a', name: '+55 (11) 99999-1234' },
    { id: 'player-private-b', name: 'player-private-b' },
  ],
  result: { winnerId: 'player-internal-missing-winner', loserId: 'player-private-b', reason: 'knock' },
  economicResult: { tableValue: 5, totalPot: 10, winnerPrize: 9, platformFeeAmount: 1, platformFeePercent: 10 },
  matchLog: [{
    timestamp: new Date().toISOString(),
    playerId: 'player-private-a',
    action: 'playerDiscardCard',
    payloadResumo: { matchId: 'match-internal-sensitive-id', roomId: 'room-internal-sensitive-id', cardId: 'card-private' },
    accepted: true,
  }],
});
const publicHistory = matchHistory.listPublicMatchHistory();
assert.equal(publicHistory.length, 1);
for (const forbiddenKey of ['roomId', 'player1Id', 'player2Id', 'winnerId', 'loserId', 'logs']) {
  assert.equal(forbiddenKey in publicHistory[0], false, `histórico público não deve conter ${forbiddenKey}`);
}
assert.notEqual(publicHistory[0].matchId, 'match-internal-sensitive-id');
assert.equal(publicHistory[0].player1Name, 'Jogador 1');
assert.equal(publicHistory[0].player2Name, 'Jogador 2');
assert.equal(publicHistory[0].winnerName, 'Vencedor');
assert.equal(publicHistory[0].loserName, 'Adversário');
const publicSerialized = JSON.stringify(publicHistory[0]);
for (const forbiddenValue of [
  'player-internal-missing-winner', 'player-private-a', 'player-private-b',
  'room-internal-sensitive-id', 'match-internal-sensitive-id', '11999991234',
]) {
  assert.equal(publicSerialized.includes(forbiddenValue), false, `projeção pública não deve conter ${forbiddenValue}`);
}
assert.equal(matchHistory.getMatchAudit('match-internal-sensitive-id').winnerName, 'player-internal-missing-winner',
  'registro administrativo interno permanece inalterado');
const publicAudit = matchHistory.getPublicMatchAudit(publicHistory[0].matchId);
assert.ok(publicAudit);
assert.equal(publicAudit.logs[0].playerId, undefined);
assert.equal(publicAudit.logs[0].payloadResumo, undefined);
assert.equal(JSON.stringify(publicAudit).includes('room-internal-sensitive-id'), false);
matchHistory.clearMatchHistory();

const probeServer = createServer();
await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
const port = probeServer.address().port;
await new Promise((resolve) => probeServer.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const adminPassword = 'local-public-surface-test-password';
const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    ADMIN_PASSWORD: adminPassword,
    FRONTEND_URL: `${baseUrl}/configured-path`,
    CLIENT_URL: baseUrl,
    PUBLIC_GAME_URL: `${baseUrl}/join`,
    ALLOWED_CLIENT_URLS: baseUrl,
    FINANCIAL_WALLET_ENABLED: 'false',
    PIX_DEPOSITS_ENABLED: 'false',
    REAL_MONEY_GAMES_ENABLED: 'false',
    WITHDRAWALS_ENABLED: 'false',
    AUTO_WITHDRAWALS_ENABLED: 'false',
    FINANCIAL_MODE: 'sandbox',
    PAYMENT_PROVIDER: 'mock',
    DATABASE_URL: '',
    ASAAS_API_KEY: '',
    ASAAS_WEBHOOK_TOKEN: '',
    DEMO_CREDITS_ENABLED: 'false',
    WHATSAPP_PAYMENTS_ENABLED: 'false',
    PAYMENT_GATE_ENABLED: 'false',
    WHATSAPP_SAFE_ENTRY_ENABLED: 'false',
    WHATSAPP_FIRST_LOBBY_ENABLED: 'false',
    PAYMENT_STORE_PATH: '',
    WHATSAPP_ENTRY_STORE_PATH: '',
    DEMO_CREDITS_STORE_PATH: '',
    PAYMENT_ACCESS_SECRET: '',
    WHATSAPP_ENTRY_ACCESS_SECRET: '',
    WHATSAPP_ADMIN_NUMBERS: '',
    EVOLUTION_API_URL: '',
    EVOLUTION_API_KEY: '',
    EVOLUTION_INSTANCE_NAME: '',
    WHATSAPP_PROVIDER: 'meta_cloud',
    WHATSAPP_CONNECTIVITY_TEST_ENABLED: 'true',
    META_WHATSAPP_TOKEN: 'test-token-not-a-credential',
    META_PHONE_NUMBER_ID: 'test-phone-id',
    META_VERIFY_TOKEN: 'test-verify-token',
    META_APP_SECRET: 'test-app-secret',
    META_GRAPH_API_VERSION: 'v99.0',
    EVOLUTION_WEBHOOK_SECRET: 'local-evolution-webhook-secret',
  },
  stdio: 'ignore',
});
const sockets = [];

async function waitForHealth() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Servidor local da auditoria não iniciou.');
}

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

try {
  const health = await waitForHealth();
  const healthBody = await health.json();
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(healthBody).sort(), ['ok', 'service', 'status', 'time', 'uptime']);

  const publicStatus = await request('/api/status');
  assert.equal(publicStatus.status, 401);
  const queryPasswordStatus = await request(`/api/status?password=${encodeURIComponent(adminPassword)}`);
  assert.equal(queryPasswordStatus.status, 401, 'senha em query não deve autenticar');
  const bodyPasswordStatus = await request('/api/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPassword }),
  });
  assert.notEqual(bodyPasswordStatus.status, 200, 'senha no body não deve autenticar');
  const bodyPasswordLogin = await request('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPassword }),
  });
  assert.equal(bodyPasswordLogin.status, 401, 'senha no body não deve autenticar endpoints admin');
  const adminStatus = await request('/api/status', { headers: { 'x-admin-password': adminPassword } });
  assert.equal(adminStatus.status, 200);
  const adminStatusBody = await adminStatus.json();
  assert.equal(adminStatusBody.rooms, 0);
  assert.equal(typeof adminStatusBody.financialWallet?.enabled, 'boolean', 'detalhes operacionais ficam atrás da autenticação admin');
  assert.equal('financialWallet' in healthBody, false, 'health público não deve revelar configuração financeira');

  for (const [method, path, body] of [
    ['GET', '/api/rooms', undefined],
    ['POST', '/api/rooms', { players: [{ name: 'anon' }] }],
    ['GET', '/api/rooms/arbitrary-room-id', undefined],
    ['GET', '/api/matches', undefined],
    ['POST', '/api/matches', {},],
    ['GET', '/api/matches/arbitrary-match-id', undefined],
  ]) {
    const response = await request(path, {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 404, `${method} ${path} deve permanecer inacessível publicamente`);
  }
  const statusAfterRoomAttempts = await request('/api/status', { headers: { 'x-admin-password': adminPassword } });
  assert.equal((await statusAfterRoomAttempts.json()).rooms, 0, 'tentativas públicas não devem criar salas ou jogadores órfãos');

  const economyResults = await request('/api/economy/results');
  assert.equal(economyResults.status, 401);
  const malformedAdminPath = await request('/api/admin/match-audit/%2e%2e');
  assert.ok([401, 403, 404].includes(malformedAdminPath.status));

  const failedAdminAttempts = [];
  for (let attempt = 0; attempt < 15; attempt += 1) {
    failedAdminAttempts.push(await request('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': 'invalid-test-password' },
      body: '{}',
    }));
  }
  assert.ok(failedAdminAttempts.some((response) => response.status === 429), 'tentativas admin inválidas devem sofrer rate limit');
  const adminDashboard = await request('/api/admin/dashboard', { headers: { 'x-admin-password': adminPassword } });
  assert.equal(adminDashboard.status, 200, 'credencial válida permanece funcional após falhas limitadas');
  const adminPlayersBefore = await request('/api/admin/online-players', { headers: { 'x-admin-password': adminPassword } });
  assert.equal(adminPlayersBefore.status, 200);

  const malformedJson = await request('/api/webhooks/evolution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid',
  });
  assert.equal(malformedJson.status, 400);
  assert.equal((await malformedJson.text()).includes('stack'), false);
  const oversizedJson = await request('/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'x'.repeat(110 * 1024) }),
  });
  assert.equal(oversizedJson.status, 413);
  assert.equal((await oversizedJson.text()).includes('stack'), false);
  const clientErrorResponses = [];
  for (let index = 0; index < 61; index += 1) {
    clientErrorResponses.push(await request('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'bounded diagnostic test' }),
    }));
  }
  assert.equal(clientErrorResponses.at(-1).status, 429, 'endpoint anônimo de diagnóstico deve limitar flood');

  for (let index = 0; index < 12; index += 1) {
    const socket = io(baseUrl, { autoConnect: false, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    const connected = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Socket local não conectou.')), 3000);
      socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    });
    socket.connect();
    await connected;
    socket.disconnect();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const adminPlayersAfter = await request('/api/admin/online-players', { headers: { 'x-admin-password': adminPassword } });
  const playersAfter = await adminPlayersAfter.json();
  assert.deepEqual(playersAfter.players, [], 'visitantes desconectados não devem ficar retidos em memória');

  const socket = io(baseUrl, { autoConnect: false, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  const socketConnected = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket local para rate-limit não conectou.')), 3000);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
  });
  socket.connect();
  await socketConnected;
  const queueStatusResponses = [];
  const queueStatusListener = (payload) => queueStatusResponses.push(payload);
  socket.on('queueStatus', queueStatusListener);
  for (let index = 0; index < 40; index += 1) socket.emit('requestQueueStatus', { tableValue: 5 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  socket.off('queueStatus', queueStatusListener);
  assert.ok(queueStatusResponses.length < 40, 'solicitações Socket.IO repetidas devem ser limitadas');

  const deniedOrigin = await request('/health', { headers: { Origin: 'https://attacker.example' } });
  assert.equal(deniedOrigin.status, 403);
  assert.equal(deniedOrigin.headers.get('access-control-allow-origin'), null);
  const allowedOrigin = await request('/health', { headers: { Origin: baseUrl } });
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), baseUrl);
  const untrustedRailwayOrigin = await request('/health', { headers: { Origin: 'https://other-service.up.railway.app' } });
  assert.equal(untrustedRailwayOrigin.status, 403, 'Railway origin desconhecida não é liberada por wildcard');
  assert.equal((await request('/health')).status, 200, 'server-to-server sem Origin permanece permitido');

  const invalidEvolution = await request('/api/webhooks/evolution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-evolution-webhook-secret': 'invalid' },
    body: '{}',
  });
  assert.equal(invalidEvolution.status, 401);
  const validEvolution = await request('/api/webhooks/evolution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-evolution-webhook-secret': 'local-evolution-webhook-secret' },
    body: '{}',
  });
  assert.equal(validEvolution.status, 200, 'webhook Evolution válido recebe payload vazio sem crash');
  const invalidMetaVerification = await request('/api/webhooks/meta-whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test');
  assert.equal(invalidMetaVerification.status, 403);
  const invalidMetaSignature = await request('/api/webhooks/meta-whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=invalid' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
  });
  assert.equal(invalidMetaSignature.status, 401);
  const inactiveAsaas = await request('/api/financial/webhooks/asaas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'asaas-access-token': 'invalid' },
    body: '{}',
  });
  assert.equal(inactiveAsaas.status, 503);

  console.log('Public surface hardening: endpoints, auth, limits, projections, payloads, CORS e limpeza de sockets validados.');
} finally {
  sockets.forEach((socket) => socket.disconnect());
  server.kill();
}
