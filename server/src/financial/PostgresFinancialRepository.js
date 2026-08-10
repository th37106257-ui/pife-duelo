import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const migrationPath = join(dirname(fileURLToPath(import.meta.url)), 'migrations', '001_financial_wallet.sql');

export class PostgresFinancialRepository {
  constructor({ connectionString, pool = null, ssl = null, serializableTransactions = true, manageTransactions = true } = {}) {
    if (!pool && !connectionString) throw new Error('FINANCIAL_DATABASE_REQUIRED');
    this.pool = pool ?? new Pool({
      connectionString,
      ssl: ssl ?? (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.ownsPool = !pool;
    this.serializableTransactions = serializableTransactions;
    this.manageTransactions = manageTransactions;
  }

  async initialize() {
    await this.pool.query(readFileSync(migrationPath, 'utf8'));
    return true;
  }

  async transaction(operation) {
    const client = await this.pool.connect();
    try {
      if (this.manageTransactions) await client.query('BEGIN');
      if (this.manageTransactions && this.serializableTransactions) await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const result = await operation(client);
      if (this.manageTransactions) await client.query('COMMIT');
      return result;
    } catch (error) {
      if (this.manageTransactions) try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
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
