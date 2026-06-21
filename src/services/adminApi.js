import { reportClientError } from './errorReporter.js';
import { getServerUrl } from './serverUrl.js';

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
    const error = new Error(payload.message || payload.error || 'Acao admin rejeitada.');
    if (response.status >= 500 || response.status === 0) reportClientError(error, 'admin-request');
    throw error;
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
  const [dashboard, activeMatches, players, history, payments] = await Promise.all([
    requestAdmin('/api/admin/dashboard', { password }),
    requestAdmin('/api/admin/active-matches', { password }),
    requestAdmin('/api/admin/online-players', { password }),
    requestAdmin('/api/admin/match-history', { password }),
    requestAdmin('/api/admin/payments?status=pending', { password }),
  ]);

  return {
    dashboard: dashboard.dashboard,
    metrics: dashboard.metrics ?? {},
    monitoring: dashboard.monitoring ?? {},
    adminLogs: dashboard.adminLogs ?? [],
    activeMatches: activeMatches.matches ?? [],
    players: players.players ?? [],
    history: history.history ?? [],
    pendingPayments: payments.payments ?? [],
  };
}

export function adminConfirmPayment(password, paymentId) {
  return requestAdmin(`/api/admin/payments/${paymentId}/confirm`, {
    password,
    method: 'POST',
    body: {},
  });
}

export function adminRejectPayment(password, paymentId, reason) {
  return requestAdmin(`/api/admin/payments/${paymentId}/reject`, {
    password,
    method: 'POST',
    body: { reason },
  });
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
