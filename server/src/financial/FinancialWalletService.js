import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizePhone } from '../payments/PaymentService.js';

const GAME_CODES = new Set(['PIFE_DUELO', 'BOMBERMAN_FUTURE']);
const SANDBOX_NOTICE = '🧪 Ambiente de demonstração — nenhum dinheiro real está sendo movimentado.';

function cents(value, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error('FINANCIAL_INVALID_AMOUNT');
  return parsed;
}

function databaseInteger(value) {
  let parsed;
  try {
    parsed = typeof value === 'bigint' ? value : BigInt(String(value));
  } catch {
    throw new Error('FINANCIAL_DATABASE_AMOUNT_INVALID');
  }
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('FINANCIAL_DATABASE_AMOUNT_OUT_OF_RANGE');
  }
  return Number(parsed);
}

function safeText(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function publicReference(prefix) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return `${prefix}-${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join('')}`;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

async function insertLedger(client, { type, status = 'CONFIRMED', idempotencyKey, publicRef, gameCode = null, metadata = {}, entries }) {
  if (!entries.length || entries.reduce((sum, entry) => sum + BigInt(entry.amountCents), 0n) !== 0n) {
    throw new Error('FINANCIAL_LEDGER_UNBALANCED');
  }
  const transactionId = randomUUID();
  await client.query(
    `INSERT INTO financial_transactions
      (transaction_id, public_reference, transaction_type, status, idempotency_key, game_code, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [transactionId, publicRef, type, status, idempotencyKey, gameCode, json(metadata)],
  );
  for (const entry of entries) {
    await client.query(
      `INSERT INTO financial_ledger_entries
        (entry_id, transaction_id, account_id, ledger_account, amount_cents)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), transactionId, entry.accountId ?? null, entry.ledgerAccount, entry.amountCents],
    );
  }
  return transactionId;
}

