import { config } from '../config.js';
import { createRoomState } from '../game/RoomState.js';

export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(options = {}) {
    const room = createRoomState(options);
    this.rooms.set(room.roomId, room);
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) ?? null;
  }

  listRooms() {
    return [...this.rooms.values()];
  }

  joinRoom(roomId, player) {
    const room = this.getRoom(roomId);
    if (!room) return { blocked: true, reason: 'room-not-found' };
    if (room.players.some((item) => item.id === player.id)) return { blocked: true, reason: 'player-already-in-room', room };
    if (room.players.length >= room.maxPlayers) return { blocked: true, reason: 'room-full', room };

    const nextRoom = {
      ...room,
      players: [
        ...room.players,
        {
          ...player,
          position: room.players.length === 0 ? 'bottom' : 'top',
        },
      ],
      status: room.players.length + 1 >= config.MAX_PLAYERS_PER_ROOM ? 'waiting' : room.status,
    };
    this.rooms.set(roomId, nextRoom);

    return { blocked: false, room: nextRoom };
  }

  leaveRoom(roomId, playerId) {
    const room = this.getRoom(roomId);
    if (!room) return { blocked: true, reason: 'room-not-found' };

    const nextRoom = {
      ...room,
      players: room.players.filter((player) => player.id !== playerId),
    };
    this.rooms.set(roomId, nextRoom);

    return { blocked: false, room: nextRoom };
  }

  setRoomMatch(roomId, matchId) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const nextRoom = {
      ...room,
      status: 'playing',
      matchId,
    };
    this.rooms.set(roomId, nextRoom);

    return nextRoom;
  }

  updateRoom(roomId, updates = {}) {
    const room = this.getRoom(roomId);
    if (!room) return null;

    const nextRoom = {
      ...room,
      ...updates,
      roomId: room.roomId,
    };
    this.rooms.set(roomId, nextRoom);

    return nextRoom;
  }

  deleteRoom(roomId) {
    const room = this.getRoom(roomId);
    this.rooms.delete(roomId);
    return room;
  }
}

export default RoomManager;
