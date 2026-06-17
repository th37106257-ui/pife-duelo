import { createPlayerState } from '../game/PlayerState.js';

export class PlayerManager {
  constructor() {
    this.players = new Map();
  }

  createPlayer({ name, socketId, type = 'human', position = 'bottom' } = {}) {
    const player = createPlayerState({ name, socketId, type, position });
    this.players.set(player.id, player);
    return player;
  }

  getPlayer(playerId) {
    return this.players.get(playerId) ?? null;
  }

  removePlayer(playerId) {
    const player = this.getPlayer(playerId);
    this.players.delete(playerId);
    return player;
  }

  setPlayerConnected(playerId, isConnected) {
    const player = this.getPlayer(playerId);
    if (!player) return null;

    return this.updatePlayer(playerId, { isConnected });
  }

  updatePlayer(playerId, updates = {}) {
    const player = this.getPlayer(playerId);
    if (!player) return null;

    const nextPlayer = {
      ...player,
      ...updates,
      id: player.id,
    };
    this.players.set(playerId, nextPlayer);
    return nextPlayer;
  }

  listPlayers() {
    return [...this.players.values()];
  }
}

export default PlayerManager;
