import { useEffect, useMemo, useRef, useState } from 'react';
import OnlineGameTable from './OnlineGameTable.jsx';
import MatchHistoryScreen from './MatchHistoryScreen.jsx';
import WhatsAppLobbyFallback from './WhatsAppLobbyFallback.jsx';
import {
  clearStaleMatchAccessFromUrl,
  connectSocket,
  disconnectSocket,
  getSocket,
  getSocketConnectionState,
  subscribeSocketConnection,
} from '../services/socket.js';
import { resumeOnlineMatch, startOnlineListeners, stopOnlineListeners } from '../services/onlineGameSocket.js';
import { formatMoney, listOfficialTables } from '../shared/economy.js';
import { isWhatsAppFirstLobbyEnabled } from '../services/whatsAppLink.js';

const TABLE_OPTIONS = listOfficialTables();
const ACTIVE_MATCH_STORAGE_KEY = 'pifeDuelo.activeOnlineMatch';

function readEntryTokenFromUrl() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('entry')?.trim() || '';
}

function readJoinMatchIdFromUrl() {
  if (typeof window === 'undefined') return '';
  const pathMatch = window.location.pathname.match(/^\/join\/([^/]+)\/?$/);
  return decodeURIComponent(pathMatch?.[1] || new URLSearchParams(window.location.search).get('matchId') || '').trim();
}

function readStoredMatchSession() {
  if (typeof window === 'undefined') return null;

  try {
    const rawSession = window.localStorage.getItem(ACTIVE_MATCH_STORAGE_KEY);
    if (!rawSession) return null;

    const session = JSON.parse(rawSession);
    if (!session?.matchId || !session?.roomId || !session?.playerId) return null;
    return session;
  } catch {
    return null;
  }
}

function writeStoredMatchSession(session) {
  if (typeof window === 'undefined') return;

  if (!session?.matchId || !session?.roomId || !session?.playerId) return;
  window.localStorage.setItem(ACTIVE_MATCH_STORAGE_KEY, JSON.stringify(session));
}

function clearStoredMatchSession() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACTIVE_MATCH_STORAGE_KEY);
}

function maskClientId(value = '') {
  const text = String(value || '');
  if (text.length <= 8) return text;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainingSeconds = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function buildPreMatchReviewMessage(publicReference) {
  const reference = String(publicReference || '').trim();
  return reference
    ? `Minha partida nao iniciou e quero verificar minha entrada. Codigo: ${reference}`
    : 'Minha partida nao iniciou e quero verificar minha entrada.';
}

function joinQueueWithConfirmation(socket, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit('joinQueue', payload, (error, acknowledgement = {}) => {
      if (error) {
        reject(new Error('O servidor nao confirmou a entrada na fila.'));
        return;
      }
      if (!acknowledgement.ok) {
        reject(new Error(acknowledgement.message || 'Nao foi possivel entrar na fila.'));
        return;
      }
      resolve(acknowledgement);
    });
  });
}

