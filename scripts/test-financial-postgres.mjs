import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolveFinancialConfig } from '../server/src/financial/financialConfig.js';
import { PostgresFinancialRepository } from '../server/src/financial/PostgresFinancialRepository.js';
import { FinancialWalletService } from '../server/src/financial/FinancialWalletService.js';
import { MockPaymentProvider } from '../server/src/financial/paymentProviders/MockPaymentProvider.js';

const connectionString = String(process.env.FINANCIAL_TEST_DATABASE_URL || '').trim();
if (!connectionString) throw new Error('FINANCIAL_TEST_DATABASE_URL_REQUIRED');
const databaseUrl = new URL(connectionString);
if (!['127.0.0.1', 'localhost', '::1'].includes(databaseUrl.hostname)) throw new Error('FINANCIAL_TEST_DATABASE_MUST_BE_LOCAL');
if (!/homolog|test/i.test(databaseUrl.pathname)) throw new Error('FINANCIAL_TEST_DATABASE_MUST_BE_ISOLATED');

const repositoryA = new PostgresFinancialRepository({ connectionString, maxSerializableRetries: 4 });
const repositoryB = new PostgresFinancialRepository({ connectionString, maxSerializableRetries: 4 });
const repositories = [repositoryA, repositoryB];
const webhookToken = randomBytes(24).toString('hex');
const encryptionKey = randomBytes(48).toString('base64url');
const config = resolveFinancialConfig({
  FINANCIAL_WALLET_ENABLED: 'true',
  FINANCIAL_MODE: 'sandbox',
  PAYMENT_PROVIDER: 'mock',
  PIX_DEPOSITS_ENABLED: 'true',
  REAL_MONEY_GAMES_ENABLED: 'true',
  WITHDRAWALS_ENABLED: 'true',
  WITHDRAWAL_MODE: 'manual',
  AUTO_WITHDRAWALS_ENABLED: 'false',
  MIN_WITHDRAWAL_AMOUNT_CENTS: '100',
  DATABASE_URL: connectionString,
  FINANCIAL_DATA_ENCRYPTION_KEY: encryptionKey,
  ASAAS_WEBHOOK_TOKEN: webhookToken,
  WHATSAPP_FINANCIAL_ADMIN_NUMBERS: '5511999990001',
});
assert.equal(config.ready, true);
assert.equal(config.autoWithdrawalsEnabled, false);

const provider = new MockPaymentProvider({ webhookToken });
let serviceA = new FinancialWalletService({ repository: repositoryA, provider, config });
let serviceB = new FinancialWalletService({ repository: repositoryB, provider, config });

const errorCode = (code) => (error) => error?.code === code;
const count = async (repository, query, values = []) => Number((await repository.query(query, values)).rows[0].total);

async function deposit(phone, amountCents, suffix, service = serviceA) {
  const order = await service.createDeposit(phone, amountCents, { idempotencyKey: `pg-deposit-${suffix}` });
  provider.markPaid(order.provider_payment_id);
  const result = await service.processPaymentWebhook({
    headers: { 'asaas-access-token': webhookToken },
    payload: { id: `pg-event-${suffix}`, event: 'PAYMENT_RECEIVED', payment: { id: order.provider_payment_id } },
  });
  assert.equal(result.credited, true);
  return order;
}

async function prepareMatch(matchId, suffix, firstPhone, secondPhone, stake = 500) {
  const first = `PG-${suffix}-1`;
  const second = `PG-${suffix}-2`;
  await serviceA.reserveStake(firstPhone, { amountCents: stake, entryId: first, tableId: 20 });
  await serviceA.reserveStake(secondPhone, { amountCents: stake, entryId: second, tableId: 20 });
  await serviceA.commitMatchReservations([first, second], matchId);
  return [first, second];
}

async function failAfterQuery(repository, predicate, message, operation) {
  const originalTransaction = repository.transaction.bind(repository);
  let injected = false;
  repository.transaction = (callback) => originalTransaction((client) => callback({
    query: async (text, values) => {
      const result = await client.query(text, values);
      if (!injected && predicate(String(text))) {
        injected = true;
        throw new Error(message);
      }
      return result;
    },
  }));
  try {
    await assert.rejects(operation, new RegExp(message));
  } finally {
    repository.transaction = originalTransaction;
  }
  assert.equal(injected, true);
}

