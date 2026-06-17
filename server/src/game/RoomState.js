import { config } from '../config.js';
import { createId } from '../utils/createId.js';

export function createRoomState({
  roomId = createId('room'),
  roomType = config.ROOM_MODE,
  tableValue = null,
  status = 'waiting',
  players = [],
  maxPlayers = config.MAX_PLAYERS_PER_ROOM,
  createdAt = new Date().toISOString(),
  matchId = null,
} = {}) {
  return {
    roomId,
    roomType,
    tableValue,
    status,
    players,
    maxPlayers,
    createdAt,
    matchId,
  };
}

export default createRoomState;
