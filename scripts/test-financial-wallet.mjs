import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFinancialConfig } from '../server/src/financial/financialConfig.js';
import { PostgresFinancialRepository } from '../server/src/financial/PostgresFinancialRepository.js';
import { FinancialWalletService } from '../server/src/financial/FinancialWalletService.js';
import { MockPaymentProvider } from '../server/src/financial/paymentProviders/MockPaymentProvider.js';
import { AsaasSandboxProvider } from '../server/src/financial/paymentProviders/AsaasSandboxProvider.js';

const here = dirname(fileURLToPath(import.meta.url));
const requireFromServer = createRequire(resolve(here, '../server/package.json'));
const { newDb } = requireFromServer('pg-mem');

const db = newDb();
const { Pool } = db.adapters.createPg();
const pool = new Pool();
const repository = new PostgresFinancialRepository({ pool, serializableTransactions: false, manageTransactions: false });
const migration = readFileSync(resolve(here, '../server/src/financial/migrations/001_financial_wallet.sql'), 'utf8')
  .replace(/CREATE OR REPLACE FUNCTION reject_financial_ledger_mutation[\s\S]*?FOR EACH ROW EXECUTE FUNCTION reject_financial_ledger_mutation\(\);/m, '')
  .replace(/CREATE OR REPLACE FUNCTION reject_confirmed_transaction_mutation[\s\S]*?FOR EACH ROW EXECUTE FUNCTION reject_confirmed_transaction_mutation\(\);/m, '')
  .replace(/ CHECK \([^\r\n]+\)/g, '');
await pool.query(migration);

const config = resolveFinancialConfig({
  FINANCIAL_WALLET_ENABLED: 'true',
  FINANCIAL_MODE: 'sandbox',
  PAYMENT_PROVIDER: 'mock',
  PIX_DEPOSITS_ENABLED: 'true',
  REAL_MONEY_GAMES_ENABLED: 'true',
  WITHDRAWALS_ENABLED: 'true',
  WITHDRAWAL_MODE: 'manual',
  AUTO_WITHDRAWALS_ENABLED: 'false',
  MIN_WITHDRAWAL_AMOUNT_CENTS: '2000',
  DATABASE_URL: 'postgres://test',
  FINANCIAL_DATA_ENCRYPTION_KEY: 'test-only-key-with-at-least-32-characters',
  ASAAS_WEBHOOK_TOKEN: 'test-webhook-token',
  WHATSAPP_FINANCIAL_ADMIN_NUMBERS: '5511999990001',
});
assert.equal(config.ready, true);
const provider = new MockPaymentProvider({ webhookToken: 'test-webhook-token' });
const service = new FinancialWalletService({ repository, provider, config });

const playerOne = '5511999991001';
const playerTwo = '5511999991002';
const accountOne = await service.getOrCreateAccount(playerOne, { displayName: 'Jogador Um' });
assert.match(accountOne.public_id, /^PD-[A-Z2-9]{6}$/);
assert.equal((await service.getOrCreateAccount(playerOne)).account_id, accountOne.account_id);
const accountTwo = await service.getOrCreateAccount(playerTwo, { displayName: 'Jogador Dois' });
assert.notEqual(accountOne.public_id, accountTwo.public_id);

async function depositAndCredit(phone, amountCents, suffix) {
  const deposit = await service.createDeposit(phone, amountCents, { idempotencyKey: `deposit-${suffix}` });
  assert.match(deposit.pix_copy_paste, /^000201-MOCK-/);
  assert.match(deposit.pix_qr_code, /^MOCK_QR_/);
  provider.markPaid(deposit.provider_payment_id);
  const credited = await service.processPaymentWebhook({
    headers: { 'asaas-access-token': 'test-webhook-token' },
    payload: { id: `event-${suffix}`, event: 'PAYMENT_RECEIVED', payment: { id: deposit.provider_payment_id } },
  });
  assert.equal(credited.credited, true);
  const duplicate = await service.processPaymentWebhook({
    headers: { 'asaas-access-token': 'test-webhook-token' },
    payload: { id: `event-${suffix}`, event: 'PAYMENT_RECEIVED', payment: { id: deposit.provider_payment_id } },
  });
  assert.equal(duplicate.duplicate, true);
  return deposit;
}

await depositAndCredit(playerOne, 10_000, 'one');
await depositAndCredit(playerTwo, 10_000, 'two');
assert.equal(Number((await service.getAccount(playerOne)).available_balance_cents), 10_000);
assert.equal(Number((await service.getAccount(playerTwo)).available_balance_cents), 10_000);

const refundPhone = '5511999991003';
const refundable = await depositAndCredit(refundPhone, 2_000, 'refund');
provider.markRefunded(refundable.provider_payment_id);
const refund = await service.processPaymentWebhook({
  headers: { 'asaas-access-token': 'test-webhook-token' },
  payload: { id: 'event-refund-confirmed', event: 'PAYMENT_REFUNDED', payment: { id: refundable.provider_payment_id } },
});
assert.equal(refund.reversed, true);
assert.equal(Number((await service.getAccount(refundPhone)).available_balance_cents), 0);

