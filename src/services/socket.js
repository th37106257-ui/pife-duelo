import { io } from 'socket.io-client';

let socket = null;
let socketConnectPromise = null;

function getSocketUrl() {
  if (import.meta.env.VITE_SOCKET_URL) {
    return import.meta.env.VITE_SOCKET_URL;
  }

  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function getSocket() {
  return socket;
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
        transports: ['websocket', 'polling'],
      });

      socket.on('connect', () => {
        console.log('[SOCKET_CONNECTED]', { socketId: socket.id });
      });

      socket.on('connection:success', (payload) => {
        socket.connectionSuccess = payload;
      });

      socket.on('disconnect', (reason) => {
        console.log('[SOCKET_DISCONNECTED]', { socketId: socket.id, reason });
      });
    }

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        socketConnectPromise = null;
        reject(new Error('Tempo limite ao conectar com o servidor online.'));
      }, 8000);

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
        reject(new Error(error?.message || 'Nao foi possivel conectar ao servidor online.'));
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
  socketConnectPromise = null;
}
