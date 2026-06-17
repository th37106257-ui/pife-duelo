import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { config } from './config.js';
import { RoomManager } from './managers/RoomManager.js';
import { MatchManager } from './managers/MatchManager.js';
import { PlayerManager } from './managers/PlayerManager.js';
import { QueueManager } from './managers/QueueManager.js';
import { SocketManager } from './managers/SocketManager.js';
import { setupSocketServer } from './socket/index.js';
import { buildClientGameState } from './game/clientState.js';
import { listAdminLogs, recordAdminLog } from './adminStore.js';
import { logError, logInfo, logWarn } from './utils/logger.js';
import { calculatePrize, listOfficialTables } from '../../src/shared/economy.js';

const app = express();
const roomManager = new RoomManager();
const matchManager = new MatchManager();
const playerManager = new PlayerManager();
const socketManager = new SocketManager({ playerManager });
const queueManager = new QueueManager();
const corsOptions = {
  origin(origin, callback) {
    if (!origin || config.ALLOWED_CLIENT_URLS.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('cors-origin-not-allowed'));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

function isAdminRequest(request) {
  const password = request.get('x-admin-password') ?? request.body?.password ?? request.query?.password;
  return Boolean(config.ADMIN_PASSWORD && password === config.ADMIN_PASSWORD);
}

function requireAdmin(request, response) {
  if (isAdminRequest(request)) return true;

  recordAdminLog({
    adminAction: 'admin_auth_failed',
    targetId: request.path,
    reason: 'invalid-password',
    result: 'denied',
  });
  response.status(401).json({ error: 'admin-unauthorized' });
  return false;
}

function isToday(value) {
  if (!value) return false;
  const date = new Date(value);
  const now = new Date();
  return date.toDateString() === now.toDateString();
}

function getMatchDurationSeconds(match) {
  const started = Date.parse(match.startedAt);
  if (!Number.isFinite(started)) return 0;
  const finished = match.finishedAt ? Date.parse(match.finishedAt) : Date.now();
  return Math.max(0, Math.round((finished - started) / 1000));
}

function getActiveAdminMatches() {
  return matchManager.listMatches()
    .filter((match) => match.mode === 'online_1v1' && match.status !== 'finished')
    .map((match) => ({
      matchId: match.matchId,
      roomId: match.roomId,
      tableValue: match.tableValue,
      prize: match.economy?.winnerPrize ?? 0,
      economy: match.economy,
      player1: match.players[0]
        ? {
            playerId: match.players[0].id,
            name: match.players[0].name,
            isConnected: match.players[0].isConnected,
            handCount: match.players[0].hand?.length ?? match.players[0].handCount ?? 0,
          }
        : null,
      player2: match.players[1]
        ? {
            playerId: match.players[1].id,
            name: match.players[1].name,
            isConnected: match.players[1].isConnected,
            handCount: match.players[1].hand?.length ?? match.players[1].handCount ?? 0,
          }
        : null,
      currentTurnPlayerId: match.currentTurnPlayerId,
      turnSecondsLeft: match.turnSecondsLeft,
      status: match.status,
      durationSeconds: getMatchDurationSeconds(match),
      blockReason: match.blockReason ?? null,
      integrityErrors: match.integrityErrors ?? [],
    }));
}

function getOnlinePlayersForAdmin() {
  const queueEntries = queueManager.getQueue();
  const matches = matchManager.listMatches();

  return playerManager.listPlayers().map((player) => {
    const queueEntry = queueEntries.find((entry) => entry.playerId === player.id);
    const activeMatch = matches.find((match) =>
      match.mode === 'online_1v1' &&
      match.status !== 'finished' &&
      match.players.some((item) => item.id === player.id),
    );
    const matchPlayer = activeMatch?.players.find((item) => item.id === player.id);
    const isConnected = Boolean(matchPlayer?.isConnected ?? player.isConnected);
    const status = !isConnected
      ? 'desconectado'
      : activeMatch
        ? 'jogando'
        : queueEntry
          ? 'fila'
          : 'lobby';

    return {
      playerId: player.id,
      name: matchPlayer?.name ?? queueEntry?.playerName ?? player.name,
      socketId: matchPlayer?.socketId ?? queueEntry?.socketId ?? player.socketId,
      status,
      matchId: activeMatch?.matchId ?? null,
      lastActivity: matchPlayer?.disconnectedAt ?? queueEntry?.joinedAt ?? null,
    };
  });
}

function emitMatchToPlayers(gameState, eventName = 'matchFinished') {
  if (!gameState?.players) return;

  gameState.players.forEach((player) => {
    const targetSocket = socketManager.getSocket(player.socketId);
    if (!targetSocket) return;
    targetSocket.emit(eventName, buildClientGameState(gameState, player.id));
  });
}

app.get('/health', (request, response) => {
  response.json({
    status: 'ok',
    uptime: process.uptime(),
    activeMatches: matchManager.listMatches().filter((match) => match.status !== 'finished').length,
    onlinePlayers: socketManager.onlineCount(),
    queuedPlayers: queueManager.getQueueSize(),
    service: 'pife-duelo-server',
    phase: '4.13',
  });
});

app.get('/api/status', (request, response) => {
  response.json({
    ok: true,
    service: 'pife-duelo-server',
    phase: '4.13',
    environment: config.NODE_ENV,
    roomMode: config.ROOM_MODE,
    maxPlayersPerRoom: config.MAX_PLAYERS_PER_ROOM,
    turnDurationSeconds: config.TURN_DURATION_SECONDS,
    queueTimeoutSeconds: config.QUEUE_TIMEOUT_SECONDS,
    rooms: roomManager.listRooms().length,
    matches: matchManager.listMatches().length,
    queuedPlayers: queueManager.getQueueSize(),
  });
});

app.get('/api/economy/tables', (request, response) => {
  response.json({ tables: listOfficialTables() });
});

app.get('/api/economy/tables/:tableValue', (request, response) => {
  const prize = calculatePrize(request.params.tableValue);
  if (!prize) {
    response.status(404).json({ error: 'invalid-table-value' });
    return;
  }

  response.json({ prize });
});

app.get('/api/economy/results', (request, response) => {
  response.json({ results: matchManager.listEconomicResults() });
});

app.get('/api/match-history', (request, response) => {
  response.json({ history: matchManager.listMatchHistory() });
});

app.get('/api/match-history/:matchId/audit', (request, response) => {
  const audit = matchManager.getMatchAudit(request.params.matchId);
  if (!audit) {
    response.status(404).json({ error: 'match-history-not-found' });
    return;
  }

  response.json({ audit });
});

app.post('/api/admin/login', (request, response) => {
  if (!requireAdmin(request, response)) return;

  recordAdminLog({
    adminAction: 'admin_login',
    targetId: 'admin-panel',
    result: 'ok',
  });
  response.json({ ok: true });
});

app.get('/api/admin/dashboard', (request, response) => {
  if (!requireAdmin(request, response)) return;

  const history = matchManager.listMatchHistory({ limit: 1000 });
  const todayHistory = history.filter((record) => isToday(record.finishedAt ?? record.createdAt));
  const activeMatches = getActiveAdminMatches();
  const errorMatches = activeMatches.filter((match) =>
    match.status === 'paused' ||
    match.status === 'error' ||
    match.blockReason ||
    match.integrityErrors.length > 0,
  );

  response.json({
    dashboard: {
      onlinePlayers: socketManager.onlineCount(),
      activeMatches: activeMatches.length,
      finishedToday: todayHistory.length,
      totalPotToday: todayHistory.reduce((total, record) => total + Number(record.totalPot || 0), 0),
      platformFeeToday: todayHistory.reduce((total, record) => total + Number(record.platformFeeAmount || 0), 0),
      stuckMatches: errorMatches.length,
    },
    adminLogs: listAdminLogs({ limit: 30 }),
  });
});

app.get('/api/admin/active-matches', (request, response) => {
  if (!requireAdmin(request, response)) return;
  response.json({ matches: getActiveAdminMatches() });
});

app.get('/api/admin/online-players', (request, response) => {
  if (!requireAdmin(request, response)) return;
  response.json({ players: getOnlinePlayersForAdmin() });
});

app.get('/api/admin/match-history', (request, response) => {
  if (!requireAdmin(request, response)) return;
  response.json({ history: matchManager.listMatchHistory({ limit: 1000 }) });
});

app.get('/api/admin/match-audit/:matchId', (request, response) => {
  if (!requireAdmin(request, response)) return;

  const audit = matchManager.getMatchAudit(request.params.matchId);
  recordAdminLog({
    adminAction: 'view_match_audit',
    targetId: request.params.matchId,
    result: audit ? 'ok' : 'not-found',
  });

  if (!audit) {
    response.status(404).json({ error: 'match-audit-not-found' });
    return;
  }

  response.json({ audit });
});

app.post('/api/admin/matches/:matchId/end', (request, response) => {
  if (!requireAdmin(request, response)) return;

  const reason = request.body?.reason || 'admin_closed';
  const result = matchManager.adminEndMatch(request.params.matchId, reason);
  recordAdminLog({
    adminAction: 'admin_end_match',
    targetId: request.params.matchId,
    reason,
    result: result.blocked ? result.reason : 'ok',
  });

  if (result.blocked) {
    response.status(400).json({ error: result.reason, message: result.message });
    return;
  }

  emitMatchToPlayers(result.gameState);
  response.json({ match: result.gameState });
});

app.post('/api/admin/matches/:matchId/force-winner', (request, response) => {
  if (!requireAdmin(request, response)) return;

  const winnerId = request.body?.winnerId;
  const reason = request.body?.reason || 'admin_decision';
  const result = matchManager.adminForceWinner(request.params.matchId, winnerId, reason);
  recordAdminLog({
    adminAction: 'admin_force_winner',
    targetId: request.params.matchId,
    reason,
    result: result.blocked ? result.reason : 'ok',
  });

  if (result.blocked) {
    response.status(400).json({ error: result.reason, message: result.message });
    return;
  }

  emitMatchToPlayers(result.gameState);
  response.json({ match: result.gameState });
});

app.delete('/api/admin/rooms/:roomId', (request, response) => {
  if (!requireAdmin(request, response)) return;

  const room = roomManager.getRoom(request.params.roomId);
  if (!room) {
    recordAdminLog({
      adminAction: 'admin_remove_room',
      targetId: request.params.roomId,
      result: 'room-not-found',
    });
    response.status(404).json({ error: 'room-not-found' });
    return;
  }

  const hasActiveMatch = room.matchId && matchManager.getMatch(room.matchId)?.status !== 'finished';
  if (hasActiveMatch && !request.body?.confirmActiveMatch) {
    recordAdminLog({
      adminAction: 'admin_remove_room',
      targetId: request.params.roomId,
      result: 'active-match-needs-confirmation',
    });
    response.status(409).json({ error: 'active-match-needs-confirmation' });
    return;
  }

  const removedRoom = roomManager.deleteRoom(request.params.roomId);
  recordAdminLog({
    adminAction: 'admin_remove_room',
    targetId: request.params.roomId,
    reason: request.body?.reason || 'admin_remove_room',
    result: 'ok',
  });
  response.json({ room: removedRoom });
});

app.get('/api/rooms', (request, response) => {
  response.json({ rooms: roomManager.listRooms() });
});

app.post('/api/rooms', (request, response) => {
  const playerNames = Array.isArray(request.body?.players) ? request.body.players : [];
  const players = playerNames.slice(0, config.MAX_PLAYERS_PER_ROOM).map((player, index) =>
    playerManager.createPlayer({
      name: player.name ?? `Jogador ${index + 1}`,
      socketId: player.socketId ?? null,
      position: index === 0 ? 'bottom' : 'top',
    }),
  );
  const room = roomManager.createRoom({ players });

  logInfo('ROOM_CREATED', { roomId: room.roomId, playerCount: players.length });
  response.status(201).json({ room });
});

app.get('/api/rooms/:roomId', (request, response) => {
  const room = roomManager.getRoom(request.params.roomId);
  if (!room) {
    response.status(404).json({ error: 'room-not-found' });
    return;
  }

  response.json({ room });
});

app.get('/api/matches', (request, response) => {
  response.json({ matches: matchManager.listMatches() });
});

app.post('/api/matches', (request, response) => {
  const roomId = request.body?.roomId;
  const room = roomId ? roomManager.getRoom(roomId) : roomManager.createRoom();
  if (!room) {
    response.status(404).json({ error: 'room-not-found' });
    return;
  }

  const players = room.players.length > 0
    ? room.players
    : [
        playerManager.createPlayer({ name: 'Jogador 1', position: 'bottom' }),
        playerManager.createPlayer({ name: 'Jogador 2', position: 'top' }),
      ];
  const match = matchManager.createMatch(room.roomId, players);
  const startedMatch = request.body?.autoStart === false ? match : matchManager.startMatch(match.matchId);
  roomManager.setRoomMatch(room.roomId, startedMatch.matchId);

  logInfo('MATCH_CREATED', { roomId: room.roomId, matchId: startedMatch.matchId });
  response.status(201).json({ match: startedMatch });
});

app.get('/api/matches/:matchId', (request, response) => {
  const match = matchManager.getMatch(request.params.matchId);
  if (!match) {
    response.status(404).json({ error: 'match-not-found' });
    return;
  }

  response.json({ match });
});

app.use((request, response) => {
  logWarn('ROUTE_NOT_FOUND', { method: request.method, path: request.path });
  response.status(404).json({ error: 'route-not-found' });
});

app.use((error, request, response, next) => {
  logError('SERVER_ERROR', { message: error.message });
  response.status(500).json({ error: 'server-error' });
});

const server = http.createServer(app);
const io = setupSocketServer(server, {
  roomManager,
  matchManager,
  playerManager,
  socketManager,
  queueManager,
  corsOptions,
});

server.listen(config.PORT, () => {
  if (!config.ADMIN_PASSWORD) {
    logWarn('ADMIN_PASSWORD_NOT_CONFIGURED', {
      message: 'Admin endpoints will reject access until ADMIN_PASSWORD is configured.',
    });
  }

  logInfo('SERVER_STARTED', {
    port: config.PORT,
    environment: config.NODE_ENV,
    clientUrls: config.ALLOWED_CLIENT_URLS,
    phase: '4.13',
  });
});

export { app, server, io, roomManager, matchManager, playerManager, socketManager, queueManager };
