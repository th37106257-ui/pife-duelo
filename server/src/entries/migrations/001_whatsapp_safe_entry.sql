CREATE TABLE IF NOT EXISTS whatsapp_safe_entries (
  entry_id TEXT PRIMARY KEY,
  player_binding_hash TEXT NOT NULL,
  selected_table INTEGER NOT NULL,
  entry_status TEXT NOT NULL,
  token_hash TEXT,
  whatsapp_match_id TEXT,
  linked_match_id TEXT,
  player_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  session_key_hash TEXT,
  session_version INTEGER NOT NULL DEFAULT 1,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_safe_entries_claim_pair_check
    CHECK ((claimed_at IS NULL) = (session_key_hash IS NULL))
);

CREATE INDEX IF NOT EXISTS whatsapp_safe_entries_active_token_idx
  ON whatsapp_safe_entries (token_hash)
  WHERE token_hash IS NOT NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_safe_entries_active_token_uq
  ON whatsapp_safe_entries (token_hash)
  WHERE token_hash IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS whatsapp_safe_entries_active_match_idx
  ON whatsapp_safe_entries (whatsapp_match_id, linked_match_id)
  WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_safe_entries_session_hash_uq
  ON whatsapp_safe_entries (session_key_hash)
  WHERE session_key_hash IS NOT NULL;
