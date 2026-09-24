import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const migrationPath = join(dirname(fileURLToPath(import.meta.url)), 'migrations', '001_whatsapp_safe_entry.sql');
const ACTIVE_ENTRY_STATUSES = ['approved_for_queue', 'queued', 'linked', 'playing', 'requeued_after_opponent_cancel'];

function toAuthRecord(row) {
  if (!row) return null;
  return {
    entryId: row.entry_id,
    playerBindingHash: row.player_binding_hash,
    selectedTable: Number(row.selected_table),
    status: row.entry_status,
    accessTokenHash: row.token_hash,
    accessExpiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    accessSessionClaimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    accessSessionTokenHash: row.session_key_hash,
    sessionVersion: Number(row.session_version) || 1,
    whatsappMatchId: row.whatsapp_match_id,
    linkedMatchId: row.linked_match_id,
    playerId: row.player_id,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

function isRailwayPrivateHost(connectionString) {
  try {
    return new URL(connectionString).hostname.toLowerCase().endsWith('.railway.internal');
  } catch {
    return false;
  }
}

export class PostgresWhatsAppEntryAccessRepository {
  constructor({ connectionString, pool = null, ssl = undefined } = {}) {
    if (!pool && !connectionString) throw new Error('SAFE_ENTRY_DATABASE_REQUIRED');
    this.pool = pool ?? new Pool({
      connectionString,
      ssl: ssl ?? (isRailwayPrivateHost(connectionString) ? { rejectUnauthorized: false } : undefined),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.ownsPool = !pool;
  }

  async initialize() {
    await this.pool.query(readFileSync(migrationPath, 'utf8'));
    return true;
  }

  async issueAccess(entry, playerBindingHash) {
    const result = await this.pool.query(
      `INSERT INTO whatsapp_safe_entries (
         entry_id, player_binding_hash, selected_table, entry_status, token_hash,
         whatsapp_match_id, linked_match_id, player_id, expires_at, session_version,
         claimed_at, session_key_hash, revoked_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL, NULL, NOW())
       ON CONFLICT (entry_id) DO UPDATE SET
         selected_table = EXCLUDED.selected_table,
         entry_status = EXCLUDED.entry_status,
         token_hash = EXCLUDED.token_hash,
         whatsapp_match_id = EXCLUDED.whatsapp_match_id,
         linked_match_id = EXCLUDED.linked_match_id,
         player_id = EXCLUDED.player_id,
         expires_at = EXCLUDED.expires_at,
         session_version = EXCLUDED.session_version,
         updated_at = NOW()
       WHERE whatsapp_safe_entries.player_binding_hash = EXCLUDED.player_binding_hash
         AND whatsapp_safe_entries.claimed_at IS NULL
         AND whatsapp_safe_entries.session_key_hash IS NULL
         AND whatsapp_safe_entries.revoked_at IS NULL
       RETURNING entry_id`,
      [
        entry.entryId,
        playerBindingHash,
        Number(entry.selectedTable),
        entry.status,
        entry.accessTokenHash,
        entry.whatsappMatchId || null,
        entry.linkedMatchId || null,
        entry.playerId || null,
        entry.accessExpiresAt,
        Math.max(1, Number(entry.sessionVersion) || 1),
      ],
    );
    if (result.rowCount !== 1) {
      const existing = await this.pool.query(
        'SELECT player_binding_hash FROM whatsapp_safe_entries WHERE entry_id = $1',
        [entry.entryId],
      );
      if (existing.rows[0] && existing.rows[0].player_binding_hash !== playerBindingHash) {
        throw new Error('SAFE_ENTRY_BINDING_MISMATCH');
      }
      throw new Error('SAFE_ENTRY_ISSUE_REJECTED');
    }
    return true;
  }

  async findByTokenHash(tokenHash) {
    const result = await this.pool.query(
      `SELECT * FROM whatsapp_safe_entries
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
         AND entry_status = ANY($2::text[])
       LIMIT 2`,
      [tokenHash, ACTIVE_ENTRY_STATUSES],
    );
    if (result.rows.length !== 1) return null;
    return toAuthRecord(result.rows[0]);
  }

  async claimOrRecover({ entryId, expectedMatchId = null, tokenHash = null, sessionKeyHash = null, nextSessionKeyHash = null }) {
    if (!nextSessionKeyHash) throw new Error('SAFE_ENTRY_SESSION_KEY_REQUIRED');
    const claimed = await this.pool.query(
      `UPDATE whatsapp_safe_entries
       SET claimed_at = NOW(), session_key_hash = $2, updated_at = NOW()
       WHERE entry_id = $1
         AND ($3::text IS NULL OR COALESCE(linked_match_id, whatsapp_match_id) = $3)
         AND ($4::text IS NULL OR token_hash = $4)
         AND claimed_at IS NULL
         AND $6::text IS NULL
         AND revoked_at IS NULL
         AND expires_at > NOW()
         AND entry_status = ANY($5::text[])
       RETURNING *`,
      [entryId, nextSessionKeyHash, expectedMatchId, tokenHash, ACTIVE_ENTRY_STATUSES, sessionKeyHash],
    );
    if (claimed.rowCount === 1) return { claimed: true, entry: toAuthRecord(claimed.rows[0]) };

    const current = await this.pool.query(
      `SELECT * FROM whatsapp_safe_entries
       WHERE entry_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
         AND entry_status = ANY($2::text[])
         AND ($3::text IS NULL OR COALESCE(linked_match_id, whatsapp_match_id) = $3)
         AND ($4::text IS NULL OR token_hash = $4)
       LIMIT 2`,
      [entryId, ACTIVE_ENTRY_STATUSES, expectedMatchId, tokenHash],
    );
    if (current.rows.length !== 1) throw new Error('ENTRY_ACCESS_DENIED');
    const entry = toAuthRecord(current.rows[0]);
    if (!entry.accessSessionTokenHash) {
      if (sessionKeyHash) throw new Error('ENTRY_ACCESS_DENIED');
      throw new Error('ENTRY_DUPLICATE_SESSION');
    }
    if (!sessionKeyHash) throw new Error('ENTRY_DUPLICATE_SESSION');
    return { claimed: false, entry };
  }

  async findBySession({ matchId, sessionKeyHash }) {
    const result = await this.pool.query(
      `SELECT * FROM whatsapp_safe_entries
       WHERE COALESCE(linked_match_id, whatsapp_match_id) = $1
         AND session_key_hash = $2
         AND revoked_at IS NULL
         AND expires_at > NOW()
         AND entry_status = ANY($3::text[])
       LIMIT 2`,
      [matchId, sessionKeyHash, ACTIVE_ENTRY_STATUSES],
    );
    if (result.rows.length !== 1) throw new Error('ENTRY_ACCESS_DENIED');
    return toAuthRecord(result.rows[0]);
  }

  async bindMatch({ entryId, playerBindingHash, whatsappMatchId = null, linkedMatchId = null, playerId = null, status = null }) {
    const result = await this.pool.query(
      `UPDATE whatsapp_safe_entries
       SET whatsapp_match_id = COALESCE($3, whatsapp_match_id),
           linked_match_id = COALESCE($4, linked_match_id),
           player_id = COALESCE($5, player_id),
           entry_status = COALESCE($6, entry_status),
           updated_at = NOW()
       WHERE entry_id = $1 AND player_binding_hash = $2
         AND revoked_at IS NULL AND expires_at > NOW()
       RETURNING entry_id`,
      [entryId, playerBindingHash, whatsappMatchId, linkedMatchId, playerId, status],
    );
    if (result.rowCount !== 1) throw new Error('SAFE_ENTRY_STORE_UNAVAILABLE');
    return true;
  }

  async revoke({ entryId, playerBindingHash }) {
    const result = await this.pool.query(
      `UPDATE whatsapp_safe_entries
       SET entry_status = 'revoked', token_hash = NULL, revoked_at = COALESCE(revoked_at, NOW()), updated_at = NOW()
       WHERE entry_id = $1 AND player_binding_hash = $2 AND revoked_at IS NULL
       RETURNING entry_id`,
      [entryId, playerBindingHash],
    );
    return result.rowCount === 1;
  }

  async countEntry(entryId) {
    const result = await this.pool.query(
      'SELECT COUNT(*)::integer AS count FROM whatsapp_safe_entries WHERE entry_id = $1',
      [entryId],
    );
    return Number(result.rows[0]?.count || 0);
  }

  async getEntry(entryId) {
    const result = await this.pool.query('SELECT * FROM whatsapp_safe_entries WHERE entry_id = $1', [entryId]);
    return toAuthRecord(result.rows[0] || null);
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

export default PostgresWhatsAppEntryAccessRepository;
