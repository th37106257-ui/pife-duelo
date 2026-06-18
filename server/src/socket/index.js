import { Server } from 'socket.io';
import { config } from '../config.js';
import { buildClientGameState } from '../game/clientState.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { recordClientError } from '../observabilityStore.js';

export function setupSocketServer(httpServer, {
  roomManager,
  matchManager,
  playerManager,
  socketManager,
  queueManager,
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
    uptime: Math.round(process.uptime()),
  });

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
      logInfo('MATCH_FINISHED', {
        matchId: gameState.matchId,
        roomId: gameState.roomId,
        winnerId: gameState.result?.winnerId ?? null,
        loserId: gameState.result?.loserId ?? null,
        reason: 'disconnect',
      });
      sendClientGameState(gameState, 'matchFinished');
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

    const onlineMatch = matchManager.createOnlineMatch(room.roomId, room.players, room.tableValue);
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
      currentTurnPlayerId: onlineMatch.currentTurnPlayerId,
    });
    sendClientGameState(onlineMatch, 'matchStarted');

    return room;
  };

  queueManager.setTimeoutHandler((entry) => {
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

    onSafe('joinQueue', (payload = {}) => {
      const playerName = String(payload.playerName || '').trim().slice(0, 32) || 'Jogador';
      const tableValue = Number(payload.tableValue);

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
        return;
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
      });

      if (queueResult.blocked) {
        logInfo('MATCHMAKING_ERROR', {
          socketId: socket.id,
          playerId: player.id,
          reason: queueResult.reason,
          tableValue,
        });
        socket.emit('matchmakingError', {
          reason: queueResult.reason,
          message: 'Voce ja esta na fila ou a entrada nao e valida.',
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
      logInfo('MATCH_FINISHED', {
        matchId: result.gameState.matchId,
        roomId: result.gameState.roomId,
        winnerId: activePlayerId,
        reason: 'knock',
      });
      acknowledgeAction(ack, payload, result);
      sendClientGameState(result.gameState, 'matchFinished');
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

      logInfo('MATCH_FINISHED', {
        matchId: result.gameState.matchId,
        roomId: result.gameState.roomId,
        winnerId: result.gameState.result?.winnerId ?? null,
        loserId: activePlayerId,
        reason: 'surrender',
      });
      acknowledgeAction(ack, payload, result);
      sendClientGameState(result.gameState, 'matchFinished');
    });

    socket.on('disconnect', (reason) => {
      const activePlayerId = getActivePlayerId();
      const leaveResult = queueManager.leaveQueueBySocket(socket.id);
      if (leaveResult.removed) {
        logInfo('QUEUE_LEFT', {
          socketId: socket.id,
          playerId: activePlayerId,
          removed: true,
          reason: 'disconnect',
          tableValue: leaveResult.entry.tableValue,
        });
      }
      playerManager.setPlayerConnected(activePlayerId, false);
      matchManager.handleOnlineDisconnect(activePlayerId);
      socketManager.removeSocket(socket.id);
      broadcastServerStatus();

      logInfo('SOCKET_DISCONNECTED', { socketId: socket.id, playerId: activePlayerId, reason });
      logInfo('PLAYER_DISCONNECTED', { socketId: socket.id, playerId: activePlayerId, reason });
    });
  });

  logInfo('SOCKET_SERVER_READY', {
    phase: '4.15',
    roomMode: config.ROOM_MODE,
  });

  return io;
}

export default setupSocketServer;
