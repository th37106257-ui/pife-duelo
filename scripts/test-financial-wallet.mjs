import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFinancialConfig } from '../server/src/financial/financialConfig.js';
import { PostgresFinancialRepository, resolveFinancialDatabaseSsl } from '../server/src/financial/PostgresFinancialRepository.js';
import { FinancialWalletService } from '../server/src/financial/FinancialWalletService.js';
import { MockPaymentProvider } from '../server/src/financial/paymentProviders/MockPaymentProvider.js';
import { AsaasSandboxProvider } from '../server/src/financial/paymentProviders/AsaasSandboxProvider.js';

const here = dirname(fileURLToPath(import.meta.url));
const requireFromServer = createRequire(resolve(here, '../server/package.json'));
const { newDb } = requireFromServer('pg-mem');

assert.deepEqual(
  resolveFinancialDatabaseSsl({ connectionString: 'postgres://user:secret@postgres.railway.internal:5432/app', nodeEnv: 'production' }),
  { rejectUnauthorized: false },
);
assert.deepEqual(
  resolveFinancialDatabaseSsl({ connectionString: 'postgres://user:secret@public.example.com:5432/app', nodeEnv: 'production' }),
  { rejectUnauthorized: true },
);
assert.equal(
  resolveFinancialDatabaseSsl({ connectionString: 'postgres://user:secret@localhost:5432/app', nodeEnv: 'test' }),
  undefined,
);
assert.deepEqual(
  resolveFinancialDatabaseSsl({ connectionString: 'postgres://user:secret@postgres.railway.internal:5432/app', ssl: { ca: 'trusted-ca' }, nodeEnv: 'production' }),
  { ca: 'trusted-ca' },
);

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

async function prepareCommittedMatch(matchId, suffix, stake = 100) {
  const firstEntry = `ENTRY-${suffix}-1`;
  const secondEntry = `ENTRY-${suffix}-2`;
  await service.reserveStake(playerOne, { amountCents: stake, entryId: firstEntry, tableId: 2 });
  await service.reserveStake(playerTwo, { amountCents: stake, entryId: secondEntry, tableId: 2 });
  await service.commitMatchReservations([firstEntry, secondEntry], matchId);
  return [firstEntry, secondEntry];
}

await prepareCommittedMatch('MATCH-RETRY', 'RETRY');
const faultingService = new FinancialWalletService({
  repository, provider, config,
  faultInjector: (stage, context) => {
    if (stage === 'before_match_financial_mutation' && context.matchId === 'MATCH-RETRY') throw new Error('INJECTED_SETTLEMENT_FAILURE');
  },
});
await assert.rejects(
  () => faultingService.settleMatch({ matchId: 'MATCH-RETRY', winnerPhone: playerOne, platformFeeCents: 20 }),
  /INJECTED_SETTLEMENT_FAILURE/,
);
assert.equal((await repository.query("SELECT status FROM financial_match_settlements WHERE match_id='MATCH-RETRY'")).rows[0].status, 'RETRY_REQUIRED');
const restartedService = new FinancialWalletService({ repository, provider, config });
const recoveredSettlement = await restartedService.settleMatch({ matchId: 'MATCH-RETRY', winnerPhone: playerOne, platformFeeCents: 20 });
assert.equal(recoveredSettlement.status, 'SETTLED');

await prepareCommittedMatch('MATCH-AFTER-COMMIT', 'AFTER');
const executeOriginal = service.executeMatchOperation.bind(service);
let throwAfterCommit = true;
service.executeMatchOperation = async (matchId) => {
  const result = await executeOriginal(matchId);
  if (matchId === 'MATCH-AFTER-COMMIT' && throwAfterCommit) {
    throwAfterCommit = false;
    throw new Error('INJECTED_AFTER_SETTLEMENT_COMMIT');
  }
  return result;
};
await assert.rejects(
  () => service.settleMatch({ matchId: 'MATCH-AFTER-COMMIT', winnerPhone: playerOne, platformFeeCents: 20 }),
  /INJECTED_AFTER_SETTLEMENT_COMMIT/,
);
service.executeMatchOperation = executeOriginal;
assert.equal((await service.settleMatch({ matchId: 'MATCH-AFTER-COMMIT', winnerPhone: playerOne, platformFeeCents: 20 })).duplicate, true);
assert.equal(Number((await repository.query(
  "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key='match:settle:MATCH-AFTER-COMMIT'",
)).rows[0].total), 1);

