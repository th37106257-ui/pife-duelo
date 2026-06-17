export class SocketManager {
  constructor({ playerManager } = {}) {
    this.sockets = new Map();
    this.socketPlayers = new Map();
    this.playerManager = playerManager;
  }

  registerSocket(socket, player = null) {
    this.sockets.set(socket.id, socket);
    if (player?.id) {
      this.socketPlayers.set(socket.id, player.id);
    }

    return {
      socketId: socket.id,
      playerId: player?.id ?? null,
    };
  }

  removeSocket(socketId) {
    const socket = this.getSocket(socketId);
    this.sockets.delete(socketId);
    this.socketPlayers.delete(socketId);
    return socket;
  }

  getSocket(socketId) {
    return this.sockets.get(socketId) ?? null;
  }

  getPlayerBySocket(socketId) {
    const playerId = this.socketPlayers.get(socketId);
    if (!playerId || !this.playerManager) return null;

    return this.playerManager.getPlayer(playerId);
  }

  setPlayerForSocket(socketId, playerId) {
    if (!this.sockets.has(socketId)) return null;

    this.socketPlayers.set(socketId, playerId);
    return this.getPlayerBySocket(socketId);
  }

  onlineCount() {
    return this.sockets.size;
  }
}

export default SocketManager;
