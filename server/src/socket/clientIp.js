import { isIP } from 'node:net';
import { config } from '../config.js';

function normalizeIp(value) {
  const candidate = String(value || '').trim();
  return isIP(candidate) ? candidate : null;
}

export function getHttpClientIp(request) {
  const realIp = normalizeIp(request?.get?.('x-real-ip') ?? request?.headers?.['x-real-ip']);
  if (realIp) return realIp;

  return normalizeIp(request?.ip)
    || normalizeIp(request?.socket?.remoteAddress)
    || 'unknown';
}

export function getSocketClientIp(socket, { trustedProxyHops = config.TRUST_PROXY_HOPS } = {}) {
  const realIp = normalizeIp(socket?.handshake?.headers?.['x-real-ip']);
  if (realIp) return realIp;

  const remoteAddress = normalizeIp(socket?.handshake?.address) || 'unknown';
  if (trustedProxyHops !== 1) return remoteAddress;

  const forwardedHeader = socket?.handshake?.headers?.['x-forwarded-for'];
  if (typeof forwardedHeader !== 'string') return remoteAddress;

  const chain = forwardedHeader
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);

  const oneTrustedProxyClientAddress = chain.at(-1);
  return normalizeIp(oneTrustedProxyClientAddress) || remoteAddress;
}

export default getSocketClientIp;
