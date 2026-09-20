import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function listFinancialMigrations() {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_.+\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export function resolveFinancialDatabaseSsl({ connectionString, ssl = null, nodeEnv = process.env.NODE_ENV } = {}) {
  if (ssl !== null && ssl !== undefined) return ssl;
  if (nodeEnv !== 'production') return undefined;
  try {
    const hostname = new URL(connectionString).hostname.toLowerCase();
    if (hostname.endsWith('.railway.internal')) return { rejectUnauthorized: false };
  } catch {}
  return { rejectUnauthorized: true };
}

export class PostgresFinancialRepository {
  constructor({
    connectionString,
    pool = null,
    ssl = null,
    serializableTransactions = true,
    manageTransactions = true,
    maxSerializableRetries = 3,
    supportsSkipLocked = true,
  } = {}) {
    if (!pool && !connectionString) throw new Error('FINANCIAL_DATABASE_REQUIRED');
    this.pool = pool ?? new Pool({
      connectionString,
      ssl: resolveFinancialDatabaseSsl({ connectionString, ssl }),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.ownsPool = !pool;
    this.serializableTransactions = serializableTransactions;
    this.manageTransactions = manageTransactions;
    this.maxSerializableRetries = Math.max(0, Math.min(10, Number(maxSerializableRetries) || 0));
    this.supportsSkipLocked = supportsSkipLocked !== false;
  }

  async initialize() {
    for (const migration of listFinancialMigrations()) {
      await this.pool.query(readFileSync(join(migrationsDirectory, migration), 'utf8'));
    }
    return true;
  }

  async transaction(operation) {
    let attempt = 0;
    while (true) {
      const client = await this.pool.connect();
      try {
        if (this.manageTransactions) await client.query('BEGIN');
        if (this.manageTransactions && this.serializableTransactions) await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        const result = await operation(client);
        if (this.manageTransactions) await client.query('COMMIT');
        return result;
      } catch (error) {
        if (this.manageTransactions) try { await client.query('ROLLBACK'); } catch {}
        const canRetry = this.manageTransactions
          && this.serializableTransactions
          && ['40001', '40P01'].includes(error?.code)
          && attempt < this.maxSerializableRetries;
        if (!canRetry) throw error;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, attempt * 10));
      } finally {
        client.release();
      }
    }
  }

  query(text, values = []) {
    return this.pool.query(text, values);
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

export default PostgresFinancialRepository;