try {
  await repositoryA.initialize();
  await repositoryA.query(`TRUNCATE TABLE
    financial_admin_audit, financial_processed_webhooks, financial_reconciliations,
    financial_recovery_tasks, financial_match_settlements, financial_match_reservations,
    financial_withdrawals, financial_deposits, financial_ledger_entries,
    financial_transactions, financial_accounts RESTART IDENTITY CASCADE`);
  await repositoryB.initialize();

  const version = (await repositoryA.query('SHOW server_version')).rows[0].server_version;
  assert.match(version, /^17\./);
  const bigintColumns = await repositoryA.query(`SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND data_type='bigint' AND table_name LIKE 'financial_%'`);
  assert.ok(bigintColumns.rows.length >= 10);
  const triggers = await repositoryA.query(`SELECT tgname FROM pg_trigger
    WHERE NOT tgisinternal AND tgname IN ('financial_ledger_no_update','financial_transaction_no_mutation')`);
  assert.equal(triggers.rowCount, 2);
  const foreignKeys = await repositoryA.query(`SELECT count(*)::int AS total FROM pg_constraint
    WHERE contype='f' AND conrelid::regclass::text LIKE 'financial_%'`);
  assert.ok(foreignKeys.rows[0].total >= 8);

  const constraintAccount = await serviceA.getOrCreateAccount('5511999900001', { displayName: 'Constraint Player' });
  await assert.rejects(
    repositoryA.query('UPDATE financial_accounts SET available_balance_cents=-1 WHERE account_id=$1', [constraintAccount.account_id]),
    errorCode('23514'),
  );
  await assert.rejects(
    repositoryA.query(`INSERT INTO financial_accounts
      (account_id,public_id,phone_normalized,display_name) VALUES ($1,$2,$3,'Duplicate')`,
    [randomUUID(), constraintAccount.public_id, '5511999900999']),
    errorCode('23505'),
  );
  await assert.rejects(
    repositoryA.query(`INSERT INTO financial_ledger_entries
      (entry_id,transaction_id,ledger_account,amount_cents) VALUES ($1,$2,'INVALID_FK',1)`,
    [randomUUID(), randomUUID()]),
    errorCode('23503'),
  );

  const rollbackReference = `RB-${randomUUID()}`;
  await assert.rejects(repositoryA.transaction(async (client) => {
    await client.query(`INSERT INTO financial_transactions
      (transaction_id,public_reference,transaction_type,status,idempotency_key)
      VALUES ($1,$2,'ROLLBACK_TEST','PENDING',$3)`, [randomUUID(), rollbackReference, rollbackReference]);
    throw new Error('CONTROLLED_ROLLBACK');
  }), /CONTROLLED_ROLLBACK/);
  assert.equal(await count(repositoryA, 'SELECT count(*)::int AS total FROM financial_transactions WHERE public_reference=$1', [rollbackReference]), 0);

  const immutableTransaction = randomUUID();
  await repositoryA.query(`INSERT INTO financial_transactions
    (transaction_id,public_reference,transaction_type,status,idempotency_key)
    VALUES ($1,$2,'IMMUTABILITY_TEST','CONFIRMED',$3)`, [immutableTransaction, `IMM-${randomUUID()}`, `imm-${randomUUID()}`]);
  const immutableEntry = randomUUID();
  await repositoryA.query(`INSERT INTO financial_ledger_entries
    (entry_id,transaction_id,ledger_account,amount_cents) VALUES ($1,$2,'TEST_DEBIT',100)`, [immutableEntry, immutableTransaction]);
  await repositoryA.query(`INSERT INTO financial_ledger_entries
    (entry_id,transaction_id,ledger_account,amount_cents) VALUES ($1,$2,'TEST_CREDIT',-100)`, [randomUUID(), immutableTransaction]);
  await assert.rejects(repositoryA.query('UPDATE financial_ledger_entries SET amount_cents=101 WHERE entry_id=$1', [immutableEntry]), /FINANCIAL_LEDGER_IMMUTABLE/);
  await assert.rejects(repositoryA.query('DELETE FROM financial_ledger_entries WHERE entry_id=$1', [immutableEntry]), /FINANCIAL_LEDGER_IMMUTABLE/);
  await assert.rejects(repositoryA.query("UPDATE financial_transactions SET status='PENDING' WHERE transaction_id=$1", [immutableTransaction]), /CONFIRMED_FINANCIAL_TRANSACTION_IMMUTABLE/);
  await assert.rejects(repositoryA.query('DELETE FROM financial_transactions WHERE transaction_id=$1', [immutableTransaction]), /CONFIRMED_FINANCIAL_TRANSACTION_IMMUTABLE/);
  assert.equal((await repositoryA.query('SELECT 9007199254740991::bigint AS exact')).rows[0].exact, '9007199254740991');
  await repositoryA.query('UPDATE financial_accounts SET available_balance_cents=9007199254740992 WHERE account_id=$1', [constraintAccount.account_id]);
  await assert.rejects(
    serviceA.reserveStake('5511999900001', { amountCents: 1, entryId: 'PG-BIGINT-RANGE', tableId: 1 }),
    /FINANCIAL_DATABASE_AMOUNT_OUT_OF_RANGE/,
  );
  await repositoryA.query('UPDATE financial_accounts SET available_balance_cents=0 WHERE account_id=$1', [constraintAccount.account_id]);

  const serialAccount = await serviceA.getOrCreateAccount('5511999900002', { displayName: 'Serializable Player' });
  let firstArrived;
  let secondArrived;
  const firstReady = new Promise((resolve) => { firstArrived = resolve; });
  const secondReady = new Promise((resolve) => { secondArrived = resolve; });
  let attemptsA = 0;
  let attemptsB = 0;
  const increment = (repository, side) => repository.transaction(async (client) => {
    if (side === 'A') attemptsA += 1; else attemptsB += 1;
    const current = (await client.query('SELECT available_balance_cents FROM financial_accounts WHERE account_id=$1', [serialAccount.account_id])).rows[0];
    if ((side === 'A' ? attemptsA : attemptsB) === 1) {
      if (side === 'A') { firstArrived(); await secondReady; } else { secondArrived(); await firstReady; }
    }
    await client.query('UPDATE financial_accounts SET available_balance_cents=$1 WHERE account_id=$2', [BigInt(current.available_balance_cents) + 1n, serialAccount.account_id]);
  });
  await Promise.all([increment(repositoryA, 'A'), increment(repositoryB, 'B')]);
  assert.ok(attemptsA + attemptsB >= 3);
  assert.equal((await repositoryA.query('SELECT available_balance_cents FROM financial_accounts WHERE account_id=$1', [serialAccount.account_id])).rows[0].available_balance_cents, '2');
  await repositoryA.query('UPDATE financial_accounts SET available_balance_cents=0 WHERE account_id=$1', [serialAccount.account_id]);

  const webhookPhone = '5511999901001';
  const webhookOrder = await serviceA.createDeposit(webhookPhone, 1_000, { idempotencyKey: 'pg-webhook-concurrent' });
  provider.markPaid(webhookOrder.provider_payment_id);
  const webhookResults = await Promise.all([
    serviceA.processPaymentWebhook({ headers: { 'asaas-access-token': webhookToken }, payload: { id: 'pg-webhook-a', event: 'PAYMENT_RECEIVED', payment: { id: webhookOrder.provider_payment_id } } }),
    serviceB.processPaymentWebhook({ headers: { 'asaas-access-token': webhookToken }, payload: { id: 'pg-webhook-b', event: 'PAYMENT_RECEIVED', payment: { id: webhookOrder.provider_payment_id } } }),
  ]);
  assert.equal(webhookResults.filter((item) => item.credited).length, 1);
  assert.equal(webhookResults.filter((item) => item.duplicate).length, 1);
  assert.equal(await count(repositoryA, "SELECT count(*)::int AS total FROM financial_transactions WHERE transaction_type='DEPOSIT_CREDITED' AND metadata->>'depositId'=$1", [webhookOrder.deposit_id]), 1);

  const reservationResults = await Promise.allSettled([
    serviceA.reserveStake(webhookPhone, { amountCents: 700, entryId: 'PG-RACE-RES-A', tableId: 7 }),
    serviceB.reserveStake(webhookPhone, { amountCents: 700, entryId: 'PG-RACE-RES-B', tableId: 7 }),
  ]);
  assert.equal(reservationResults.filter((item) => item.status === 'fulfilled').length, 1);
  assert.match(reservationResults.find((item) => item.status === 'rejected').reason.message, /FINANCIAL_INSUFFICIENT_BALANCE/);
  const racedAccount = await serviceA.getAccount(webhookPhone);
  assert.equal(racedAccount.available_balance_cents, '300');
  assert.equal(racedAccount.reserved_balance_cents, '700');
  const winningReservation = reservationResults.find((item) => item.status === 'fulfilled').value;
  await serviceA.releaseStake(winningReservation.entry_id);

  const playerOne = '5511999902001';
  const playerTwo = '5511999902002';
  await deposit(playerOne, 10_000, 'player-one');
  await deposit(playerTwo, 10_000, 'player-two');

  const qrOriginal = provider.getPixQrCode.bind(provider);
  let qrFailure = true;
  provider.getPixQrCode = async (...args) => {
    if (qrFailure) { qrFailure = false; throw new Error('PG_CONTROLLED_CRASH_AFTER_PENDING'); }
    return qrOriginal(...args);
  };
  await assert.rejects(
    serviceA.createDeposit(playerOne, 900, { idempotencyKey: 'pg-deposit-pending-recovery' }),
    /PG_CONTROLLED_CRASH_AFTER_PENDING/,
  );
  provider.getPixQrCode = qrOriginal;
  assert.equal((await repositoryA.query("SELECT d.status FROM financial_deposits d JOIN financial_transactions t ON t.public_reference=d.public_reference WHERE t.idempotency_key='pg-deposit-pending-recovery'")).rows[0].status, 'REVIEW_REQUIRED');
  const recoveredDeposit = await serviceA.createDeposit(playerOne, 900, { idempotencyKey: 'pg-deposit-pending-recovery' });
  provider.markPaid(recoveredDeposit.provider_payment_id);
  await serviceA.processPaymentWebhook({
    headers: { 'asaas-access-token': webhookToken },
    payload: { id: 'pg-event-pending-recovery', event: 'PAYMENT_RECEIVED', payment: { id: recoveredDeposit.provider_payment_id } },
  });

  const preCommitEntries = ['PG-PRE-COMMIT-1', 'PG-PRE-COMMIT-2'];
  await serviceA.reserveStake(playerOne, { amountCents: 200, entryId: preCommitEntries[0], tableId: 9 });
  await serviceA.reserveStake(playerTwo, { amountCents: 200, entryId: preCommitEntries[1], tableId: 9 });
  await serviceA.recoverFailedMatchStart(preCommitEntries, 'PG-PRE-COMMIT', 'pg_before_commit');
  assert.equal(await count(repositoryA, "SELECT count(*)::int AS total FROM financial_match_reservations WHERE entry_id IN ('PG-PRE-COMMIT-1','PG-PRE-COMMIT-2') AND status='RELEASED'"), 2);

  const partialEntries = ['PG-PARTIAL-1', 'PG-PARTIAL-2'];
  await serviceA.reserveStake(playerOne, { amountCents: 200, entryId: partialEntries[0], tableId: 9 });
  await serviceA.reserveStake(playerTwo, { amountCents: 200, entryId: partialEntries[1], tableId: 9 });
  await repositoryA.query("UPDATE financial_match_reservations SET status='COMMITTED', match_id='PG-PARTIAL' WHERE entry_id=$1", [partialEntries[0]]);
  await serviceA.recoverFailedMatchStart(partialEntries, 'PG-PARTIAL', 'pg_partial_commit');
  assert.equal(await count(repositoryA, "SELECT count(*)::int AS total FROM financial_match_reservations WHERE entry_id IN ('PG-PARTIAL-1','PG-PARTIAL-2') AND status='RELEASED'"), 2);

  const partialCompEntries = ['PG-PARTIAL-COMP-1', 'PG-PARTIAL-COMP-2'];
  await serviceA.reserveStake(playerOne, { amountCents: 200, entryId: partialCompEntries[0], tableId: 9 });
  await serviceA.reserveStake(playerTwo, { amountCents: 200, entryId: partialCompEntries[1], tableId: 9 });
  await serviceA.releaseStake(partialCompEntries[0], 'pg_partial_release');
  await repositoryA.query("UPDATE financial_match_reservations SET status='COMMITTED', match_id='PG-PARTIAL-COMP' WHERE entry_id=$1", [partialCompEntries[1]]);
  await serviceA.recoverFailedMatchStart(partialCompEntries, 'PG-PARTIAL-COMP', 'pg_partial_compensation');
  assert.equal(await count(repositoryA, "SELECT count(*)::int AS total FROM financial_match_reservations WHERE entry_id IN ('PG-PARTIAL-COMP-1','PG-PARTIAL-COMP-2') AND status='RELEASED'"), 2);

  await prepareMatch('PG-MATCH-CONCURRENT', 'MATCH-CONCURRENT', playerOne, playerTwo);
  const settlementResults = await Promise.all([
    serviceA.settleMatch({ matchId: 'PG-MATCH-CONCURRENT', winnerPhone: playerOne, platformFeeCents: 100 }),
    serviceB.settleMatch({ matchId: 'PG-MATCH-CONCURRENT', winnerPhone: playerOne, platformFeeCents: 100 }),
  ]);
  assert.ok(settlementResults.every((item) => item.status === 'SETTLED'));
  assert.equal(await count(repositoryA, "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key='match:settle:PG-MATCH-CONCURRENT'"), 1);

  await prepareMatch('PG-MATCH-DURING', 'MATCH-DURING', playerOne, playerTwo, 300);
  await failAfterQuery(
    repositoryA,
    (text) => text.includes('reserved_balance_cents=reserved_balance_cents-$1::bigint'),
    'PG_CONTROLLED_DURING_SETTLEMENT',
    () => serviceA.settleMatch({ matchId: 'PG-MATCH-DURING', winnerPhone: playerOne, platformFeeCents: 50 }),
  );
  const duringReservations = await repositoryA.query("SELECT status FROM financial_match_reservations WHERE match_id='PG-MATCH-DURING'");
  assert.ok(duringReservations.rows.every((item) => item.status === 'COMMITTED'));
  await serviceA.settleMatch({ matchId: 'PG-MATCH-DURING', winnerPhone: playerOne, platformFeeCents: 50 });

  await prepareMatch('PG-MATCH-AFTER-RESPONSE', 'MATCH-AFTER-RESPONSE', playerOne, playerTwo, 300);
  const executeOriginal = serviceA.executeMatchOperation.bind(serviceA);
  let afterResponseFailure = true;
  serviceA.executeMatchOperation = async (matchId) => {
    const result = await executeOriginal(matchId);
    if (matchId === 'PG-MATCH-AFTER-RESPONSE' && afterResponseFailure) {
      afterResponseFailure = false;
      throw new Error('PG_CONTROLLED_AFTER_SETTLEMENT_COMMIT');
    }
    return result;
  };
  await assert.rejects(
    serviceA.settleMatch({ matchId: 'PG-MATCH-AFTER-RESPONSE', winnerPhone: playerOne, platformFeeCents: 50 }),
    /PG_CONTROLLED_AFTER_SETTLEMENT_COMMIT/,
  );
  serviceA.executeMatchOperation = executeOriginal;
  assert.equal((await serviceA.settleMatch({ matchId: 'PG-MATCH-AFTER-RESPONSE', winnerPhone: playerOne, platformFeeCents: 50 })).duplicate, true);
  assert.equal(await count(repositoryA, "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key='match:settle:PG-MATCH-AFTER-RESPONSE'"), 1);

  await prepareMatch('PG-MATCH-COMPENSATE', 'MATCH-COMPENSATE', playerOne, playerTwo, 400);
  const compensationResults = await Promise.all([
    serviceA.compensateMatch('PG-MATCH-COMPENSATE', 'pg_controlled_abort'),
    serviceB.compensateMatch('PG-MATCH-COMPENSATE', 'pg_controlled_abort'),
  ]);
  assert.ok(compensationResults.every((item) => item.status === 'COMPENSATED'));
  assert.equal(await count(repositoryA, "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key='match:compensate:PG-MATCH-COMPENSATE'"), 1);

  await prepareMatch('PG-MATCH-COMPENSATE-FAIL', 'MATCH-COMPENSATE-FAIL', playerOne, playerTwo, 300);
  await failAfterQuery(
    repositoryA,
    (text) => text.includes('reserved_balance_cents=reserved_balance_cents-$1::bigint'),
    'PG_CONTROLLED_DURING_COMPENSATION',
    () => serviceA.compensateMatch('PG-MATCH-COMPENSATE-FAIL', 'pg_controlled_abort'),
  );
  await serviceA.compensateMatch('PG-MATCH-COMPENSATE-FAIL', 'pg_controlled_abort');

  const refundPhone = '5511999902101';
  const refundable = await deposit(refundPhone, 800, 'refund-after-credit');
  provider.markRefunded(refundable.provider_payment_id);
  const refunded = await serviceA.processPaymentWebhook({
    headers: { 'asaas-access-token': webhookToken },
    payload: { id: 'pg-event-refund-after-credit-reversal', event: 'PAYMENT_REFUNDED', payment: { id: refundable.provider_payment_id } },
  });
  assert.equal(refunded.reversed, true);
  assert.equal((await serviceA.getAccount(refundPhone)).available_balance_cents, '0');
  const pendingRefund = await serviceA.createDeposit(refundPhone, 600, { idempotencyKey: 'pg-deposit-refund-before-credit' });
  provider.markRefunded(pendingRefund.provider_payment_id);
  const pendingClosed = await serviceA.processPaymentWebhook({
    headers: { 'asaas-access-token': webhookToken },
    payload: { id: 'pg-event-refund-before-credit', event: 'PAYMENT_REFUNDED', payment: { id: pendingRefund.provider_payment_id } },
  });
  assert.equal(pendingClosed.reversed, true);
  assert.equal(pendingClosed.creditedBalanceAffected, false);

  const releaseReservation = await serviceA.reserveStake(playerOne, { amountCents: 300, entryId: 'PG-RELEASE-RETRY', tableId: 8 });
  const originalReleaseStake = serviceA.releaseStake.bind(serviceA);
  let releaseFailure = true;
  serviceA.releaseStake = async (...args) => {
    if (releaseFailure) { releaseFailure = false; throw new Error('PG_CONTROLLED_RELEASE_FAILURE'); }
    return originalReleaseStake(...args);
  };
  await assert.rejects(serviceA.releaseStakeWithRecovery(releaseReservation.entry_id, 'pg_retry'), /PG_CONTROLLED_RELEASE_FAILURE/);
  serviceA.releaseStake = originalReleaseStake;
  assert.equal((await repositoryA.query("SELECT status FROM financial_recovery_tasks WHERE task_key='stake-release:PG-RELEASE-RETRY'")).rows[0].status, 'RETRY_REQUIRED');

  const withdrawalPhone = '5511999903001';
  await deposit(withdrawalPhone, 6_000, 'withdrawal');
  await failAfterQuery(
    repositoryA,
    (text) => text.includes('withdrawal_pending_balance_cents=withdrawal_pending_balance_cents+$1::bigint'),
    'PG_CONTROLLED_WITHDRAWAL_FAILURE',
    () => serviceA.requestWithdrawal(withdrawalPhone, { amountCents: 500, pixKeyType: 'EVP', pixKey: '00000000-1111-4222-8333-444444444444', holderName: 'Test Holder', idempotencyKey: 'pg-withdrawal-failure' }),
  );
  assert.equal(await count(repositoryA, "SELECT count(*)::int AS total FROM financial_withdrawals WHERE idempotency_key='pg-withdrawal-failure'"), 0);
  const recoveredWithdrawal = await serviceA.requestWithdrawal(withdrawalPhone, { amountCents: 500, pixKeyType: 'EVP', pixKey: '00000000-1111-4222-8333-444444444444', holderName: 'Test Holder', idempotencyKey: 'pg-withdrawal-failure' });
  await serviceA.rejectWithdrawal('5511999990001', recoveredWithdrawal.public_reference, 'pg_recovered_after_failure');
  const withdrawalResults = await Promise.all([
    serviceA.requestWithdrawal(withdrawalPhone, { amountCents: 1_000, pixKeyType: 'EMAIL', pixKey: 'pg-secret@example.test', holderName: 'Test Holder', idempotencyKey: 'pg-withdrawal-concurrent' }),
    serviceB.requestWithdrawal(withdrawalPhone, { amountCents: 1_000, pixKeyType: 'EMAIL', pixKey: 'pg-secret@example.test', holderName: 'Test Holder', idempotencyKey: 'pg-withdrawal-concurrent' }),
  ]);
  assert.equal(await count(repositoryA, "SELECT count(*)::int AS total FROM financial_withdrawals WHERE idempotency_key='pg-withdrawal-concurrent'"), 1);
  assert.equal(withdrawalResults.filter((item) => item.duplicate).length, 1);
  const rawWithdrawal = (await repositoryA.query("SELECT * FROM financial_withdrawals WHERE idempotency_key='pg-withdrawal-concurrent'")).rows[0];
  assert.ok(!rawWithdrawal.pix_key_ciphertext.includes('pg-secret@example.test'));
  assert.ok(!JSON.stringify(rawWithdrawal).includes('pg-secret@example.test'));
  await assert.rejects(serviceA.getWithdrawalDetails('5511999903999', rawWithdrawal.public_reference), /FINANCIAL_ADMIN_UNAUTHORIZED/);
  const revealed = await serviceA.getWithdrawalDetails('5511999990001', rawWithdrawal.public_reference);
  assert.equal(revealed.pix_key, 'pg-secret@example.test');
  assert.equal(await count(repositoryA, "SELECT count(*)::int AS total FROM financial_admin_audit WHERE action='WITHDRAWAL_PIX_DETAILS_ACCESSED' AND target_reference=$1", [rawWithdrawal.public_reference]), 1);
  for (const [type, key] of [['CPF', '11122233344'], ['CNPJ', '11222333000181'], ['PHONE', '+5511999998888']]) {
    const protectedWithdrawal = await serviceA.requestWithdrawal(withdrawalPhone, {
      amountCents: 100, pixKeyType: type, pixKey: key, holderName: 'Test Holder', idempotencyKey: `pg-protected-${type.toLowerCase()}`,
    });
    const protectedRaw = (await repositoryA.query('SELECT * FROM financial_withdrawals WHERE public_reference=$1', [protectedWithdrawal.public_reference])).rows[0];
    assert.ok(!JSON.stringify(protectedRaw).includes(key));
    await serviceA.rejectWithdrawal('5511999990001', protectedWithdrawal.public_reference, 'pg_security_fixture_cleanup');
  }

  await prepareMatch('PG-MATCH-RESTART', 'MATCH-RESTART', playerOne, playerTwo);
  const faultingService = new FinancialWalletService({
    repository: repositoryA, provider, config,
    faultInjector: (stage, context) => {
      if (stage === 'before_match_financial_mutation' && context.matchId === 'PG-MATCH-RESTART') throw new Error('PG_CONTROLLED_SETTLEMENT_FAILURE');
    },
  });
  await assert.rejects(
    faultingService.settleMatch({ matchId: 'PG-MATCH-RESTART', winnerPhone: playerOne, platformFeeCents: 100 }),
    /PG_CONTROLLED_SETTLEMENT_FAILURE/,
  );
  assert.equal((await repositoryA.query("SELECT status FROM financial_match_settlements WHERE match_id='PG-MATCH-RESTART'")).rows[0].status, 'RETRY_REQUIRED');

  await repositoryA.close();
  await repositoryB.close();
  repositories.length = 0;
  const restartedRepository = new PostgresFinancialRepository({ connectionString, maxSerializableRetries: 4 });
  repositories.push(restartedRepository);
  const restartedService = new FinancialWalletService({ repository: restartedRepository, provider, config });
  await restartedService.initialize();
  const recovered = (await restartedRepository.query("SELECT * FROM financial_match_settlements WHERE match_id='PG-MATCH-RESTART'")).rows[0];
  assert.equal(recovered.status, 'SETTLED');
  assert.equal(await count(restartedRepository, "SELECT count(*)::int AS total FROM financial_transactions WHERE idempotency_key='match:settle:PG-MATCH-RESTART'"), 1);
  assert.equal((await restartedService.settleMatch({ matchId: 'PG-MATCH-RESTART', winnerPhone: playerOne, platformFeeCents: 100 })).duplicate, true);

  const recoveredRelease = (await restartedRepository.query("SELECT status FROM financial_match_reservations WHERE entry_id='PG-RELEASE-RETRY'")).rows[0];
  assert.equal(recoveredRelease.status, 'RELEASED');
  assert.equal((await restartedRepository.query("SELECT status FROM financial_recovery_tasks WHERE task_key='stake-release:PG-RELEASE-RETRY'")).rows[0].status, 'COMPLETED');

  const totals = await restartedRepository.query(`SELECT transaction_id, sum(amount_cents)::bigint AS balance
    FROM financial_ledger_entries GROUP BY transaction_id HAVING sum(amount_cents) <> 0`);
  assert.equal(totals.rowCount, 0);
  const reconciliation = await restartedService.reconcile('5511999990001');
  assert.equal(reconciliation.status, 'MATCHED');

  const rejectedWithdrawal = await restartedService.rejectWithdrawal('5511999990001', rawWithdrawal.public_reference, 'pg_controlled_rejection');
  assert.equal(rejectedWithdrawal.status, 'REJECTED');
  assert.equal((await restartedService.reconcile('5511999990001')).status, 'MATCHED');

  const paidWithdrawal = await restartedService.requestWithdrawal(withdrawalPhone, {
    amountCents: 1_000, pixKeyType: 'EVP', pixKey: '11111111-2222-4333-8444-555555555555',
    holderName: 'Test Holder', idempotencyKey: 'pg-withdrawal-paid',
  });
  await restartedService.markWithdrawalPaid('5511999990001', paidWithdrawal.public_reference, 'PG-TRANSFER-1');
  const paidRaw = (await restartedRepository.query("SELECT * FROM financial_withdrawals WHERE idempotency_key='pg-withdrawal-paid'")).rows[0];
  assert.ok(!JSON.stringify(paidRaw).includes('11111111-2222-4333-8444-555555555555'));
  assert.equal((await restartedService.reconcile('5511999990001')).status, 'MISMATCH');

  const unknownFeeOrder = await restartedService.createDeposit(withdrawalPhone, 1_000, { idempotencyKey: 'pg-deposit-unknown-fee' });
  const unknownFeePayment = provider.payments.get(unknownFeeOrder.provider_payment_id);
  delete unknownFeePayment.feeAmountCents;
  delete unknownFeePayment.netAmountCents;
  provider.markPaid(unknownFeeOrder.provider_payment_id);
  await restartedService.processPaymentWebhook({
    headers: { 'asaas-access-token': webhookToken },
    payload: { id: 'pg-event-unknown-fee', event: 'PAYMENT_RECEIVED', payment: { id: unknownFeeOrder.provider_payment_id } },
  });
  assert.equal((await restartedService.reconcile('5511999990001')).status, 'REVIEW_REQUIRED');
  const finalTotals = await restartedRepository.query(`SELECT transaction_id FROM financial_ledger_entries
    GROUP BY transaction_id HAVING sum(amount_cents) <> 0`);
  assert.equal(finalTotals.rowCount, 0);

  console.log(`PASS PostgreSQL real ${version}: migration, constraints, triggers, SERIALIZABLE retries, concurrency, recovery, reconciliation, restart, ledger and Pix protection`);
} finally {
  await Promise.all(repositories.map((repository) => repository.close().catch(() => {})));
}
