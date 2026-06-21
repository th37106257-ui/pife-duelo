export const PRODUCTION_SERVER_URL = 'https://pife-duelo-production-4f73.up.railway.app';

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function isLocalUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.');
  } catch {
    return false;
  }
}

export function getServerUrl() {
  const configuredUrl = normalizeUrl(
    import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL,
  );
  const currentOrigin = typeof window === 'undefined' ? '' : normalizeUrl(window.location.origin);
  const pageIsLocal = isLocalUrl(currentOrigin);

  if (configuredUrl && (!isLocalUrl(configuredUrl) || pageIsLocal)) {
    return configuredUrl;
  }

  if (currentOrigin) return currentOrigin;

  if (import.meta.env.DEV) return 'http://localhost:3000';
  return PRODUCTION_SERVER_URL;
}
