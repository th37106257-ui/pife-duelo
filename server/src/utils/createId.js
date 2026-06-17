import crypto from 'node:crypto';

export function createId(prefix = 'id') {
  return `${prefix}-${crypto.randomUUID()}`;
}
