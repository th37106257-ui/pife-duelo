import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { FinancialWalletService } from '../server/src/financial/FinancialWalletService.js';
import { listFinancialMigrations, PostgresFinancialRepository } from '../server/src/financial/PostgresFinancialRepository.js';
import { MockPaymentProvider } from '../server/src/financial/paymentProviders/MockPaymentProvider.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
assert.ok(listFinancialMigrations().includes('003_pix_expiration.sql'));
const db = require('pg-mem').newDb();
const { Pool } = db.adapters.createPg();
const pool = new Pool();
const migration = readFileSync(new URL('../server/src/financial/migrations/001_financial_wallet.sql', import.meta.url), 'utf8')
  .replace(/CREATE OR REPLACE FUNCTION reject_financial_ledger_mutation[\s\S]*?FOR EACH ROW EXECUTE FUNCTION reject_financial_ledger_mutation\(\);/m, '')
  .replace(/CREATE OR REPLACE FUNCTION reject_confirmed_transaction_mutation[\s\S]*?FOR EACH ROW EXECUTE FUNCTION reject_confirmed_transaction_mutation\(\);/m, '')
  .replace(/ CHECK \([^\r\n]+\)/g, '');
await pool.query(migration);
await pool.query(readFileSync(new URL('../server/src/financial/migrations/002_payment_confirmation_notification.sql', import.meta.url), 'utf8'));
await pool.query(readFileSync(new URL('../server/src/financial/migrations/003_pix_expiration.sql', import.meta.url), 'utf8'));

const repository = new PostgresFinancialRepository({ pool, serializableTransactions: false, supportsSkipLocked: false });
const provider = new MockPaymentProvider({ webhookToken: 'expiration-test-token' });
let now = Date.parse('2026-09-20T12:00:00.000Z');
const config = {
  ready: true,
  mode: 'sandbox',
  provider: 'mock',
  pixDepositsEnabled: true,
  pixPaymentWindowMinutes: 10,
};
const service = new FinancialWalletService({ repository, provider, config, clock: () => now });
const phone = '5511999997001';

const pending = await service.createDeposit(phone, 500, { idempotencyKey: 'expiration-pending-1' });
assert.equal(new Date(pending.expires_at).getTime(), now + 10 * 60 * 1000);
assert.deepEqual(await service.expirePendingDeposits(), []);
assert.equal((await repository.query('SELECT status FROM financial_deposits WHERE deposit_id=$1', [pending.deposit_id])).rows[0].status, 'PENDING');

now += 10 * 60 * 1000 + 1_000;
const expired = await service.expirePendingDeposits();
assert.equal(expired[0].status, 'EXPIRED');
assert.equal((await repository.query('SELECT status FROM financial_deposits WHERE deposit_id=$1', [pending.deposit_id])).rows[0].status, 'EXPIRED');
assert.equal(provider.payments.get(pending.provider_payment_id).status, 'CANCELLED');
const lateUnpaidWebhook = await service.processPaymentWebhook({
  headers: { 'asaas-access-token': provider.webhookToken },
  payload: { id: 'expiration-late-unpaid', event: 'PAYMENT_RECEIVED', payment: { id: pending.provider_payment_id } },
});
assert.equal(lateUnpaidWebhook.ignored, true);
assert.equal(Number((await service.getAccount(phone)).available_balance_cents), 0);
assert.equal(Number((await repository.query(
  "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key=$1",
  [`deposit:expire:${pending.deposit_id}`],
)).rows[0].total), 1);

await assert.rejects(
  () => service.createDeposit(phone, 500, { idempotencyKey: 'expiration-pending-1' }),
  /FINANCIAL_DEPOSIT_EXPIRED/,
);
const replacement = await service.createDeposit(phone, 500, { idempotencyKey: 'expiration-pending-2' });
assert.notEqual(replacement.public_reference, pending.public_reference);
assert.notEqual(replacement.provider_payment_id, pending.provider_payment_id);

const paidRace = await service.createDeposit(phone, 700, { idempotencyKey: 'expiration-paid-race' });
provider.markPaid(paidRace.provider_payment_id);
now += 10 * 60 * 1000 + 1_000;
const reconciled = await service.expirePendingDeposits();
assert.ok(reconciled.some((item) => item.publicReference === paidRace.public_reference && item.status === 'CREDITED'));
assert.equal((await repository.query('SELECT status FROM financial_deposits WHERE deposit_id=$1', [paidRace.deposit_id])).rows[0].status, 'CREDITED');
assert.equal(Number((await service.getAccount(phone)).available_balance_cents), 700);
assert.equal(Number((await repository.query(
  "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key=$1",
  [`deposit:credit:${paidRace.deposit_id}`],
)).rows[0].total), 1);

