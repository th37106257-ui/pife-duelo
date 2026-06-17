import { getSocket } from './socket.js';

const EVENTS = ['matchStarted', 'gameStateUpdated', 'matchFinished', 'actionRejected', 'turnTimerUpdate'];

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
    onMatchStarted?.(payload);
  });
  socket.on('gameStateUpdated', (payload) => {
    onGameStateUpdated?.(payload);
  });
  socket.on('matchFinished', (payload) => {
    onMatchFinished?.(payload);
  });
  socket.on('actionRejected', (payload) => {
    onActionRejected?.(payload);
  });
  socket.on('turnTimerUpdate', (payload) => {
    onTurnTimerUpdate?.(payload);
  });
}

export function stopOnlineListeners() {
  const socket = getSocket();
  if (!socket) return;

  EVENTS.forEach((event) => socket.off(event));
}

export function drawFromDeckOnline({ roomId, matchId, playerId }) {
  getSocket()?.emit('playerDrawFromDeck', { roomId, matchId, playerId });
}

export function drawFromDiscardOnline({ roomId, matchId, playerId }) {
  getSocket()?.emit('playerDrawFromDiscard', { roomId, matchId, playerId });
}

export function discardCardOnline({ roomId, matchId, playerId, cardId }) {
  getSocket()?.emit('playerDiscardCard', { roomId, matchId, playerId, cardId });
}

export function knockOnline({ roomId, matchId, playerId, clientHandOrder = [] }) {
  getSocket()?.emit('player:knock', { roomId, matchId, playerId, clientHandOrder });
}

export function reorderHandOnline({ roomId, matchId, playerId, handOrder = [] }) {
  getSocket()?.emit('player:reorderHand', { roomId, matchId, playerId, handOrder });
}

export function requestGameState({ roomId, matchId, playerId }) {
  getSocket()?.emit('requestGameState', { roomId, matchId, playerId });
}

export function resumeOnlineMatch({ roomId, matchId, playerId }) {
  getSocket()?.emit('resumeOnlineMatch', { roomId, matchId, playerId });
}

export function surrenderOnlineMatch({ roomId, matchId, playerId }) {
  getSocket()?.emit('playerSurrender', { roomId, matchId, playerId });
}
