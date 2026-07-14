import { createHash } from 'node:crypto';

export function buildPublicMatchReference(matchId) {
  const normalized = String(matchId || '').trim();
  if (!normalized) return 'PD-000000';
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 6).toUpperCase();
  return `PD-${digest}`;
}

export default buildPublicMatchReference;
