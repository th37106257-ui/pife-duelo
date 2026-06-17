function getServerUrl() {
  if (import.meta.env.VITE_SOCKET_URL) return import.meta.env.VITE_SOCKET_URL;
  return typeof window === 'undefined' ? '' : window.location.origin;
}

async function requestAdmin(path, { password, method = 'GET', body = null } = {}) {
  const response = await fetch(`${getServerUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-password': password,
    },
    body: body ? JSON.stringify(body) : null,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || 'Acao admin rejeitada.');
  }

  return response.json();
}

export function loginAdmin(password) {
  return requestAdmin('/api/admin/login', {
    password,
    method: 'POST',
    body: {},
  });
}

export async function getAdminSnapshot(password) {
  const [dashboard, activeMatches, players, history] = await Promise.all([
    requestAdmin('/api/admin/dashboard', { password }),
    requestAdmin('/api/admin/active-matches', { password }),
    requestAdmin('/api/admin/online-players', { password }),
    requestAdmin('/api/admin/match-history', { password }),
  ]);

  return {
    dashboard: dashboard.dashboard,
    adminLogs: dashboard.adminLogs ?? [],
    activeMatches: activeMatches.matches ?? [],
    players: players.players ?? [],
    history: history.history ?? [],
  };
}

export function getAdminMatchAudit(password, matchId) {
  return requestAdmin(`/api/admin/match-audit/${matchId}`, { password });
}

export function adminEndMatch(password, matchId, reason) {
  return requestAdmin(`/api/admin/matches/${matchId}/end`, {
    password,
    method: 'POST',
    body: { reason },
  });
}

export function adminForceWinner(password, matchId, winnerId, reason) {
  return requestAdmin(`/api/admin/matches/${matchId}/force-winner`, {
    password,
    method: 'POST',
    body: { winnerId, reason },
  });
}

export function adminRemoveRoom(password, roomId, { reason, confirmActiveMatch = false } = {}) {
  return requestAdmin(`/api/admin/rooms/${roomId}`, {
    password,
    method: 'DELETE',
    body: { reason, confirmActiveMatch },
  });
}
