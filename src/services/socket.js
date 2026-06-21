import { io } from 'socket.io-client';
import { reportClientError } from './errorReporter.js';
import { getServerUrl } from './serverUrl.js';

const CONNECTION_TIMEOUT_MS = 30000;
const connectionSubscribers = new Set();

let socket = null;
let socketConnectPromise = null;
let gamePingInterval = null;
let connectionState = {
  status: 'disconnected',
  connected: false,
  message: 'Desconectado do servidor.',
  url: null,
};

function publishConnectionState(nextState) {
  connectionState = {
    ...connectionState,
    ...nextState,
  };
  connectionSubscribers.forEach((listener) => listener(connectionState));
}

export function subscribeSocketConnection(listener) {
  connectionSubscribers.add(listener);
  listener(connectionState);
  return () => connectionSubscribers.delete(listener);
}

export function getSocketConnectionState() {
  return connectionState;
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

function getPaymentAccessToken() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('access')?.trim() || '';
}

function isPaymentAccessError(error) {
  return error?.data?.code === 'PAYMENT_REQUIRED' || error?.message === 'PAYMENT_REQUIRED';
}

function createSocket() {
  const socketUrl = getServerUrl();
  const paymentToken = getPaymentAccessToken();
  console.info('[socket] URL usada para conectar:', socketUrl);

  const nextSocket = io(socketUrl, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: 8,
    reconnectionDelay: 800,
    reconnectionDelayMax: 4000,
    timeout: 10000,
    auth: paymentToken ? { paymentToken } : {},
  });

  nextSocket.gameTelemetry = {
    latencyMs: null,
    socketTransport: null,
    lastStateUpdateAt: null,
  };
  window.__PIFE_DUELO_SOCKET__ = nextSocket;

  nextSocket.on('connect', () => {
    console.info('[socket] conectado:', nextSocket.id);
    nextSocket.gameTelemetry.socketTransport = nextSocket.io.engine.transport.name;
    startGameLatencyMonitor();
  });

  nextSocket.on('connection:success', (payload) => {
    nextSocket.connectionSuccess = payload;
    publishConnectionState({
      status: 'connected',
      connected: true,
      message: 'Conectado ao servidor',
      url: socketUrl,
      socketId: nextSocket.id,
    });
  });

  nextSocket.on('connect_error', (error) => {
    console.error('[socket] erro de conexao:', error?.message, error);
    const paymentDenied = isPaymentAccessError(error);
    publishConnectionState({
      status: paymentDenied ? 'error' : 'reconnecting',
      connected: false,
      message: paymentDenied
        ? 'Pagamento confirmado necessario. Use o link recebido no WhatsApp.'
        : 'Reconectando ao servidor...',
      url: socketUrl,
      reason: error?.message ?? 'connect_error',
    });
    reportClientError(error, 'socket-connect');
  });

  nextSocket.on('disconnect', (reason) => {
    console.warn('[socket] desconectado:', reason);
    nextSocket.connectionSuccess = null;
    publishConnectionState({
      status: reason === 'io client disconnect' ? 'disconnected' : 'reconnecting',
      connected: false,
      message: reason === 'io client disconnect' ? 'Desconectado do servidor.' : 'Reconectando ao servidor...',
      url: socketUrl,
      reason,
    });
    if (reason !== 'io client disconnect') {
      reportClientError(new Error(`Socket desconectado: ${reason}`), 'socket-disconnect', { level: 'warn' });
    }
    if (gamePingInterval) {
      window.clearInterval(gamePingInterval);
      gamePingInterval = null;
    }
  });

  nextSocket.io.on('reconnect_attempt', (attempt) => {
    console.info('[socket] tentativa de reconexao:', attempt);
    publishConnectionState({
      status: 'reconnecting',
      connected: false,
      message: 'Reconectando ao servidor...',
      url: socketUrl,
      attempt,
    });
  });

  nextSocket.io.on('reconnect_failed', () => {
    console.error('[socket] reconexao esgotada');
    publishConnectionState({
      status: 'error',
      connected: false,
      message: 'Servidor indisponivel. Tente conectar novamente.',
      url: socketUrl,
    });
  });

  return nextSocket;
}

export async function connectSocket() {
  if (!socket) socket = createSocket();
  if (socket.connected && socket.connectionSuccess?.connected) return socket;
  if (socketConnectPromise) return socketConnectPromise;

  publishConnectionState({
    status: socket.active ? 'reconnecting' : 'connecting',
    connected: false,
    message: socket.active ? 'Reconectando ao servidor...' : 'Conectando ao servidor...',
    url: getServerUrl(),
  });

  socketConnectPromise = new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      socket.off('connection:success', onServerConfirmed);
      socket.off('connect_error', onConnectError);
      socket.io.off('reconnect_failed', onReconnectFailed);
    };

    const fail = (message) => {
      cleanup();
      socketConnectPromise = null;
      socket.disconnect();
      const error = new Error(message);
      publishConnectionState({
        status: 'error',
        connected: false,
        message,
        url: getServerUrl(),
      });
      reject(error);
    };

    const onServerConfirmed = () => {
      cleanup();
      socketConnectPromise = null;
      resolve(socket);
    };

    const onReconnectFailed = () => {
      fail('Servidor indisponivel. Tente conectar novamente.');
    };

    const onConnectError = (error) => {
      if (isPaymentAccessError(error)) {
        fail('Pagamento confirmado necessario. Use o link recebido no WhatsApp.');
      }
    };

    const timeoutId = window.setTimeout(() => {
      fail('O servidor nao confirmou a conexao. Tente novamente.');
    }, CONNECTION_TIMEOUT_MS);

    socket.once('connection:success', onServerConfirmed);
    socket.on('connect_error', onConnectError);
    socket.io.once('reconnect_failed', onReconnectFailed);
    socket.connect();
  });

  return socketConnectPromise;
}

export function disconnectSocket() {
  if (!socket) return;

  socket.disconnect();
  socket.removeAllListeners();
  socket.io.removeAllListeners();
  socket = null;
  if (gamePingInterval) window.clearInterval(gamePingInterval);
  gamePingInterval = null;
  window.__PIFE_DUELO_SOCKET__ = null;
  socketConnectPromise = null;
  publishConnectionState({
    status: 'disconnected',
    connected: false,
    message: 'Desconectado do servidor.',
    socketId: null,
  });
}