await prepareCommittedMatch('MATCH-CONCURRENT', 'CONCURRENT');
const concurrent = await Promise.all([
  service.settleMatch({ matchId: 'MATCH-CONCURRENT', winnerPhone: playerOne, platformFeeCents: 20 }),
  service.settleMatch({ matchId: 'MATCH-CONCURRENT', winnerPhone: playerOne, platformFeeCents: 20 }),
]);
assert.equal(concurrent.filter((item) => item.status === 'SETTLED').length, 2);
assert.equal(Number((await repository.query(
  "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key='match:settle:MATCH-CONCURRENT'",
)).rows[0].total), 1);

const partialEntries = ['ENTRY-PARTIAL-1', 'ENTRY-PARTIAL-2'];
await service.reserveStake(playerOne, { amountCents: 100, entryId: partialEntries[0], tableId: 2 });
await service.reserveStake(playerTwo, { amountCents: 100, entryId: partialEntries[1], tableId: 2 });
await repository.query("UPDATE financial_match_reservations SET status='COMMITTED', match_id='MATCH-PARTIAL' WHERE entry_id=$1", [partialEntries[0]]);
const partialRecovery = await service.recoverFailedMatchStart(partialEntries, 'MATCH-PARTIAL', 'injected_partial_commit');
assert.equal(partialRecovery.recovered, true);
assert.ok((await repository.query(
  "SELECT * FROM financial_match_reservations WHERE entry_id IN ($1,$2)", partialEntries,
)).rows.every((row) => row.status === 'RELEASED'));

const partialCompEntries = ['ENTRY-PARTIAL-COMP-1', 'ENTRY-PARTIAL-COMP-2'];
await service.reserveStake(playerOne, { amountCents: 100, entryId: partialCompEntries[0], tableId: 2 });
await service.reserveStake(playerTwo, { amountCents: 100, entryId: partialCompEntries[1], tableId: 2 });
await service.releaseStake(partialCompEntries[0], 'injected_partial_release');
await repository.query("UPDATE financial_match_reservations SET status='COMMITTED', match_id='MATCH-PARTIAL-COMP' WHERE entry_id=$1", [partialCompEntries[1]]);
assert.equal((await service.recoverFailedMatchStart(partialCompEntries, 'MATCH-PARTIAL-COMP', 'injected_partial_compensation')).recovered, true);

const releaseReservation = await service.reserveStake(playerTwo, { amountCents: 100, entryId: 'ENTRY-RELEASE-RETRY', tableId: 2 });
const releaseOriginal = service.releaseStake.bind(service);
service.releaseStake = async () => { throw new Error('INJECTED_RELEASE_FAILURE'); };
await assert.rejects(() => service.releaseStakeWithRecovery(releaseReservation.entry_id, 'injected_release'), /INJECTED_RELEASE_FAILURE/);
assert.equal((await repository.query("SELECT status FROM financial_recovery_tasks WHERE task_key='stake-release:ENTRY-RELEASE-RETRY'")).rows[0].status, 'RETRY_REQUIRED');
service.releaseStake = releaseOriginal;
await service.retryPendingFinancialOperations();
assert.equal((await repository.query("SELECT status FROM financial_recovery_tasks WHERE task_key='stake-release:ENTRY-RELEASE-RETRY'")).rows[0].status, 'COMPLETED');

const feePhone = '5511999991888';
const feeDeposit = await service.createDeposit(feePhone, 2_000, { idempotencyKey: 'deposit-with-provider-fee' });
const feePayment = provider.payments.get(feeDeposit.provider_payment_id);
feePayment.status = 'RECEIVED';
feePayment.feeAmountCents = 100;
feePayment.netAmountCents = 1_900;
await service.processPaymentWebhook({
  headers: { 'asaas-access-token': 'test-webhook-token' },
  payload: { id: 'event-provider-fee', event: 'PAYMENT_RECEIVED', payment: { id: feeDeposit.provider_payment_id } },
});
const storedFeeDeposit = (await repository.query('SELECT * FROM financial_deposits WHERE deposit_id=$1', [feeDeposit.deposit_id])).rows[0];
assert.equal(Number(storedFeeDeposit.fee_amount_cents), 100);
assert.equal(Number(storedFeeDeposit.net_amount_cents), 1_900);
assert.equal(Number((await repository.query(
  "SELECT COALESCE(sum(amount_cents),0)::bigint AS total FROM financial_ledger_entries WHERE account_id=$1 AND ledger_account='DEPOSIT_PENDING'",
  [storedFeeDeposit.account_id],
)).rows[0].total), 0);
assert.equal(Number((await repository.query(
  "SELECT COALESCE(sum(amount_cents),0)::bigint AS total FROM financial_ledger_entries WHERE ledger_account='PROVIDER_FEE'",
)).rows[0].total), -100);

