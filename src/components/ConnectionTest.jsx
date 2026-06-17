import { useEffect, useMemo, useState } from 'react';
import { connectSocket, disconnectSocket, getSocket } from '../services/socket.js';

const initialState = {
  connected: false,
  socketId: null,
  playerId: null,
  queuePlayerName: null,
  lastPong: null,
  serverStatus: null,
};

export default function ConnectionTest() {
  const [state, setState] = useState(initialState);
  const [playerName, setPlayerName] = useState('Jogador Teste');
  const [tableValue, setTableValue] = useState(2);
  const [errorMessage, setErrorMessage] = useState('');
  const statusLabel = state.connected ? 'Conectado' : 'Desconectado';
  const canUseSocket = state.connected && getSocket();
  const formattedStatus = useMemo(
    () => state.serverStatus ? JSON.stringify(state.serverStatus, null, 2) : 'Aguardando status...',
    [state.serverStatus],
  );

  useEffect(() => {
    return () => {
      disconnectSocket();
    };
  }, []);

  const attachListeners = (socket) => {
    socket.off('connection:success');
    socket.off('pong');
    socket.off('queueJoined');
    socket.off('queueLeft');
    socket.off('queueTimeout');
    socket.off('queueStatus');
    socket.off('matchFound');
    socket.off('matchmakingError');
    socket.off('serverStatus');
    socket.off('connect');
    socket.off('disconnect');

    socket.on('connect', () => {
      console.log('[SOCKET_CONNECTED]', { socketId: socket.id });
      setState((current) => ({
        ...current,
        connected: true,
        socketId: socket.id,
      }));
    });

    socket.on('disconnect', (reason) => {
      console.log('[SOCKET_DISCONNECTED]', { reason });
      setState((current) => ({
        ...current,
        connected: false,
      }));
    });

    socket.on('connection:success', (payload) => {
      setState((current) => ({
        ...current,
        connected: payload.connected,
        socketId: payload.socketId,
        playerId: payload.playerId,
      }));
    });

    socket.on('pong', (payload) => {
      setState((current) => ({
        ...current,
        lastPong: payload.receivedAt,
      }));
    });

    socket.on('queueJoined', (payload) => {
      setState((current) => ({
        ...current,
        playerId: payload.playerId,
        queuePlayerName: payload.playerName,
      }));
    });

    socket.on('queueLeft', () => {
      setState((current) => ({
        ...current,
        queuePlayerName: null,
      }));
    });

    socket.on('queueTimeout', (payload) => {
      setErrorMessage(payload.message);
    });

    socket.on('queueStatus', (payload) => {
      setState((current) => ({
        ...current,
        serverStatus: payload,
      }));
    });

    socket.on('matchFound', (payload) => {
      setState((current) => ({
        ...current,
        serverStatus: payload,
      }));
    });

    socket.on('matchmakingError', (payload) => {
      setErrorMessage(payload.message || 'Erro no matchmaking.');
    });

    socket.on('serverStatus', (payload) => {
      setState((current) => ({
        ...current,
        serverStatus: payload,
      }));
    });
  };

  const handleConnect = async () => {
    setErrorMessage('');
    try {
      const socket = await connectSocket();
      attachListeners(socket);
    } catch (error) {
      setErrorMessage(error.message || 'Nao foi possivel conectar ao servidor.');
    }
  };

  const handleDisconnect = () => {
    disconnectSocket();
    setState(initialState);
  };

  const handlePing = () => {
    getSocket()?.emit('ping', { sentAt: new Date().toISOString() });
  };

  const handleJoinQueue = () => {
    getSocket()?.emit('joinQueue', { playerName, tableValue });
  };

  const handleLeaveQueue = () => {
    getSocket()?.emit('leaveQueue');
  };

  const handleRequestStatus = () => {
    getSocket()?.emit('requestServerStatus');
    getSocket()?.emit('requestQueueStatus', { tableValue });
  };

  return (
    <main className="connection-test-shell">
      <section className="connection-test-panel" aria-label="Teste de conexao Socket.io">
        <header>
          <span>Fase 4.2</span>
          <h1>Socket.io</h1>
        </header>

        <dl className="connection-test-status">
          <div>
            <dt>Status</dt>
            <dd>{statusLabel}</dd>
          </div>
          <div>
            <dt>Socket ID</dt>
            <dd>{state.socketId || '-'}</dd>
          </div>
          <div>
            <dt>Player ID</dt>
            <dd>{state.playerId || '-'}</dd>
          </div>
          <div>
            <dt>Fila</dt>
            <dd>{state.queuePlayerName || '-'}</dd>
          </div>
          <div>
            <dt>Ultimo pong</dt>
            <dd>{state.lastPong || '-'}</dd>
          </div>
        </dl>

        <label className="connection-test-name">
          Nome do jogador
          <input
            type="text"
            value={playerName}
            onChange={(event) => setPlayerName(event.target.value)}
          />
        </label>

        <label className="connection-test-name">
          Mesa
          <select value={tableValue} onChange={(event) => setTableValue(Number(event.target.value))}>
            <option value={2}>R$2</option>
            <option value={5}>R$5</option>
            <option value={10}>R$10</option>
            <option value={20}>R$20</option>
          </select>
        </label>

        <div className="connection-test-actions">
          <button type="button" onClick={handleConnect} disabled={state.connected}>
            Conectar
          </button>
          <button type="button" onClick={handleDisconnect} disabled={!state.connected}>
            Desconectar
          </button>
          <button type="button" onClick={handlePing} disabled={!canUseSocket}>
            Ping
          </button>
          <button type="button" onClick={handleJoinQueue} disabled={!canUseSocket}>
            Entrar na fila
          </button>
          <button type="button" onClick={handleLeaveQueue} disabled={!canUseSocket}>
            Sair da fila
          </button>
          <button type="button" onClick={handleRequestStatus} disabled={!canUseSocket}>
            Status servidor
          </button>
        </div>

        {errorMessage ? <p className="connection-test-error">{errorMessage}</p> : null}

        <pre className="connection-test-output">{formattedStatus}</pre>
      </section>
    </main>
  );
}
