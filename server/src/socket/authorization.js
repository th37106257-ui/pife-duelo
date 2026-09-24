const ACTIVE_ENTRY_STATUSES = new Set(['linked', 'playing']);

export function resolveAuthorizedMatchPlayer({
  socket,
  match,
  socketManager,
  entryService,
  paymentService,
  requestedPlayerId = null,
} = {}) {
  if (!socket?.id || !match?.matchId || !Array.isArray(match.players)) return null;

  const boundPlayerId = socketManager?.getPlayerBySocket?.(socket.id)?.id ?? null;
  const boundPlayer = match.players.find((candidate) => (
    candidate.id === boundPlayerId && candidate.socketId === socket.id
  ));
  if (boundPlayer) {
    return !requestedPlayerId || requestedPlayerId === boundPlayer.id ? boundPlayer.id : null;
  }

  const entryId = socket.entryAccess?.entryId;
  if (entryId) {
    const entry = entryService?.getEntry?.(entryId, { includeSecrets: true });
    const linkedMatchId = entry?.linkedMatchId ?? socket.entryAccess.linkedMatchId;
    const playerId = entry?.playerId ?? socket.entryAccess.playerId;
    const status = entry?.status ?? socket.entryAccess.authorizationStatus;
    if (
      ACTIVE_ENTRY_STATUSES.has(status)
      && playerId
      && linkedMatchId === match.matchId
      && socket.entryAccess.linkedMatchId === match.matchId
    ) {
      const authorizedPlayer = match.players.find((candidate) => candidate.id === playerId);
      if (authorizedPlayer && (!requestedPlayerId || requestedPlayerId === authorizedPlayer.id)) {
        return authorizedPlayer.id;
      }
    }
  }

  const paymentId = socket.paymentAccess?.paymentId;
  if (!paymentId || socket.paymentAccess?.linkedMatchId !== match.matchId) return null;
  const payment = paymentService?.getPayment?.(paymentId);
  if (
    !payment
    || payment.status !== 'confirmed'
    || !payment.accessUsedAt
    || payment.linkedMatchId !== match.matchId
    || !payment.accessReservedBy
  ) {
    return null;
  }

  const paymentPlayer = match.players.find((candidate) => candidate.socketId === payment.accessReservedBy);
  if (!paymentPlayer || (requestedPlayerId && requestedPlayerId !== paymentPlayer.id)) return null;
  return paymentPlayer.id;
}

export default resolveAuthorizedMatchPlayer;