const blockedPhone = '5511999991999';
const blockedAccount = await service.getOrCreateAccount(blockedPhone, { displayName: 'Bloqueado' });
await repository.query("UPDATE financial_accounts SET status='BLOCKED' WHERE account_id=$1", [blockedAccount.account_id]);
await assert.rejects(() => service.createDeposit(blockedPhone, 2_000, { idempotencyKey: 'blocked-deposit' }), /FINANCIAL_ACCOUNT_BLOCKED/);
await assert.rejects(() => service.reserveStake(blockedPhone, { amountCents: 100, entryId: 'BLOCKED-ENTRY', tableId: 2 }), /FINANCIAL_ACCOUNT_BLOCKED/);
await assert.rejects(() => service.requestWithdrawal(blockedPhone, {
  amountCents: 2_000, pixKeyType: 'EMAIL', pixKey: 'blocked@example.test', holderName: 'Bloqueado', idempotencyKey: 'blocked-withdrawal',
}), /FINANCIAL_ACCOUNT_BLOCKED/);

let customerPosts = 0;
let paymentPosts = 0;
let qrFailures = 0;
const remoteCustomers = [];
const remotePayments = [];
const asaasFetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const method = options.method || 'GET';
  let body = options.body ? JSON.parse(options.body) : null;
  let responseBody;
  if (parsed.pathname.endsWith('/customers') && method === 'GET') {
    responseBody = { data: remoteCustomers.filter((item) => item.externalReference === parsed.searchParams.get('externalReference')) };
  } else if (parsed.pathname.endsWith('/customers') && method === 'POST') {
    customerPosts += 1;
    responseBody = { id: `cus-safe-${customerPosts}`, ...body };
    remoteCustomers.push(responseBody);
  } else if (parsed.pathname.endsWith('/payments') && method === 'GET') {
    responseBody = { data: remotePayments.filter((item) => item.externalReference === parsed.searchParams.get('externalReference')) };
  } else if (parsed.pathname.endsWith('/payments') && method === 'POST') {
    paymentPosts += 1;
    responseBody = { id: `pay-safe-${paymentPosts}`, status: 'PENDING', ...body };
    remotePayments.push(responseBody);
  } else if (parsed.pathname.endsWith('/pixQrCode')) {
    qrFailures += 1;
    if (qrFailures === 1) throw new Error('INJECTED_LOCAL_CRASH_AFTER_ASAAS_CHARGE');
    responseBody = { payload: 'PIX-SANDBOX-RECOVERED', encodedImage: 'QR-SANDBOX-RECOVERED' };
  } else {
    responseBody = {};
  }
  return { ok: true, status: 200, json: async () => responseBody };
};
const asaasProvider = new AsaasSandboxProvider({ apiKey: '$aact_hmlg_test_only', webhookToken: 'test-webhook-token', fetchImpl: asaasFetch });
const asaasService = new FinancialWalletService({ repository, provider: asaasProvider, config: { ...config, provider: 'asaas' } });
await assert.rejects(() => asaasService.createDeposit('5511999991777', 2_000, { idempotencyKey: 'asaas-crash-retry' }), /INJECTED_LOCAL_CRASH/);
const recoveredAsaasDeposit = await asaasService.createDeposit('5511999991777', 2_000, { idempotencyKey: 'asaas-crash-retry' });
assert.equal(recoveredAsaasDeposit.status, 'PENDING');
assert.equal(customerPosts, 1);
assert.equal(paymentPosts, 1);

assert.equal(Number((await repository.query(
  "SELECT count(*)::int AS total FROM financial_admin_audit WHERE action='WITHDRAWAL_PIX_DETAILS_ACCESSED'",
)).rows[0].total), 1);

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
