export function buildHtmlContentSecurityPolicy(nonce) {
  const safeNonce = String(nonce || '').trim();
  if (!safeNonce) throw new Error('CSP_NONCE_REQUIRED');

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${safeNonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

export function injectScriptNonce(html, nonce) {
  const safeNonce = String(nonce || '').trim();
  if (!safeNonce) throw new Error('CSP_NONCE_REQUIRED');
  return String(html || '').replace(/<script\b(?![^>]*\bnonce=)/g, `<script nonce="${safeNonce}"`);
}

export function applySecurityHeaders(response, { production = false, sensitive = false } = {}) {
  response.set('Referrer-Policy', 'no-referrer');
  response.set('X-Content-Type-Options', 'nosniff');
  response.set('X-Frame-Options', 'DENY');
  response.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.set('X-DNS-Prefetch-Control', 'off');

  if (production) {
    response.set('Strict-Transport-Security', 'max-age=31536000');
  }
  if (sensitive) {
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
  }
}

export default {
  applySecurityHeaders,
  buildHtmlContentSecurityPolicy,
  injectScriptNonce,
};
