import { Server } from 'socket.io';
import { config } from '../config.js';
import { buildClientGameState } from '../game/clientState.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { recordClientError } from '../observabilityStore.js';
import { createPostMatchFlow } from '../services/postMatchFlow.js';

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
  corsOptions,
} = {}) {
  const io = new Server(httpServer, {
    cors: corsOptions ?? {
      origin: config.ALLOWED_CLIENT_URLS,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    pingInterval: 25000,
    pingTimeout: 20000,
  });
  if (paymentGateEnabled || safeEntryEnabled) {
    io.use((socket, next) => {
      const entryToken = String(socket.handshake.auth?.entryToken || '').trim();
      if (safeEntryEnabled && entryToken) {
        const entry = entryService?.validateAccessToken(entryToken);
        if (!entry) {
          const requestedMatchId = String(socket.handshake.auth?.joinMatchId || '').trim() || null;
          logWarn('WHATSAPP_ENTRY_LINK_OPENED', {
            socketId: socket.id,
            requestedMatchId,
            matchFound: false,
            reason: 'ENTRY_ACCESS_DENIED',
          });
          logWarn('STALE_MATCH_LINK_OPENED', {
            socketId: socket.id,
            requestedMatchId,
            reason: 'ENTRY_ACCESS_DENIED',
          });
          const error = new Error('ENTRY_ACCESS_DENIED');
          error.data = { code: 'ENTRY_ACCESS_DENIED' };
          next(error);
          return;
        }
        const requestedMatchId = String(socket.handshake.auth?.joinMatchId || '').trim();
        const expectedMatchId = entry.whatsappMatchId || entry.linkedMatchId || null;
        if (requestedMatchId && expectedMatchId && requestedMatchId !== expectedMatchId) {
          logWarn('WHATSAPP_ENTRY_LINK_OPENED', {
            socketId: socket.id,
            requestedMatchId,
            expectedMatchId,
            entryId: entry.entryId,
            matchFound: false,
            reason: 'ENTRY_MATCH_MISMATCH',
          });
          const error = new Error('ENTRY_MATCH_MISMATCH');
          error.data = { code: 'ENTRY_ACCESS_DENIED' };
          next(error);
          return;
        }
        logInfo('WHATSAPP_ENTRY_LINK_OPENED', {
          socketId: socket.id,
          requestedMatchId: requestedMatchId || null,
          expectedMatchId,
          linkedMatchId: entry.linkedMatchId ?? null,
          entryId: entry.entryId,
          selectedTable: entry.selectedTable,
          matchFound: Boolean(entry.linkedMatchId || expectedMatchId),
        });
        socket.entryAccess = {
          entryId: entry.entryId,
          selectedTable: entry.selectedTable,
          linkedMatchId: entry.linkedMatchId ?? null,
          whatsappMatchId: entry.whatsappMatchId ?? null,
          requestedMatchId: requestedMatchId || null,
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

  const sendTimeSync = (gameState) => {
    const payload = buildTimeSync(gameState);
    gameState.players.forEach((player) => {
      socketManager.getSocket(player.socketId)?.emit('time_sync', payload);
    });
  };

  const sendClientGameState = (gameState, eventName = 'gameStateUpdated') => {
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
    activeRooms: roomManager.listRooms().length,
    activeMatches: matchManager.listMatches().filter((match) => match.status !== 'finished').length,
    queuedPlayers: queueManager.getQueueSize(),
    paymentGateEnabled,
    safeEntryEnabled,
    uptime: Math.round(process.uptime()),
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

  const postMatchFlow = createPostMatchFlow({
    entryService,
    whatsappBot,
    whatsappMatchQueue,
    whatsappEnabled: config.POST_MATCH_WHATSAPP_ENABLED,
    logInfo,
    logWarn,
    logError,
  });

  const finishMatchAndNotify = (gameState, reason = 'match_finished') => postMatchFlow.finishMatchAndNotify(
    gameState,
    reason,
    { emitResult: sendClientGameState },
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

  const emitMatchFound = (entries) => {
    const [first, second] = entries;
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

  queueManager.setTimeoutHandler((entry) => {
    if (paymentGateEnabled && entry.paymentId) {
      paymentService.releaseAccessReservation({
        paymentId: entry.paymentId,
        socketId: entry.socketId,
        reason: 'queue_timeout',
      });
    }
    const abortResult = entry.entryId && whatsappMatchQueue
      ? whatsappMatchQueue.abortMatchAndReleaseParticipants({
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
      message: 'Nenhum adversario encontrado. Tente novamente.',
      canTryAgain: true,
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
      } : null,
    });
    broadcastServerStatus();

    const getActivePlayerId = () => socketManager.getPlayerBySocket(socket.id)?.id ?? player.id;
    const onSafe = (eventName, handler) => {
      socket.on(eventName, (payload = {}, acknowledgement) => {
        const ack = typeof acknowledgement === 'function' ? acknowledgement : null;
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
      logInfo('PING_RECEIVED', { socketId: socket.id, playerId: player.id });
      socket.emit('pong', {
        ok: true,
        receivedAt: new Date().toISOString(),
        payload,
      });
      logInfo('PONG_SENT', { socketId: socket.id, playerId: player.id });
    });

    socket.on('ping_game', (payload = {}, ack) => {
      ack?.({
        clientSentAt: Number(payload.clientSentAt) || null,
        serverNow: Date.now(),
        transport: socket.conn.transport.name,
      });
    });

    socket.on('client_error_report', (payload = {}) => {
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

    onSafe('joinQueue', (payload = {}, ack) => {
      const playerName = String(payload.playerName || '').trim().slice(0, 32) || 'Jogador';
      const tableValue = Number(payload.tableValue);
      logInfo('JOIN_QUEUE_RECEIVED', {
        socketId: socket.id,
        playerId: player.id,
        playerName,
        tableValue,
      });

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
          entryService.reserveQueueAccess({
            entryId: socket.entryAccess.entryId,
            socketId: socket.id,
            selectedTable: tableValue,
          });
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
          message: 'Voce ja esta na fila ou a entrada nao e valida.',
        });
        ack?.({
          ok: false,
          reason: queueResult.reason,
          message: 'Voce ja esta na fila ou a entrada nao e valida.',
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
        serverNow: Date.now(),
      });
      socket.emit('queueJoined', {
        playerId: player.id,
        tableValue,
        queuePosition: queueResult.queuePosition,
        waitingSince: queueResult.entry.joinedAt,
      });

      const matchEntries = queueManager.findMatch(tableValue);
      if (matchEntries) {
        emitMatchFound(matchEntries);
      }
    });

    socket.on('leaveQueue', () => {
      const leaveResult = queueManager.leaveQueue(player.id);
      if (paymentGateEnabled && leaveResult.entry?.paymentId) {
        paymentService.releaseAccessReservation({
          paymentId: leaveResult.entry.paymentId,
          socketId: socket.id,
          reason: 'queue_left',
        });
      }
      const abortResult = leaveResult.entry?.entryId && whatsappMatchQueue
        ? whatsappMatchQueue.abortMatchAndReleaseParticipants({
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
    });

    socket.on('requestQueueStatus', (payload = {}) => {
      socket.emit('queueStatus', queueManager.getQueueStatus(payload.tableValue));
    });

    socket.on('requestServerStatus', () => {
      socket.emit('serverStatus', buildServerStatus());
    });

    socket.on('getMatchHistory', () => {
      socket.emit('matchHistory', {
        history: matchManager.listMatchHistory(),
      });
    });

    socket.on('getMatchAudit', (payload = {}) => {
      const audit = matchManager.getMatchAudit(payload.matchId);
      if (!audit) {
        socket.emit('matchAudit', {
          matchId: payload.matchId,
          error: 'match-history-not-found',
        });
        return;
      }

      socket.emit('matchAudit', { audit });
    });

    onSafe('resumeOnlineMatch', (payload = {}) => {
      const savedPlayerId = String(payload.playerId || '');
      const savedMatchId = String(payload.matchId || '');
      const match = matchManager.reconnectOnlinePlayer(savedMatchId, savedPlayerId, socket.id);

      if (!match || (payload.roomId && match.roomId !== payload.roomId)) {
        rejectAction(socket, {
          reason: 'MATCH_NOT_FOUND',
          message: 'Partida ativa nao encontrada.',
          action: 'resumeOnlineMatch',
        });
        return;
      }

      socketManager.setPlayerForSocket(socket.id, savedPlayerId);
      playerManager.updatePlayer(savedPlayerId, {
        socketId: socket.id,
        isConnected: true,
      });
      matchManager.setOnlinePlayerConnection(savedPlayerId, true, socket.id);
      socket.emit('gameStateUpdated', buildClientGameState(match, savedPlayerId));
      socket.emit('time_sync', buildTimeSync(match));
      logInfo('PLAYER_RECONNECTED', {
        socketId: socket.id,
        playerId: savedPlayerId,
        matchId: match.matchId,
        roomId: match.roomId,
        table: match.tableValue ?? match.economy?.tableValue ?? null,
      });
      logInfo('CLIENT_STATE_SENT', {
        eventName: 'resumeOnlineMatch',
        matchId: match.matchId,
        roomId: match.roomId,
        playerId: savedPlayerId,
      });
    });

    socket.on('requestGameState', (payload = {}) => {
      const match = matchManager.expireTurnIfNeeded(payload.matchId) ?? matchManager.getOnlineMatch(payload.matchId);
      const viewerPlayerId = match?.players.some((item) => item.id === payload.playerId)
        ? payload.playerId
        : player.id;

      if (!match || !match.players.some((item) => item.id === viewerPlayerId)) {
        rejectAction(socket, {
          reason: 'MATCH_NOT_FOUND',
          message: 'Partida nao encontrada.',
          action: 'requestGameState',
        });
        return;
      }

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
      const activePlayerId = getActivePlayerId();
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
      const activePlayerId = getActivePlayerId();
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
      const activePlayerId = getActivePlayerId();
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
      const result = matchManager.reorderOnlineHand(payload.matchId, getActivePlayerId(), payload.handOrder);
      if (result.blocked) {
        acknowledgeAction(ack, payload, result);
        rejectAction(socket, result);
        return;
      }
      acknowledgeAction(ack, payload, result);
    });

    const handlePlayerKnock = (payload = {}, ack) => {
      const activePlayerId = getActivePlayerId();
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
      const activePlayerId = getActivePlayerId();
      const result = matchManager.surrenderOnlineMatch(payload.matchId, activePlayerId);
      if (result.blocked) {
        acknowledgeAction(ack, payload, result);
        rejectAction(socket, result);
        return;
      }

      logInfo('MATCH_FINISHED', buildMatchFinishedLog(result.gameState, 'surrender'));
      acknowledgeAction(ack, payload, result);
      void finishMatchAndNotify(result.gameState, 'surrender');
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
