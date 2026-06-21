import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import {
  getDailyObservabilityMetrics,
  getErrorCountSince,
  listObservabilityLogs,
  recordClientError,
} from './observabilityStore.js';

const app = express();
const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, '../../dist');
const indexPath = resolve(distPath, 'index.html');
const roomManager = new RoomManager();
const matchManager = new MatchManager();
const playerManager = new PlayerManager();
const socketManager = new SocketManager({ playerManager });
const queueManager = new QueueManager();
const reportedStuckMatches = new Set();

function isAllowedRailwayOrigin(origin) {
  try {
    return new URL(origin).hostname.endsWith('.up.railway.app');
  } catch {
    return false;
  }
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin || config.ALLOWED_CLIENT_URLS.includes(origin) || isAllowedRailwayOrigin(origin)) {
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
  logWarn('ADMIN_AUTH_FAILED', {
    path: request.path,
    message: 'Tentativa de acesso admin rejeitada.',
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

function getMatchStuckStatus(match) {
  const reasons = [];
  const players = match?.players ?? [];
  const lastLogAt = Date.parse(match?.matchLog?.at(-1)?.timestamp ?? match?.turnStartedAt ?? match?.startedAt);
  const idleSeconds = Number.isFinite(lastLogAt) ? Math.floor((Date.now() - lastLogAt) / 1000) : 0;
  const threshold = Math.max(90, Number(match?.turnDurationSeconds || config.TURN_DURATION_SECONDS) + 30);

  if (!players.length) reasons.push('active_without_players');
  if (players.length > 0 && players.every((player) => !player.isConnected)) reasons.push('all_players_disconnected');
  if (match?.status === 'playing' && idleSeconds > threshold) reasons.push('no_recent_action');
  if (match?.status === 'playing' && !matchManager.hasActiveTurnTimer(match.matchId)) reasons.push('turn_timer_missing');
  if (match?.blockReason || (match?.integrityErrors?.length ?? 0) > 0) reasons.push('invalid_state');

  return { stuckWarning: reasons.length > 0, reasons, idleSeconds };
}

function getProductionMetrics() {
  const history = matchManager.listMatchHistory({ limit: 1000 });
  const todayHistory = history.filter((record) => isToday(record.finishedAt ?? record.createdAt));
  const daily = getDailyObservabilityMetrics();
  const durations = todayHistory.map((record) => Number(record.durationSeconds || 0)).filter((value) => value > 0);
  return {
    ...daily,
    finishedMatchesToday: Math.max(daily.finishedMatchesToday, todayHistory.length),
    activeMatches: matchManager.listMatches().filter((match) => match.status !== 'finished').length,
    onlinePlayers: socketManager.onlineCount(),
    averageMatchDurationSeconds: durations.length
      ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
      : 0,
  };
}

function getActiveAdminMatches() {
  return matchManager.listMatches()
    .filter((match) => match.mode === 'online_1v1' && match.status !== 'finished')
    .map((match) => {
      const stuck = getMatchStuckStatus(match);
      return ({
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
      stuckWarning: stuck.stuckWarning,
      stuckReasons: stuck.reasons,
      idleSeconds: stuck.idleSeconds,
    });
    });
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
  const metrics = getProductionMetrics();
  const memory = process.memoryUsage();
  response.json({
    ok: true,
    status: 'ok',
    time: new Date().toISOString(),
    uptime: process.uptime(),
    onlinePlayers: metrics.onlinePlayers,
    activeMatches: metrics.activeMatches,
    waitingPlayers: queueManager.getQueueSize(),
    queuedPlayers: queueManager.getQueueSize(),
    finishedMatchesToday: metrics.finishedMatchesToday,
    errorCountLastHour: getErrorCountSince(Date.now() - 60 * 60 * 1000),
    memoryUsage: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    },
    service: 'pife-duelo-server',
    phase: '4.15',
  });
});

app.post('/api/client-errors', (request, response) => {
  recordClientError(request.body ?? {});
  response.status(202).json({ accepted: true });
});

app.get('/api/status', (request, response) => {
  response.json({
    ok: true,
    service: 'pife-duelo-server',
    phase: '4.15',
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
    match.integrityErrors.length > 0 ||
    match.stuckWarning,
  );
  const observability = listObservabilityLogs({ limit: 200 });
  const metrics = getProductionMetrics();

  response.json({
    dashboard: {
      onlinePlayers: socketManager.onlineCount(),
      activeMatches: activeMatches.length,
      finishedToday: todayHistory.length,
      totalPotToday: todayHistory.reduce((total, record) => total + Number(record.totalPot || 0), 0),
      platformFeeToday: todayHistory.reduce((total, record) => total + Number(record.platformFeeAmount || 0), 0),
      stuckMatches: errorMatches.length,
    },
    metrics,
    monitoring: {
      serverErrors: observability.server,
      clientErrors: observability.client,
      events: observability.events,
      stuckMatches: errorMatches,
    },
    adminLogs: listAdminLogs({ limit: 30 }),
  });
});

app.get('/api/admin/monitoring', (request, response) => {
  if (!requireAdmin(request, response)) return;
  const activeMatches = getActiveAdminMatches();
  response.json({
    metrics: getProductionMetrics(),
    logs: listObservabilityLogs({ limit: request.query.limit }),
    stuckMatches: activeMatches.filter((match) => match.stuckWarning),
    generatedAt: new Date().toISOString(),
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

  logInfo('ADMIN_MATCH_CLOSED', {
    matchId: request.params.matchId,
    roomId: result.gameState?.roomId,
    reason,
  });

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

  logInfo('ADMIN_FORCE_WINNER', {
    matchId: request.params.matchId,
    roomId: result.gameState?.roomId,
    winnerId,
    reason,
  });

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

if (existsSync(distPath)) {
  app.use(express.static(distPath, {
    index: false,
    maxAge: config.NODE_ENV === 'production' ? '1h' : 0,
  }));

  const renderClientHtml = () => {
    const html = readFileSync(indexPath, 'utf8');
    const scriptMatch = html.match(/\s*<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/);
    if (!scriptMatch) return html;

    const scriptSrc = scriptMatch[1];
    return html
      .replace(scriptMatch[0], '')
      .replace(/\s+crossorigin/g, '')
      .replace(
        '</body>',
        `    <script defer src="${scriptSrc}"></script>\n  </body>`,
      );
  };

  app.get('*', (request, response, next) => {
    if (
      request.path.startsWith('/api/') ||
      request.path === '/health' ||
      request.path.startsWith('/socket.io/')
    ) {
      next();
      return;
    }

    response
      .type('html')
      .set('Cache-Control', 'no-store')
      .send(renderClientHtml());
  });
}

app.use((request, response) => {
  logWarn('ROUTE_NOT_FOUND', { method: request.method, path: request.path });
  response.status(404).json({ error: 'route-not-found' });
});

app.use((error, request, response, next) => {
  logError('SERVER_ERROR', {
    message: error.message,
    stack: error.stack,
    method: request.method,
    path: request.path,
  });
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

const stuckMatchMonitor = setInterval(() => {
  matchManager.listMatches()
    .forEach((match) => {
      if (match.status === 'finished') {
        reportedStuckMatches.delete(match.matchId);
        return;
      }
      const status = getMatchStuckStatus(match);
      if (status.stuckWarning && !reportedStuckMatches.has(match.matchId)) {
        reportedStuckMatches.add(match.matchId);
        logWarn('STUCK_MATCH_DETECTED', {
          matchId: match.matchId,
          roomId: match.roomId,
          message: 'Partida suspeita detectada pelo monitor.',
          reasons: status.reasons,
          idleSeconds: status.idleSeconds,
        });
      }
      if (!status.stuckWarning) reportedStuckMatches.delete(match.matchId);
    });
}, 30000);
stuckMatchMonitor.unref?.();

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
    phase: '4.15',
  });
});

process.on('unhandledRejection', (error) => {
  logError('UNHANDLED_REJECTION', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  });
});

export { app, server, io, roomManager, matchManager, playerManager, socketManager, queueManager };
