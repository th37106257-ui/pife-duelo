const ACTIVE_MATCH_STORAGE_KEY = 'pifeDuelo.activeOnlineMatch';
const recentReports = new Map();

function getServerUrl() {
  if (import.meta.env.VITE_SOCKET_URL) return import.meta.env.VITE_SOCKET_URL;
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function readSession() {
  try {
    return JSON.parse(window.localStorage.getItem(ACTIVE_MATCH_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function reportClientError(error, source = 'frontend', extra = {}) {
  if (typeof window === 'undefined') return;
  const normalized = error instanceof Error ? error : new Error(String(error?.message ?? error ?? 'Erro desconhecido'));
  const session = readSession();
  const payload = {
    timestamp: new Date().toISOString(),
    level: extra.level ?? 'error',
    message: normalized.message,
    source,
    stack: normalized.stack ?? null,
    playerId: extra.playerId ?? session.playerId ?? null,
    matchId: extra.matchId ?? session.matchId ?? null,
    roomId: extra.roomId ?? session.roomId ?? null,
    url: window.location.href,
    userAgent: window.navigator.userAgent,
  };
  const fingerprint = `${source}:${payload.message}:${payload.matchId ?? ''}`;
  const lastSent = recentReports.get(fingerprint) ?? 0;
  if (Date.now() - lastSent < 10000) return;
  recentReports.set(fingerprint, Date.now());

  const socket = window.__PIFE_DUELO_SOCKET__;
  if (socket?.connected) {
    socket.emit('client_error_report', payload);
    return;
  }
  fetch(`${getServerUrl()}/api/client-errors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}

export function installClientErrorReporting() {
  window.addEventListener('error', (event) => {
    reportClientError(event.error || new Error(event.message), 'window.onerror');
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportClientError(event.reason, 'window.onunhandledrejection');
  });
}
