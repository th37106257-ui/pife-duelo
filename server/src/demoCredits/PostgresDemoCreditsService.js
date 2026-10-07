import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DemoCreditsRepository, createEmptyDemoCreditsState } from './DemoCreditsRepository.js';
import { DemoCreditsService } from './DemoCreditsService.js';
import { resolveFinancialDatabaseSsl } from '../financial/PostgresFinancialRepository.js';

const { Pool } = pg;
const migrationPath = join(dirname(fileURLToPath(import.meta.url)), 'migrations', '001_demo_credits.sql');
const LOCK_NAMESPACE = 173711;
const LOCK_ID = 1;

function units(value) {
  const scaled = Math.round((Number(value) + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(scaled)) throw new Error('DEMO_AMOUNT_OUT_OF_RANGE');
  return scaled;
}

function credits(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('DEMO_AMOUNT_OUT_OF_RANGE');
  return parsed / 100;
}

function iso(value) {
  return new Date(value).toISOString();
}

function accountFromRow(row) {
  return {
    playerId: row.player_id,
    availableBalance: credits(row.available_units),
    reservedBalance: credits(row.reserved_units),
    lifetimeGranted: credits(row.lifetime_granted_units),
    lifetimeConsumed: credits(row.lifetime_consumed_units),
    lifetimeRewarded: credits(row.lifetime_rewarded_units),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function reservationFromRow(row) {
  return {
    reservationId: row.reservation_id,
    playerId: row.player_id,
    amount: credits(row.amount_units),
    status: row.status,
    publicReference: row.public_reference,
    entryId: row.entry_id,
    preMatchId: row.pre_match_id,
    matchId: row.match_id,
    matchPlayerId: row.match_player_id,
    tableId: row.table_id,
    releaseReason: row.release_reason,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function eventFromRow(row) {
  return {
    eventId: row.event_id,
    playerId: row.player_id,
    type: row.event_type,
    amount: credits(row.amount_units),
    previousAvailableBalance: credits(row.previous_available_units),
    newAvailableBalance: credits(row.new_available_units),
    previousReservedBalance: credits(row.previous_reserved_units),
    newReservedBalance: credits(row.new_reserved_units),
    publicReference: row.public_reference,
    matchId: row.match_id,
    tableId: row.table_id,
    entryId: row.entry_id,
    reason: row.reason,
    actor: row.actor,
    createdAt: iso(row.created_at),
    idempotencyKey: row.idempotency_key,
    origin: row.origin,
    withdrawable: row.withdrawable,
    convertibleToRealMoney: row.convertible_to_real_money,
  };
}

export class PostgresDemoCreditsRepository {
  constructor({ connectionString, pool = null, ssl = null } = {}) {
    if (!pool && !connectionString) throw new Error('DEMO_CREDITS_DATABASE_REQUIRED');
    this.pool = pool ?? new Pool({
      connectionString,
      ssl: resolveFinancialDatabaseSsl({ connectionString, ssl }),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.ownsPool = !pool;
    this.initialized = false;
  }

  async withLock(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_NAMESPACE, LOCK_ID]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async initialize({ legacyFilePath = null } = {}) {
    await this.withLock(async (client) => {
      await client.query(readFileSync(migrationPath, 'utf8'));
      if (!legacyFilePath || !existsSync(legacyFilePath)) return;
      const count = await client.query('SELECT count(*)::integer AS total FROM demo_credit_ledger');
      const accountCount = await client.query('SELECT count(*)::integer AS total FROM demo_credit_accounts');
      if (count.rows[0].total !== 0 || accountCount.rows[0].total !== 0) return;
      const legacy = new DemoCreditsRepository({ filePath: legacyFilePath }).snapshot();
      if (!legacy.ledger.length && !Object.keys(legacy.accounts).length) return;
      await this.persistState(client, createEmptyDemoCreditsState(), legacy);
    });
    this.initialized = true;
    return true;
  }

  async loadState(client) {
    const [accounts, reservations, ledger] = await Promise.all([
      client.query('SELECT * FROM demo_credit_accounts ORDER BY player_id'),
      client.query('SELECT * FROM demo_credit_reservations ORDER BY created_at, reservation_id'),
      client.query('SELECT * FROM demo_credit_ledger ORDER BY sequence'),
    ]);
    return {
      schemaVersion: 1,
      accounts: Object.fromEntries(accounts.rows.map((row) => [row.player_id, accountFromRow(row)])),
      reservations: reservations.rows.map(reservationFromRow),
      ledger: ledger.rows.map(eventFromRow),
    };
  }

  async persistState(client, before, after) {
    for (const account of Object.values(after.accounts)) {
      if (JSON.stringify(account) === JSON.stringify(before.accounts[account.playerId])) continue;
      await client.query(
        `INSERT INTO demo_credit_accounts (
           player_id, available_units, reserved_units, lifetime_granted_units,
           lifetime_consumed_units, lifetime_rewarded_units, version, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (player_id) DO UPDATE SET
           available_units = EXCLUDED.available_units,
           reserved_units = EXCLUDED.reserved_units,
           lifetime_granted_units = EXCLUDED.lifetime_granted_units,
           lifetime_consumed_units = EXCLUDED.lifetime_consumed_units,
           lifetime_rewarded_units = EXCLUDED.lifetime_rewarded_units,
           version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`,
        [account.playerId, units(account.availableBalance), units(account.reservedBalance),
          units(account.lifetimeGranted), units(account.lifetimeConsumed), units(account.lifetimeRewarded),
          account.version, account.createdAt, account.updatedAt],
      );
    }

    const previousReservations = new Map(before.reservations.map((item) => [item.reservationId, item]));
    for (const reservation of after.reservations) {
      if (JSON.stringify(reservation) === JSON.stringify(previousReservations.get(reservation.reservationId))) continue;
      await client.query(
        `INSERT INTO demo_credit_reservations (
           reservation_id, player_id, amount_units, status, public_reference, entry_id,
           pre_match_id, match_id, match_player_id, table_id, release_reason, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (reservation_id) DO UPDATE SET
           status = EXCLUDED.status, pre_match_id = EXCLUDED.pre_match_id,
           match_id = EXCLUDED.match_id, match_player_id = EXCLUDED.match_player_id,
           release_reason = EXCLUDED.release_reason, updated_at = EXCLUDED.updated_at`,
        [reservation.reservationId, reservation.playerId, units(reservation.amount),
          reservation.status, reservation.publicReference, reservation.entryId,
          reservation.preMatchId, reservation.matchId, reservation.matchPlayerId,
          reservation.tableId, reservation.releaseReason, reservation.createdAt, reservation.updatedAt],
      );
    }

    const previousEvents = new Set(before.ledger.map((event) => event.eventId));
    for (const event of after.ledger) {
      if (previousEvents.has(event.eventId)) continue;
      await client.query(
        `INSERT INTO demo_credit_ledger (
           event_id, player_id, event_type, amount_units, previous_available_units,
           new_available_units, previous_reserved_units, new_reserved_units, public_reference,
           match_id, table_id, entry_id, reason, actor, created_at, idempotency_key,
           origin, withdrawable, convertible_to_real_money
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [event.eventId, event.playerId, event.type, units(event.amount),
          units(event.previousAvailableBalance), units(event.newAvailableBalance),
          units(event.previousReservedBalance), units(event.newReservedBalance),
          event.publicReference, event.matchId, event.tableId, event.entryId, event.reason,
          event.actor, event.createdAt, event.idempotencyKey, event.origin,
          event.withdrawable, event.convertibleToRealMoney],
      );
    }
  }

  async run(method, args, serviceOptions) {
    if (!this.initialized) throw new Error('DEMO_CREDITS_STORE_UNAVAILABLE');
    const pendingLogs = [];
    const result = await this.withLock(async (client) => {
      const before = await this.loadState(client);
      const memoryRepository = new DemoCreditsRepository({ initialState: before });
      const service = new DemoCreditsService({
        ...serviceOptions,
        repository: memoryRepository,
        logInfo: (...items) => pendingLogs.push(['logInfo', items]),
        logWarn: (...items) => pendingLogs.push(['logWarn', items]),
        logError: (...items) => pendingLogs.push(['logError', items]),
      });
      const operationResult = service[method](...args);
      await this.persistState(client, before, memoryRepository.snapshot());
      return method === 'getStatus'
        ? { ...operationResult, persistenceConfigured: true }
        : operationResult;
    });
    for (const [level, items] of pendingLogs) serviceOptions[level]?.(...items);
    return result;
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

export class PostgresDemoCreditsService {
  constructor({ repository, enabled = false, startingBalance = 100, historyLimit = 50,
    maxAdminGrant = 10_000, clock = Date.now, logInfo, logWarn, logError } = {}) {
    if (!repository) throw new Error('DEMO_CREDITS_REPOSITORY_REQUIRED');
    this.repository = repository;
    this.enabled = Boolean(enabled);
    this.startingBalance = startingBalance;
    this.options = { enabled, startingBalance, historyLimit, maxAdminGrant, clock, logInfo, logWarn, logError };
  }

  isEnabled() { return this.enabled; }
  isPersistenceConfigured() { return true; }
  getOrCreateAccount(...args) { return this.repository.run('getOrCreateAccount', args, this.options); }
  grantInitialCredits(...args) { return this.repository.run('grantInitialCredits', args, this.options); }
  getBalance(...args) { return this.repository.run('getBalance', args, this.options); }
  getHistory(...args) { return this.repository.run('getHistory', args, this.options); }
  reserveCredits(...args) { return this.repository.run('reserveCredits', args, this.options); }
  releaseReservation(...args) { return this.repository.run('releaseReservation', args, this.options); }
  validateMatchReservations(...args) { return this.repository.run('validateMatchReservations', args, this.options); }
  consumeMatchReservations(...args) { return this.repository.run('consumeMatchReservations', args, this.options); }
  rewardWinner(...args) { return this.repository.run('rewardWinner', args, this.options); }
  compensateMatch(...args) { return this.repository.run('compensateMatch', args, this.options); }
  settleMatchResult(...args) { return this.repository.run('settleMatchResult', args, this.options); }
  adminGrantCredits(...args) { return this.repository.run('adminGrantCredits', args, this.options); }
  adminResetDemoAccount(...args) { return this.repository.run('adminResetDemoAccount', args, this.options); }
  getStatus(...args) { return this.repository.run('getStatus', args, this.options); }
  close() { return this.repository.close(); }
}

export default PostgresDemoCreditsService;
