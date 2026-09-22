export function normalizeOrigin(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function buildAllowedClientOrigins({
  frontendUrl = '',
  clientUrl = '',
  allowedClientUrls = '',
  publicGameUrl = '',
} = {}) {
  const configuredOrigins = [
    frontendUrl,
    clientUrl,
    ...String(allowedClientUrls || '').split(','),
    publicGameUrl,
  ];
  return [...new Set(configuredOrigins.map(normalizeOrigin).filter(Boolean))];
}

export default { normalizeOrigin, buildAllowedClientOrigins };
