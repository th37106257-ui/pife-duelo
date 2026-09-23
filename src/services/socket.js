import { io } from 'socket.io-client';
import { reportClientError } from './errorReporter.js';
import { getServerUrl } from './serverUrl.js';

const CONNECTION_TIMEOUT_MS = 30000;
const ENTRY_SESSION_STORAGE_PREFIX = 'pifeDuelo.entrySession.';
const connectionSubscribers = new Set();
const FRIENDLY_ENTRY_ACCESS_MESSAGE = '✅ Sua partida anterior foi encerrada. Você já pode escolher uma mesa novamente.';

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

function getWhatsAppEntryToken() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('entry')?.trim() || '';
}

function getWhatsAppJoinMatchId() {
  if (typeof window === 'undefined') return '';
  const pathMatch = window.location.pathname.match(/^\/join\/([^/]+)\/?$/);
  return decodeURIComponent(pathMatch?.[1] || new URLSearchParams(window.location.search).get('matchId') || '').trim();
}

function getEntrySessionStorageKey(matchId = getWhatsAppJoinMatchId()) {
  return matchId ? `${ENTRY_SESSION_STORAGE_PREFIX}${matchId}` : `${ENTRY_SESSION_STORAGE_PREFIX}pending`;
}

function getStoredEntrySessionKey() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(getEntrySessionStorageKey()) || '';
  } catch {
    return '';
  }
}

function storeEntrySessionKey(sessionKey, matchId = getWhatsAppJoinMatchId()) {
  if (typeof window === 'undefined' || !sessionKey || !matchId) return false;
  try {
    window.localStorage.setItem(getEntrySessionStorageKey(matchId), sessionKey);
    return true;
  } catch {
    // A sessão ativa continua válida no servidor; o navegador apenas perde a recuperação local.
    return false;
  }
}

export function hasStoredEntrySession(matchId = getWhatsAppJoinMatchId()) {
  if (typeof window === 'undefined' || !matchId) return false;
  try {
    return Boolean(window.localStorage.getItem(getEntrySessionStorageKey(matchId)));
  } catch {
    return false;
  }
}

export function clearEntrySessionKey(matchId = getWhatsAppJoinMatchId()) {
  if (typeof window === 'undefined' || !matchId) return;
  try {
    window.localStorage.removeItem(getEntrySessionStorageKey(matchId));
  } catch {
    // Sem efeito fora de navegadores com armazenamento disponível.
  }
}

export function finalizeWhatsAppEntryBootstrap(nextSocket, sessionKey = null) {
  if (typeof window === 'undefined' || !nextSocket?.auth) return false;
  const matchId = getWhatsAppJoinMatchId();
  if (!matchId) return false;

  const normalizedSessionKey = String(sessionKey || '').trim();
  const storedSessionKey = normalizedSessionKey ? '' : getStoredEntrySessionKey();
  const activeSessionKey = normalizedSessionKey || storedSessionKey;
  if (!activeSessionKey) return false;

  if (normalizedSessionKey && !storeEntrySessionKey(normalizedSessionKey, matchId)) return false;

  const safeAuth = { ...nextSocket.auth };
  delete safeAuth.entryToken;
  nextSocket.auth = { ...safeAuth, joinMatchId: matchId, entrySessionKey: activeSessionKey };

  const url = new URL(window.location.href);
  if (url.searchParams.has('entry')) {
    url.searchParams.delete('entry');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  return true;
}

export function clearStaleMatchAccessFromUrl() {
  if (typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  const hadStaleMatchAccess = /^\/join\/[^/]+\/?$/.test(url.pathname)
    || url.searchParams.has('entry')
    || url.searchParams.has('matchId');
  if (!hadStaleMatchAccess) return false;

  clearEntrySessionKey(getWhatsAppJoinMatchId());

  url.pathname = '/';
  url.searchParams.delete('entry');
  url.searchParams.delete('matchId');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  console.info('LOBBY_STATE_RESET_AFTER_ABORT', {
    route: window.location.pathname,
    staleMatchAccessRemoved: true,
  });
  return true;
}

function isPaymentAccessError(error) {
  return error?.data?.code === 'PAYMENT_REQUIRED' || error?.message === 'PAYMENT_REQUIRED';
}

function isEntryAccessError(error) {
  return error?.data?.code === 'ENTRY_ACCESS_DENIED' || error?.message === 'ENTRY_ACCESS_DENIED';
}

function createSocket() {
  const socketUrl = getServerUrl();
  const paymentToken = getPaymentAccessToken();
  const entryToken = getWhatsAppEntryToken();
  const joinMatchId = getWhatsAppJoinMatchId();
  const entrySessionKey = getStoredEntrySessionKey();
  console.info('[socket] URL usada para conectar:', socketUrl);
  if (joinMatchId) console.info('[socket] matchId recebido pelo link:', joinMatchId);

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
    auth: {
      ...(paymentToken ? { paymentToken } : {}),
      ...(entryToken ? { entryToken } : {}),
      ...(joinMatchId ? { joinMatchId } : {}),
      ...(entrySessionKey ? { entrySessionKey } : {}),
    },
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
    const claimedSessionKey = payload?.entryAccess?.sessionKey;
    if (payload?.entryAccess?.entryId) finalizeWhatsAppEntryBootstrap(nextSocket, claimedSessionKey);
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
    const entryDenied = isEntryAccessError(error);
    publishConnectionState({
      status: paymentDenied || entryDenied ? 'error' : 'reconnecting',
      connected: false,
      message: entryDenied
        ? FRIENDLY_ENTRY_ACCESS_MESSAGE
        : paymentDenied
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

    const fail = (message, { resetEntryAccess = false, code = null } = {}) => {
      cleanup();
      socketConnectPromise = null;
      const failedSocket = socket;
      failedSocket?.disconnect();
      if (resetEntryAccess && failedSocket) {
        failedSocket.removeAllListeners();
        failedSocket.io.removeAllListeners();
        if (socket === failedSocket) socket = null;
        clearStaleMatchAccessFromUrl();
      }
      const error = new Error(message);
      if (code) error.code = code;
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
      if (isEntryAccessError(error)) {
        fail(FRIENDLY_ENTRY_ACCESS_MESSAGE, {
          resetEntryAccess: true,
          code: 'ENTRY_ACCESS_DENIED',
        });
        return;
      }
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