for (const [index, status] of ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].entries()) {
  const settled = await service.createDeposit(phone, 701 + index, { idempotencyKey: `expiration-settled-${status}` });
  provider.payments.get(settled.provider_payment_id).status = status;
  now += 10 * 60 * 1000 + 1_000;
  const outcomes = await service.expirePendingDeposits();
  assert.ok(outcomes.some((item) => item.publicReference === settled.public_reference && item.status === 'CREDITED'));
  assert.equal((await repository.query('SELECT status FROM financial_deposits WHERE deposit_id=$1', [settled.deposit_id])).rows[0].status, 'CREDITED');
  assert.notEqual(provider.payments.get(settled.provider_payment_id).status, 'CANCELLED');
  assert.equal(Number((await repository.query(
    "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key=$1",
    [`deposit:credit:${settled.deposit_id}`],
  )).rows[0].total), 1);
}

const ambiguousStatus = await service.createDeposit(phone, 800, { idempotencyKey: 'expiration-ambiguous-paid' });
provider.payments.get(ambiguousStatus.provider_payment_id).status = 'PAID';
now += 10 * 60 * 1000 + 1_000;
const ambiguousOutcomes = await service.expirePendingDeposits();
assert.ok(ambiguousOutcomes.some((item) => item.publicReference === ambiguousStatus.public_reference
  && item.status === 'RETRY_REQUIRED' && item.reason === 'AMBIGUOUS_PROVIDER_STATE'));
assert.equal((await repository.query('SELECT status FROM financial_deposits WHERE deposit_id=$1', [ambiguousStatus.deposit_id])).rows[0].status, 'PENDING');
assert.equal(provider.payments.get(ambiguousStatus.provider_payment_id).status, 'PAID');
assert.equal(Number((await repository.query(
  "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key=$1",
  [`deposit:credit:${ambiguousStatus.deposit_id}`],
)).rows[0].total), 0);

const credited = await service.createDeposit(phone, 300, { idempotencyKey: 'expiration-credited' });
provider.markPaid(credited.provider_payment_id);
await service.processPaymentWebhook({
  headers: { 'asaas-access-token': provider.webhookToken },
  payload: { id: 'expiration-credited-event', event: 'PAYMENT_RECEIVED', payment: { id: credited.provider_payment_id } },
});
now += 10 * 60 * 1000 + 1_000;
await service.expirePendingDeposits();
assert.equal((await repository.query('SELECT status FROM financial_deposits WHERE deposit_id=$1', [credited.deposit_id])).rows[0].status, 'CREDITED');

const timeoutDeposit = await service.createDeposit(phone, 900, { idempotencyKey: 'expiration-timeout' });
now += 10 * 60 * 1000 + 1_000;
const originalGetPayment = provider.getPayment.bind(provider);
let timeoutOnce = true;
provider.getPayment = async (...args) => {
  if (timeoutOnce && args[0] === timeoutDeposit.provider_payment_id) {
    timeoutOnce = false;
    throw new Error('ASAAS_REQUEST_TIMEOUT');
  }
  return originalGetPayment(...args);
};
assert.ok((await service.expirePendingDeposits()).some((item) => item.publicReference === timeoutDeposit.public_reference && item.status === 'RETRY_REQUIRED'));
assert.equal((await repository.query('SELECT status FROM financial_deposits WHERE deposit_id=$1', [timeoutDeposit.deposit_id])).rows[0].status, 'PENDING');
assert.ok((await service.expirePendingDeposits()).some((item) => item.publicReference === timeoutDeposit.public_reference && item.status === 'EXPIRED'));
provider.getPayment = originalGetPayment;

const restartDeposit = await service.createDeposit(phone, 1_100, { idempotencyKey: 'expiration-restart' });
now += 10 * 60 * 1000 + 1_000;
const restarted = new FinancialWalletService({ repository, provider, config, clock: () => now });
await restarted.expirePendingDeposits();
assert.equal((await repository.query('SELECT status FROM financial_deposits WHERE deposit_id=$1', [restartDeposit.deposit_id])).rows[0].status, 'EXPIRED');

const concurrentDeposit = await service.createDeposit(phone, 1_300, { idempotencyKey: 'expiration-concurrent' });
now += 10 * 60 * 1000 + 1_000;
const secondInstance = new FinancialWalletService({ repository, provider, config, clock: () => now });
await Promise.all([service.expirePendingDeposits(), secondInstance.expirePendingDeposits()]);
assert.equal(Number((await repository.query(
  "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key=$1",
  [`deposit:expire:${concurrentDeposit.deposit_id}`],
)).rows[0].total), 1);

const webhookRace = await service.createDeposit(phone, 1_500, { idempotencyKey: 'expiration-webhook-race' });
provider.markPaid(webhookRace.provider_payment_id);
now += 10 * 60 * 1000 + 1_000;
await Promise.all([
  service.expirePendingDeposits(),
  service.processPaymentWebhook({
    headers: { 'asaas-access-token': provider.webhookToken },
    payload: { id: 'expiration-webhook-race-event', event: 'PAYMENT_RECEIVED', payment: { id: webhookRace.provider_payment_id } },
  }),
]);
assert.equal((await repository.query('SELECT status FROM financial_deposits WHERE deposit_id=$1', [webhookRace.deposit_id])).rows[0].status, 'CREDITED');
assert.equal(Number((await repository.query(
  "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key=$1",
  [`deposit:credit:${webhookRace.deposit_id}`],
)).rows[0].total), 1);

await pool.end();
console.log('Pix expiration persistence, provider check, retry, restart and concurrency tests passed.');
