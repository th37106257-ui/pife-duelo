import { useEffect, useMemo, useRef, useState } from 'react';
import OnlineGameTable from './OnlineGameTable.jsx';
import MatchHistoryScreen from './MatchHistoryScreen.jsx';
import { connectSocket, disconnectSocket, getSocket } from '../services/socket.js';
import { resumeOnlineMatch, startOnlineListeners, stopOnlineListeners } from '../services/onlineGameSocket.js';
import { formatMoney, listOfficialTables } from '../shared/economy.js';

const TABLE_OPTIONS = listOfficialTables();
const ACTIVE_MATCH_STORAGE_KEY = 'pifeDuelo.activeOnlineMatch';

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

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainingSeconds = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

export default function MatchmakingScreen() {
  const [playerName, setPlayerName] = useState('Jogador');
  const [tableValue, setTableValue] = useState(2);
  const [status, setStatus] = useState('idle');
  const [playerId, setPlayerId] = useState(null);
  const [queueInfo, setQueueInfo] = useState(null);
  const [matchInfo, setMatchInfo] = useState(null);
  const [onlineGameState, setOnlineGameState] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [onlinePlayers, setOnlinePlayers] = useState(null);
  const waitingSinceRef = useRef(null);
  const activeSessionRef = useRef(readStoredMatchSession());
  const onlineGameStateRef = useRef(null);
  const bootstrappedRef = useRef(false);

  const opponent = useMemo(
    () => matchInfo?.players?.find((player) => player.position === 'top') ?? null,
    [matchInfo],
  );

  useEffect(() => {
    if (status !== 'searching') return undefined;

    const interval = window.setInterval(() => {
      if (!waitingSinceRef.current) {
        setElapsedSeconds(0);
        return;
      }

      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - waitingSinceRef.current) / 1000)));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [status]);

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
    turnStartedAt: payload.turnStartedAt,
    turnDurationSeconds: payload.turnDurationSeconds,
    turnSecondsLeft: payload.turnSecondsLeft,
    currentTurnPlayerId: payload.currentTurnPlayerId,
    isResolvingAction: payload.isResolvingAction,
    status: payload.status,
    result: payload.result,
    matchLog: payload.matchLog ?? [],
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
  };

  const attachListeners = (socket) => {
    socket.off('connection:success');
    socket.off('queueJoined');
    socket.off('queueLeft');
    socket.off('queueTimeout');
    socket.off('queueStatus');
    socket.off('serverStatus');
    socket.off('matchFound');
    stopOnlineListeners();
    socket.off('matchmakingError');
    socket.off('disconnect');
    if (socket.pifeResumeHandler) {
      socket.off('connect', socket.pifeResumeHandler);
    }

    socket.on('connection:success', (payload) => {
      setPlayerId(payload.playerId);
      socket.emit('requestServerStatus');
    });

    socket.on('serverStatus', (payload) => {
      setOnlinePlayers(Math.max(0, Number(payload.onlinePlayers) || 0));
    });

    socket.on('queueJoined', (payload) => {
      waitingSinceRef.current = new Date(payload.waitingSince).getTime();
      setElapsedSeconds(0);
      setQueueInfo(payload);
      setErrorMessage('');
      setStatus('searching');
    });

    socket.on('queueLeft', () => {
      waitingSinceRef.current = null;
      setQueueInfo(null);
      setElapsedSeconds(0);
      setStatus('idle');
    });

    socket.on('queueTimeout', (payload) => {
      waitingSinceRef.current = null;
      setQueueInfo(null);
      setElapsedSeconds(0);
      setErrorMessage(payload.message);
      setStatus('timeout');
    });

    socket.on('queueStatus', (payload) => {
      setQueueInfo((current) => ({
        ...current,
        ...payload,
      }));
    });

    socket.on('matchFound', (payload) => {
      waitingSinceRef.current = null;
      activeSessionRef.current = {
        roomId: payload.roomId,
        playerId: playerId || getSocket()?.connectionSuccess?.playerId,
        tableValue: payload.tableValue,
      };
      setMatchInfo(payload);
      setQueueInfo(null);
      setElapsedSeconds(0);
      setStatus('matched');
    });

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
        if (payload.reason === 'MATCH_NOT_FOUND') {
          activeSessionRef.current = null;
          onlineGameStateRef.current = null;
          clearStoredMatchSession();
          setOnlineGameState(null);
          setStatus('idle');
        }
      },
      onTurnTimerUpdate: (payload) => {
        setOnlineGameState((current) => {
          if (!current || current.matchId !== payload.matchId) return current;

          const nextState = {
            ...current,
            currentTurnPlayerId: payload.currentPlayerId,
            isYourTurn: current.playerId === payload.currentPlayerId,
            turnSecondsLeft: payload.timeLeft,
          };
          onlineGameStateRef.current = nextState;
          rememberOnlineState(nextState);
          return nextState;
        });
      },
    });

    socket.on('matchmakingError', (payload) => {
      setErrorMessage(payload.message || 'Nao foi possivel entrar na fila.');
      setStatus('idle');
    });

    socket.on('disconnect', () => {
      waitingSinceRef.current = null;
      setQueueInfo(null);
      if (!activeSessionRef.current) {
        setStatus('idle');
      }
    });

    socket.pifeResumeHandler = () => {
      const session = activeSessionRef.current ?? readStoredMatchSession();
      if (session?.matchId && session?.roomId && session?.playerId) {
        activeSessionRef.current = session;
        resumeOnlineMatch(session);
      }
    };
    socket.on('connect', socket.pifeResumeHandler);
  };

  const restoreActiveMatch = async () => {
    const session = readStoredMatchSession();
    if (!session?.matchId || !session?.roomId || !session?.playerId) return false;

    activeSessionRef.current = session;
    setStatus((current) => (current === 'playing' || current === 'finished' ? current : 'connecting'));
    setActionError('');

    try {
      const socket = await connectSocket();
      attachListeners(socket);
      resumeOnlineMatch(session);
      return true;
    } catch (error) {
      setActionError(error.message || 'Nao foi possivel reconectar a partida.');
      return false;
    }
  };

  useEffect(() => {
    if (bootstrappedRef.current) return undefined;
    bootstrappedRef.current = true;
    let cancelled = false;

    const bootstrapLobby = async () => {
      const restored = await restoreActiveMatch();
      if (cancelled || restored) return;

      try {
        const socket = await connectSocket();
        if (cancelled) return;
        attachListeners(socket);
        socket.emit('requestServerStatus');
      } catch {
        setOnlinePlayers(null);
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
    if (status === 'searching') return;

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
      socket.emit('joinQueue', {
        playerName,
        tableValue,
      });
      socket.emit('requestQueueStatus', { tableValue });
    } catch (error) {
      setErrorMessage(error.message || 'Nao foi possivel conectar ao servidor.');
      setStatus('idle');
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
    setStatus('idle');
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
            <div className="matchmaking-presence" aria-live="polite">
              <span aria-hidden="true" />
              {onlinePlayers == null
                ? 'Conectando ao servidor...'
                : `${onlinePlayers} ${onlinePlayers === 1 ? 'jogador online' : 'jogadores online'}`}
            </div>

            <div className="matchmaking-tables" aria-label="Mesa">
              {TABLE_OPTIONS.map((option) => (
                <button
                  key={option.tableValue}
                  type="button"
                  className={tableValue === option.tableValue ? 'is-selected' : ''}
                  onClick={() => setTableValue(option.tableValue)}
                >
                  <strong>Mesa {formatMoney(option.tableValue)}</strong>
                  <span>Voc&ecirc; paga: {formatMoney(option.playerEntry)}</span>
                  <span>Voc&ecirc; recebe: {formatMoney(option.winnerPrize)}</span>
                </button>
              ))}
            </div>

            <div className="matchmaking-actions">
              <button className="matchmaking-primary-action" type="button" onClick={handlePlayOnline} disabled={status === 'connecting'}>
                {status === 'connecting' ? 'Conectando...' : 'Jogar'}
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
            <span>{formatTime(elapsedSeconds)}</span>
            <small>Posicao na fila: {queueInfo?.queuePosition ?? 1}</small>
            <button type="button" onClick={handleCancel}>
              Cancelar
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
