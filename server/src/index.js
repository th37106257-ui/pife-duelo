import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
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
import { PaymentStore } from './payments/PaymentStore.js';
import { maskPhone, PaymentService } from './payments/PaymentService.js';
import { EvolutionClient } from './payments/EvolutionClient.js';
import { buildEvolutionMessageDiagnostic, WhatsAppPaymentBot } from './payments/WhatsAppPaymentBot.js';
import { WhatsAppEntryStore } from './entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from './entries/WhatsAppEntryService.js';
import { MatchQueue } from './services/matchQueue.js';
import {
  getDailyObservabilityMetrics,
  getErrorCountSince,
  listObservabilityLogs,
  recordClientError,
} from './observabilityStore.js';

const app = express();
app.set('trust proxy', 1);
const here = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(here, '../../dist');
const indexPath = resolve(distPath, 'index.html');
const roomManager = new RoomManager();
const matchManager = new MatchManager();
const playerManager = new PlayerManager();
const socketManager = new SocketManager({ playerManager });
const queueManager = new QueueManager();
const reportedStuckMatches = new Set();
const paymentStore = new PaymentStore({ filePath: config.PAYMENT_STORE_PATH || null });
const paymentService = new PaymentService({
  store: paymentStore,
  adminNumbers: config.ADMIN_WHATSAPP_NUMBERS,
  accessSecret: config.PAYMENT_ACCESS_SECRET,
  publicGameUrl: config.PUBLIC_GAME_URL,
  paymentExpiryMinutes: config.PAYMENT_EXPIRY_MINUTES,
  accessTtlMinutes: config.PAYMENT_ACCESS_TTL_MINUTES,
});
const whatsappEntryStore = new WhatsAppEntryStore({ filePath: config.WHATSAPP_ENTRY_STORE_PATH || null });
const whatsappEntryService = new WhatsAppEntryService({
  store: whatsappEntryStore,
  adminNumbers: config.ADMIN_WHATSAPP_NUMBERS,
  accessSecret: config.WHATSAPP_ENTRY_ACCESS_SECRET,
  publicGameUrl: config.PUBLIC_GAME_URL,
  entryExpiryMinutes: config.WHATSAPP_ENTRY_EXPIRY_MINUTES,
  accessTtlMinutes: config.WHATSAPP_ENTRY_ACCESS_TTL_MINUTES,
});
const evolutionClient = new EvolutionClient({
  baseUrl: config.EVOLUTION_API_URL,
  apiKey: config.EVOLUTION_API_KEY,
  instanceName: config.EVOLUTION_INSTANCE_NAME,
});
const whatsappMatchQueue = new MatchQueue({
  entryService: whatsappEntryService,
  logInfo,
  logWarn,
  logError,
});
const whatsappPaymentBot = new WhatsAppPaymentBot({
  paymentService,
  entryService: whatsappEntryService,
  matchQueue: whatsappMatchQueue,
  safeEntryEnabled: config.WHATSAPP_SAFE_ENTRY_ENABLED,
  evolutionClient,
  pixKey: config.PIX_KEY,
  pixReceiver: config.PIX_RECEIVER,
  adminNumbers: config.ADMIN_WHATSAPP_NUMBERS,
  supportNumber: config.WHATSAPP_SUPPORT_NUMBER,
  publicGameUrl: config.PUBLIC_GAME_URL,
  logInfo,
  logWarn,
  logError,
});
const paymentSystemEnabled = config.WHATSAPP_PAYMENTS_ENABLED
  && config.PAYMENT_GATE_ENABLED
  && getPaymentConfigurationErrors().length === 0;
const whatsappConnectivityConfigured = Boolean(
  config.EVOLUTION_API_URL
  && config.EVOLUTION_API_KEY
  && config.EVOLUTION_INSTANCE_NAME
  && config.EVOLUTION_WEBHOOK_SECRET,
);
const whatsappConnectivityTestEnabled = config.WHATSAPP_CONNECTIVITY_TEST_ENABLED
  && whatsappConnectivityConfigured;
