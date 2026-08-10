export const DEMO_CREDIT_EVENT_TYPES = Object.freeze({
  INITIAL_GRANT: 'DEMO_INITIAL_GRANT',
  ADMIN_GRANT: 'DEMO_ADMIN_GRANT',
  ENTRY_RESERVED: 'DEMO_ENTRY_RESERVED',
  ENTRY_RELEASED: 'DEMO_ENTRY_RELEASED',
  ENTRY_CONSUMED: 'DEMO_ENTRY_CONSUMED',
  MATCH_REWARD: 'DEMO_MATCH_REWARD',
  SYSTEM_COMPENSATION: 'DEMO_SYSTEM_COMPENSATION',
  ACCOUNT_RESET: 'DEMO_ACCOUNT_RESET',
});

export const DEMO_RESERVATION_STATUSES = Object.freeze({
  RESERVED: 'reserved',
  CONSUMED: 'consumed',
  RELEASED: 'released',
  COMPENSATED: 'compensated',
});

export const DEMO_CREDITS_DISCLAIMER = 'Os Créditos de Teste não possuem valor em dinheiro e servem apenas para testar o funcionamento do Pife Duelo.';

export function normalizeDemoPlayerId(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) throw new Error('DEMO_INVALID_PLAYER_ID');
  return digits;
}

export function normalizeDemoAmount(value, { integer = false } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('DEMO_INVALID_AMOUNT');
  if (integer && !Number.isInteger(amount)) throw new Error('DEMO_AMOUNT_MUST_BE_INTEGER');
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function normalizeDemoReference(reference = {}) {
  const source = typeof reference === 'string' ? { publicReference: reference } : (reference || {});
  const publicReference = String(source.publicReference || source.entryId || source.matchId || '').trim().slice(0, 120);
  if (!publicReference) throw new Error('DEMO_REFERENCE_REQUIRED');
  return {
    publicReference,
    entryId: String(source.entryId || '').trim().slice(0, 80) || null,
    matchId: String(source.matchId || '').trim().slice(0, 120) || null,
    tableId: source.tableId === null || source.tableId === undefined ? null : Number(source.tableId),
  };
}