const pending = await service.createDeposit(playerOne, 2_000, { idempotencyKey: 'deposit-out-of-order' });
const ignored = await service.processPaymentWebhook({
  headers: { 'asaas-access-token': 'test-webhook-token' },
  payload: { id: 'event-pending', event: 'PAYMENT_CREATED', payment: { id: pending.provider_payment_id } },
});
assert.equal(ignored.ignored, true);

const released = await service.reserveStake(playerTwo, { amountCents: 500, entryId: 'ENTRY-RELEASE', tableId: 5 });
assert.equal((await service.releaseStake(released.entry_id)).released, true);
assert.equal((await service.releaseStake(released.entry_id)).duplicate, true);

const withdrawal = await service.requestWithdrawal(playerOne, {
  amountCents: 2_000, pixKeyType: 'EVP', pixKey: 'sensitive-test-key', holderName: 'Jogador Um', idempotencyKey: 'withdrawal-one',
});
const details = await service.getWithdrawalDetails('5511999990001', withdrawal.public_reference);
assert.equal(details.pix_key, 'sensitive-test-key');
assert.equal(details.pix_key_ciphertext, undefined);
assert.equal((await service.requestWithdrawal(playerOne, {
  amountCents: 2_000, pixKeyType: 'EVP', pixKey: 'sensitive-test-key', holderName: 'Jogador Um', idempotencyKey: 'withdrawal-one',
})).duplicate, true);
const rejected = await service.rejectWithdrawal('5511999990001', withdrawal.public_reference, 'dados divergentes');
assert.equal(rejected.status, 'REJECTED');
assert.equal(Number((await service.getAccount(playerOne)).available_balance_cents), 10_000);
assert.equal((await service.rejectWithdrawal('5511999990001', withdrawal.public_reference, 'repetido')).duplicate, true);

const withdrawalPaid = await service.requestWithdrawal(playerOne, {
  amountCents: 2_000, pixKeyType: 'EMAIL', pixKey: 'pix@example.test', holderName: 'Jogador Um', idempotencyKey: 'withdrawal-two',
});
const paid = await service.markWithdrawalPaid('5511999990001', withdrawalPaid.public_reference, 'TRANSFER-TEST-1');
assert.equal(paid.status, 'PAID');
assert.equal((await service.markWithdrawalPaid('5511999990001', withdrawalPaid.public_reference, 'TRANSFER-TEST-1')).duplicate, true);
await assert.rejects(() => service.listPendingWithdrawals(playerOne), /FINANCIAL_ADMIN_UNAUTHORIZED/);

await service.reserveStake(playerOne, { amountCents: 2_000, entryId: 'ENTRY-1', tableId: 20 });
await service.reserveStake(playerTwo, { amountCents: 2_000, entryId: 'ENTRY-2', tableId: 20 });
await service.commitMatchReservations(['ENTRY-1', 'ENTRY-2'], 'MATCH-1');
const settlement = await service.settleMatch({ matchId: 'MATCH-1', winnerPhone: playerOne, platformFeeCents: 400 });
assert.equal(Number(settlement.winner_prize_cents), 3_600);
assert.equal((await service.settleMatch({ matchId: 'MATCH-1', winnerPhone: playerOne, platformFeeCents: 400 })).duplicate, true);

const ledgerTotals = await repository.query(
  'SELECT transaction_id, sum(amount_cents)::bigint AS total FROM financial_ledger_entries GROUP BY transaction_id',
);
assert.ok(ledgerTotals.rows.length > 0);
assert.ok(ledgerTotals.rows.every((row) => Number(row.total) === 0));
const finalAccount = await service.getAccount(playerOne);
assert.ok(Number(finalAccount.available_balance_cents) >= 0);
assert.ok(Number(finalAccount.reserved_balance_cents) >= 0);
assert.ok(Number(finalAccount.withdrawal_pending_balance_cents) >= 0);

const disabled = resolveFinancialConfig({
  FINANCIAL_WALLET_ENABLED: 'false', PIX_DEPOSITS_ENABLED: 'false', REAL_MONEY_GAMES_ENABLED: 'false', WITHDRAWALS_ENABLED: 'false',
});
assert.equal(disabled.ready, false);
assert.equal(disabled.errors.length, 0);
const unsafeProduction = resolveFinancialConfig({
  FINANCIAL_WALLET_ENABLED: 'true', FINANCIAL_MODE: 'production', PAYMENT_PROVIDER: 'mock', DATABASE_URL: 'postgres://test',
});
assert.ok(unsafeProduction.errors.includes('PRODUCTION_FINANCIAL_ACTIVATION_REQUIRES_RELEASE'));
assert.throws(() => new AsaasSandboxProvider({ apiKey: '$aact_prod_wrong', webhookToken: 'x' }), /ASAAS_SANDBOX_KEY_REQUIRED/);

const serverSource = readFileSync(resolve(here, '../server/src/index.js'), 'utf8');
assert.match(serverSource, /financialWallet:\s*\{/);
assert.match(serverSource, /storeConfigured: Boolean\(financialConfig\.databaseUrl\)/);
const healthBlock = serverSource.slice(serverSource.indexOf("app.get('/health'"), serverSource.indexOf("app.get('/api/status'"));
assert.ok(!healthBlock.includes('asaasApiKey'));
assert.ok(!healthBlock.includes('asaasWebhookToken'));
assert.ok(!healthBlock.includes('encryptionKey'));

await pool.end();
console.log('Financial wallet tests passed.');