const whatsappSafeEntryEnabled = config.WHATSAPP_SAFE_ENTRY_ENABLED
  && getWhatsAppEntryConfigurationErrors().length === 0;

function getPaymentConfigurationErrors() {
  const required = {
    PAYMENT_STORE_PATH: config.PAYMENT_STORE_PATH,
    PAYMENT_ACCESS_SECRET: config.PAYMENT_ACCESS_SECRET,
    PUBLIC_GAME_URL: config.PUBLIC_GAME_URL,
    ADMIN_WHATSAPP_NUMBERS: config.ADMIN_WHATSAPP_NUMBERS.length,
    EVOLUTION_API_URL: config.EVOLUTION_API_URL,
    EVOLUTION_API_KEY: config.EVOLUTION_API_KEY,
    EVOLUTION_INSTANCE_NAME: config.EVOLUTION_INSTANCE_NAME,
    EVOLUTION_WEBHOOK_SECRET: config.EVOLUTION_WEBHOOK_SECRET,
    PIX_KEY: config.PIX_KEY,
    PIX_RECEIVER: config.PIX_RECEIVER,
  };
  return Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
}

function getWhatsAppEntryConfigurationErrors() {
  const required = {
    WHATSAPP_ENTRY_STORE_PATH: config.WHATSAPP_ENTRY_STORE_PATH,
    WHATSAPP_ENTRY_ACCESS_SECRET: config.WHATSAPP_ENTRY_ACCESS_SECRET,
    PUBLIC_GAME_URL: config.PUBLIC_GAME_URL,
    EVOLUTION_API_URL: config.EVOLUTION_API_URL,
    EVOLUTION_API_KEY: config.EVOLUTION_API_KEY,
    EVOLUTION_INSTANCE_NAME: config.EVOLUTION_INSTANCE_NAME,
    EVOLUTION_WEBHOOK_SECRET: config.EVOLUTION_WEBHOOK_SECRET,
  };
  return Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function getWebhookSecret(request) {
  const authorization = String(request.get('authorization') || '');
  return request.get('x-evolution-webhook-secret')
    || (authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
}

function requirePaymentsReady(response) {
  if (!paymentSystemEnabled) {
    response.status(503).json({ error: 'whatsapp-payments-disabled' });
    return false;
  }
  const configurationErrors = getPaymentConfigurationErrors();
  if (configurationErrors.length) {
    logError('WHATSAPP_PAYMENT_CONFIGURATION_ERROR', { missing: configurationErrors });
    response.status(503).json({ error: 'whatsapp-payments-not-configured' });
    return false;
  }
  return true;
}

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
app.use((request, response, next) => {
  response.set('Referrer-Policy', 'no-referrer');
  next();
});

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

async function confirmAndDeliverPayment(paymentId, { adminPhone, source }) {
  if (!evolutionClient.isConfigured()) throw new Error('EVOLUTION_API_NOT_CONFIGURED');
  const currentPayment = paymentService.getPayment(paymentId);
  const deliveryRetry = currentPayment?.status === 'confirmed' && !currentPayment.linkSentAt;
  const result = deliveryRetry
    ? paymentService.retryAccessLinkDelivery({ paymentId, adminPhone, source: `${source}-delivery-retry` })
    : paymentService.confirmPayment({ paymentId, adminPhone, source });
  try {
    await evolutionClient.sendText(result.payment.phone, [
      '✅ Pagamento confirmado!',
      'Sua partida está pronta:',
      result.accessLink,
    ].join('\n'));
    paymentService.markLinkDelivery(result.payment.paymentId, { sent: true });
    return { payment: paymentService.getPayment(result.payment.paymentId), notificationSent: true, deliveryRetry };
  } catch (error) {
    paymentService.markLinkDelivery(result.payment.paymentId, { sent: false, error: error.message });
    error.paymentId = result.payment.paymentId;
    throw error;
  }
}

async function approveAndDeliverWhatsAppEntry(entryId, { actor, source }) {
  if (!whatsappSafeEntryEnabled) throw new Error('WHATSAPP_SAFE_ENTRIES_DISABLED');
  if (!evolutionClient.isConfigured()) throw new Error('EVOLUTION_API_NOT_CONFIGURED');
  const internalEntry = whatsappEntryService.getEntry(entryId, { includeSecrets: true });
  if (!internalEntry) throw new Error('ENTRY_NOT_FOUND');
  const result = whatsappEntryService.approveEntry({ entryId, actor, source });
  try {
    await evolutionClient.sendText(
      internalEntry.phone,
      whatsappPaymentBot.safeEntryApprovedText(result.entry, result.accessLink),
    );
    whatsappEntryService.markLinkDelivery(entryId, { sent: true });
    return { entry: whatsappEntryService.getEntry(entryId), notificationSent: true };
  } catch (error) {
    whatsappEntryService.markLinkDelivery(entryId, { sent: false, error: error.message });
    whatsappEntryService.rollbackApprovalAfterDeliveryFailure(entryId, { error: error.message });
    error.entryId = entryId;
    throw error;
  }
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

function buildMatchFinishedLog(gameState, reason = null) {
  const finishedAt = gameState?.finishedAt || gameState?.result?.finishedAt || new Date().toISOString();
  const startedAt = gameState?.startedAt || null;
  const duration = startedAt
    ? Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000))
    : null;
  return {
    matchId: gameState?.matchId ?? null,
    roomId: gameState?.roomId ?? null,
    table: gameState?.tableValue ?? gameState?.economy?.tableValue ?? null,
    winner: gameState?.result?.winnerId ?? null,
    loser: gameState?.result?.loserId ?? null,
    finishedAt,
    startedAt,
    reason: reason || gameState?.result?.reason || null,
    duration,
    players: (gameState?.players ?? []).map((player) => ({
      playerId: player.id,
      name: player.name ?? player.playerName ?? null,
    })),
  };
}

function releaseWhatsAppEntriesAfterMatch(gameState, reason = 'match_finished') {
  if (!gameState?.matchId || !whatsappEntryService?.finishEntriesForMatch) return [];
  const released = whatsappEntryService.finishEntriesForMatch({
    matchId: gameState.matchId,
    winnerId: gameState.result?.winnerId ?? null,
    loserId: gameState.result?.loserId ?? null,
    reason,
  });
  released.forEach((entry) => {
    logInfo('PLAYER_RELEASED_AFTER_MATCH', {
      playerId: entry.phoneMasked ?? entry.entryId,
      entryId: entry.entryId,
      matchId: gameState.matchId,
      table: entry.selectedTable ?? gameState.tableValue ?? null,
      status: entry.status,
      reason,
    });
  });
  return released;
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
    payments: {
      enabled: paymentSystemEnabled,
      configured: getPaymentConfigurationErrors().length === 0,
      whatsappPaymentsEnabled: config.WHATSAPP_PAYMENTS_ENABLED,
      gateEnabled: config.PAYMENT_GATE_ENABLED,
    },
    whatsapp: {
      connectivityTestEnabled: whatsappConnectivityTestEnabled,
      configured: whatsappConnectivityConfigured,
      safeEntryEnabled: whatsappSafeEntryEnabled,
      safeEntryConfigured: getWhatsAppEntryConfigurationErrors().length === 0,
      entryStorePersisted: Boolean(config.WHATSAPP_ENTRY_STORE_PATH),
      publicGameUrlConfigured: Boolean(config.PUBLIC_GAME_URL),
      instanceName: config.EVOLUTION_INSTANCE_NAME || null,
      botNumberConfigured: Boolean(config.WHATSAPP_BOT_NUMBER),
      botNumberMasked: config.WHATSAPP_BOT_NUMBER ? maskPhone(config.WHATSAPP_BOT_NUMBER) : null,
    },
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

app.post('/api/webhooks/evolution', async (request, response) => {
  const originIp = request.ip || request.get('x-forwarded-for') || null;
  if (!paymentSystemEnabled && !whatsappConnectivityTestEnabled && !whatsappSafeEntryEnabled) {
    response.status(503).json({ error: 'whatsapp-disabled' });
    return;
  }
  if (!secureEquals(getWebhookSecret(request), config.EVOLUTION_WEBHOOK_SECRET)) {
    logWarn('EVOLUTION_WEBHOOK_UNAUTHORIZED', { originIp });
    response.status(401).json({ error: 'webhook-unauthorized' });
    return;
  }
  if (request.body?.instance && request.body.instance !== config.EVOLUTION_INSTANCE_NAME) {
    logWarn('EVOLUTION_WEBHOOK_INSTANCE_REJECTED', { originIp, instance: request.body.instance });
    response.status(403).json({ error: 'webhook-instance-rejected' });
    return;
  }

  try {
    const eventName = String(request.body?.event || '').toUpperCase().replace('.', '_');
    if (/CONNECTION|STATUS/.test(eventName)) {
      logInfo('EVOLUTION_INSTANCE_CONNECTED', {
        originIp,
        event: request.body?.event ?? null,
        instanceName: request.body?.instance ?? config.EVOLUTION_INSTANCE_NAME,
        botNumber: config.WHATSAPP_BOT_NUMBER ? maskPhone(config.WHATSAPP_BOT_NUMBER) : null,
        state: request.body?.data?.state ?? request.body?.state ?? request.body?.data?.status ?? null,
      });
    }
    const messageDiagnostic = buildEvolutionMessageDiagnostic(request.body ?? {});
    logInfo('EVOLUTION_MESSAGE_DIAGNOSTIC', messageDiagnostic);
    logInfo('EVOLUTION_MESSAGE_RECEIVED', {
      originIp,
      event: request.body?.event ?? null,
      mode: paymentSystemEnabled ? 'payments' : (whatsappSafeEntryEnabled ? 'safe-entry-without-pix' : 'connectivity-test'),
    });
    logInfo('WHATSAPP_MESSAGE_RECEIVED', {
      originIp,
      event: request.body?.event ?? null,
      instanceName: request.body?.instance ?? config.EVOLUTION_INSTANCE_NAME,
      senderPhone: messageDiagnostic.playerPhone,
      remoteJid: messageDiagnostic.remoteJid,
      playerPhoneSource: messageDiagnostic.playerPhoneSource,
    });
    const result = paymentSystemEnabled
      ? await whatsappPaymentBot.handleWebhook(request.body ?? {}, { originIp })
      : await whatsappPaymentBot.handleConnectivityWebhook(request.body ?? {}, { originIp });
    logInfo('EVOLUTION_MESSAGE_DECISION', {
      decision: result.decision ?? (result.ignored ? 'ignored_invalid' : 'processed_incoming'),
      reason: result.reason ?? result.type ?? 'unknown',
      messageType: messageDiagnostic.messageType,
      keyFromMe: messageDiagnostic.keyFromMe,
      remoteJid: messageDiagnostic.remoteJid,
    });
    if (result.decision === 'reply_sent') {
      logInfo('EVOLUTION_REPLY_SENT', {
        originIp,
        replyType: result.type,
        decision: 'reply_sent',
        reason: result.reason,
        remoteJid: messageDiagnostic.remoteJid,
        conversationState: result.state ?? null,
      });
    }
    logInfo('EVOLUTION_WEBHOOK_PROCESSED', {
      originIp,
      event: request.body?.event ?? null,
      resultType: result.type ?? result.reason ?? 'ignored',
      paymentId: result.paymentId ?? null,
    });
    response.json({ accepted: true });
  } catch (error) {
    logError('EVOLUTION_WEBHOOK_ERROR', { originIp, message: error.message });
    response.status(500).json({ error: 'webhook-processing-failed' });
  }
});

app.get('/api/payment-access/validate', (request, response) => {
  if (!paymentSystemEnabled) {
    response.json({ ok: true, paymentGateEnabled: false });
    return;
  }
  const payment = paymentService.validateAccessToken(request.query?.token);
  if (!payment) {
    response.status(403).json({ ok: false, error: 'payment-access-denied' });
    return;
  }
  response.json({
    ok: true,
    paymentGateEnabled: true,
    paymentId: payment.paymentId,
    selectedTable: payment.selectedTable,
  });
});

app.get('/api/entry-access/validate', (request, response) => {
  if (!whatsappSafeEntryEnabled) {
    response.status(503).json({ ok: false, error: 'whatsapp-safe-entries-disabled' });
    return;
  }
  const entry = whatsappEntryService.validateAccessToken(request.query?.token);
  if (!entry) {
    response.status(403).json({ ok: false, error: 'entry-access-denied' });
    return;
  }
  response.json({
    ok: true,
    entryId: entry.entryId,
    selectedTable: entry.selectedTable,
    status: entry.status,
    accessExpiresAt: entry.accessExpiresAt,
  });
});

app.get('/api/admin/payments', (request, response) => {
  if (!requireAdmin(request, response)) return;
  const status = request.query?.status;
  if (status && !paymentService.assertValidStatus(status)) {
    response.status(400).json({ error: 'invalid-payment-status' });
    return;
  }
  response.json({ payments: paymentService.listPayments({ status: status || null }) });
});

app.post('/api/admin/payments/:paymentId/confirm', async (request, response) => {
  if (!requireAdmin(request, response)) return;
  if (!requirePaymentsReady(response)) return;
  const adminPhone = config.ADMIN_WHATSAPP_NUMBERS[0];
  try {
    const result = await confirmAndDeliverPayment(request.params.paymentId, { adminPhone, source: 'admin-panel' });
    recordAdminLog({
      adminAction: result.deliveryRetry ? 'payment_link_resent' : 'payment_confirmed',
      targetId: request.params.paymentId,
      result: 'ok',
    });
    logInfo('PAYMENT_CONFIRMED', {
      paymentId: request.params.paymentId,
      confirmedBy: adminPhone,
      source: 'admin-panel',
      deliveryRetry: result.deliveryRetry,
    });
    response.json(result);
  } catch (error) {
    recordAdminLog({
      adminAction: 'payment_confirm_failed',
      targetId: request.params.paymentId,
      reason: error.message,
      result: 'blocked',
    });
    logWarn('PAYMENT_CONFIRM_REJECTED', { paymentId: request.params.paymentId, reason: error.message });
    response.status(error.paymentId ? 502 : 400).json({
      error: error.paymentId ? 'access-link-delivery-failed' : error.message,
      paymentId: error.paymentId ?? request.params.paymentId,
    });
  }
});

app.post('/api/admin/payments/:paymentId/reject', async (request, response) => {
  if (!requireAdmin(request, response)) return;
  if (!requirePaymentsReady(response)) return;
  const adminPhone = config.ADMIN_WHATSAPP_NUMBERS[0];
  try {
    const payment = paymentService.rejectPayment({
      paymentId: request.params.paymentId,
      adminPhone,
      reason: request.body?.reason,
      source: 'admin-panel',
    });
    let notificationSent = false;
    try {
      await evolutionClient.sendText(payment.phone, `❌ O pagamento #${payment.paymentId} não foi aprovado. Motivo: ${payment.rejectionReason}`);
      notificationSent = true;
    } catch (error) {
      logWarn('PAYMENT_REJECTION_NOTIFICATION_FAILED', { paymentId: payment.paymentId, message: error.message });
    }
    recordAdminLog({ adminAction: 'payment_rejected', targetId: payment.paymentId, reason: payment.rejectionReason, result: 'ok' });
    logInfo('PAYMENT_REJECTED', { paymentId: payment.paymentId, rejectedBy: adminPhone, source: 'admin-panel' });
    response.json({ payment, notificationSent });
  } catch (error) {
    recordAdminLog({
      adminAction: 'payment_reject_failed',
      targetId: request.params.paymentId,
      reason: error.message,
      result: 'blocked',
    });
    response.status(400).json({ error: error.message });
  }
});

app.get('/api/admin/whatsapp-entries', (request, response) => {
  if (!requireAdmin(request, response)) return;
  const status = request.query?.status;
  if (status && !whatsappEntryService.assertValidStatus(status)) {
    response.status(400).json({ error: 'invalid-entry-status' });
    return;
  }
  response.json({ entries: whatsappEntryService.listEntries({ status: status || null }) });
});

app.post('/api/admin/whatsapp-entries/:entryId/approve', async (request, response) => {
  if (!requireAdmin(request, response)) return;
  try {
    const result = await approveAndDeliverWhatsAppEntry(request.params.entryId, {
      actor: 'admin-panel',
      source: 'admin-panel',
    });
    recordAdminLog({ adminAction: 'whatsapp_entry_approved', targetId: request.params.entryId, result: 'ok' });
    logInfo('WHATSAPP_ENTRY_APPROVED', { entryId: request.params.entryId, source: 'admin-panel' });
    response.json(result);
  } catch (error) {
    recordAdminLog({
      adminAction: 'whatsapp_entry_approve_failed',
      targetId: request.params.entryId,
      reason: error.message,
      result: 'blocked',
    });
    logWarn('WHATSAPP_ENTRY_APPROVAL_REJECTED', { entryId: request.params.entryId, reason: error.message });
    response.status(error.entryId ? 502 : 400).json({ error: error.message });
  }
});

app.post('/api/admin/whatsapp-entries/:entryId/reject', async (request, response) => {
  if (!requireAdmin(request, response)) return;
  try {
    const internalEntry = whatsappEntryService.getEntry(request.params.entryId, { includeSecrets: true });
    if (!internalEntry) throw new Error('ENTRY_NOT_FOUND');
    const entry = whatsappEntryService.rejectEntry({
      entryId: request.params.entryId,
      actor: 'admin-panel',
      reason: request.body?.reason,
      source: 'admin-panel',
    });
    let notificationSent = false;
    try {
      await evolutionClient.sendText(internalEntry.phone, [
        '\u274C Sua entrada n\u00e3o foi liberada pelo admin.',
        '',
        `Motivo: ${entry.rejectionReason}`,
        '',
        'Digite menu para come\u00e7ar novamente.',
      ].join('\n'));
      notificationSent = true;
    } catch (error) {
      logWarn('WHATSAPP_ENTRY_REJECTION_NOTIFICATION_FAILED', { entryId: entry.entryId, message: error.message });
    }
    recordAdminLog({
      adminAction: 'whatsapp_entry_rejected',
      targetId: entry.entryId,
      reason: entry.rejectionReason,
      result: 'ok',
    });
    logInfo('WHATSAPP_ENTRY_REJECTED', { entryId: entry.entryId, source: 'admin-panel' });
    response.json({ entry, notificationSent });
  } catch (error) {
    recordAdminLog({
      adminAction: 'whatsapp_entry_reject_failed',
      targetId: request.params.entryId,
      reason: error.message,
      result: 'blocked',
    });
    response.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/whatsapp-entries/:entryId/expire', (request, response) => {
  if (!requireAdmin(request, response)) return;
  try {
    const entry = whatsappEntryService.expireEntry({
      entryId: request.params.entryId,
      actor: 'admin-panel',
      source: 'admin-panel',
    });
    recordAdminLog({ adminAction: 'whatsapp_entry_expired', targetId: entry.entryId, result: 'ok' });
    logInfo('WHATSAPP_ENTRY_EXPIRED', { entryId: entry.entryId, source: 'admin-panel' });
    response.json({ entry });
  } catch (error) {
    recordAdminLog({
      adminAction: 'whatsapp_entry_expire_failed',
      targetId: request.params.entryId,
      reason: error.message,
      result: 'blocked',
    });
    response.status(400).json({ error: error.message });
  }
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
  releaseWhatsAppEntriesAfterMatch(result.gameState, reason);
  logInfo('MATCH_FINISHED', buildMatchFinishedLog(result.gameState, reason));

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
  releaseWhatsAppEntriesAfterMatch(result.gameState, 'admin_decision');
  logInfo('MATCH_FINISHED', buildMatchFinishedLog(result.gameState, 'admin_decision'));

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
  paymentService,
  paymentGateEnabled: paymentSystemEnabled,
  entryService: whatsappEntryService,
  safeEntryEnabled: whatsappSafeEntryEnabled,
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