export default function MatchmakingScreen() {
  const [playerName, setPlayerName] = useState('Jogador');
  const [tableValue, setTableValue] = useState(2);
  const [lockedTableValue, setLockedTableValue] = useState(null);
  const [status, setStatus] = useState('idle');
  const [playerId, setPlayerId] = useState(null);
  const [queueInfo, setQueueInfo] = useState(null);
  const [matchInfo, setMatchInfo] = useState(null);
  const [onlineGameState, setOnlineGameState] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState(60);
  const [terminalFlow, setTerminalFlow] = useState(null);
  const [onlinePlayers, setOnlinePlayers] = useState(null);
  const [serverConnection, setServerConnection] = useState(getSocketConnectionState);
  const waitingSinceRef = useRef(null);
  const activeSessionRef = useRef(readStoredMatchSession());
  const onlineGameStateRef = useRef(null);
  const bootstrappedRef = useRef(false);
  const directJoinAttemptedRef = useRef(false);
  const recoveryInProgressRef = useRef(false);
  const recoveryLoggedMatchRef = useRef(null);
  const terminalFlowRef = useRef(null);
  const directJoinMatchId = useMemo(() => readJoinMatchIdFromUrl(), []);
  const hasDirectEntryLink = useMemo(() => Boolean(readEntryTokenFromUrl()), []);
  const whatsappFirstLobbyEnabled = useMemo(() => isWhatsAppFirstLobbyEnabled(), []);
  const hasStoredSession = useMemo(() => Boolean(readStoredMatchSession()), []);

  const opponent = useMemo(
    () => matchInfo?.players?.find((player) => player.position === 'top') ?? null,
    [matchInfo],
  );
  const isServerConnected = serverConnection.connected && serverConnection.status === 'connected';

  useEffect(() => subscribeSocketConnection((nextState) => {
    setServerConnection({ ...nextState });
    if (nextState.status === 'error') {
      setErrorMessage(nextState.message || 'Servidor indisponivel. Tente novamente.');
    }
  }), []);

  useEffect(() => {
    if (status !== 'searching') return undefined;

    const interval = window.setInterval(() => {
      if (!waitingSinceRef.current) {
        setElapsedSeconds(0);
        return;
      }

      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - waitingSinceRef.current) / 1000)));
      const deadline = Date.parse(queueInfo?.preMatchDeadline || '');
      if (Number.isFinite(deadline)) {
        const nextRemaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        setRemainingSeconds(nextRemaining);
        if (nextRemaining === 0) getSocket()?.emit('requestQueueStatus', { tableValue });
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [queueInfo?.preMatchDeadline, status, tableValue]);

  useEffect(() => {
    terminalFlowRef.current = terminalFlow;
  }, [terminalFlow]);

  const normalizeOnlineState = (payload) => ({
    isOnlineMode: true,
    roomId: payload.roomId,
    matchId: payload.matchId,
    tableValue: payload.tableValue ?? activeSessionRef.current?.tableValue ?? matchInfo?.tableValue ?? tableValue,
    economy: payload.economy,
    paymentStatus: payload.paymentStatus,
    economicResult: payload.economicResult,
    playerId: payload.you?.playerId,
    you: payload.you,
    opponent: payload.opponent,
    hand: payload.you?.hand ?? [],
    hasDrawnThisTurn: Boolean(payload.you?.hasDrawnThisTurn),
    deckCount: payload.deckCount,
    discardCount: payload.discardCount,
    canRecycleDrawPile: Boolean(payload.canRecycleDrawPile),
    topDiscardCard: payload.topDiscardCard,
    isYourTurn: payload.isYourTurn,
    turnNumber: payload.turnNumber,
    serverNow: payload.serverNow,
    turnStartedAt: payload.turnStartedAt,
    turnDurationMs: payload.turnDurationMs,
    turnDurationSeconds: payload.turnDurationSeconds,
    currentTurnPlayerId: payload.currentTurnPlayerId,
    isResolvingAction: payload.isResolvingAction,
    status: payload.status,
    result: payload.result,
    matchLog: payload.matchLog ?? [],
    entryAccess: payload.entryAccess ?? activeSessionRef.current?.entryAccess ?? null,
    fromWhatsAppEntry: Boolean(payload.entryAccess?.entryId || activeSessionRef.current?.entryAccess?.entryId || hasDirectEntryLink),
  });

  const rememberOnlineState = (nextState) => {
    if (!nextState?.matchId || !nextState?.roomId || !nextState?.playerId) return;

    if (nextState.status === 'finished') {
      activeSessionRef.current = null;
      clearStoredMatchSession();
      return;
    }

    const session = {
      matchId: nextState.matchId,
      roomId: nextState.roomId,
      playerId: nextState.playerId,
      tableValue: nextState.tableValue,
      entryAccess: nextState.entryAccess ?? null,
      fromWhatsAppEntry: Boolean(nextState.fromWhatsAppEntry),
      savedAt: Date.now(),
    };
    activeSessionRef.current = session;
    writeStoredMatchSession(session);
  };

  const applyOnlineState = (payload, nextStatus = null) => {
    const normalized = normalizeOnlineState(payload);
    if (!normalized.you?.playerId) {
      setActionError('Nao foi possivel recuperar sua partida.');
      return;
    }

    rememberOnlineState(normalized);
    onlineGameStateRef.current = normalized;
    setOnlineGameState(normalized);
    setPlayerId(normalized.playerId);
    setStatus(nextStatus ?? (normalized.status === 'finished' ? 'finished' : 'playing'));

    if (
      recoveryInProgressRef.current
      && normalized.matchId
      && normalized.matchId === activeSessionRef.current?.matchId
      && recoveryLoggedMatchRef.current !== normalized.matchId
    ) {
      console.info('CLIENT_RECOVERY_SUCCESS', {
        matchId: maskClientId(normalized.matchId),
        roomId: maskClientId(normalized.roomId),
        playerId: maskClientId(normalized.playerId),
        status: normalized.status,
        turnNumber: normalized.turnNumber,
      });
      recoveryLoggedMatchRef.current = normalized.matchId;
      recoveryInProgressRef.current = false;
    }
  };

  const attachListeners = (socket) => {
    socket.pifeLobbyCleanup?.();
    stopOnlineListeners();

    const onConnectionSuccess = (payload) => {
      setPlayerId(payload.playerId);
      const authorizedTable = payload.entryAccess?.selectedTable ?? payload.paymentAccess?.selectedTable;
      if (payload.entryAccess?.requestedMatchId || payload.entryAccess?.whatsappMatchId || directJoinMatchId) {
        console.info('[whatsapp-link] matchId recebido:', payload.entryAccess?.requestedMatchId || directJoinMatchId || null);
        console.info('[whatsapp-link] partida encontrada:', Boolean(payload.entryAccess?.whatsappMatchId || payload.entryAccess?.linkedMatchId));
      }
      if (authorizedTable) {
        const lockedTable = Number(authorizedTable);
        setTableValue(lockedTable);
        setLockedTableValue(lockedTable);
      }
      socket.emit('requestServerStatus');
    };

    const onServerStatus = (payload) => {
      setOnlinePlayers(Math.max(0, Number(payload.onlinePlayers) || 0));
      setErrorMessage('');
    };

    const onQueueJoined = (payload) => {
      console.info('[socket] entrada na fila confirmada:', payload);
      waitingSinceRef.current = new Date(payload.waitingSince).getTime();
      setElapsedSeconds(0);
      const deadline = Date.parse(payload.preMatchDeadline || '');
      setRemainingSeconds(Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 60);
      setQueueInfo(payload);
      setErrorMessage('');
      setStatus('searching');
    };

    const onQueueLeft = () => {
      waitingSinceRef.current = null;
      setQueueInfo(null);
      setElapsedSeconds(0);
      if (whatsappFirstLobbyEnabled && hasDirectEntryLink) {
        if (!terminalFlowRef.current) {
          setTerminalFlow({
            title: 'Espera cancelada',
            message: 'Sua partida não iniciou. Você já pode voltar ao WhatsApp.',
            autoRedirect: true,
          });
        }
        setStatus('terminal');
        return;
      }
      setStatus('idle');
    };

    const onQueueTimeout = (payload) => {
      waitingSinceRef.current = null;
      setQueueInfo(null);
      setElapsedSeconds(0);
      setErrorMessage(payload.message);
      if (whatsappFirstLobbyEnabled) {
        setTerminalFlow({
          title: 'Tempo de espera encerrado',
          message: payload.message || 'Sua partida não iniciou dentro do prazo. Sua entrada foi liberada com segurança.',
          publicReference: payload.publicReference || null,
          whatsappMessage: buildPreMatchReviewMessage(payload.publicReference),
          autoRedirect: true,
        });
        setStatus('terminal');
      } else {
        setStatus('timeout');
      }
    };

    const onQueueStatus = (payload) => {
      setQueueInfo((current) => ({
        ...current,
        ...payload,
      }));
    };

    const onMatchAborted = (payload = {}) => {
      const previousMatchId = activeSessionRef.current?.matchId
        ?? onlineGameStateRef.current?.matchId
        ?? payload.matchId
        ?? directJoinMatchId
        ?? null;
      waitingSinceRef.current = null;
      activeSessionRef.current = null;
      onlineGameStateRef.current = null;
      clearStoredMatchSession();
      clearStaleMatchAccessFromUrl();
      setLockedTableValue(null);
      setQueueInfo(null);
      setMatchInfo(null);
      setOnlineGameState(null);
      setElapsedSeconds(0);
      setActionError('');
      setErrorMessage(payload.message || 'Sua partida anterior foi encerrada. Voce ja pode escolher uma mesa novamente.');
      if (whatsappFirstLobbyEnabled) {
        setTerminalFlow({
          title: payload.reason === 'queue_timeout_before_start' ? 'Partida não iniciada' : 'Partida encerrada',
          message: payload.paidEntryPreserved
            ? 'Sua partida não iniciou. Sua entrada será encaminhada para revisão.'
            : (payload.message || 'Sua partida anterior foi encerrada. Você já pode voltar ao WhatsApp.'),
          publicReference: payload.publicReference || null,
          whatsappMessage: payload.paidEntryPreserved || payload.publicReference
            ? buildPreMatchReviewMessage(payload.publicReference)
            : 'menu',
          autoRedirect: true,
        });
        setStatus('terminal');
      } else {
        setStatus('idle');
      }
      console.info('LOBBY_STATE_RESET_AFTER_ABORT', {
        matchId: maskClientId(previousMatchId),
        cleared: true,
      });

      disconnectSocket();
      if (whatsappFirstLobbyEnabled) return;
      window.setTimeout(async () => {
        try {
          const freshSocket = await connectSocket();
          attachListeners(freshSocket);
        } catch (error) {
          setErrorMessage(error.message || 'Servidor indisponivel. Tente conectar novamente.');
        }
      }, 0);
    };

    const onMatchFound = (payload) => {
      console.info('[socket] match_found recebido:', payload.roomId);
      waitingSinceRef.current = null;
      activeSessionRef.current = {
        roomId: payload.roomId,
        playerId: socket.connectionSuccess?.playerId || playerId,
        tableValue: payload.tableValue,
      };
      setMatchInfo(payload);
      setQueueInfo(null);
      setElapsedSeconds(0);
      setStatus('matched');
    };

    startOnlineListeners({
      onMatchStarted: (payload) => {
        setActionError('');
        applyOnlineState(payload, 'playing');
      },
      onGameStateUpdated: (payload) => {
        setActionError('');
        applyOnlineState(payload);
      },
      onMatchFinished: (payload) => {
        setActionError('');
        applyOnlineState(payload, 'finished');
      },
      onActionRejected: (payload) => {
        setActionError(payload.message || payload.reason || 'Acao rejeitada.');
        if (String(payload.reason || '').includes('DUPLICATE_SESSION')) {
          console.warn('DUPLICATE_SESSION_BLOCKED', {
            reason: payload.reason,
            action: payload.action,
          });
        }
        if (payload.reason === 'MATCH_NOT_FOUND') {
          if (recoveryInProgressRef.current) {
            console.warn('CLIENT_RECOVERY_FAILED', {
              reason: payload.reason,
              action: payload.action,
            });
            recoveryInProgressRef.current = false;
          }
          activeSessionRef.current = null;
          onlineGameStateRef.current = null;
          clearStoredMatchSession();
          setOnlineGameState(null);
          setStatus('idle');
        }
      },
    });

    const onMatchmakingError = (payload) => {
      setErrorMessage(payload.message || 'Nao foi possivel entrar na fila.');
      setStatus('idle');
    };

    const onDisconnect = () => {
      waitingSinceRef.current = null;
      setQueueInfo(null);
      if (!activeSessionRef.current) {
        setStatus('idle');
      }
    };

    const onConnect = () => {
      socket.emit('requestServerStatus');
      const session = activeSessionRef.current ?? readStoredMatchSession();
      if (session?.matchId && session?.roomId && session?.playerId) {
        console.info('CLIENT_RECOVERY_SOCKET_CONNECTED', {
          matchId: maskClientId(session.matchId),
          roomId: maskClientId(session.roomId),
          playerId: maskClientId(session.playerId),
        });
        activeSessionRef.current = session;
        recoveryInProgressRef.current = true;
        console.info('CLIENT_RECOVERY_REQUEST_SENT', {
          matchId: maskClientId(session.matchId),
          roomId: maskClientId(session.roomId),
          playerId: maskClientId(session.playerId),
        });
        resumeOnlineMatch(session);
      }
    };

    const handlers = {
      'connection:success': onConnectionSuccess,
      serverStatus: onServerStatus,
      queueJoined: onQueueJoined,
      queueLeft: onQueueLeft,
      queueTimeout: onQueueTimeout,
      queueStatus: onQueueStatus,
      matchAborted: onMatchAborted,
      matchFound: onMatchFound,
      matchmakingError: onMatchmakingError,
      disconnect: onDisconnect,
      connect: onConnect,
    };
    Object.entries(handlers).forEach(([eventName, handler]) => socket.on(eventName, handler));
    socket.pifeLobbyCleanup = () => {
      Object.entries(handlers).forEach(([eventName, handler]) => socket.off(eventName, handler));
      socket.pifeLobbyCleanup = null;
    };

    if (socket.connectionSuccess?.playerId) {
      setPlayerId(socket.connectionSuccess.playerId);
    }
    socket.emit('requestServerStatus');
  };

  const enterOnlineQueue = async ({ automatic = false } = {}) => {
    if (status === 'searching' && !automatic) return;

    setErrorMessage('');
    setMatchInfo(null);
    setOnlineGameState(null);
    activeSessionRef.current = null;
    onlineGameStateRef.current = null;
    clearStoredMatchSession();
    setActionError('');
    setStatus('connecting');

    try {
      const socket = await connectSocket();
      attachListeners(socket);
      if (socket.connectionSuccess?.playerId) {
        setPlayerId(socket.connectionSuccess.playerId);
      }
      const authorizedTable = socket.connectionSuccess?.entryAccess?.selectedTable
        ?? socket.connectionSuccess?.paymentAccess?.selectedTable;
      if (authorizedTable) {
        const lockedTable = Number(authorizedTable);
        setTableValue(lockedTable);
        setLockedTableValue(lockedTable);
      }
      const confirmedTableValue = Number(authorizedTable) || null;
      const queueTableValue = confirmedTableValue ?? tableValue;
      const queuePayload = {
        playerName,
        tableValue: queueTableValue,
      };
      console.info('[socket] join_match enviado:', {
        ...queuePayload,
        source: automatic ? 'whatsapp_link' : 'lobby',
        requestedMatchId: socket.connectionSuccess?.entryAccess?.requestedMatchId || directJoinMatchId || null,
      });
      await joinQueueWithConfirmation(socket, queuePayload);
      socket.emit('requestQueueStatus', { tableValue: queueTableValue });
    } catch (error) {
      console.error('[whatsapp-link] erro ao entrar pela URL:', error?.message || error);
      setErrorMessage(error.message || 'Nao foi possivel conectar ao servidor.');
      setStatus('idle');
    }
  };

  const restoreActiveMatch = async () => {
    console.info('CLIENT_RECOVERY_STARTED');
    const session = readStoredMatchSession();
    if (!session?.matchId || !session?.roomId || !session?.playerId) {
      console.info('CLIENT_RECOVERY_FAILED', { reason: 'NO_STORED_SESSION' });
      return false;
    }

    console.info('CLIENT_RECOVERY_STORAGE_FOUND', {
      matchId: maskClientId(session.matchId),
      roomId: maskClientId(session.roomId),
      playerId: maskClientId(session.playerId),
      savedAt: session.savedAt ?? null,
    });
    activeSessionRef.current = session;
    recoveryInProgressRef.current = true;
    setStatus((current) => (current === 'playing' || current === 'finished' ? current : 'connecting'));
    setActionError('');

    try {
      const socket = await connectSocket();
      attachListeners(socket);
      console.info('CLIENT_RECOVERY_SOCKET_CONNECTED', {
        matchId: maskClientId(session.matchId),
        roomId: maskClientId(session.roomId),
        playerId: maskClientId(session.playerId),
      });
      console.info('CLIENT_RECOVERY_REQUEST_SENT', {
        matchId: maskClientId(session.matchId),
        roomId: maskClientId(session.roomId),
        playerId: maskClientId(session.playerId),
      });
      resumeOnlineMatch(session);
      return true;
    } catch (error) {
      console.warn('CLIENT_RECOVERY_FAILED', {
        reason: error.message || 'SOCKET_CONNECT_FAILED',
      });
      recoveryInProgressRef.current = false;
      setActionError(error.message || 'Nao foi possivel reconectar a partida.');
      return false;
    }
  };

  useEffect(() => {
    if (bootstrappedRef.current) return undefined;
    bootstrappedRef.current = true;
    let cancelled = false;

    const bootstrapLobby = async () => {
      const restored = hasDirectEntryLink ? false : await restoreActiveMatch();
      if (cancelled || restored) return;

      try {
        const socket = await connectSocket();
        if (cancelled) return;
        attachListeners(socket);
        socket.emit('requestServerStatus');
        if (hasDirectEntryLink && !directJoinAttemptedRef.current) {
          directJoinAttemptedRef.current = true;
          console.info('[whatsapp-link] abrindo entrada direta:', { matchId: directJoinMatchId || null });
          await enterOnlineQueue({ automatic: true });
        }
      } catch (error) {
        if (error?.code === 'ENTRY_ACCESS_DENIED' && !cancelled) {
          if (whatsappFirstLobbyEnabled) {
            setTerminalFlow({
              title: 'Link indisponível',
              message: 'Este link expirou, já foi utilizado em outra sessão ou a partida foi encerrada.',
              autoRedirect: true,
            });
            setStatus('terminal');
            return;
          }
          try {
            const freshSocket = await connectSocket();
            if (cancelled) return;
            attachListeners(freshSocket);
            freshSocket.emit('requestServerStatus');
            setStatus('idle');
            setErrorMessage(error.message || 'Sua partida anterior foi encerrada. Voce ja pode escolher uma mesa novamente.');
            return;
          } catch (reconnectError) {
            setOnlinePlayers(null);
            setErrorMessage(reconnectError.message || 'Servidor indisponivel. Tente novamente.');
            return;
          }
        }
        setOnlinePlayers(null);
        setErrorMessage(error.message || 'Servidor indisponivel. Tente novamente.');
      }
    };

    bootstrapLobby();

    return () => {
      cancelled = true;
      if (activeSessionRef.current) return;

      getSocket()?.emit('leaveQueue');
      stopOnlineListeners();
      disconnectSocket();
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const socket = getSocket();
      if (socket?.connected) socket.emit('requestServerStatus');
    }, 10000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleResume = () => {
      if (document.visibilityState === 'hidden') return;
      const session = activeSessionRef.current ?? readStoredMatchSession();
      if (!session?.matchId || !session?.roomId || !session?.playerId) return;
      restoreActiveMatch();
    };
    const handlePageHide = () => {
      if (onlineGameStateRef.current) {
        rememberOnlineState(onlineGameStateRef.current);
      }
    };

    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('focus', handleResume);
    window.addEventListener('pageshow', handleResume);

    return () => {
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('focus', handleResume);
      window.removeEventListener('pageshow', handleResume);
    };
  }, []);

  const handlePlayOnline = async () => {
    await enterOnlineQueue();
  };

  const handleReconnectServer = async () => {
    setErrorMessage('');
    try {
      const socket = await connectSocket();
      attachListeners(socket);
    } catch (error) {
      setErrorMessage(error.message || 'Servidor indisponivel. Tente novamente.');
    }
  };

  const handleCancel = () => {
    getSocket()?.emit('leaveQueue');
  };

  const handleTryAgain = () => {
    setErrorMessage('');
    setStatus('idle');
    setMatchInfo(null);
    setQueueInfo(null);
    setOnlineGameState(null);
    activeSessionRef.current = null;
    onlineGameStateRef.current = null;
    clearStoredMatchSession();
    setActionError('');
  };

  const handleLocalPlay = () => {
    window.location.href = '/';
  };

  const handleLeaveOnline = () => {
    activeSessionRef.current = null;
    onlineGameStateRef.current = null;
    clearStoredMatchSession();
    stopOnlineListeners();
    disconnectSocket();
    setOnlineGameState(null);
    setMatchInfo(null);
    setQueueInfo(null);
    setActionError('');
    if (whatsappFirstLobbyEnabled) {
      setTerminalFlow({
        title: 'Partida finalizada',
        message: 'Sua partida foi encerrada. Volte ao WhatsApp para jogar novamente.',
        autoRedirect: false,
      });
      setStatus('terminal');
    } else {
      setStatus('idle');
    }
  };

  if (onlineGameState) {
    return (
      <OnlineGameTable
        onlineGameState={onlineGameState}
        actionError={actionError}
        onLeaveOnline={handleLeaveOnline}
      />
    );
  }

  if (showHistory) {
    return <MatchHistoryScreen onBack={() => setShowHistory(false)} />;
  }

  if (whatsappFirstLobbyEnabled && (status === 'terminal' || terminalFlow)) {
    return (
      <WhatsAppLobbyFallback
        title={terminalFlow?.title}
        message={terminalFlow?.message}
        publicReference={terminalFlow?.publicReference}
        autoRedirect={Boolean(terminalFlow?.autoRedirect)}
        whatsappMessage={terminalFlow?.whatsappMessage || 'menu'}
      />
    );
  }

  if (whatsappFirstLobbyEnabled && !hasDirectEntryLink && !hasStoredSession) {
    return (
      <WhatsAppLobbyFallback
        title="Pife Duelo pelo WhatsApp"
        message="Para encontrar uma partida, acesse o Pife Duelo pelo WhatsApp."
      />
    );
  }

  return (
    <main className="matchmaking-shell">
      <section className="matchmaking-panel" aria-label="Pife Duelo Online">
        <header>
          <span>Pife Duelo</span>
          <h1>Jogar online</h1>
        </header>

        {status === 'idle' || status === 'connecting' ? (
          <>
            <label className="matchmaking-field">
              Nome
              <input
                type="text"
                value={playerName}
                maxLength={32}
                onChange={(event) => setPlayerName(event.target.value)}
              />
            </label>
            <div className={`matchmaking-presence is-${serverConnection.status}`} aria-live="polite">
              <span aria-hidden="true" />
              {isServerConnected
                ? `Conectado ao servidor${onlinePlayers == null ? '' : ` · ${onlinePlayers} ${onlinePlayers === 1 ? 'jogador online' : 'jogadores online'}`}`
                : serverConnection.message}
            </div>

            <div className="matchmaking-tables" aria-label="Mesa">
              {TABLE_OPTIONS.map((option) => (
                <button
                  key={option.tableValue}
                  type="button"
                  className={tableValue === option.tableValue ? 'is-selected' : ''}
                  onClick={() => setTableValue(option.tableValue)}
                  disabled={lockedTableValue !== null}
                >
                  <strong>Mesa {formatMoney(option.tableValue)}</strong>
                  <span>Voc&ecirc; paga: {formatMoney(option.playerEntry)}</span>
                  <span>Voc&ecirc; recebe: {formatMoney(option.winnerPrize)}</span>
                </button>
              ))}
            </div>
            {lockedTableValue !== null ? (
              <small className="matchmaking-payment-lock">Mesa confirmada pelo pagamento: {formatMoney(lockedTableValue)}</small>
            ) : null}

            <div className="matchmaking-actions">
              <button
                className="matchmaking-primary-action"
                type="button"
                onClick={isServerConnected ? handlePlayOnline : handleReconnectServer}
                disabled={status === 'connecting' || serverConnection.status === 'connecting' || serverConnection.status === 'reconnecting'}
              >
                {status === 'connecting'
                  ? 'Entrando...'
                  : isServerConnected
                    ? 'Jogar'
                    : serverConnection.status === 'error'
                      ? 'Tentar conectar'
                      : 'Aguardando servidor...'}
              </button>
              <div className="matchmaking-secondary-actions">
                <button className="matchmaking-test-action" type="button" onClick={handleLocalPlay}>
                  Modo teste
                </button>
                <button className="matchmaking-history-action" type="button" onClick={() => setShowHistory(true)}>
                  Historico
                </button>
              </div>
            </div>
          </>
        ) : null}

        {status === 'searching' ? (
          <div className="matchmaking-waiting">
            <strong>Mesa R${queueInfo?.tableValue ?? tableValue}</strong>
            <p>Procurando adversario...</p>
            <span>{queueInfo?.preMatchDeadline ? formatTime(remainingSeconds) : formatTime(elapsedSeconds)}</span>
            <small>Posicao na fila: {queueInfo?.queuePosition ?? 1}</small>
            <button type="button" onClick={handleCancel}>
              Cancelar espera
            </button>
          </div>
        ) : null}

        {status === 'timeout' ? (
          <div className="matchmaking-message">
            <strong>Tempo esgotado</strong>
            <p>{errorMessage || 'Nenhum adversario encontrado. Tente novamente.'}</p>
            <button type="button" onClick={handleTryAgain}>
              Tentar novamente
            </button>
          </div>
        ) : null}

        {status === 'matched' ? (
          <div className="matchmaking-message">
            <strong>Adversario encontrado</strong>
            <p>Preparando partida...</p>
            <dl>
              <div>
                <dt>Sala</dt>
                <dd>{matchInfo?.roomId}</dd>
              </div>
              <div>
                <dt>Mesa</dt>
                <dd>R${matchInfo?.tableValue}</dd>
              </div>
              <div>
                <dt>Voce</dt>
                <dd>{playerId || matchInfo?.players?.[0]?.playerId}</dd>
              </div>
              <div>
                <dt>Adversario</dt>
                <dd>{opponent?.playerName ?? opponent?.playerId ?? '-'}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {errorMessage && status !== 'timeout' ? <p className="matchmaking-error">{errorMessage}</p> : null}
      </section>
    </main>
  );
}
