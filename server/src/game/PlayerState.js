import { createId } from '../utils/createId.js';

export function createPlayerState({
  id = createId('player'),
  socketId = null,
  name = 'Jogador',
  type = 'human',
  position = 'bottom',
  hand = [],
  isConnected = true,
  isReady = false,
  hasDrawnThisTurn = false,
  hasKnocked = false,
} = {}) {
  return {
    id,
    socketId,
    name,
    type,
    position,
    hand,
    isConnected,
    isReady,
    hasDrawnThisTurn,
    hasKnocked,
  };
}

export default createPlayerState;