function encryptSensitive(value, secret) {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptSensitive(value, secret) {
  const packed = Buffer.from(String(value), 'base64');
  const key = createHash('sha256').update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
}

function maskedAdmin(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 4 ? `***${digits.slice(-4)}` : '***';
}

function assertAccountActive(account) {
  if (!account || account.status !== 'ACTIVE') throw new Error('FINANCIAL_ACCOUNT_BLOCKED');
  return account;
}

async function insertSystemAudit(client, { action, targetReference = null, reason = null, previousState = null, nextState = null, amountCents = null } = {}) {
  await client.query(
    `INSERT INTO financial_admin_audit
      (audit_id, admin_phone_masked, action, target_reference, reason, previous_state, next_state, amount_cents)
     VALUES ($1,'SYSTEM',$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
    [randomUUID(), action, targetReference, safeText(reason, 240) || null, json(previousState), json(nextState), amountCents],
  );
}

export class FinancialWalletService {
  constructor({ repository, provider, config, logInfo = () => {}, logWarn = () => {}, logError = () => {}, faultInjector = null } = {}) {
    if (!repository) throw new Error('FINANCIAL_REPOSITORY_REQUIRED');
    if (!provider) throw new Error('PAYMENT_PROVIDER_REQUIRED');
    this.repository = repository;
    this.provider = provider;
    this.config = config;
    this.logInfo = logInfo;
    this.logWarn = logWarn;
    this.logError = logError;
    this.faultInjector = typeof faultInjector === 'function' ? faultInjector : () => {};
    this.matchOperationLocks = new Map();
  }

  isEnabled() { return Boolean(this.config?.ready); }
  isSandbox() { return this.config?.mode === 'sandbox'; }
  notice() { return this.isSandbox() ? SANDBOX_NOTICE : ''; }
  assertEnabled() { if (!this.isEnabled()) throw new Error('FINANCIAL_WALLET_DISABLED'); }

  async initialize() {
    this.assertEnabled();
    await this.repository.initialize();
    try {
      await this.retryPendingFinancialOperations();
    } catch (error) {
      this.logError('FINANCIAL_RECOVERY_STARTUP_FAILED', { reason: error.message });
    }
    return true;
  }

  async retryPendingFinancialOperations({ limit = 100 } = {}) {
    this.assertEnabled();
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 100));
    const settlements = (await this.repository.query(
      `SELECT match_id FROM financial_match_settlements
       WHERE status IN ('PENDING','PROCESSING','RETRY_REQUIRED') ORDER BY updated_at ASC LIMIT $1`, [safeLimit],
    )).rows;
    const recoveryTasks = (await this.repository.query(
      `SELECT * FROM financial_recovery_tasks
       WHERE status IN ('PENDING','RETRY_REQUIRED') AND (next_attempt_at IS NULL OR next_attempt_at<=now())
       ORDER BY created_at ASC LIMIT $1`, [safeLimit],
    )).rows;
    const results = [];
    for (const settlement of settlements) {
      try {
        results.push({ type: 'MATCH_OPERATION', matchId: settlement.match_id, result: await this.executeMatchOperation(settlement.match_id) });
      } catch (error) {
        results.push({ type: 'MATCH_OPERATION', matchId: settlement.match_id, error: error.message });
      }
    }
    for (const task of recoveryTasks) {
      try {
        const payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : (task.payload ?? {});
        const result = task.task_type === 'STAKE_RELEASE'
          ? await this.releaseStakeWithRecovery(task.entry_id, payload.reason)
          : await this.recoverFailedMatchStart(payload.entryIds, task.match_id, payload.reason);
        results.push({ type: task.task_type, taskKey: task.task_key, result });
      } catch (error) {
        results.push({ type: task.task_type, taskKey: task.task_key, error: error.message });
      }
    }
    return results;
  }

  async getOrCreateAccount(phone, { displayName = 'Jogador' } = {}) {
    this.assertEnabled();
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) throw new Error('FINANCIAL_INVALID_PLAYER');
    return this.repository.transaction(async (client) => {
      const existing = await client.query('SELECT * FROM financial_accounts WHERE phone_normalized=$1 FOR UPDATE', [normalizedPhone]);
      if (existing.rows[0]) return existing.rows[0];
      const account = {
        accountId: randomUUID(),
        publicId: publicReference('PD'),
        displayName: safeText(displayName, 80) || 'Jogador',
      };
      const created = await client.query(
        `INSERT INTO financial_accounts (account_id, public_id, phone_normalized, display_name)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [account.accountId, account.publicId, normalizedPhone, account.displayName],
      );
      this.logInfo('FINANCIAL_ACCOUNT_CREATED', { publicId: account.publicId });
      return created.rows[0];
    });
  }

  async getAccount(phone) {
    this.assertEnabled();
    const normalizedPhone = normalizePhone(phone);
    const result = await this.repository.query('SELECT * FROM financial_accounts WHERE phone_normalized=$1', [normalizedPhone]);
    return result.rows[0] ?? null;
  }

  async createDeposit(phone, amountCents, { displayName = 'Jogador', idempotencyKey } = {}) {
    this.assertEnabled();
    if (!this.config.pixDepositsEnabled) throw new Error('PIX_DEPOSITS_DISABLED');
    const amount = cents(amountCents);
    const idem = safeText(idempotencyKey, 180);
    if (!idem) throw new Error('FINANCIAL_IDEMPOTENCY_KEY_REQUIRED');
    const account = assertAccountActive(await this.getOrCreateAccount(phone, { displayName }));
    const existing = await this.repository.query(
      `SELECT d.* FROM financial_deposits d
       JOIN financial_transactions t ON t.public_reference=d.public_reference
       WHERE t.idempotency_key=$1 AND d.account_id=$2`, [idem, account.account_id],
    );
    let deposit = existing.rows[0] ?? null;
    const duplicate = Boolean(deposit);
    if (deposit && databaseInteger(deposit.amount_cents) !== amount) throw new Error('FINANCIAL_IDEMPOTENCY_CONFLICT');
    if (!deposit) {
      const depositId = randomUUID();
      const publicRef = publicReference('DEP');
      await this.repository.transaction(async (client) => {
        await insertLedger(client, {
          type: 'DEPOSIT_ORDER_CREATED', status: 'PENDING', idempotencyKey: idem, publicRef,
          metadata: { depositId, amountCents: amount },
          entries: [
            { accountId: account.account_id, ledgerAccount: 'DEPOSIT_PENDING', amountCents: amount },
            { ledgerAccount: 'PROVIDER_EXPECTED', amountCents: -amount },
          ],
        });
        await client.query(
          `INSERT INTO financial_deposits
            (deposit_id, public_reference, account_id, amount_cents, status, provider)
           VALUES ($1,$2,$3,$4,'CREATED',$5)`,
          [depositId, publicRef, account.account_id, amount, this.config.provider],
        );
      });
      deposit = { deposit_id: depositId, public_reference: publicRef, amount_cents: amount, status: 'CREATED' };
    }
    if (deposit.provider_payment_id && ['PENDING', 'CREDITED'].includes(deposit.status)) return { ...deposit, duplicate: true };
    if (['REFUNDED', 'REVERSED'].includes(deposit.status)) throw new Error('FINANCIAL_DEPOSIT_CLOSED');
    let stage = 'PROVIDER_CUSTOMER';
    try {
      this.logInfo('PIX_DEPOSIT_STAGE', { stage: 'PLAYER_RESOLVED', publicReference: deposit.public_reference });
      this.logInfo('PIX_DEPOSIT_STAGE', { stage });
      const customer = await this.provider.createOrFindCustomer({
        publicId: account.public_id,
        name: account.display_name,
        phone: account.phone_normalized,
        existingCustomerId: account.provider_customer_id,
      });
      const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      stage = 'PROVIDER_CHARGE';
      this.logInfo('PIX_DEPOSIT_STAGE', { stage });
      const charge = await this.provider.createPixCharge({
        customerId: customer.id,
        amountCents: amount,
        dueDate,
        description: `Saldo Pife Duelo ${deposit.public_reference}`,
        externalReference: deposit.public_reference,
      });
      stage = 'PROVIDER_QR';
      this.logInfo('PIX_DEPOSIT_STAGE', { stage });
      const qr = await this.provider.getPixQrCode(charge.id);
      if (!charge?.id || !customer?.id || !qr?.payload) throw new Error('FINANCIAL_PROVIDER_RESPONSE_INVALID');
      stage = 'DEPOSIT_PERSISTENCE';
      const updated = await this.repository.query(
        `UPDATE financial_deposits SET status='PENDING', provider_payment_id=$1,
          provider_customer_id=$2, pix_copy_paste=$3, pix_qr_code=$4, expires_at=$5, updated_at=now()
         WHERE deposit_id=$6 RETURNING *`,
        [charge.id, customer.id, qr.payload ?? null, qr.encodedImage ?? null, qr.expirationDate ?? null, deposit.deposit_id],
      );
      await this.repository.query(
        'UPDATE financial_accounts SET provider_customer_id=$1, updated_at=now() WHERE account_id=$2 AND provider_customer_id IS NULL',
        [customer.id, account.account_id],
      );
      this.logInfo('DEPOSIT_CREATED', { publicReference: deposit.public_reference, amountCents: amount, provider: this.config.provider, recovered: duplicate });
      return { ...updated.rows[0], duplicate };
    } catch (error) {
      await this.repository.query("UPDATE financial_deposits SET status='REVIEW_REQUIRED', updated_at=now() WHERE deposit_id=$1", [deposit.deposit_id]);
      this.logError('DEPOSIT_CREATE_FAILED', { publicReference: deposit.public_reference, stage, errorCode: 'DEPOSIT_CREATE_FAILED' });
      throw error;
    }
  }

  async processPaymentWebhook({ headers, payload }) {
    this.assertEnabled();
    if (!this.provider.validateWebhook({ headers, payload })) throw new Error('FINANCIAL_WEBHOOK_UNAUTHORIZED');
    const eventId = safeText(payload?.id, 120);
    const eventType = safeText(payload?.event, 80);
    const paymentId = safeText(payload?.payment?.id, 100);
    if (!eventId || !eventType || !paymentId) throw new Error('FINANCIAL_WEBHOOK_INVALID');
    const remotePayment = await this.provider.getPayment(paymentId);
    const payloadHash = createHash('sha256').update(json(payload)).digest('hex');
    return this.repository.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO financial_processed_webhooks
          (webhook_event_id, provider, event_type, payload_hash, status)
         VALUES ($1,$2,$3,$4,'RECEIVED') ON CONFLICT DO NOTHING RETURNING webhook_event_id`,
        [eventId, this.config.provider, eventType, payloadHash],
      );
      if (!inserted.rows[0]) {
        this.logInfo('DEPOSIT_DUPLICATE_IGNORED', { webhookEventId: eventId });
        return { duplicate: true };
      }
      const depositResult = await client.query('SELECT * FROM financial_deposits WHERE provider_payment_id=$1 FOR UPDATE', [paymentId]);
      const deposit = depositResult.rows[0];
      if (!deposit) throw new Error('FINANCIAL_DEPOSIT_NOT_FOUND');
      const reversalEvent = ['PAYMENT_REFUNDED', 'PAYMENT_REVERSED'].includes(eventType);
      const reversalStatus = ['REFUNDED', 'REVERSED'].includes(String(remotePayment.status || '').toUpperCase());
      if (reversalEvent && reversalStatus) {
        if (['REFUNDED', 'REVERSED'].includes(deposit.status)) {
          await client.query("UPDATE financial_processed_webhooks SET status='DUPLICATE', processed_at=now() WHERE webhook_event_id=$1", [eventId]);
          return { duplicate: true, deposit };
        }
        if (deposit.status !== 'CREDITED') {
          const pendingAmount = cents(deposit.amount_cents);
          await insertLedger(client, {
            type: 'DEPOSIT_PENDING_CLOSED', idempotencyKey: `deposit:close:${deposit.deposit_id}`,
            publicRef: publicReference('TX'), metadata: { depositId: deposit.deposit_id, eventType }, entries: [
              { accountId: deposit.account_id, ledgerAccount: 'DEPOSIT_PENDING', amountCents: -pendingAmount },
              { ledgerAccount: 'PROVIDER_EXPECTED', amountCents: pendingAmount },
            ],
          });
          await client.query(
            "UPDATE financial_deposits SET status=$1, updated_at=now() WHERE deposit_id=$2",
            [eventType === 'PAYMENT_REFUNDED' ? 'REFUNDED' : 'REVERSED', deposit.deposit_id],
          );
          await client.query("UPDATE financial_processed_webhooks SET status='PROCESSED', processed_at=now() WHERE webhook_event_id=$1", [eventId]);
          return { reversed: true, creditedBalanceAffected: false };
        }
        const account = (await client.query('SELECT * FROM financial_accounts WHERE account_id=$1 FOR UPDATE', [deposit.account_id])).rows[0];
        if (account?.status !== 'ACTIVE') {
          await client.query("UPDATE financial_deposits SET status='REVIEW_REQUIRED', updated_at=now() WHERE deposit_id=$1", [deposit.deposit_id]);
          await client.query("UPDATE financial_processed_webhooks SET status='REVIEW_REQUIRED', processed_at=now() WHERE webhook_event_id=$1", [eventId]);
          await insertSystemAudit(client, {
            action: 'DEPOSIT_REVERSAL_BLOCKED_ACCOUNT_REVIEW', targetReference: deposit.public_reference,
            reason: 'FINANCIAL_ACCOUNT_BLOCKED', previousState: { accountStatus: account?.status }, nextState: { status: 'REVIEW_REQUIRED' },
            amountCents: deposit.credited_amount_cents || deposit.amount_cents,
          });
          return { reviewRequired: true, reason: 'FINANCIAL_ACCOUNT_BLOCKED' };
        }
        const amount = databaseInteger(deposit.credited_amount_cents || deposit.amount_cents);
        if (databaseInteger(account.available_balance_cents) < amount) {
          await client.query("UPDATE financial_deposits SET status='REVIEW_REQUIRED', updated_at=now() WHERE deposit_id=$1", [deposit.deposit_id]);
          await client.query("UPDATE financial_processed_webhooks SET status='REVIEW_REQUIRED', processed_at=now() WHERE webhook_event_id=$1", [eventId]);
          this.logWarn('DEPOSIT_REVERSAL_REVIEW_REQUIRED', { publicReference: deposit.public_reference, amountCents: amount });
          return { reviewRequired: true };
        }
        await client.query(
          'UPDATE financial_accounts SET available_balance_cents=available_balance_cents-$1::bigint, updated_at=now() WHERE account_id=$2',
          [amount, account.account_id],
        );
        await insertLedger(client, {
          type: eventType === 'PAYMENT_REFUNDED' ? 'DEPOSIT_REFUNDED' : 'DEPOSIT_REVERSED',
          idempotencyKey: `deposit:reverse:${deposit.deposit_id}`, publicRef: publicReference('TX'),
          metadata: { depositId: deposit.deposit_id, providerPaymentId: paymentId, eventType }, entries: [
            { accountId: account.account_id, ledgerAccount: 'PLAYER_AVAILABLE', amountCents: -amount },
            { ledgerAccount: 'PROVIDER_CLEARING', amountCents: amount },
          ],
        });
        await client.query(
          "UPDATE financial_deposits SET status=$1, updated_at=now() WHERE deposit_id=$2",
          [eventType === 'PAYMENT_REFUNDED' ? 'REFUNDED' : 'REVERSED', deposit.deposit_id],
        );
        await client.query("UPDATE financial_processed_webhooks SET status='PROCESSED', processed_at=now() WHERE webhook_event_id=$1", [eventId]);
        return { reversed: true, creditedBalanceAffected: true, amountCents: amount };
      }
      const paidEvent = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(eventType);
      const paidStatus = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(String(remotePayment.status || '').toUpperCase());
      if (!paidEvent || !paidStatus) {
        await client.query("UPDATE financial_processed_webhooks SET status='IGNORED', processed_at=now() WHERE webhook_event_id=$1", [eventId]);
        return { ignored: true, eventType };
      }
      if (deposit.status === 'CREDITED') {
        await client.query("UPDATE financial_processed_webhooks SET status='DUPLICATE', processed_at=now() WHERE webhook_event_id=$1", [eventId]);
        this.logInfo('DEPOSIT_DUPLICATE_IGNORED', { webhookEventId: eventId, publicReference: deposit.public_reference });
        return { duplicate: true, deposit };
      }
      const remoteAmount = cents(remotePayment.amountCents ?? Math.round(Number(remotePayment.value || 0) * 100));
      if (remoteAmount !== databaseInteger(deposit.amount_cents)) throw new Error('FINANCIAL_DEPOSIT_AMOUNT_MISMATCH');
      const accountResult = await client.query('SELECT * FROM financial_accounts WHERE account_id=$1 FOR UPDATE', [deposit.account_id]);
      const account = accountResult.rows[0];
      if (account?.status !== 'ACTIVE') {
        await client.query("UPDATE financial_deposits SET status='REVIEW_REQUIRED', updated_at=now() WHERE deposit_id=$1", [deposit.deposit_id]);
        await client.query("UPDATE financial_processed_webhooks SET status='REVIEW_REQUIRED', processed_at=now() WHERE webhook_event_id=$1", [eventId]);
        await insertSystemAudit(client, {
          action: 'DEPOSIT_CREDIT_BLOCKED_ACCOUNT_REVIEW', targetReference: deposit.public_reference,
          reason: 'FINANCIAL_ACCOUNT_BLOCKED', previousState: { accountStatus: account?.status }, nextState: { status: 'REVIEW_REQUIRED' },
          amountCents: deposit.amount_cents,
        });
        return { reviewRequired: true, reason: 'FINANCIAL_ACCOUNT_BLOCKED' };
      }
      const providerFeeSupplied = remotePayment.feeAmountCents !== undefined && remotePayment.feeAmountCents !== null;
      const providerNetSupplied = remotePayment.netAmountCents !== undefined && remotePayment.netAmountCents !== null;
      const feeKnown = providerFeeSupplied || providerNetSupplied;
      const suppliedFee = providerFeeSupplied ? cents(remotePayment.feeAmountCents, { allowZero: true }) : null;
      const suppliedNet = providerNetSupplied ? cents(remotePayment.netAmountCents, { allowZero: true }) : null;
      const feeAmount = feeKnown ? (suppliedFee ?? remoteAmount - suppliedNet) : null;
      const netAmount = feeKnown ? (suppliedNet ?? remoteAmount - suppliedFee) : null;
      if (feeKnown && (feeAmount < 0 || netAmount < 0 || feeAmount + netAmount !== remoteAmount)) throw new Error('FINANCIAL_PROVIDER_FEE_MISMATCH');
      const providerClearing = feeKnown ? netAmount : remoteAmount;
      const transactionId = await insertLedger(client, {
        type: 'DEPOSIT_CREDITED', idempotencyKey: `deposit:credit:${deposit.deposit_id}`,
        publicRef: publicReference('TX'), metadata: {
          depositId: deposit.deposit_id, providerPaymentId: paymentId, feeKnown, feeAmountCents: feeAmount, netAmountCents: netAmount,
        },
        entries: [
          { accountId: account.account_id, ledgerAccount: 'DEPOSIT_PENDING', amountCents: -remoteAmount },
          { ledgerAccount: 'PROVIDER_EXPECTED', amountCents: remoteAmount },
          { ledgerAccount: 'PROVIDER_CLEARING', amountCents: -providerClearing },
          ...(feeKnown && feeAmount > 0 ? [{ ledgerAccount: 'PROVIDER_FEE', amountCents: -feeAmount }] : []),
          { accountId: account.account_id, ledgerAccount: 'PLAYER_AVAILABLE', amountCents: remoteAmount },
        ],
      });
      await client.query(
        `UPDATE financial_accounts SET available_balance_cents=available_balance_cents+$1::bigint, updated_at=now()
         WHERE account_id=$2`, [remoteAmount, account.account_id],
      );
      await client.query(
        `UPDATE financial_deposits SET status='CREDITED', gross_amount_cents=$1, fee_amount_cents=$2,
          net_amount_cents=$3, credited_amount_cents=$1, credited_transaction_id=$4, updated_at=now()
         WHERE deposit_id=$5`, [remoteAmount, feeAmount, netAmount, transactionId, deposit.deposit_id],
      );
      await client.query("UPDATE financial_processed_webhooks SET status='PROCESSED', processed_at=now() WHERE webhook_event_id=$1", [eventId]);
      this.logInfo('DEPOSIT_CREDITED', { publicReference: deposit.public_reference, amountCents: remoteAmount });
      const previousBalanceCents = databaseInteger(account.available_balance_cents);
      return { credited: true, accountId: account.account_id, amountCents: remoteAmount, previousBalanceCents, newBalanceCents: previousBalanceCents + remoteAmount };
    });
  }

  async reserveStake(phone, { amountCents, entryId, tableId, gameCode = 'PIFE_DUELO' } = {}) {
    this.assertEnabled();
    if (!this.config.realMoneyGamesEnabled) throw new Error('REAL_MONEY_GAMES_DISABLED');
    if (!GAME_CODES.has(gameCode) || gameCode !== 'PIFE_DUELO') throw new Error('FINANCIAL_GAME_NOT_ACTIVE');
    const amount = cents(amountCents);
    const account = await this.getAccount(phone);
    if (!account) throw new Error('FINANCIAL_ACCOUNT_NOT_FOUND');
    assertAccountActive(account);
    return this.repository.transaction(async (client) => {
      const duplicate = await client.query('SELECT * FROM financial_match_reservations WHERE entry_id=$1', [safeText(entryId, 100)]);
      if (duplicate.rows[0]) return { ...duplicate.rows[0], duplicate: true };
      const locked = assertAccountActive((await client.query('SELECT * FROM financial_accounts WHERE account_id=$1 FOR UPDATE', [account.account_id])).rows[0]);
      if (databaseInteger(locked.available_balance_cents) < amount) throw new Error('FINANCIAL_INSUFFICIENT_BALANCE');
      const reservationId = randomUUID();
      const publicRef = publicReference('RES');
      await client.query(
        `UPDATE financial_accounts SET available_balance_cents=available_balance_cents-$1::bigint,
          reserved_balance_cents=reserved_balance_cents+$1::bigint, updated_at=now() WHERE account_id=$2`,
        [amount, account.account_id],
      );
      await insertLedger(client, {
        type: 'STAKE_RESERVED', idempotencyKey: `stake:reserve:${entryId}`, publicRef,
        gameCode, metadata: { entryId, tableId }, entries: [
          { accountId: account.account_id, ledgerAccount: 'PLAYER_AVAILABLE', amountCents: -amount },
          { accountId: account.account_id, ledgerAccount: 'PLAYER_RESERVED', amountCents: amount },
        ],
      });
      const reservation = await client.query(
        `INSERT INTO financial_match_reservations
          (reservation_id, public_reference, account_id, game_code, entry_id, table_id, amount_cents, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'RESERVED') RETURNING *`,
        [reservationId, publicRef, account.account_id, gameCode, entryId, String(tableId), amount],
      );
      this.logInfo('STAKE_RESERVED', { publicReference: publicRef, amountCents: amount, gameCode });
      return reservation.rows[0];
    });
  }

  async releaseStake(entryId, reason = 'pre_start_cancelled') {
    this.assertEnabled();
    return this.repository.transaction(async (client) => {
      const reservation = (await client.query('SELECT * FROM financial_match_reservations WHERE entry_id=$1 FOR UPDATE', [entryId])).rows[0];
      if (!reservation) return { released: false, reason: 'NOT_FOUND' };
      if (reservation.status === 'RELEASED') return { released: false, duplicate: true };
      if (reservation.status !== 'RESERVED') return { released: false, reason: 'NOT_RELEASEABLE' };
      const amount = databaseInteger(reservation.amount_cents);
      await client.query(
        `UPDATE financial_accounts SET available_balance_cents=available_balance_cents+$1::bigint,
          reserved_balance_cents=reserved_balance_cents-$1::bigint, updated_at=now() WHERE account_id=$2`,
        [amount, reservation.account_id],
      );
      await insertLedger(client, {
        type: 'STAKE_RELEASED', idempotencyKey: `stake:release:${entryId}`, publicRef: publicReference('TX'),
        gameCode: reservation.game_code, metadata: { entryId, reason }, entries: [
          { accountId: reservation.account_id, ledgerAccount: 'PLAYER_RESERVED', amountCents: -amount },
          { accountId: reservation.account_id, ledgerAccount: 'PLAYER_AVAILABLE', amountCents: amount },
        ],
      });
      await client.query("UPDATE financial_match_reservations SET status='RELEASED', updated_at=now() WHERE reservation_id=$1", [reservation.reservation_id]);
      this.logInfo('STAKE_RELEASED', { publicReference: reservation.public_reference, reason });
      return { released: true, reservation };
    });
  }

  async upsertRecoveryTask({ taskKey, taskType, matchId = null, entryId = null, payload = {}, status = 'PENDING', error = null }) {
    const result = await this.repository.query(
      `INSERT INTO financial_recovery_tasks
        (task_id, task_key, task_type, status, match_id, entry_id, payload, attempt_count, last_error, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,1,$8,now())
       ON CONFLICT (task_key) DO UPDATE SET status=EXCLUDED.status, payload=EXCLUDED.payload,
         attempt_count=financial_recovery_tasks.attempt_count+1, last_error=EXCLUDED.last_error,
         next_attempt_at=CASE WHEN EXCLUDED.status='COMPLETED' THEN NULL ELSE now() END,
         completed_at=CASE WHEN EXCLUDED.status='COMPLETED' THEN now() ELSE financial_recovery_tasks.completed_at END,
         updated_at=now()
       RETURNING *`,
      [randomUUID(), safeText(taskKey, 220), taskType, status, matchId, entryId, json(payload), error ? safeText(error, 240) : null],
    );
    return result.rows[0];
  }

  async releaseStakeWithRecovery(entryId, reason = 'pre_start_cancelled') {
    const safeEntryId = safeText(entryId, 100);
    const taskKey = `stake-release:${safeEntryId}`;
    try {
      const result = await this.releaseStake(safeEntryId, reason);
      await this.upsertRecoveryTask({ taskKey, taskType: 'STAKE_RELEASE', entryId: safeEntryId, payload: { reason }, status: 'COMPLETED' });
      return result;
    } catch (error) {
      await this.upsertRecoveryTask({
        taskKey, taskType: 'STAKE_RELEASE', entryId: safeEntryId, payload: { reason }, status: 'RETRY_REQUIRED', error: error.message,
      });
      this.logError('FINANCIAL_STAKE_RELEASE_RETRY_REQUIRED', { entryId: safeEntryId, reason: error.message });
      throw error;
    }
  }

  async recoverFailedMatchStart(entryIds, matchId, reason = 'financial_reservation_commit_failed') {
    const safeMatchId = safeText(matchId, 120);
    const safeEntryIds = [...new Set((entryIds ?? []).map((entryId) => safeText(entryId, 100)).filter(Boolean))];
    if (!safeMatchId || safeEntryIds.length !== 2) throw new Error('FINANCIAL_MATCH_PARTICIPANTS_INVALID');
    const taskKey = `match-start-recovery:${safeMatchId}`;
    await this.upsertRecoveryTask({ taskKey, taskType: 'MATCH_START_RECOVERY', matchId: safeMatchId, payload: { entryIds: safeEntryIds, reason } });
    try {
      return await this.repository.transaction(async (client) => {
        const reservations = (await client.query(
          'SELECT * FROM financial_match_reservations WHERE entry_id IN ($1,$2) ORDER BY entry_id FOR UPDATE', safeEntryIds,
        )).rows;
        const unsafe = reservations.length !== 2 || reservations.some((item) => (
          !['RESERVED', 'COMMITTED', 'RELEASED'].includes(item.status)
          || (item.status === 'COMMITTED' && item.match_id && item.match_id !== safeMatchId)
        ));
        if (unsafe) {
          await client.query(
            `UPDATE financial_recovery_tasks SET status='REVIEW_REQUIRED', last_error=$1, next_attempt_at=NULL, updated_at=now()
             WHERE task_key=$2`, ['FINANCIAL_MATCH_START_STATE_AMBIGUOUS', taskKey],
          );
          await insertSystemAudit(client, {
            action: 'MATCH_START_REVIEW_REQUIRED', targetReference: safeMatchId, reason,
            previousState: { reservations: reservations.map((item) => ({ entryId: item.entry_id, status: item.status, matchId: item.match_id })) },
            nextState: { status: 'REVIEW_REQUIRED' },
          });
          return { recovered: false, reviewRequired: true };
        }
        const active = reservations.filter((item) => ['RESERVED', 'COMMITTED'].includes(item.status));
        if (active.length) {
          const entries = [];
          for (const reservation of active) {
            const amount = cents(reservation.amount_cents);
            await client.query(
              `UPDATE financial_accounts SET reserved_balance_cents=reserved_balance_cents-$1::bigint,
                 available_balance_cents=available_balance_cents+$1::bigint, updated_at=now() WHERE account_id=$2`,
              [amount, reservation.account_id],
            );
            entries.push(
              { accountId: reservation.account_id, ledgerAccount: 'PLAYER_RESERVED', amountCents: -amount },
              { accountId: reservation.account_id, ledgerAccount: 'PLAYER_AVAILABLE', amountCents: amount },
            );
          }
          await insertLedger(client, {
            type: 'MATCH_START_COMPENSATED', idempotencyKey: `match:start-recover:${safeMatchId}`,
            publicRef: publicReference('TX'), gameCode: active[0].game_code,
            metadata: { matchId: safeMatchId, reason, entries: safeEntryIds }, entries,
          });
          await client.query(
            "UPDATE financial_match_reservations SET status='RELEASED', match_id=COALESCE(match_id,$1), updated_at=now() WHERE entry_id IN ($2,$3) AND status IN ('RESERVED','COMMITTED')",
            [safeMatchId, safeEntryIds[0], safeEntryIds[1]],
          );
        }
        await client.query(
          `UPDATE financial_recovery_tasks SET status='COMPLETED', last_error=NULL, next_attempt_at=NULL,
             completed_at=now(), updated_at=now() WHERE task_key=$1`, [taskKey],
        );
        this.logWarn('MATCH_START_FINANCIAL_RECOVERED', { matchId: safeMatchId, participants: active.length });
        return { recovered: true, participants: active.length, duplicate: active.length === 0 };
      });
    } catch (error) {
      await this.upsertRecoveryTask({
        taskKey, taskType: 'MATCH_START_RECOVERY', matchId: safeMatchId,
        payload: { entryIds: safeEntryIds, reason }, status: 'RETRY_REQUIRED', error: error.message,
      });
      throw error;
    }
  }

  async commitMatchReservations(entryIds, matchId) {
    this.assertEnabled();
    if (!Array.isArray(entryIds) || entryIds.length !== 2 || !safeText(matchId, 120)) throw new Error('FINANCIAL_MATCH_PARTICIPANTS_INVALID');
    return this.repository.transaction(async (client) => {
      const result = await client.query(
        `SELECT * FROM financial_match_reservations WHERE entry_id IN ($1,$2) ORDER BY entry_id FOR UPDATE`, entryIds,
      );
      if (result.rows.length !== 2 || result.rows.some((item) => item.status !== 'RESERVED')) throw new Error('FINANCIAL_MATCH_RESERVATION_INVALID');
      if (new Set(result.rows.map((item) => item.account_id)).size !== 2) throw new Error('FINANCIAL_MATCH_PARTICIPANTS_INVALID');
      const accounts = (await client.query(
        'SELECT * FROM financial_accounts WHERE account_id IN ($1,$2) ORDER BY account_id FOR UPDATE',
        [result.rows[0].account_id, result.rows[1].account_id],
      )).rows;
      accounts.forEach(assertAccountActive);
      await client.query(
        `UPDATE financial_match_reservations SET status='COMMITTED', match_id=$1, updated_at=now()
         WHERE entry_id IN ($2,$3)`, [matchId, entryIds[0], entryIds[1]],
      );
      this.logInfo('MATCH_FINANCIAL_STARTED', { matchId, reservations: result.rows.map((item) => item.public_reference) });
      return result.rows;
    });
  }

  async settleMatch({ matchId, winnerPhone, platformFeeCents, gameCode = 'PIFE_DUELO' } = {}) {
    this.assertEnabled();
    const fee = cents(platformFeeCents, { allowZero: true });
    const safeMatchId = safeText(matchId, 120);
    const final = await this.repository.query("SELECT * FROM financial_match_settlements WHERE match_id=$1 AND status IN ('SETTLED','COMPENSATED')", [safeMatchId]);
    if (final.rows[0]) return { ...final.rows[0], duplicate: true };
    const winner = await this.getAccount(winnerPhone);
    if (!winner) throw new Error('FINANCIAL_WINNER_NOT_FOUND');
    assertAccountActive(winner);
    await this.prepareMatchOperation({ matchId: safeMatchId, operationType: 'SETTLE', winnerAccountId: winner.account_id, fee, gameCode });
    return this.executeMatchOperation(safeMatchId);
  }

  async compensateMatch(matchId, reason = 'technical_abort') {
    this.assertEnabled();
    const safeMatchId = safeText(matchId, 120);
    const final = await this.repository.query("SELECT * FROM financial_match_settlements WHERE match_id=$1 AND status IN ('SETTLED','COMPENSATED')", [safeMatchId]);
    if (final.rows[0]) return { ...final.rows[0], duplicate: true };
    await this.prepareMatchOperation({ matchId: safeMatchId, operationType: 'COMPENSATE', reason: safeText(reason, 240), gameCode: 'PIFE_DUELO' });
    return this.executeMatchOperation(safeMatchId);
  }

  async prepareMatchOperation({ matchId, operationType, winnerAccountId = null, fee = 0, reason = null, gameCode = 'PIFE_DUELO' }) {
    try {
      return await this.repository.transaction(async (client) => {
        const existing = (await client.query('SELECT * FROM financial_match_settlements WHERE match_id=$1 FOR UPDATE', [matchId])).rows[0];
        if (existing) {
          if (existing.operation_type !== operationType && !['SETTLED', 'COMPENSATED'].includes(existing.status)) throw new Error('FINANCIAL_MATCH_OPERATION_AMBIGUOUS');
          return existing;
        }
        const reservations = (await client.query(
          'SELECT * FROM financial_match_reservations WHERE match_id=$1 ORDER BY entry_id FOR UPDATE', [matchId],
        )).rows;
        if (reservations.length !== 2 || reservations.some((item) => item.status !== 'COMMITTED')) throw new Error('FINANCIAL_MATCH_NOT_COMMITTED');
        const accounts = (await client.query(
          'SELECT * FROM financial_accounts WHERE account_id IN ($1,$2) ORDER BY account_id FOR UPDATE',
          [reservations[0].account_id, reservations[1].account_id],
        )).rows;
        accounts.forEach(assertAccountActive);
        if (operationType === 'SETTLE' && !reservations.some((item) => item.account_id === winnerAccountId)) throw new Error('FINANCIAL_WINNER_NOT_PARTICIPANT');
        const total = reservations.reduce((sum, item) => sum + cents(item.amount_cents), 0);
        if (fee > total) throw new Error('FINANCIAL_INVALID_PLATFORM_FEE');
        const prize = operationType === 'SETTLE' ? total - fee : 0;
        const inserted = await client.query(
          `INSERT INTO financial_match_settlements
            (settlement_id, match_id, game_code, winner_account_id, total_stakes_cents, platform_fee_cents,
             winner_prize_cents, status, operation_type, failure_reason, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,now()) RETURNING *`,
          [randomUUID(), matchId, gameCode, winnerAccountId, total, operationType === 'SETTLE' ? fee : 0, prize, operationType, reason],
        );
        return inserted.rows[0];
      });
    } catch (error) {
      if (error.code === '23505') {
        const existing = (await this.repository.query('SELECT * FROM financial_match_settlements WHERE match_id=$1', [matchId])).rows[0];
        if (existing?.operation_type === operationType) return existing;
        await this.markMatchOperationReview(matchId, 'FINANCIAL_MATCH_OPERATION_AMBIGUOUS');
        throw new Error('FINANCIAL_MATCH_OPERATION_AMBIGUOUS');
      }
      if (error.message === 'FINANCIAL_MATCH_OPERATION_AMBIGUOUS') await this.markMatchOperationReview(matchId, error.message);
      throw error;
    }
  }

  async executeMatchOperation(matchId) {
    const previous = this.matchOperationLocks.get(matchId) ?? Promise.resolve();
    let releaseLock;
    const current = new Promise((resolve) => { releaseLock = resolve; });
    this.matchOperationLocks.set(matchId, current);
    await previous;
    try {
      return await this.executeMatchOperationUnlocked(matchId);
    } finally {
      releaseLock();
      if (this.matchOperationLocks.get(matchId) === current) this.matchOperationLocks.delete(matchId);
    }
  }

  async executeMatchOperationUnlocked(matchId) {
    try {
      return await this.repository.transaction(async (client) => {
        const settlement = (await client.query('SELECT * FROM financial_match_settlements WHERE match_id=$1 FOR UPDATE', [matchId])).rows[0];
        if (!settlement) throw new Error('FINANCIAL_MATCH_OPERATION_NOT_PREPARED');
        if (['SETTLED', 'COMPENSATED'].includes(settlement.status)) return { ...settlement, duplicate: true };
        if (settlement.status === 'REVIEW_REQUIRED') throw new Error('FINANCIAL_MATCH_REVIEW_REQUIRED');
        await client.query(
          "UPDATE financial_match_settlements SET status='PROCESSING', attempt_count=attempt_count+1, last_attempt_at=now(), failure_reason=NULL, updated_at=now() WHERE match_id=$1",
          [matchId],
        );
        const reservations = (await client.query(
          'SELECT * FROM financial_match_reservations WHERE match_id=$1 ORDER BY entry_id FOR UPDATE', [matchId],
        )).rows;
        if (reservations.length !== 2 || reservations.some((item) => item.status !== 'COMMITTED')) throw new Error('FINANCIAL_MATCH_NOT_COMMITTED');
        const accounts = (await client.query(
          'SELECT * FROM financial_accounts WHERE account_id IN ($1,$2) ORDER BY account_id FOR UPDATE',
          [reservations[0].account_id, reservations[1].account_id],
        )).rows;
        accounts.forEach(assertAccountActive);
        await this.faultInjector('before_match_financial_mutation', { matchId, settlement });
        const entries = [];
        for (const reservation of reservations) {
          const amount = cents(reservation.amount_cents);
          await client.query(
            'UPDATE financial_accounts SET reserved_balance_cents=reserved_balance_cents-$1::bigint, updated_at=now() WHERE account_id=$2',
            [amount, reservation.account_id],
          );
          entries.push({ accountId: reservation.account_id, ledgerAccount: 'PLAYER_RESERVED', amountCents: -amount });
        }
        const settle = settlement.operation_type === 'SETTLE';
        const prize = cents(settlement.winner_prize_cents, { allowZero: true });
        const fee = cents(settlement.platform_fee_cents, { allowZero: true });
        if (settle && prize > 0) {
          await client.query(
            'UPDATE financial_accounts SET available_balance_cents=available_balance_cents+$1::bigint, updated_at=now() WHERE account_id=$2',
            [prize, settlement.winner_account_id],
          );
          entries.push({ accountId: settlement.winner_account_id, ledgerAccount: 'PLAYER_AVAILABLE', amountCents: prize });
        }
        if (settle && fee > 0) entries.push({ ledgerAccount: 'PLATFORM_REVENUE', amountCents: fee });
        if (!settle) {
          for (const reservation of reservations) {
            const amount = cents(reservation.amount_cents);
            await client.query(
              'UPDATE financial_accounts SET available_balance_cents=available_balance_cents+$1::bigint, updated_at=now() WHERE account_id=$2',
              [amount, reservation.account_id],
            );
            entries.push({ accountId: reservation.account_id, ledgerAccount: 'PLAYER_AVAILABLE', amountCents: amount });
          }
        }
        const finalStatus = settle ? 'SETTLED' : 'COMPENSATED';
        const transactionId = await insertLedger(client, {
          type: settle ? 'MATCH_SETTLED' : 'MATCH_COMPENSATED',
          idempotencyKey: `match:${settle ? 'settle' : 'compensate'}:${matchId}`,
          publicRef: publicReference('TX'), gameCode: settlement.game_code,
          metadata: { matchId, totalStakesCents: settlement.total_stakes_cents, platformFeeCents: fee, winnerPrizeCents: prize }, entries,
        });
        await client.query("UPDATE financial_match_reservations SET status=$1, updated_at=now() WHERE match_id=$2", [settle ? 'SETTLED' : 'RELEASED', matchId]);
        const updated = (await client.query(
          `UPDATE financial_match_settlements SET status=$1, transaction_id=$2, failure_reason=NULL, updated_at=now()
           WHERE match_id=$3 RETURNING *`, [finalStatus, transactionId, matchId],
        )).rows[0];
        this.logInfo(settle ? 'MATCH_SETTLED' : 'MATCH_FINANCIAL_COMPENSATED', { matchId, status: finalStatus });
        return updated;
      });
    } catch (error) {
      if (!['FINANCIAL_MATCH_REVIEW_REQUIRED'].includes(error.message)) {
        await this.repository.query(
          `UPDATE financial_match_settlements SET status='RETRY_REQUIRED', attempt_count=attempt_count+1,
             failure_reason=$1, last_attempt_at=now(), updated_at=now()
           WHERE match_id=$2 AND status NOT IN ('SETTLED','COMPENSATED','REVIEW_REQUIRED')`,
          [safeText(error.message, 240), matchId],
        );
      }
      throw error;
    }
  }

  async markMatchOperationReview(matchId, reason) {
    return this.repository.transaction(async (client) => {
      const previous = (await client.query('SELECT * FROM financial_match_settlements WHERE match_id=$1 FOR UPDATE', [matchId])).rows[0];
      if (!previous) return null;
      const updated = (await client.query(
        "UPDATE financial_match_settlements SET status='REVIEW_REQUIRED', failure_reason=$1, updated_at=now() WHERE match_id=$2 RETURNING *",
        [safeText(reason, 240), matchId],
      )).rows[0];
      await insertSystemAudit(client, {
        action: 'MATCH_FINANCIAL_REVIEW_REQUIRED', targetReference: matchId, reason,
        previousState: { status: previous.status, operationType: previous.operation_type },
        nextState: { status: 'REVIEW_REQUIRED' }, amountCents: previous.total_stakes_cents,
      });
      return updated;
    });
  }

  async requestWithdrawal(phone, { amountCents, pixKeyType, pixKey, holderName, idempotencyKey } = {}) {
    this.assertEnabled();
    if (!this.config.withdrawalsEnabled) throw new Error('WITHDRAWALS_DISABLED');
    const amount = cents(amountCents);
    if (amount < this.config.minWithdrawalAmountCents) throw new Error('WITHDRAWAL_BELOW_MINIMUM');
    const account = await this.getAccount(phone);
    if (!account) throw new Error('FINANCIAL_ACCOUNT_NOT_FOUND');
    assertAccountActive(account);
    const type = safeText(pixKeyType, 24).toUpperCase();
    const key = safeText(pixKey, 180);
    const holder = safeText(holderName, 120);
    const idem = safeText(idempotencyKey, 180);
    if (!idem) throw new Error('FINANCIAL_IDEMPOTENCY_KEY_REQUIRED');
    if (!['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'].includes(type) || !key || !holder) throw new Error('WITHDRAWAL_PIX_INVALID');
    return this.repository.transaction(async (client) => {
      const existing = await client.query(
        `SELECT withdrawal_id, public_reference, account_id, amount_cents, pix_key_type, holder_name, status, created_at
         FROM financial_withdrawals WHERE idempotency_key=$1`, [idem],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].account_id !== account.account_id || databaseInteger(existing.rows[0].amount_cents) !== amount) {
          throw new Error('FINANCIAL_IDEMPOTENCY_CONFLICT');
        }
        return { ...existing.rows[0], duplicate: true };
      }
      const locked = assertAccountActive((await client.query('SELECT * FROM financial_accounts WHERE account_id=$1 FOR UPDATE', [account.account_id])).rows[0]);
      if (databaseInteger(locked.available_balance_cents) < amount) throw new Error('FINANCIAL_INSUFFICIENT_BALANCE');
      const withdrawalId = randomUUID();
      const publicRef = publicReference('WD');
      await client.query(
        `UPDATE financial_accounts SET available_balance_cents=available_balance_cents-$1::bigint,
          withdrawal_pending_balance_cents=withdrawal_pending_balance_cents+$1::bigint, updated_at=now() WHERE account_id=$2`,
        [amount, account.account_id],
      );
      await insertLedger(client, {
        type: 'WITHDRAWAL_REQUESTED', idempotencyKey: `withdrawal:request:${idem}`, publicRef: publicReference('TX'),
        metadata: { withdrawalId, publicReference: publicRef }, entries: [
          { accountId: account.account_id, ledgerAccount: 'PLAYER_AVAILABLE', amountCents: -amount },
          { accountId: account.account_id, ledgerAccount: 'PLAYER_WITHDRAWAL_PENDING', amountCents: amount },
        ],
      });
      const result = await client.query(
        `INSERT INTO financial_withdrawals
          (withdrawal_id, public_reference, idempotency_key, account_id, amount_cents, pix_key_type, pix_key_ciphertext, holder_name, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'AWAITING_ADMIN_PAYMENT') RETURNING withdrawal_id, public_reference, account_id, amount_cents, pix_key_type, holder_name, status, created_at`,
        [withdrawalId, publicRef, idem, account.account_id, amount, type, encryptSensitive(key, this.config.encryptionKey), holder],
      );
      this.logInfo('WITHDRAWAL_REQUESTED', { publicReference: publicRef, amountCents: amount, pixKeyType: type });
      return result.rows[0];
    });
  }

  assertFinancialAdmin(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized || !this.config.financialAdminNumbers.includes(normalized)) throw new Error('FINANCIAL_ADMIN_UNAUTHORIZED');
    return normalized;
  }

  async listPendingWithdrawals(adminPhone) {
    this.assertEnabled();
    this.assertFinancialAdmin(adminPhone);
    const result = await this.repository.query(
      `SELECT w.public_reference, w.amount_cents, w.pix_key_type, w.holder_name, w.status, w.created_at,
              a.public_id, a.display_name, right(a.phone_normalized, 4) AS phone_last4
       FROM financial_withdrawals w JOIN financial_accounts a ON a.account_id=w.account_id
       WHERE w.status IN ('AWAITING_ADMIN_PAYMENT','REVIEW_REQUIRED') ORDER BY w.created_at ASC LIMIT 100`,
    );
    return result.rows;
  }

  async getWithdrawalDetails(adminPhone, reference) {
    this.assertEnabled();
    const admin = this.assertFinancialAdmin(adminPhone);
    return this.repository.transaction(async (client) => {
      const result = await client.query(
        `SELECT w.*, a.public_id, a.display_name, a.phone_normalized, a.available_balance_cents,
                a.withdrawal_pending_balance_cents
         FROM financial_withdrawals w JOIN financial_accounts a ON a.account_id=w.account_id
         WHERE w.public_reference=$1`, [safeText(reference, 40).toUpperCase()],
      );
      const withdrawal = result.rows[0];
      if (!withdrawal) throw new Error('WITHDRAWAL_NOT_FOUND');
      await client.query(
        `INSERT INTO financial_admin_audit
          (audit_id, admin_phone_masked, action, target_reference, reason, previous_state, next_state, amount_cents)
         VALUES ($1,$2,'WITHDRAWAL_PIX_DETAILS_ACCESSED',$3,'manual_payment_review',$4::jsonb,$5::jsonb,$6)`,
        [randomUUID(), maskedAdmin(admin), withdrawal.public_reference,
          json({ status: withdrawal.status, playerPublicId: withdrawal.public_id }),
          json({ access: 'PIX_KEY_REVEALED_TO_FINANCIAL_ADMIN' }), withdrawal.amount_cents],
      );
      return { ...withdrawal, pix_key: decryptSensitive(withdrawal.pix_key_ciphertext, this.config.encryptionKey), pix_key_ciphertext: undefined };
    });
  }

  async markWithdrawalPaid(adminPhone, reference, providerTransferId) {
    this.assertEnabled();
    const admin = this.assertFinancialAdmin(adminPhone);
    const transferId = safeText(providerTransferId, 120);
    if (!transferId) throw new Error('WITHDRAWAL_TRANSFER_ID_REQUIRED');
    return this.repository.transaction(async (client) => {
      const withdrawal = (await client.query(
        'SELECT * FROM financial_withdrawals WHERE public_reference=$1 FOR UPDATE', [safeText(reference, 40).toUpperCase()],
      )).rows[0];
      if (!withdrawal) throw new Error('WITHDRAWAL_NOT_FOUND');
      if (withdrawal.status === 'PAID') return { ...withdrawal, duplicate: true };
      if (!['AWAITING_ADMIN_PAYMENT', 'PROCESSING'].includes(withdrawal.status)) throw new Error('WITHDRAWAL_NOT_PAYABLE');
      const duplicate = await client.query(
        'SELECT public_reference FROM financial_withdrawals WHERE provider_transfer_id=$1 AND withdrawal_id<>$2',
        [transferId, withdrawal.withdrawal_id],
      );
      if (duplicate.rows[0]) throw new Error('WITHDRAWAL_TRANSFER_ID_DUPLICATE');
      const amount = databaseInteger(withdrawal.amount_cents);
      await client.query(
        `UPDATE financial_accounts SET withdrawal_pending_balance_cents=withdrawal_pending_balance_cents-$1::bigint,
          updated_at=now() WHERE account_id=$2`, [amount, withdrawal.account_id],
      );
      await insertLedger(client, {
        type: 'WITHDRAWAL_PAID', idempotencyKey: `withdrawal:paid:${withdrawal.withdrawal_id}`,
        publicRef: publicReference('TX'), metadata: { withdrawalId: withdrawal.withdrawal_id, transferId }, entries: [
          { accountId: withdrawal.account_id, ledgerAccount: 'PLAYER_WITHDRAWAL_PENDING', amountCents: -amount },
          { ledgerAccount: 'PROVIDER_PAYOUT', amountCents: amount },
        ],
      });
      const updated = (await client.query(
        `UPDATE financial_withdrawals SET status='PAID', provider_transfer_id=$1, updated_at=now()
         WHERE withdrawal_id=$2 RETURNING withdrawal_id, public_reference, account_id, amount_cents, status, provider_transfer_id, updated_at`,
        [transferId, withdrawal.withdrawal_id],
      )).rows[0];
      await client.query(
        `INSERT INTO financial_admin_audit
          (audit_id, admin_phone_masked, action, target_reference, previous_state, next_state, amount_cents)
         VALUES ($1,$2,'WITHDRAWAL_PAID_MANUALLY',$3,$4::jsonb,$5::jsonb,$6)`,
        [randomUUID(), maskedAdmin(admin), withdrawal.public_reference, json({ status: withdrawal.status }), json({ status: 'PAID', transferId }), amount],
      );
      this.logInfo('WITHDRAWAL_PAID_MANUALLY', { publicReference: withdrawal.public_reference, amountCents: amount, admin: maskedAdmin(admin) });
      return updated;
    });
  }

  async rejectWithdrawal(adminPhone, reference, reason) {
    this.assertEnabled();
    const admin = this.assertFinancialAdmin(adminPhone);
    const rejectionReason = safeText(reason, 240);
    if (!rejectionReason) throw new Error('WITHDRAWAL_REJECTION_REASON_REQUIRED');
    return this.repository.transaction(async (client) => {
      const withdrawal = (await client.query(
        'SELECT * FROM financial_withdrawals WHERE public_reference=$1 FOR UPDATE', [safeText(reference, 40).toUpperCase()],
      )).rows[0];
      if (!withdrawal) throw new Error('WITHDRAWAL_NOT_FOUND');
      if (withdrawal.status === 'REJECTED') return { ...withdrawal, duplicate: true };
      if (!['AWAITING_ADMIN_PAYMENT', 'REVIEW_REQUIRED'].includes(withdrawal.status)) throw new Error('WITHDRAWAL_NOT_REJECTABLE');
      const amount = databaseInteger(withdrawal.amount_cents);
      await client.query(
        `UPDATE financial_accounts SET withdrawal_pending_balance_cents=withdrawal_pending_balance_cents-$1::bigint,
          available_balance_cents=available_balance_cents+$1::bigint, updated_at=now() WHERE account_id=$2`,
        [amount, withdrawal.account_id],
      );
      await insertLedger(client, {
        type: 'WITHDRAWAL_REJECTED', idempotencyKey: `withdrawal:reject:${withdrawal.withdrawal_id}`,
        publicRef: publicReference('TX'), metadata: { withdrawalId: withdrawal.withdrawal_id, reason: rejectionReason }, entries: [
          { accountId: withdrawal.account_id, ledgerAccount: 'PLAYER_WITHDRAWAL_PENDING', amountCents: -amount },
          { accountId: withdrawal.account_id, ledgerAccount: 'PLAYER_AVAILABLE', amountCents: amount },
        ],
      });
      const updated = (await client.query(
        `UPDATE financial_withdrawals SET status='REJECTED', failure_reason=$1, updated_at=now()
         WHERE withdrawal_id=$2 RETURNING withdrawal_id, public_reference, account_id, amount_cents, status, failure_reason, updated_at`,
        [rejectionReason, withdrawal.withdrawal_id],
      )).rows[0];
      await client.query(
        `INSERT INTO financial_admin_audit
          (audit_id, admin_phone_masked, action, target_reference, reason, previous_state, next_state, amount_cents)
         VALUES ($1,$2,'WITHDRAWAL_REJECTED',$3,$4,$5::jsonb,$6::jsonb,$7)`,
        [randomUUID(), maskedAdmin(admin), withdrawal.public_reference, rejectionReason, json({ status: withdrawal.status }), json({ status: 'REJECTED' }), amount],
      );
      this.logInfo('WITHDRAWAL_REJECTED', { publicReference: withdrawal.public_reference, amountCents: amount, admin: maskedAdmin(admin) });
      return updated;
    });
  }

  async markWithdrawalReview(adminPhone, reference, reason) {
    this.assertEnabled();
    const admin = this.assertFinancialAdmin(adminPhone);
    const reviewReason = safeText(reason, 240);
    if (!reviewReason) throw new Error('WITHDRAWAL_REVIEW_REASON_REQUIRED');
    return this.repository.transaction(async (client) => {
      const previous = (await client.query(
        "SELECT * FROM financial_withdrawals WHERE public_reference=$1 AND status IN ('AWAITING_ADMIN_PAYMENT','PROCESSING') FOR UPDATE",
        [safeText(reference, 40).toUpperCase()],
      )).rows[0];
      if (!previous) throw new Error('WITHDRAWAL_NOT_REVIEWABLE');
      const updated = (await client.query(
        "UPDATE financial_withdrawals SET status='REVIEW_REQUIRED', failure_reason=$1, updated_at=now() WHERE withdrawal_id=$2 RETURNING *",
        [reviewReason, previous.withdrawal_id],
      )).rows[0];
      await client.query(
        `INSERT INTO financial_admin_audit (audit_id, admin_phone_masked, action, target_reference, reason, previous_state, next_state, amount_cents)
         VALUES ($1,$2,'WITHDRAWAL_REVIEW_REQUIRED',$3,$4,$5::jsonb,$6::jsonb,$7)`,
        [randomUUID(), maskedAdmin(admin), updated.public_reference, reviewReason,
          json({ status: previous.status }), json({ status: 'REVIEW_REQUIRED' }), updated.amount_cents],
      );
      this.logWarn('WITHDRAWAL_REVIEW_REQUIRED', { publicReference: updated.public_reference, admin: maskedAdmin(admin) });
      return updated;
    });
  }

  async reconcile(adminPhone) {
    this.assertEnabled();
    const admin = this.assertFinancialAdmin(adminPhone);
    const internal = (await this.repository.query(
      `SELECT COALESCE(sum(available_balance_cents + reserved_balance_cents + withdrawal_pending_balance_cents),0)::bigint AS liability
       FROM financial_accounts`,
    )).rows[0];
    const provider = await this.provider.getProviderBalance();
    const providerBalance = databaseInteger(provider.amountCents);
    const liability = databaseInteger(internal.liability);
    const ledgerRows = (await this.repository.query(
      `SELECT ledger_account, COALESCE(sum(amount_cents),0)::bigint AS balance_cents
       FROM financial_ledger_entries GROUP BY ledger_account ORDER BY ledger_account`,
    )).rows;
    const ledgerBalances = Object.fromEntries(ledgerRows.map((row) => [row.ledger_account, databaseInteger(row.balance_cents)]));
    const pending = (await this.repository.query(
      `SELECT
        count(*) FILTER (WHERE status IN ('CREATED','PENDING','REVIEW_REQUIRED'))::int AS pending_deposits,
        count(*) FILTER (WHERE status='CREDITED' AND fee_amount_cents IS NULL)::int AS unknown_fee_deposits
       FROM financial_deposits`,
    )).rows[0];
    const platformRevenue = Number(ledgerBalances.PLATFORM_REVENUE || 0);
    const providerFees = Math.abs(Number(ledgerBalances.PROVIDER_FEE || 0));
    const expectedProviderBalance = liability + platformRevenue - providerFees;
    const mismatch = providerBalance - expectedProviderBalance;
    const hasUnknownFee = Number(pending.unknown_fee_deposits || 0) > 0;
    const status = hasUnknownFee ? 'REVIEW_REQUIRED' : (mismatch === 0 ? 'MATCHED' : 'MISMATCH');
    const result = await this.repository.query(
      `INSERT INTO financial_reconciliations
        (reconciliation_id, status, provider_balance_cents, internal_liability_cents, mismatch_cents, details)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [randomUUID(), status, providerBalance, liability, mismatch, json({
        provider: this.config.provider,
        admin: maskedAdmin(admin),
        expectedProviderBalanceCents: expectedProviderBalance,
        platformRevenueCents: platformRevenue,
        providerFeesCents: providerFees,
        pendingDeposits: Number(pending.pending_deposits || 0),
        unknownFeeDeposits: Number(pending.unknown_fee_deposits || 0),
        ledgerAccountBalances: ledgerBalances,
      })],
    );
    if (status !== 'MATCHED') this.logWarn('RECONCILIATION_MISMATCH', {
      providerBalanceCents: providerBalance, expectedProviderBalanceCents: expectedProviderBalance,
      internalLiabilityCents: liability, mismatchCents: mismatch, status,
    });
    return result.rows[0];
  }

  async listHistory(phone, { limit = 20 } = {}) {
    this.assertEnabled();
    const account = await this.getAccount(phone);
    if (!account) return [];
    const result = await this.repository.query(
      `SELECT t.public_reference, t.transaction_type, t.status, t.game_code, e.ledger_account, e.amount_cents, e.created_at
       FROM financial_ledger_entries e JOIN financial_transactions t ON t.transaction_id=e.transaction_id
       WHERE e.account_id=$1 ORDER BY e.created_at DESC LIMIT $2`,
      [account.account_id, Math.min(100, Math.max(1, Number(limit) || 20))],
    );
    return result.rows;
  }

  async getStatus() {
    if (!this.isEnabled()) return { enabled: false, ready: false, mode: this.config?.mode ?? 'sandbox', errors: this.config?.errors ?? [] };
    const counts = await this.repository.query(
      `SELECT
        (SELECT count(*)::int FROM financial_accounts) AS accounts,
        (SELECT count(*)::int FROM financial_deposits WHERE status IN ('CREATED','PENDING')) AS pending_deposits,
        (SELECT count(*)::int FROM financial_withdrawals WHERE status='AWAITING_ADMIN_PAYMENT') AS pending_withdrawals`,
    );
    return { enabled: true, ready: true, mode: this.config.mode, provider: this.config.provider, ...counts.rows[0] };
  }
}

export { SANDBOX_NOTICE };
export default FinancialWalletService;
