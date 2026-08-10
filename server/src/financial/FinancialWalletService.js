import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizePhone } from '../payments/PaymentService.js';

const GAME_CODES = new Set(['PIFE_DUELO', 'BOMBERMAN_FUTURE']);
const SANDBOX_NOTICE = '🧪 Ambiente de demonstração — nenhum dinheiro real está sendo movimentado.';

function cents(value, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error('FINANCIAL_INVALID_AMOUNT');
  return parsed;
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

export class FinancialWalletService {
  constructor({ repository, provider, config, logInfo = () => {}, logWarn = () => {}, logError = () => {} } = {}) {
    if (!repository) throw new Error('FINANCIAL_REPOSITORY_REQUIRED');
    if (!provider) throw new Error('PAYMENT_PROVIDER_REQUIRED');
    this.repository = repository;
    this.provider = provider;
    this.config = config;
    this.logInfo = logInfo;
    this.logWarn = logWarn;
    this.logError = logError;
  }

  isEnabled() { return Boolean(this.config?.ready); }
  isSandbox() { return this.config?.mode === 'sandbox'; }
  notice() { return this.isSandbox() ? SANDBOX_NOTICE : ''; }
  assertEnabled() { if (!this.isEnabled()) throw new Error('FINANCIAL_WALLET_DISABLED'); }

  async initialize() {
    this.assertEnabled();
    return this.repository.initialize();
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
    const account = await this.getOrCreateAccount(phone, { displayName });
    const existing = await this.repository.query(
      `SELECT d.* FROM financial_deposits d
       JOIN financial_transactions t ON t.public_reference=d.public_reference
       WHERE t.idempotency_key=$1`, [idem],
    );
    if (existing.rows[0]) return { ...existing.rows[0], duplicate: true };
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
    try {
      const customer = await this.provider.createOrFindCustomer({
        publicId: account.public_id,
        name: account.display_name,
        phone: account.phone_normalized,
        existingCustomerId: account.provider_customer_id,
      });
      const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const charge = await this.provider.createPixCharge({
        customerId: customer.id,
        amountCents: amount,
        dueDate,
        description: `Saldo Pife Duelo ${publicRef}`,
        externalReference: publicRef,
      });
      const qr = await this.provider.getPixQrCode(charge.id);
      const updated = await this.repository.query(
        `UPDATE financial_deposits SET status='PENDING', provider_payment_id=$1,
          provider_customer_id=$2, pix_copy_paste=$3, pix_qr_code=$4, expires_at=$5, updated_at=now()
         WHERE deposit_id=$6 RETURNING *`,
        [charge.id, customer.id, qr.payload ?? null, qr.encodedImage ?? null, qr.expirationDate ?? null, depositId],
      );
      await this.repository.query(
        'UPDATE financial_accounts SET provider_customer_id=$1, updated_at=now() WHERE account_id=$2 AND provider_customer_id IS NULL',
        [customer.id, account.account_id],
      );
      this.logInfo('DEPOSIT_CREATED', { publicReference: publicRef, amountCents: amount, provider: this.config.provider });
      return updated.rows[0];
    } catch (error) {
      await this.repository.query("UPDATE financial_deposits SET status='REVIEW_REQUIRED', updated_at=now() WHERE deposit_id=$1", [depositId]);
      this.logError('DEPOSIT_CREATE_FAILED', { publicReference: publicRef, reason: error.message });
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
          await client.query(
            "UPDATE financial_deposits SET status=$1, updated_at=now() WHERE deposit_id=$2",
            [eventType === 'PAYMENT_REFUNDED' ? 'REFUNDED' : 'REVERSED', deposit.deposit_id],
          );
          await client.query("UPDATE financial_processed_webhooks SET status='PROCESSED', processed_at=now() WHERE webhook_event_id=$1", [eventId]);
          return { reversed: true, creditedBalanceAffected: false };
        }
        const account = (await client.query('SELECT * FROM financial_accounts WHERE account_id=$1 FOR UPDATE', [deposit.account_id])).rows[0];
        const amount = Number(deposit.credited_amount_cents || deposit.amount_cents);
        if (Number(account.available_balance_cents) < amount) {
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
      const remoteAmount = remotePayment.amountCents ?? Math.round(Number(remotePayment.value || 0) * 100);
      if (remoteAmount !== Number(deposit.amount_cents)) throw new Error('FINANCIAL_DEPOSIT_AMOUNT_MISMATCH');
      const accountResult = await client.query('SELECT * FROM financial_accounts WHERE account_id=$1 FOR UPDATE', [deposit.account_id]);
      const account = accountResult.rows[0];
      const transactionId = await insertLedger(client, {
        type: 'DEPOSIT_CREDITED', idempotencyKey: `deposit:credit:${deposit.deposit_id}`,
        publicRef: publicReference('TX'), metadata: { depositId: deposit.deposit_id, providerPaymentId: paymentId },
        entries: [
          { ledgerAccount: 'PROVIDER_CLEARING', amountCents: -remoteAmount },
          { accountId: account.account_id, ledgerAccount: 'PLAYER_AVAILABLE', amountCents: remoteAmount },
        ],
      });
      await client.query(
        `UPDATE financial_accounts SET available_balance_cents=available_balance_cents+$1::bigint, updated_at=now()
         WHERE account_id=$2`, [remoteAmount, account.account_id],
      );
      await client.query(
        `UPDATE financial_deposits SET status='CREDITED', gross_amount_cents=$1, fee_amount_cents=0,
          net_amount_cents=$1, credited_amount_cents=$1, credited_transaction_id=$2, updated_at=now()
         WHERE deposit_id=$3`, [remoteAmount, transactionId, deposit.deposit_id],
      );
      await client.query("UPDATE financial_processed_webhooks SET status='PROCESSED', processed_at=now() WHERE webhook_event_id=$1", [eventId]);
      this.logInfo('DEPOSIT_CREDITED', { publicReference: deposit.public_reference, amountCents: remoteAmount });
      return { credited: true, accountId: account.account_id, amountCents: remoteAmount, previousBalanceCents: Number(account.available_balance_cents), newBalanceCents: Number(account.available_balance_cents) + remoteAmount };
    });
  }

  async reserveStake(phone, { amountCents, entryId, tableId, gameCode = 'PIFE_DUELO' } = {}) {
    this.assertEnabled();
    if (!this.config.realMoneyGamesEnabled) throw new Error('REAL_MONEY_GAMES_DISABLED');
    if (!GAME_CODES.has(gameCode) || gameCode !== 'PIFE_DUELO') throw new Error('FINANCIAL_GAME_NOT_ACTIVE');
    const amount = cents(amountCents);
    const account = await this.getAccount(phone);
    if (!account) throw new Error('FINANCIAL_ACCOUNT_NOT_FOUND');
    return this.repository.transaction(async (client) => {
      const duplicate = await client.query('SELECT * FROM financial_match_reservations WHERE entry_id=$1', [safeText(entryId, 100)]);
      if (duplicate.rows[0]) return { ...duplicate.rows[0], duplicate: true };
      const locked = (await client.query('SELECT * FROM financial_accounts WHERE account_id=$1 FOR UPDATE', [account.account_id])).rows[0];
      if (Number(locked.available_balance_cents) < amount) throw new Error('FINANCIAL_INSUFFICIENT_BALANCE');
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
      const amount = Number(reservation.amount_cents);
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

  async commitMatchReservations(entryIds, matchId) {
    this.assertEnabled();
    if (!Array.isArray(entryIds) || entryIds.length !== 2 || !safeText(matchId, 120)) throw new Error('FINANCIAL_MATCH_PARTICIPANTS_INVALID');
    return this.repository.transaction(async (client) => {
      const result = await client.query(
        `SELECT * FROM financial_match_reservations WHERE entry_id IN ($1,$2) ORDER BY entry_id FOR UPDATE`, entryIds,
      );
      if (result.rows.length !== 2 || result.rows.some((item) => item.status !== 'RESERVED')) throw new Error('FINANCIAL_MATCH_RESERVATION_INVALID');
      if (new Set(result.rows.map((item) => item.account_id)).size !== 2) throw new Error('FINANCIAL_MATCH_PARTICIPANTS_INVALID');
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
    const winner = await this.getAccount(winnerPhone);
    if (!winner) throw new Error('FINANCIAL_WINNER_NOT_FOUND');
    return this.repository.transaction(async (client) => {
      const duplicate = await client.query('SELECT * FROM financial_match_settlements WHERE match_id=$1', [matchId]);
      if (duplicate.rows[0]) return { ...duplicate.rows[0], duplicate: true };
      const reservations = (await client.query(
        `SELECT * FROM financial_match_reservations WHERE match_id=$1 ORDER BY entry_id FOR UPDATE`, [matchId],
      )).rows;
      if (reservations.length !== 2 || reservations.some((item) => item.status !== 'COMMITTED')) throw new Error('FINANCIAL_MATCH_NOT_COMMITTED');
      if (!reservations.some((item) => item.account_id === winner.account_id)) throw new Error('FINANCIAL_WINNER_NOT_PARTICIPANT');
      const total = reservations.reduce((sum, item) => sum + Number(item.amount_cents), 0);
      if (fee > total) throw new Error('FINANCIAL_INVALID_PLATFORM_FEE');
      const prize = total - fee;
      for (const reservation of reservations) {
        await client.query(
          'UPDATE financial_accounts SET reserved_balance_cents=reserved_balance_cents-$1::bigint, updated_at=now() WHERE account_id=$2',
          [reservation.amount_cents, reservation.account_id],
        );
      }
      await client.query(
        'UPDATE financial_accounts SET available_balance_cents=available_balance_cents+$1::bigint, updated_at=now() WHERE account_id=$2',
        [prize, winner.account_id],
      );
      const entries = reservations.map((item) => ({ accountId: item.account_id, ledgerAccount: 'PLAYER_RESERVED', amountCents: -Number(item.amount_cents) }));
      if (prize > 0) entries.push({ accountId: winner.account_id, ledgerAccount: 'PLAYER_AVAILABLE', amountCents: prize });
      if (fee > 0) entries.push({ ledgerAccount: 'PLATFORM_REVENUE', amountCents: fee });
      const transactionId = await insertLedger(client, {
        type: 'MATCH_SETTLED', idempotencyKey: `match:settle:${matchId}`, publicRef: publicReference('TX'),
        gameCode, metadata: { matchId, totalStakesCents: total, platformFeeCents: fee, winnerPrizeCents: prize }, entries,
      });
      await client.query("UPDATE financial_match_reservations SET status='SETTLED', updated_at=now() WHERE match_id=$1", [matchId]);
      const settlement = await client.query(
        `INSERT INTO financial_match_settlements
          (settlement_id, match_id, game_code, winner_account_id, total_stakes_cents, platform_fee_cents, winner_prize_cents, status, transaction_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'SETTLED',$8) RETURNING *`,
        [randomUUID(), matchId, gameCode, winner.account_id, total, fee, prize, transactionId],
      );
      this.logInfo('MATCH_SETTLED', { matchId, totalStakesCents: total, platformFeeCents: fee, winnerPrizeCents: prize });
      return settlement.rows[0];
    });
  }

  async compensateMatch(matchId, reason = 'technical_abort') {
    this.assertEnabled();
    return this.repository.transaction(async (client) => {
      const reservations = (await client.query(
        `SELECT * FROM financial_match_reservations WHERE match_id=$1 ORDER BY entry_id FOR UPDATE`, [safeText(matchId, 120)],
      )).rows;
      const active = reservations.filter((item) => item.status === 'COMMITTED');
      if (!active.length) return { compensated: false, duplicate: true };
      const entries = [];
      for (const reservation of active) {
        const amount = Number(reservation.amount_cents);
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
        type: 'MATCH_COMPENSATED', idempotencyKey: `match:compensate:${matchId}`, publicRef: publicReference('TX'),
        gameCode: active[0].game_code, metadata: { matchId, reason: safeText(reason, 240) }, entries,
      });
      await client.query(
        `UPDATE financial_match_reservations SET status='RELEASED', updated_at=now()
         WHERE match_id=$1 AND status='COMMITTED'`, [matchId],
      );
      this.logWarn('MATCH_FINANCIAL_COMPENSATED', { matchId, reason: safeText(reason, 240), participants: active.length });
      return { compensated: true, participants: active.length };
    });
  }

  async requestWithdrawal(phone, { amountCents, pixKeyType, pixKey, holderName, idempotencyKey } = {}) {
    this.assertEnabled();
    if (!this.config.withdrawalsEnabled) throw new Error('WITHDRAWALS_DISABLED');
    const amount = cents(amountCents);
    if (amount < this.config.minWithdrawalAmountCents) throw new Error('WITHDRAWAL_BELOW_MINIMUM');
    const account = await this.getAccount(phone);
    if (!account) throw new Error('FINANCIAL_ACCOUNT_NOT_FOUND');
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
      if (existing.rows[0]) return { ...existing.rows[0], duplicate: true };
      const locked = (await client.query('SELECT * FROM financial_accounts WHERE account_id=$1 FOR UPDATE', [account.account_id])).rows[0];
      if (Number(locked.available_balance_cents) < amount) throw new Error('FINANCIAL_INSUFFICIENT_BALANCE');
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
    this.assertFinancialAdmin(adminPhone);
    const result = await this.repository.query(
      `SELECT w.*, a.public_id, a.display_name, a.phone_normalized, a.available_balance_cents,
              a.withdrawal_pending_balance_cents
       FROM financial_withdrawals w JOIN financial_accounts a ON a.account_id=w.account_id
       WHERE w.public_reference=$1`, [safeText(reference, 40).toUpperCase()],
    );
    const withdrawal = result.rows[0];
    if (!withdrawal) throw new Error('WITHDRAWAL_NOT_FOUND');
    return { ...withdrawal, pix_key: decryptSensitive(withdrawal.pix_key_ciphertext, this.config.encryptionKey), pix_key_ciphertext: undefined };
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
      const amount = Number(withdrawal.amount_cents);
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
      const amount = Number(withdrawal.amount_cents);
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
    const updated = await this.repository.query(
      `UPDATE financial_withdrawals SET status='REVIEW_REQUIRED', failure_reason=$1, updated_at=now()
       WHERE public_reference=$2 AND status IN ('AWAITING_ADMIN_PAYMENT','PROCESSING') RETURNING *`,
      [reviewReason, safeText(reference, 40).toUpperCase()],
    );
    if (!updated.rows[0]) throw new Error('WITHDRAWAL_NOT_REVIEWABLE');
    await this.repository.query(
      `INSERT INTO financial_admin_audit (audit_id, admin_phone_masked, action, target_reference, reason, next_state, amount_cents)
       VALUES ($1,$2,'WITHDRAWAL_REVIEW_REQUIRED',$3,$4,$5::jsonb,$6)`,
      [randomUUID(), maskedAdmin(admin), updated.rows[0].public_reference, reviewReason, json({ status: 'REVIEW_REQUIRED' }), updated.rows[0].amount_cents],
    );
    this.logWarn('WITHDRAWAL_REVIEW_REQUIRED', { publicReference: updated.rows[0].public_reference, admin: maskedAdmin(admin) });
    return updated.rows[0];
  }

  async reconcile(adminPhone) {
    this.assertEnabled();
    const admin = this.assertFinancialAdmin(adminPhone);
    const internal = (await this.repository.query(
      `SELECT COALESCE(sum(available_balance_cents + reserved_balance_cents + withdrawal_pending_balance_cents),0)::bigint AS liability
       FROM financial_accounts`,
    )).rows[0];
    const provider = await this.provider.getProviderBalance();
    const providerBalance = Number(provider.amountCents);
    const liability = Number(internal.liability);
    const mismatch = providerBalance - liability;
    const status = mismatch === 0 ? 'MATCHED' : 'MISMATCH';
    const result = await this.repository.query(
      `INSERT INTO financial_reconciliations
        (reconciliation_id, status, provider_balance_cents, internal_liability_cents, mismatch_cents, details)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [randomUUID(), status, providerBalance, liability, mismatch, json({ provider: this.config.provider, admin: maskedAdmin(admin) })],
    );
    if (mismatch !== 0) this.logWarn('RECONCILIATION_MISMATCH', { providerBalanceCents: providerBalance, internalLiabilityCents: liability, mismatchCents: mismatch });
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
