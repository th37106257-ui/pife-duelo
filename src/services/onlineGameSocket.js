import { getSocket } from './socket.js';

const EVENTS = ['matchStarted', 'gameStateUpdated', 'matchFinished', 'actionRejected'];

function markStateUpdate(socket) {
  if (!socket?.gameTelemetry) return;
  socket.gameTelemetry.lastStateUpdateAt = Date.now();
}

function createActionId(eventName) {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${eventName}-${Date.now()}-${random}`;
}

function emitOnlineAction(eventName, payload, timeoutMs = 4500) {
  const socket = getSocket();
  if (!socket?.connected) return Promise.reject(new Error('Sem conexao com o servidor.'));
  const actionId = createActionId(eventName);

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('O servidor demorou para responder.')), timeoutMs);
    socket.emit(eventName, { ...payload, actionId }, (acknowledgement = {}) => {
      window.clearTimeout(timeout);
      if (!acknowledgement.ok) {
        const error = new Error(acknowledgement.reason || 'Acao rejeitada pelo servidor.');
        error.acknowledgement = acknowledgement;
        reject(error);
        return;
      }
      resolve(acknowledgement);
    });
  });
}

export function startOnlineListeners({
  onMatchStarted,
  onGameStateUpdated,
  onMatchFinished,
  onActionRejected,
  onTurnTimerUpdate,
} = {}) {
  const socket = getSocket();
  if (!socket) return;

  stopOnlineListeners();

  socket.on('matchStarted', (payload) => {
    markStateUpdate(socket);
    onMatchStarted?.(payload);
  });
  socket.on('gameStateUpdated', (payload) => {
    markStateUpdate(socket);
    onGameStateUpdated?.(payload);
  });
  socket.on('matchFinished', (payload) => {
    markStateUpdate(socket);
    onMatchFinished?.(payload);
  });
  socket.on('actionRejected', (payload) => {
    onActionRejected?.(payload);
  });
}

export function stopOnlineListeners() {
  const socket = getSocket();
  if (!socket) return;

  EVENTS.forEach((event) => socket.off(event));
}

export function drawFromDeckOnline({ roomId, matchId, playerId }) {
  return emitOnlineAction('playerDrawFromDeck', { roomId, matchId, playerId });
}

export function drawFromDiscardOnline({ roomId, matchId, playerId }) {
  return emitOnlineAction('playerDrawFromDiscard', { roomId, matchId, playerId });
}

export function discardCardOnline({ roomId, matchId, playerId, cardId }) {
  return emitOnlineAction('playerDiscardCard', { roomId, matchId, playerId, cardId });
}

export function knockOnline({ roomId, matchId, playerId, clientHandOrder = [] }) {
  return emitOnlineAction('player:knock', { roomId, matchId, playerId, clientHandOrder });
}

export function reorderHandOnline({ roomId, matchId, playerId, handOrder = [] }) {
  return emitOnlineAction('player:reorderHand', { roomId, matchId, playerId, handOrder });
}

export function requestGameState({ roomId, matchId, playerId }) {
  getSocket()?.emit('requestGameState', { roomId, matchId, playerId });
}

export function resumeOnlineMatch({ roomId, matchId, playerId }) {
  getSocket()?.emit('resumeOnlineMatch', { roomId, matchId, playerId });
}

export function surrenderOnlineMatch({ roomId, matchId, playerId }) {
  return emitOnlineAction('playerSurrender', { roomId, matchId, playerId });
}
