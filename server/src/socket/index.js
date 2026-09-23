import { Server } from 'socket.io';
import { config } from '../config.js';
import { buildClientGameState } from '../game/clientState.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { recordClientError } from '../observabilityStore.js';
import { createPostMatchFlow } from '../services/postMatchFlow.js';
import { createRateLimiter } from '../security/rateLimiter.js';
import { getSocketClientIp } from './clientIp.js';
import { resolveAuthorizedMatchPlayer } from './authorization.js';

export function setupSocketServer(httpServer, {
  roomManager,
  matchManager,
  playerManager,
  socketManager,
  queueManager,
  paymentService = null,
  paymentGateEnabled = false,
  entryService = null,
  safeEntryEnabled = false,
  whatsappBot = null,
  whatsappMatchQueue = null,
  demoCreditsService = null,
  financialWalletService = null,
  postMatchFlow: sharedPostMatchFlow = null,
  corsOptions,
} = {}) {
  const actionRateLimiter = createRateLimiter();
  const io = new Server(httpServer, {
    cors: corsOptions ?? {
      origin: config.ALLOWED_CLIENT_URLS,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 64 * 1024,
    allowUpgrades: true,
    pingInterval: 25000,
    pingTimeout: 20000,
  });
  io.use((socket, next) => {
    const connectionRate = actionRateLimiter.consume(
      `connect:${getSocketClientIp(socket)}`,
      { limit: 120, windowMs: 60_000 },
    );
    if (!connectionRate.allowed) {
      const error = new Error('SOCKET_CONNECTION_RATE_LIMITED');
      error.data = { code: 'RATE_LIMITED' };
      next(error);
      return;
    }
    next();
  });
  if (paymentGateEnabled || safeEntryEnabled) {
    io.use((socket, next) => {
      const entryToken = String(socket.handshake.auth?.entryToken || '').trim();
      const entrySessionKey = String(socket.handshake.auth?.entrySessionKey || '').trim();
      const requestedMatchId = String(socket.handshake.auth?.joinMatchId || '').trim();
      const hasEntryRecoveryCredentials = Boolean(entrySessionKey || requestedMatchId);
      if (safeEntryEnabled && (entryToken || hasEntryRecoveryCredentials)) {
        const isRecovery = !entryToken;
        const rate = actionRateLimiter.consume(
          `${isRecovery ? 'entry-recovery' : 'link'}:${getSocketClientIp(socket)}`,
          { limit: 30, windowMs: 60_000 },
        );
        if (!rate.allowed) {
          const error = new Error('ENTRY_ACCESS_DENIED');
          error.data = { code: 'ENTRY_ACCESS_DENIED' };
          next(error);
          return;
        }

        let accessSession;
        let expectedMatchId = null;
        try {
          if (isRecovery) {
            if (!entrySessionKey || !requestedMatchId) throw new Error('ENTRY_ACCESS_DENIED');
            accessSession = entryService?.recoverAccessSession({
              matchId: requestedMatchId,
              sessionKey: entrySessionKey,
            });
            if (!accessSession?.entry) throw new Error('ENTRY_ACCESS_DENIED');
          } else {
            const entry = entryService?.validateAccessToken(entryToken);
            if (!entry) throw new Error('ENTRY_ACCESS_DENIED');
            expectedMatchId = entry.whatsappMatchId || entry.linkedMatchId || null;
            if (requestedMatchId && expectedMatchId && requestedMatchId !== expectedMatchId) {
              throw new Error('ENTRY_ACCESS_DENIED');
            }
            accessSession = { entry, sessionKey: null, recovered: false };
            if (config.WHATSAPP_FIRST_LOBBY_ENABLED) {
              accessSession = entryService.claimAccessSession({
                entryId: entry.entryId,
                sessionKey: entrySessionKey || null,
              });
            }
          }
        } catch (sessionError) {
          const entryId = accessSession?.entry?.entryId ?? null;
          logWarn(isRecovery ? 'WHATSAPP_ENTRY_SESSION_RECOVERY_DENIED' : 'WHATSAPP_ENTRY_DUPLICATE_SESSION_BLOCKED', {
            socketId: socket.id,
            requestedMatchId: requestedMatchId || null,
            entryId,
            reason: ['ENTRY_ACCESS_DENIED', 'ENTRY_ACCESS_EXPIRED', 'ENTRY_DUPLICATE_SESSION'].includes(sessionError.message)
              ? sessionError.message
              : 'ENTRY_ACCESS_DENIED',
          });
          const error = new Error('ENTRY_ACCESS_DENIED');
          error.data = { code: 'ENTRY_ACCESS_DENIED' };
          next(error);
          return;
        }

        const authorizedEntry = accessSession.entry;
        expectedMatchId ||= authorizedEntry.whatsappMatchId || authorizedEntry.linkedMatchId || null;
        logInfo(isRecovery ? 'WHATSAPP_ENTRY_SESSION_RECOVERED' : 'WHATSAPP_ENTRY_LINK_OPENED', {
          socketId: socket.id,
          requestedMatchId: requestedMatchId || null,
          expectedMatchId,
          linkedMatchId: authorizedEntry.linkedMatchId ?? null,
          entryId: authorizedEntry.entryId,
          selectedTable: authorizedEntry.selectedTable,
          matchFound: Boolean(authorizedEntry.linkedMatchId || expectedMatchId),
          sessionVersion: authorizedEntry.sessionVersion ?? null,
          recoveredSession: Boolean(accessSession.recovered),
        });
        socket.entryAccess = {
          entryId: authorizedEntry.entryId,
          selectedTable: authorizedEntry.selectedTable,
          linkedMatchId: authorizedEntry.linkedMatchId ?? null,
          whatsappMatchId: authorizedEntry.whatsappMatchId ?? null,
          requestedMatchId: requestedMatchId || null,
          preMatchDeadline: authorizedEntry.preMatchDeadline ?? null,
          publicMatchReference: authorizedEntry.publicMatchReference ?? null,
          sessionVersion: authorizedEntry.sessionVersion ?? null,
          sessionKey: accessSession.sessionKey ?? null,
        };
      }

      if (!paymentGateEnabled) {
        next();
        return;
      }
      const payment = paymentService?.validateAccessToken(socket.handshake.auth?.paymentToken);
      if (!payment) {
        const error = new Error('PAYMENT_REQUIRED');
        error.data = { code: 'PAYMENT_REQUIRED' };
        next(error);
        return;
      }
      socket.paymentAccess = {
        paymentId: payment.paymentId,
        selectedTable: payment.selectedTable,
        linkedMatchId: payment.linkedMatchId ?? null,
      };
      next();
    });
  }
  const buildTimeSync = (gameState) => ({
    matchId: gameState.matchId,
    serverNow: Date.now(),
    turnStartedAt: Date.parse(gameState.turnStartedAt),
    turnDurationMs: Number(gameState.turnDurationSeconds ?? config.TURN_DURATION_SECONDS) * 1000,
    currentPlayerId: gameState.currentTurnPlayerId,
  });

  const actionReplayCache = new Map();
  const ACTION_REPLAY_TTL_MS = 5 * 60 * 1000;
  const ACTION_REPLAY_MAX_ENTRIES = 10_000;
  const ACTION_REPLAY_EVENTS = new Set([
    'playerDrawFromDeck',
    'playerDrawFromDiscard',
    'playerDiscardCard',
    'player:reorderHand',
    'playerKnock',
    'player:knock',
    'playerSurrender',
  ]);

  const pruneExpiredActionReplayCache = (now = Date.now()) => {
    for (const [key, entry] of actionReplayCache) {
      if (entry.expiresAt <= now) actionReplayCache.delete(key);
    }
  };

  const makeActionReplayCacheRoom = (now = Date.now()) => {
    pruneExpiredActionReplayCache(now);
    while (actionReplayCache.size >= ACTION_REPLAY_MAX_ENTRIES) {
      const oldestKey = actionReplayCache.keys().next().value;
      if (oldestKey === undefined) break;
      actionReplayCache.delete(oldestKey);
    }
  };

  const clearMatchActionReplayCache = (matchId) => {
    for (const [key, entry] of actionReplayCache) {
      if (entry.matchId === matchId) actionReplayCache.delete(key);
    }
  };

  const sendTimeSync = (gameState) => {
    const payload = buildTimeSync(gameState);
    gameState.players.forEach((player) => {
      socketManager.getSocket(player.socketId)?.emit('time_sync', payload);
    });
  };

  const sendClientGameState = (gameState, eventName = 'gameStateUpdated') => {
    if (eventName === 'matchFinished' || gameState.status === 'finished') {
      clearMatchActionReplayCache(gameState.matchId);
    }
    gameState.players.forEach((player) => {
      const targetSocket = socketManager.getSocket(player.socketId);
      if (!targetSocket) return;

      const payload = buildClientGameState(gameState, player.id);
      if (targetSocket.entryAccess) {
        payload.entryAccess = {
          entryId: targetSocket.entryAccess.entryId,
          selectedTable: targetSocket.entryAccess.selectedTable,
          whatsappMatchId: targetSocket.entryAccess.whatsappMatchId,
          requestedMatchId: targetSocket.entryAccess.requestedMatchId,
          linkedMatchId: targetSocket.entryAccess.linkedMatchId,
        };
      }
      targetSocket.emit(eventName, payload);
      targetSocket.emit('time_sync', buildTimeSync(gameState));
      logInfo('CLIENT_STATE_SENT', {
        eventName,
        matchId: gameState.matchId,
        roomId: gameState.roomId,
        playerId: player.id,
        handCount: payload.you?.hand?.length ?? 0,
        opponentHandCount: payload.opponent?.handCount ?? 0,
      });
    });
  };

  const buildServerStatus = () => ({
    onlinePlayers: socketManager.onlineCount(),
  });

  const buildMatchFinishedLog = (gameState, reason = null) => {
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
      reason: reason || gameState?.result?.reason || gameState?.finishReason || null,
      duration,
      players: (gameState?.players ?? []).map((player) => ({
        playerId: player.id,
        name: player.name ?? player.playerName ?? null,
      })),
    };
  };

  const postMatchFlow = sharedPostMatchFlow ?? createPostMatchFlow({
    entryService,
    whatsappBot,
    whatsappMatchQueue,
    whatsappEnabled: config.POST_MATCH_WHATSAPP_ENABLED,
    adminSummaryEnabled: config.ADMIN_MATCH_SUMMARY_ENABLED,
    logInfo,
    logWarn,
    logError,
  });

  const finishMatchAndNotify = (gameState, reason = 'match_finished') => postMatchFlow.finishMatchAndNotify(
    gameState,
    reason,
    { emitResult: (finishedGameState, eventName) => {
      if (finishedGameState?.matchId) clearMatchActionReplayCache(finishedGameState.matchId);
      sendClientGameState(finishedGameState, eventName);
      if (finishedGameState?.roomId) roomManager.deleteRoom(finishedGameState.roomId);
    } },
  );

  const broadcastServerStatus = () => {
    io.emit('serverStatus', buildServerStatus());
  };

  const rejectAction = (socket, rejection) => {
    logWarn('ACTION_REJECTED', {
      socketId: socket.id,
      playerId: socketManager.getPlayerBySocket(socket.id)?.id ?? null,
      matchId: rejection.gameState?.matchId ?? null,
      roomId: rejection.gameState?.roomId ?? null,
      reason: rejection.reason,
      action: rejection.action,
    });
    socket.emit('actionRejected', {
      reason: rejection.reason,
      message: rejection.message,
      action: rejection.action,
      debugReason: rejection.debugReason,
    });
  };

  matchManager.setTurnTimerHandlers({
    onTick: (gameState) => {
      const secondsLeft = gameState.turnSecondsLeft ?? gameState.turn?.turnSecondsLeft;
      if (secondsLeft === config.TURN_DURATION_SECONDS || secondsLeft % 5 === 0) {
        sendTimeSync(gameState);
      }
    },
    onTimeout: (gameState) => {
      logInfo('AUTO_TURN_TIMEOUT', {
        matchId: gameState.matchId,
        roomId: gameState.roomId,
        currentPlayerId: gameState.currentTurnPlayerId,
        reason: 'turn_timeout_auto_play',
      });
      sendClientGameState(gameState);
    },
    onDisconnectTimeout: (gameState) => {
      logInfo('MATCH_FINISHED', buildMatchFinishedLog(gameState, 'disconnect'));
      void finishMatchAndNotify(gameState, 'disconnect');
    },
  });

  io.engine.on('connection_error', (error) => {
    logError('SOCKET_CONNECTION_ERROR', {
      message: error.message,
      code: error.code,
      context: error.context,
    });
  });

  const emitMatchFound = async (entries) => {
    const [first, second] = entries;
    const whatsappPreMatchIds = new Set(entries
      .map((entry) => entry.entryId
        ? entryService?.getEntry?.(entry.entryId, { includeSecrets: true })?.whatsappMatchId
        : null)
      .filter(Boolean));
    if (paymentGateEnabled) {
      entries.forEach((entry) => {
        const payment = paymentService.getPayment(entry.paymentId);
        if (
          !payment
          || payment.status !== 'confirmed'
          || payment.accessUsedAt
          || payment.accessReservedBy !== entry.socketId
          || Number(payment.selectedTable) !== Number(entry.tableValue)
        ) {
          throw new Error('PAYMENT_ACCESS_INVALID_FOR_MATCH');
        }
      });
    }
    entries.filter((entry) => entry.entryId).forEach((entry) => {
      const safeEntry = entryService?.getEntry(entry.entryId, { includeSecrets: true });
      if (
        !safeEntry
        || safeEntry.status !== 'queued'
        || safeEntry.queueSocketId !== entry.socketId
        || Number(safeEntry.selectedTable) !== Number(entry.tableValue)
      ) {
        throw new Error('ENTRY_ACCESS_INVALID_FOR_MATCH');
      }
    });
    const demoParticipants = entries
      .filter((entry) => entry.entryId)
      .map((entry) => {
        const storedEntry = entryService?.getEntry?.(entry.entryId, { includeSecrets: true });
        return {
          playerId: storedEntry?.phone || null,
          entryId: entry.entryId,
          matchPlayerId: entry.playerId,
        };
      });
    if (demoCreditsService?.isEnabled?.()) {
      demoCreditsService.validateMatchReservations(demoParticipants, first.tableValue);
    }
    const roomPlayers = [
      {
        id: first.playerId,
        playerId: first.playerId,
        socketId: first.socketId,
        name: first.playerName,
        playerName: first.playerName,
        position: 'bottom',
      },
      {
        id: second.playerId,
        playerId: second.playerId,
        socketId: second.socketId,
        name: second.playerName,
        playerName: second.playerName,
        position: 'top',
      },
    ];
    const room = roomManager.createRoom({
      roomType: config.ROOM_MODE,
      tableValue: first.tableValue,
      status: 'matched',
      players: roomPlayers,
      maxPlayers: 2,
      matchId: null,
    });

    logInfo('ROOM_CREATED', {
      roomId: room.roomId,
      tableValue: room.tableValue,
      status: room.status,
      playerCount: room.players.length,
    });
    logInfo('MATCH_FOUND', {
      roomId: room.roomId,
      tableValue: room.tableValue,
      players: entries.map((entry) => entry.playerId),
    });

    const onlineMatch = matchManager.createOnlineMatch(room.roomId, room.players, room.tableValue);

    if (financialWalletService?.isEnabled?.()) {
      try {
        await financialWalletService.commitMatchReservations(
          entries.map((entry) => entry.entryId).filter(Boolean),
          onlineMatch.matchId,
        );
      } catch (error) {
        matchManager.adminEndMatch?.(onlineMatch.matchId, 'financial_reservation_commit_failed');
        roomManager.deleteRoom(room.roomId);
        logError('MATCH_FINANCIAL_START_FAILED', { matchId: onlineMatch.matchId, roomId: room.roomId, reason: error.message });
        let recovery;
        try {
          recovery = await financialWalletService.recoverFailedMatchStart(
            entries.map((entry) => entry.entryId).filter(Boolean),
            onlineMatch.matchId,
            error.message,
          );
        } catch (recoveryError) {
          logError('MATCH_FINANCIAL_START_RECOVERY_FAILED', {
            matchId: onlineMatch.matchId, roomId: room.roomId, reason: recoveryError.message,
          });
          recovery = { reviewRequired: true };
        }
        entries.forEach((entry) => socketManager.getSocket(entry.socketId)?.emit('matchmakingError', {
          reason: 'FINANCIAL_RESERVATION_COMMIT_FAILED',
          message: recovery?.recovered
            ? 'A partida não pôde iniciar e a reserva foi devolvida com segurança.'
            : 'A partida não pôde iniciar. A operação foi registrada para revisão financeira.',
        }));
        return null;
      }
    }

    if (demoCreditsService?.isEnabled?.()) {
      try {
        demoCreditsService.consumeMatchReservations(demoParticipants, {
          matchId: onlineMatch.matchId,
          tableId: room.tableValue,
        });
      } catch (error) {
        matchManager.adminEndMatch?.(onlineMatch.matchId, 'demo_credit_consume_failed');
        roomManager.deleteRoom(room.roomId);
        logError('DEMO_BALANCE_INCONSISTENCY', {
          matchId: onlineMatch.matchId,
          roomId: room.roomId,
          tableId: room.tableValue,
          reason: error.message,
        });
        entries.forEach((entry) => {
          socketManager.getSocket(entry.socketId)?.emit('matchmakingError', {
            reason: 'DEMO_CREDITS_CONSUME_FAILED',
            message: 'A Partida não pôde iniciar. Sua reserva continua protegida para revisão.',
          });
        });
        return null;
      }
    }

    if (paymentGateEnabled) {
      entries.forEach((entry) => {
        paymentService.consumeAccess({
          paymentId: entry.paymentId,
          socketId: entry.socketId,
          matchId: onlineMatch.matchId,
        });
      });
      logInfo('PAYMENT_ACCESS_CONSUMED', {
        matchId: onlineMatch.matchId,
        roomId: room.roomId,
        paymentIds: entries.map((entry) => entry.paymentId),
      });
    }
    entries.filter((entry) => entry.entryId).forEach((entry) => {
      entryService.linkToMatch({
        entryId: entry.entryId,
        socketId: entry.socketId,
        matchId: onlineMatch.matchId,
        playerId: entry.playerId,
      });
    });
    whatsappPreMatchIds.forEach((whatsappMatchId) => {
      whatsappMatchQueue?.markMatchStarted?.(whatsappMatchId, onlineMatch.matchId);
    });
    if (entries.some((entry) => entry.entryId)) {
      logInfo('WHATSAPP_ENTRIES_LINKED_TO_MATCH', {
        matchId: onlineMatch.matchId,
        roomId: room.roomId,
        entryIds: entries.map((entry) => entry.entryId).filter(Boolean),
      });
    }

    roomManager.updateRoom(room.roomId, {
      status: 'playing',
      matchId: onlineMatch.matchId,
    });

    logInfo('ONLINE_MATCH_CREATED', {
      matchId: onlineMatch.matchId,
      roomId: room.roomId,
      players: onlineMatch.players.map((item) => item.id),
      deckCount: onlineMatch.deckCount,
    });
    logInfo('MATCH_STARTED', {
      matchId: onlineMatch.matchId,
      roomId: room.roomId,
      table: room.tableValue,
      players: onlineMatch.players.map((item) => ({
        playerId: item.id,
        name: item.name ?? item.playerName ?? null,
      })),
      startedAt: onlineMatch.startedAt ?? null,
      currentTurnPlayerId: onlineMatch.currentTurnPlayerId,
    });
    entries.forEach((entry, index) => {
      const opponent = entries[index === 0 ? 1 : 0];
      const targetSocket = socketManager.getSocket(entry.socketId);
      targetSocket?.emit('matchFound', {
        roomId: room.roomId,
        roomType: room.roomType,
        tableValue: room.tableValue,
        players: [
          { playerId: entry.playerId, playerName: entry.playerName, position: 'bottom' },
          { playerId: opponent.playerId, playerName: opponent.playerName, position: 'top' },
        ],
        message: 'Adversario encontrado!',
      });
    });
    sendClientGameState(onlineMatch, 'matchStarted');

    return room;
  };

  queueManager.setTimeoutHandler(async (entry) => {
    if (paymentGateEnabled && entry.paymentId) {
      paymentService.releaseAccessReservation({
        paymentId: entry.paymentId,
        socketId: entry.socketId,
        reason: 'queue_timeout',
      });
    }
    const abortResult = entry.entryId && whatsappMatchQueue
      ? await whatsappMatchQueue.abortMatchAndReleaseParticipants({
          matchId: entryService?.getEntry?.(entry.entryId)?.whatsappMatchId,
          reason: 'queue_timeout_before_start',
          cancelledBy: null,
        })
      : null;
    if (entry.entryId && !abortResult?.aborted) {
      entryService?.releaseQueueAccess({
        entryId: entry.entryId,
        socketId: entry.socketId,
        reason: 'queue_timeout',
      });
    }
    const targetSocket = socketManager.getSocket(entry.socketId);
    logInfo('QUEUE_TIMEOUT', {
      playerId: entry.playerId,
      socketId: entry.socketId,
      tableValue: entry.tableValue,
    });
    targetSocket?.emit('queueTimeout', {
      message: abortResult?.paidEntryPreserved
        ? 'Sua partida não iniciou. Sua entrada será encaminhada para revisão.'
        : 'Sua partida não iniciou dentro do tempo de espera.',
      canTryAgain: false,
      publicReference: abortResult?.participants?.[0]?.publicMatchReference ?? null,
      paidEntryPreserved: Boolean(abortResult?.paidEntryPreserved),
    });
  });

  io.on('connection', (socket) => {
    const player = playerManager.createPlayer({
      name: 'Visitante',
      socketId: socket.id,
    });

    socketManager.registerSocket(socket, player);
    logInfo('SOCKET_TRANSPORT_CONNECTED', {
      socketId: socket.id,
      playerId: player.id,
      transport: socket.conn.transport.name,
    });
    socket.conn.on('upgrade', (transport) => {
      logInfo('SOCKET_TRANSPORT_UPGRADED', {
        socketId: socket.id,
        playerId: getActivePlayerId(),
        transport: transport.name,
      });
    });
    logInfo('SOCKET_CONNECTED', { socketId: socket.id, playerId: player.id });
    logInfo('PLAYER_CONNECTED', { socketId: socket.id, playerId: player.id });

    socket.emit('connection:success', {
      playerId: player.id,
      socketId: socket.id,
      connected: true,
      paymentAccess: socket.paymentAccess ? {
        paymentId: socket.paymentAccess.paymentId,
        selectedTable: socket.paymentAccess.selectedTable,
      } : null,
      entryAccess: socket.entryAccess ? {
        entryId: socket.entryAccess.entryId,
        selectedTable: socket.entryAccess.selectedTable,
        whatsappMatchId: socket.entryAccess.whatsappMatchId,
        requestedMatchId: socket.entryAccess.requestedMatchId,
        linkedMatchId: socket.entryAccess.linkedMatchId,
        preMatchDeadline: socket.entryAccess.preMatchDeadline,
        publicMatchReference: socket.entryAccess.publicMatchReference,
        sessionVersion: socket.entryAccess.sessionVersion,
        sessionKey: socket.entryAccess.sessionKey,
      } : null,
      whatsappFirstLobbyEnabled: config.WHATSAPP_FIRST_LOBBY_ENABLED,
      matchJoinTimeoutSeconds: config.MATCH_JOIN_TIMEOUT_SECONDS,
    });
    broadcastServerStatus();

    const getActivePlayerId = (matchId = null) => {
      const playerId = socketManager.getPlayerBySocket(socket.id)?.id ?? null;
      if (!playerId) return null;

      const match = matchId
        ? matchManager.getOnlineMatch(matchId)
        : matchManager.listMatches().find((candidate) => (
            candidate.mode === 'online_1v1' && candidate.players.some((item) => item.id === playerId)
          ));
      if (!match) return playerId;
      const matchPlayer = match?.players.find((candidate) => candidate.id === playerId);
      return matchPlayer?.socketId === socket.id ? playerId : null;
    };
    const consumeSocketRate = (operation, { limit, windowMs = 60_000 } = {}) => actionRateLimiter.consume(
      `${operation}:${socket.entryAccess?.entryId || socket.paymentAccess?.paymentId || socketManager.getPlayerBySocket(socket.id)?.id || socket.id}`,
      { limit, windowMs },
    );
    const onSafe = (eventName, handler) => {
      socket.on(eventName, (payload = {}, acknowledgement) => {
        const receivedAck = typeof acknowledgement === 'function' ? acknowledgement : null;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          receivedAck?.({ ok: false, reason: 'INVALID_PAYLOAD', serverNow: Date.now() });
          return;
        }
        const invalidIdentifier = ['matchId', 'roomId', 'playerId', 'actionId'].some((key) => (
          payload[key] != null && (typeof payload[key] !== 'string' || payload[key].length > 128)
        ));
        if (invalidIdentifier) {
          receivedAck?.({ ok: false, reason: 'INVALID_PAYLOAD', serverNow: Date.now() });
          return;
        }
        const actionId = typeof payload?.actionId === 'string' ? payload.actionId.trim() : '';
        const matchId = typeof payload?.matchId === 'string' ? payload.matchId : '';
        const activePlayerId = ACTION_REPLAY_EVENTS.has(eventName) ? getActivePlayerId(matchId) : null;
        const cacheEligible = Boolean(
          ACTION_REPLAY_EVENTS.has(eventName)
          && activePlayerId
          && matchId
          && actionId
          && actionId.length <= 128,
        );
        const cacheKey = cacheEligible ? JSON.stringify([matchId, activePlayerId, actionId]) : null;
        if (cacheEligible) {
          pruneExpiredActionReplayCache();
          const cached = actionReplayCache.get(cacheKey);
          if (cached) {
            receivedAck?.({ ...cached.response, duplicate: true });
            return;
          }
        }
        if (ACTION_REPLAY_EVENTS.has(eventName)) {
          const actionRate = actionRateLimiter.consume(
            `game-action:${activePlayerId || socket.entryAccess?.entryId || socket.id}`,
            { limit: 120, windowMs: 60_000 },
          );
          if (!actionRate.allowed) {
            receivedAck?.({ ok: false, actionId: payload?.actionId ?? null, reason: 'RATE_LIMITED', serverNow: Date.now() });
            socket.emit('actionRejected', {
              reason: 'RATE_LIMITED',
              action: eventName,
              message: 'Muitas ações seguidas. Aguarde um instante e tente novamente.',
            });
            return;
          }
        }
        let actionAckCalled = false;
        const ack = cacheEligible
          ? (response = {}) => {
              if (!actionAckCalled) {
                actionAckCalled = true;
                makeActionReplayCacheRoom();
                actionReplayCache.set(cacheKey, {
                  matchId,
                  response: { ...response },
                  expiresAt: Date.now() + ACTION_REPLAY_TTL_MS,
                });
              }
              receivedAck?.(response);
            }
          : receivedAck;
        if (ACTION_REPLAY_EVENTS.has(eventName) && matchId) {
          const currentMatch = matchManager.getOnlineMatch(matchId);
          if (
            currentMatch
            && (!Number.isSafeInteger(payload?.turnNumber) || payload.turnNumber !== currentMatch.turnNumber)
          ) {
            ack?.({
              ok: false,
              actionId: payload?.actionId ?? null,
              reason: 'STALE_TURN',
              serverNow: Date.now(),
            });
            rejectAction(socket, {
              reason: 'STALE_TURN',
              message: 'O estado da partida mudou. Atualize a mesa antes de tentar novamente.',
              action: eventName,
            });
            return;
          }
        }
        try {
          const result = handler(payload, ack);
          Promise.resolve(result).catch((error) => {
            logError('SOCKET_HANDLER_ERROR', {
              source: 'socket',
              eventName,
              socketId: socket.id,
              playerId: getActivePlayerId(),
              matchId: payload?.matchId ?? null,
              message: error?.message ?? String(error),
              stack: error?.stack,
            });
            ack?.({ ok: false, actionId: payload?.actionId ?? null, reason: 'SERVER_ERROR', serverNow: Date.now() });
            socket.emit('actionRejected', { reason: 'SERVER_ERROR', action: eventName, message: 'Erro interno ao processar acao.' });
          });
        } catch (error) {
          logError('SOCKET_HANDLER_ERROR', {
            source: 'socket',
            eventName,
            socketId: socket.id,
            playerId: getActivePlayerId(),
            matchId: payload?.matchId ?? null,
            message: error?.message ?? String(error),
            stack: error?.stack,
          });
          ack?.({ ok: false, actionId: payload?.actionId ?? null, reason: 'SERVER_ERROR', serverNow: Date.now() });
          socket.emit('actionRejected', { reason: 'SERVER_ERROR', action: eventName, message: 'Erro interno ao processar acao.' });
        }
      });
    };

    const acknowledgeAction = (ack, payload, result = {}) => {
      ack?.({
        ok: !result.blocked,
        actionId: payload?.actionId ?? null,
        reason: result.reason ?? null,
        serverNow: Date.now(),
      });
    };

    socket.on('ping', (payload = {}) => {
      if (!consumeSocketRate('ping', { limit: 30 }).allowed) return;
      logInfo('PING_RECEIVED', { socketId: socket.id, playerId: player.id });
      socket.emit('pong', {
        ok: true,
        receivedAt: new Date().toISOString(),
      });
      logInfo('PONG_SENT', { socketId: socket.id, playerId: player.id });
    });

    socket.on('ping_game', (payload = {}, ack) => {
      if (!consumeSocketRate('ping-game', { limit: 60 }).allowed) {
        ack?.({ ok: false, reason: 'RATE_LIMITED', serverNow: Date.now() });
        return;
      }
      const clientSentAt = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload.clientSentAt
        : null;
      ack?.({
        clientSentAt: Number(clientSentAt) || null,
        serverNow: Date.now(),
        transport: socket.conn.transport.name,
      });
    });

    socket.on('client_error_report', (payload = {}) => {
      if (!consumeSocketRate('client-error', { limit: 10 }).allowed) return;
      recordClientError({
        ...payload,
        playerId: payload.playerId ?? getActivePlayerId(),
      });
    });

    socket.on('error', (error) => {
      logError('SOCKET_ERROR', {
        socketId: socket.id,
        playerId: getActivePlayerId(),
        message: error?.message ?? String(error),
        stack: error?.stack,
      });
    });

    onSafe('joinQueue', async (payload = {}, ack) => {
      const playerName = String(payload.playerName || '').trim().slice(0, 32) || 'Jogador';
      const tableValue = Number(payload.tableValue);
      logInfo('JOIN_QUEUE_RECEIVED', {
        socketId: socket.id,
        playerId: player.id,
        playerName,
        tableValue,
      });

      if (config.WHATSAPP_FIRST_LOBBY_ENABLED && !socket.entryAccess && !socket.paymentAccess) {
        logWarn('WHATSAPP_FIRST_DIRECT_QUEUE_BLOCKED', {
          socketId: socket.id,
          playerId: player.id,
          tableValue,
        });
        const message = 'Para encontrar uma partida, acesse o Pife Duelo pelo WhatsApp.';
        socket.emit('matchmakingError', { reason: 'WHATSAPP_ENTRY_REQUIRED', message });
        ack?.({ ok: false, reason: 'WHATSAPP_ENTRY_REQUIRED', message, serverNow: Date.now() });
        return;
      }

      const queueRate = actionRateLimiter.consume(`queue:${socket.entryAccess?.entryId || socket.id}`, {
        limit: 8,
        windowMs: 60_000,
      });
      const queueIpRate = actionRateLimiter.consume(`queue-ip:${getSocketClientIp(socket)}`, {
        limit: 30,
        windowMs: 60_000,
      });
      if (!queueRate.allowed || !queueIpRate.allowed) {
        const message = 'Muitas tentativas seguidas. Aguarde um instante e tente novamente.';
        socket.emit('matchmakingError', { reason: 'RATE_LIMITED', message });
        ack?.({ ok: false, reason: 'RATE_LIMITED', message, serverNow: Date.now() });
        return;
      }

      if (!queueManager.isValidTableValue(tableValue)) {
        logInfo('MATCHMAKING_ERROR', {
          socketId: socket.id,
          playerId: player.id,
          reason: 'invalid-table-value',
          tableValue: payload.tableValue,
        });
        socket.emit('matchmakingError', {
          reason: 'invalid-table-value',
          message: 'Mesa invalida.',
        });
        ack?.({ ok: false, reason: 'invalid-table-value', message: 'Mesa invalida.', serverNow: Date.now() });
        return;
      }

      if (paymentGateEnabled) {
        if (!socket.paymentAccess) {
          socket.emit('matchmakingError', {
            reason: 'payment-required',
            message: 'Pagamento confirmado necessario para entrar na fila.',
          });
          ack?.({ ok: false, reason: 'payment-required', message: 'Pagamento confirmado necessario.', serverNow: Date.now() });
          return;
        }
        try {
          paymentService.reserveAccess({
            paymentId: socket.paymentAccess.paymentId,
            socketId: socket.id,
            selectedTable: tableValue,
          });
        } catch (error) {
          logWarn('PAYMENT_ACCESS_RESERVATION_REJECTED', {
            socketId: socket.id,
            paymentId: socket.paymentAccess.paymentId,
            tableValue,
            reason: error.message,
          });
          socket.emit('matchmakingError', {
            reason: error.message,
            message: error.message === 'PAYMENT_TABLE_MISMATCH'
              ? 'Use a mesma mesa confirmada no pagamento.'
              : 'Este acesso de pagamento nao esta disponivel.',
          });
          ack?.({ ok: false, reason: error.message, message: 'Acesso de pagamento indisponivel.', serverNow: Date.now() });
          return;
        }
      }

      if (socket.entryAccess) {
        try {
          const reservedEntry = entryService.reserveQueueAccess({
            entryId: socket.entryAccess.entryId,
            socketId: socket.id,
            selectedTable: tableValue,
          });
          socket.entryAccess.preMatchDeadline = reservedEntry.preMatchDeadline ?? socket.entryAccess.preMatchDeadline;
          socket.entryAccess.publicMatchReference = reservedEntry.publicMatchReference ?? socket.entryAccess.publicMatchReference;
        } catch (error) {
          logWarn('WHATSAPP_ENTRY_QUEUE_REJECTED', {
            socketId: socket.id,
            entryId: socket.entryAccess.entryId,
            tableValue,
            reason: error.message,
          });
          if (error.message === 'ENTRY_ACCESS_RESERVED') {
            logWarn('PLAYER_BLOCKED_ACTIVE_QUEUE', {
              playerId: socket.entryAccess.entryId,
              currentTable: socket.entryAccess.selectedTable,
              attemptedTable: tableValue,
              reason: 'ENTRY_ACCESS_RESERVED',
            });
          }
          const message = error.message === 'ENTRY_TABLE_MISMATCH'
            ? 'Use a mesma mesa liberada pelo admin.'
            : error.message === 'ENTRY_ACCESS_RESERVED'
              ? 'Você já possui uma sessão ativa nesta partida/fila.'
            : '⚠️ Não encontrei uma entrada ativa para esta mesa. Digite 2 para ver as mesas disponíveis.';
          socket.emit('matchmakingError', { reason: error.message, message });
          ack?.({ ok: false, reason: error.message, message, serverNow: Date.now() });
          return;
        }
      }

      const queuedPlayer = playerManager.updatePlayer(player.id, {
        name: playerName,
        socketId: socket.id,
        isConnected: true,
        isReady: true,
      });

      const queueResult = queueManager.joinQueue({
        playerId: queuedPlayer.id,
        socketId: socket.id,
        playerName,
        tableValue,
        paymentId: socket.paymentAccess?.paymentId ?? null,
        entryId: socket.entryAccess?.entryId ?? null,
        preMatchDeadline: socket.entryAccess?.preMatchDeadline ?? null,
      });

      if (queueResult.blocked) {
        if (paymentGateEnabled && socket.paymentAccess) {
          paymentService.releaseAccessReservation({
            paymentId: socket.paymentAccess.paymentId,
            socketId: socket.id,
            reason: queueResult.reason,
          });
        }
        if (socket.entryAccess) {
          entryService.releaseQueueAccess({
            entryId: socket.entryAccess.entryId,
            socketId: socket.id,
            reason: queueResult.reason,
          });
        }
        logInfo('MATCHMAKING_ERROR', {
          socketId: socket.id,
          playerId: player.id,
          reason: queueResult.reason,
          tableValue,
        });
        if (queueResult.reason === 'player-already-queued') {
          logWarn('PLAYER_BLOCKED_ACTIVE_QUEUE', {
            playerId: player.id,
            currentTable: queueResult.entry?.tableValue ?? null,
            attemptedTable: tableValue,
          });
        }
        socket.emit('matchmakingError', {
          reason: queueResult.reason,
          message: queueResult.reason === 'queue-full'
            ? 'A fila está temporariamente lotada. Tente novamente em instantes.'
            : 'Voce ja esta na fila ou a entrada nao e valida.',
        });
        ack?.({
          ok: false,
          reason: queueResult.reason,
          message: queueResult.reason === 'queue-full'
            ? 'A fila está temporariamente lotada. Tente novamente em instantes.'
            : 'Voce ja esta na fila ou a entrada nao e valida.',
          serverNow: Date.now(),
        });
        return;
      }

      logInfo('QUEUE_JOINED', {
        socketId: socket.id,
        playerId: player.id,
        playerName,
        tableValue,
        queuePosition: queueResult.queuePosition,
      });
      ack?.({
        ok: true,
        playerId: player.id,
        tableValue,
        queuePosition: queueResult.queuePosition,
        preMatchDeadline: queueResult.entry.preMatchDeadline ?? null,
        serverNow: Date.now(),
      });
      socket.emit('queueJoined', {
        playerId: player.id,
        tableValue,
        queuePosition: queueResult.queuePosition,
        waitingSince: queueResult.entry.joinedAt,
        preMatchDeadline: queueResult.entry.preMatchDeadline ?? null,
        publicMatchReference: socket.entryAccess?.publicMatchReference ?? null,
        serverNow: Date.now(),
      });

      const matchEntries = queueManager.findMatch(tableValue);
      if (matchEntries) {
        await emitMatchFound(matchEntries);
      }
    });

    socket.on('leaveQueue', async (payload = {}, ack) => {
      const leaveRate = actionRateLimiter.consume(`cancel:${socket.entryAccess?.entryId || socket.id}`, {
        limit: 6,
        windowMs: 60_000,
      });
      if (!leaveRate.allowed) {
        ack?.({ ok: false, reason: 'RATE_LIMITED', serverNow: Date.now() });
        return;
      }
      const leaveResult = queueManager.leaveQueue(player.id);
      if (paymentGateEnabled && leaveResult.entry?.paymentId) {
        paymentService.releaseAccessReservation({
          paymentId: leaveResult.entry.paymentId,
          socketId: socket.id,
          reason: 'queue_left',
        });
      }
      const abortResult = leaveResult.entry?.entryId && whatsappMatchQueue
        ? await whatsappMatchQueue.abortMatchAndReleaseParticipants({
            matchId: socket.entryAccess?.whatsappMatchId,
            reason: 'player_left_before_start',
            cancelledBy: entryService?.getEntry?.(leaveResult.entry.entryId, { includeSecrets: true })?.phone ?? null,
          })
        : null;
      if (leaveResult.entry?.entryId && !abortResult?.aborted) {
        entryService?.releaseQueueAccess({
          entryId: leaveResult.entry.entryId,
          socketId: socket.id,
          reason: 'queue_left',
        });
      }
      const updatedPlayer = playerManager.updatePlayer(player.id, { isReady: false });

      logInfo('QUEUE_LEFT', {
        socketId: socket.id,
        playerId: player.id,
        removed: leaveResult.removed,
        tableValue: leaveResult.entry?.tableValue,
      });
      socket.emit('queueLeft', {
        playerId: player.id,
        removed: leaveResult.removed,
        playerName: updatedPlayer?.name ?? player.name,
      });
      ack?.({
        ok: true,
        removed: leaveResult.removed,
        aborted: Boolean(abortResult?.aborted),
        publicReference: abortResult?.participants?.[0]?.publicMatchReference ?? null,
        serverNow: Date.now(),
      });
    });

    socket.on('requestQueueStatus', (payload = {}) => {
      if (!consumeSocketRate('queue-status', { limit: 30 }).allowed) return;
      const tableValue = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload.tableValue
        : null;
      socket.emit('queueStatus', queueManager.getQueueStatus(tableValue));
    });

    socket.on('requestServerStatus', () => {
      if (!consumeSocketRate('server-status', { limit: 60 }).allowed) return;
      socket.emit('serverStatus', buildServerStatus());
    });

    socket.on('getMatchHistory', () => {
      if (!consumeSocketRate('match-history', { limit: 10 }).allowed) return;
      socket.emit('matchHistory', {
        history: matchManager.listPublicMatchHistory(),
      });
    });

    socket.on('getMatchAudit', (payload = {}) => {
      if (!consumeSocketRate('match-audit', { limit: 20 }).allowed) return;
      const publicId = payload && typeof payload === 'object' && !Array.isArray(payload)
        && typeof payload.matchId === 'string' && payload.matchId.length <= 128
        ? payload.matchId
        : '';
      const audit = matchManager.getPublicMatchAudit(publicId);
      if (!audit) {
        socket.emit('matchAudit', {
          matchId: publicId || null,
          error: 'match-history-not-found',
        });
        return;
      }

      socket.emit('matchAudit', { audit });
    });

    onSafe('resumeOnlineMatch', (payload = {}) => {
      const savedPlayerId = String(payload.playerId || '');
      const savedMatchId = String(payload.matchId || '');
      const resumeRate = actionRateLimiter.consume(`recover:${socket.entryAccess?.entryId || socket.id}`, {
        limit: 20,
        windowMs: 60_000,
      });
      const resumeIpRate = actionRateLimiter.consume(`recover-ip:${getSocketClientIp(socket)}`, {
        limit: 30,
        windowMs: 60_000,
      });
      if (!resumeRate.allowed || !resumeIpRate.allowed) {
        rejectAction(socket, {
          reason: 'RATE_LIMITED',
          message: 'Muitas tentativas de recuperação. Aguarde um instante.',
          action: 'resumeOnlineMatch',
        });
        return;
      }
      const currentMatch = matchManager.getOnlineMatch(savedMatchId);
      if (!currentMatch || (payload.roomId && currentMatch.roomId !== payload.roomId)) {
        rejectAction(socket, {
          reason: 'MATCH_NOT_FOUND',
          message: 'Partida ativa nao encontrada.',
          action: 'resumeOnlineMatch',
        });
        return;
      }

      const authorizedPlayerId = resolveAuthorizedMatchPlayer({
        socket,
        match: currentMatch,
        socketManager,
        entryService,
        paymentService,
        requestedPlayerId: savedPlayerId,
      });
      if (!authorizedPlayerId) {
        logWarn('ONLINE_MATCH_RESUME_DENIED', {
          socketId: socket.id,
          matchId: savedMatchId || null,
          reason: 'MATCH_SESSION_MISMATCH',
        });
        rejectAction(socket, {
          reason: 'RESUME_NOT_AUTHORIZED',
          message: 'Esta sessão não está autorizada para recuperar essa partida.',
          action: 'resumeOnlineMatch',
        });
        return;
      }

      if (socket.supersededMatchIds?.has(savedMatchId)) {
        rejectAction(socket, {
          reason: 'RESUME_NOT_AUTHORIZED',
          message: 'Esta sessão foi substituída por outra conexão ativa.',
          action: 'resumeOnlineMatch',
        });
        return;
      }

      const match = matchManager.reconnectOnlinePlayer(savedMatchId, authorizedPlayerId, socket.id);
      if (!match) {
        rejectAction(socket, {
          reason: 'MATCH_NOT_FOUND',
          message: 'Partida ativa nao encontrada.',
          action: 'resumeOnlineMatch',
        });
        return;
      }

      const previousSocketId = currentMatch.players.find((candidate) => candidate.id === authorizedPlayerId)?.socketId;
      const previousSocket = previousSocketId && previousSocketId !== socket.id
        ? socketManager.getSocket(previousSocketId)
        : null;
      if (previousSocket) {
        previousSocket.supersededMatchIds ??= new Set();
        previousSocket.supersededMatchIds.add(savedMatchId);
      }

      socketManager.setPlayerForSocket(socket.id, authorizedPlayerId);
      playerManager.updatePlayer(authorizedPlayerId, {
        socketId: socket.id,
        isConnected: true,
      });
      matchManager.setOnlinePlayerConnection(authorizedPlayerId, true, socket.id);
      const reconnectedMatch = matchManager.getOnlineMatch(savedMatchId) ?? match;
      socket.emit('gameStateUpdated', buildClientGameState(reconnectedMatch, authorizedPlayerId));
      socket.emit('time_sync', buildTimeSync(match));
      logInfo('PLAYER_RECONNECTED', {
        socketId: socket.id,
        playerId: authorizedPlayerId,
        matchId: match.matchId,
        roomId: match.roomId,
        table: match.tableValue ?? match.economy?.tableValue ?? null,
      });
      logInfo('CLIENT_STATE_SENT', {
        eventName: 'resumeOnlineMatch',
        matchId: match.matchId,
        roomId: match.roomId,
        playerId: authorizedPlayerId,
      });
    });

    socket.on('requestGameState', (payload = {}) => {
      if (!consumeSocketRate('game-state', { limit: 60 }).allowed) return;
      const matchId = payload && typeof payload === 'object' && !Array.isArray(payload)
        && typeof payload.matchId === 'string' && payload.matchId.length <= 128
        ? payload.matchId
        : '';
      const currentMatch = matchManager.getOnlineMatch(matchId);
      if (currentMatch && socket.supersededMatchIds?.has(currentMatch.matchId)) {
        rejectAction(socket, {
          reason: 'MATCH_SESSION_MISMATCH',
          message: 'Esta sessão não está autorizada para consultar a partida.',
          action: 'requestGameState',
        });
        return;
      }
      const viewerPlayerId = resolveAuthorizedMatchPlayer({
        socket,
        match: currentMatch,
        socketManager,
        entryService,
        paymentService,
      });

      if (!currentMatch || !viewerPlayerId) {
        rejectAction(socket, {
          reason: currentMatch ? 'MATCH_SESSION_MISMATCH' : 'MATCH_NOT_FOUND',
          message: currentMatch ? 'Esta sessão não está autorizada para consultar a partida.' : 'Partida nao encontrada.',
          action: 'requestGameState',
        });
        return;
      }

      if (payload?.playerId && payload.playerId !== viewerPlayerId) {
        logWarn('REQUEST_GAME_STATE_IDENTITY_MISMATCH', {
          socketId: socket.id,
          matchId: currentMatch.matchId,
          reason: 'CLIENT_IDENTITY_IGNORED',
        });
      }

      const match = matchManager.expireTurnIfNeeded(matchId) ?? currentMatch;

      socket.emit('gameStateUpdated', buildClientGameState(match, viewerPlayerId));
      socket.emit('time_sync', buildTimeSync(match));
      logInfo('CLIENT_STATE_SENT', {
        eventName: 'gameStateUpdated',
        matchId: match.matchId,
        roomId: match.roomId,
        playerId: viewerPlayerId,
      });
    });

    onSafe('playerDrawFromDeck', (payload = {}, ack) => {
      const activePlayerId = getActivePlayerId(payload.matchId);
      const result = matchManager.drawFromDeck(payload.matchId, activePlayerId);
      if (result.blocked) {
        acknowledgeAction(ack, payload, result);
        rejectAction(socket, result);
        if (result.gameState) sendClientGameState(result.gameState);
        return;
      }

      logInfo('PLAYER_DRAW_FROM_DECK', {
        matchId: result.gameState.matchId,
        roomId: result.gameState.roomId,
        playerId: activePlayerId,
        deckCount: result.gameState.deckCount,
      });
      acknowledgeAction(ack, payload, result);
      sendClientGameState(result.gameState);
    });

    onSafe('playerDrawFromDiscard', (payload = {}, ack) => {
      const activePlayerId = getActivePlayerId(payload.matchId);
      const result = matchManager.drawFromDiscard(payload.matchId, activePlayerId);
      if (result.blocked) {
        acknowledgeAction(ack, payload, result);
        rejectAction(socket, result);
        return;
      }

      logInfo('PLAYER_DRAW_FROM_DISCARD', {
        matchId: result.gameState.matchId,
        roomId: result.gameState.roomId,
        playerId: activePlayerId,
        topDiscardCard: result.gameState.topDiscardCard?.id ?? null,
      });
      acknowledgeAction(ack, payload, result);
      sendClientGameState(result.gameState);
    });

    onSafe('playerDiscardCard', (payload = {}, ack) => {
      const activePlayerId = getActivePlayerId(payload.matchId);
      const result = matchManager.discardOnlineCard(payload.matchId, activePlayerId, payload.cardId);
      if (result.blocked) {
        acknowledgeAction(ack, payload, result);
        rejectAction(socket, result);
        return;
      }

      logInfo('PLAYER_DISCARDED_CARD', {
        matchId: result.gameState.matchId,
        roomId: result.gameState.roomId,
        playerId: activePlayerId,
        cardId: result.card.id,
      });
      logInfo('TURN_CHANGED', {
        matchId: result.gameState.matchId,
        roomId: result.gameState.roomId,
        currentTurnPlayerId: result.gameState.currentTurnPlayerId,
        turnNumber: result.gameState.turnNumber,
      });
      acknowledgeAction(ack, payload, result);
      sendClientGameState(result.gameState);
    });

    onSafe('player:reorderHand', (payload = {}, ack) => {
      const result = matchManager.reorderOnlineHand(payload.matchId, getActivePlayerId(payload.matchId), payload.handOrder);
      if (result.blocked) {
        acknowledgeAction(ack, payload, result);
        rejectAction(socket, result);
        return;
      }
      acknowledgeAction(ack, payload, result);
    });

    const handlePlayerKnock = (payload = {}, ack) => {
      const activePlayerId = getActivePlayerId(payload.matchId);
      const result = matchManager.knockOnline(payload.matchId, activePlayerId);
      if (result.blocked) {
        acknowledgeAction(ack, payload, result);
        rejectAction(socket, result);
        return;
      }

      logInfo('PLAYER_KNOCKED', {
        matchId: result.gameState.matchId,
        roomId: result.gameState.roomId,
        playerId: activePlayerId,
      });
      logInfo('MATCH_FINISHED', buildMatchFinishedLog(result.gameState, 'knock'));
      acknowledgeAction(ack, payload, result);
      void finishMatchAndNotify(result.gameState, 'knock');
    };

    onSafe('playerKnock', handlePlayerKnock);
    onSafe('player:knock', handlePlayerKnock);

    onSafe('playerSurrender', (payload = {}, ack) => {
      const activePlayerId = getActivePlayerId(payload.matchId);
      const surrenderRate = actionRateLimiter.consume(`forfeit:${activePlayerId}`, {
        limit: 3,
        windowMs: 60_000,
      });
      if (!surrenderRate.allowed) {
        ack?.({ ok: false, reason: 'RATE_LIMITED', serverNow: Date.now() });
        return;
      }
      const result = matchManager.surrenderOnlineMatch(payload.matchId, activePlayerId);
      if (result.blocked) {
        acknowledgeAction(ack, payload, result);
        rejectAction(socket, result);
        return;
      }

      logInfo('PLAYER_FORFEIT', {
        matchId: result.gameState.matchId,
        roomId: result.gameState.roomId,
        forfeitingPlayerId: activePlayerId,
        winnerId: result.gameState.result?.winnerId ?? null,
      });
      logInfo('MATCH_FINISHED', buildMatchFinishedLog(result.gameState, 'player_forfeit'));
      acknowledgeAction(ack, payload, result);
      void finishMatchAndNotify(result.gameState, 'player_forfeit');
    });

    socket.on('disconnect', (reason) => {
      const activePlayerId = getActivePlayerId();
      const leaveResult = queueManager.leaveQueueBySocket(socket.id);
      if (leaveResult.removed) {
        if (paymentGateEnabled && leaveResult.entry.paymentId) {
          paymentService.releaseAccessReservation({
            paymentId: leaveResult.entry.paymentId,
            socketId: socket.id,
            reason: 'disconnect',
          });
        }
        if (leaveResult.entry.entryId) {
          entryService?.releaseQueueAccess({
            entryId: leaveResult.entry.entryId,
            socketId: socket.id,
            reason: 'disconnect',
          });
        }
        logInfo('QUEUE_LEFT', {
          socketId: socket.id,
          playerId: activePlayerId,
          removed: true,
          reason: 'disconnect',
          tableValue: leaveResult.entry.tableValue,
        });
      }
      playerManager.setPlayerConnected(activePlayerId, false);
      const disconnectedMatch = matchManager.handleOnlineDisconnect(activePlayerId);
      if (activePlayerId && !disconnectedMatch) playerManager.removePlayer(activePlayerId);
      socketManager.removeSocket(socket.id);
      broadcastServerStatus();

      logInfo('SOCKET_DISCONNECTED', { socketId: socket.id, playerId: activePlayerId, reason });
      logInfo('PLAYER_DISCONNECTED', {
        socketId: socket.id,
        playerId: activePlayerId,
        matchId: disconnectedMatch?.matchId ?? null,
        table: disconnectedMatch?.tableValue ?? disconnectedMatch?.economy?.tableValue ?? null,
        reason,
      });
    });
  });

  logInfo('SOCKET_SERVER_READY', {
    phase: '4.15',
    roomMode: config.ROOM_MODE,
  });

  return io;
}

export default setupSocketServer;
