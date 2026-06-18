import { io } from 'socket.io-client';
import { reportClientError } from './errorReporter.js';

let socket = null;
let socketConnectPromise = null;
let gamePingInterval = null;

function getSocketUrl() {
  if (import.meta.env.VITE_SOCKET_URL) {
    return import.meta.env.VITE_SOCKET_URL;
  }

  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function getSocket() {
  return socket;
}

export function getGameNetworkDebug() {
  return socket?.gameTelemetry ?? {
    latencyMs: null,
    socketTransport: null,
    lastStateUpdateAt: null,
  };
}

function updateGameLatency() {
  if (!socket?.connected) return;
  const clientSentAt = Date.now();
  socket.timeout(4000).emit('ping_game', { clientSentAt }, (error, response) => {
    if (error || !response) return;
    socket.gameTelemetry = {
      ...(socket.gameTelemetry ?? {}),
      latencyMs: Math.max(0, Date.now() - clientSentAt),
      socketTransport: response.transport ?? socket.io.engine.transport.name,
    };
  });
}

function startGameLatencyMonitor() {
  if (gamePingInterval) window.clearInterval(gamePingInterval);
  updateGameLatency();
  gamePingInterval = window.setInterval(updateGameLatency, 10000);
}

export async function connectSocket() {
  if (socket?.connected) {
    return socket;
  }
  if (socketConnectPromise) {
    return socketConnectPromise;
  }

  socketConnectPromise = (async () => {
    if (!socket) {
      socket = io(getSocketUrl(), {
        autoConnect: false,
        transports: ['polling', 'websocket'],
        upgrade: true,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 4000,
      });
      socket.gameTelemetry = {
        latencyMs: null,
        socketTransport: null,
        lastStateUpdateAt: null,
      };
      window.__PIFE_DUELO_SOCKET__ = socket;

      socket.on('connect', () => {
        console.log('[SOCKET_CONNECTED]', { socketId: socket.id });
        socket.gameTelemetry.socketTransport = socket.io.engine.transport.name;
        startGameLatencyMonitor();
      });

      socket.on('connection:success', (payload) => {
        socket.connectionSuccess = payload;
      });

      socket.on('disconnect', (reason) => {
        console.log('[SOCKET_DISCONNECTED]', { socketId: socket.id, reason });
        if (reason !== 'io client disconnect') {
          reportClientError(new Error(`Socket desconectado: ${reason}`), 'socket-disconnect', { level: 'warn' });
        }
        if (gamePingInterval) {
          window.clearInterval(gamePingInterval);
          gamePingInterval = null;
        }
      });

      socket.on('connect_error', (error) => {
        reportClientError(error, 'socket-connect');
      });
    }

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        socketConnectPromise = null;
        reject(new Error('Tempo limite ao conectar com o servidor online.'));
      }, 15000);

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        socket.off('connect', onConnect);
        socket.off('connect_error', onConnectError);
      };

      const onConnect = () => {
        cleanup();
        socketConnectPromise = null;
        resolve(socket);
      };

      const onConnectError = (error) => {
        cleanup();
        socketConnectPromise = null;
        const connectionError = new Error(error?.message || 'Nao foi possivel conectar ao servidor online.');
        reportClientError(connectionError, 'socket-connect');
        reject(connectionError);
      };

      socket.once('connect', onConnect);
      socket.once('connect_error', onConnectError);
      socket.connect();
    });
  })();

  return socketConnectPromise;
}

export function disconnectSocket() {
  if (!socket) return;

  socket.disconnect();
  socket.removeAllListeners();
  socket = null;
  if (gamePingInterval) window.clearInterval(gamePingInterval);
  gamePingInterval = null;
  window.__PIFE_DUELO_SOCKET__ = null;
  socketConnectPromise = null;
}
