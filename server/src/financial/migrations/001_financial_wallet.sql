CREATE TABLE IF NOT EXISTS financial_accounts (
  account_id uuid PRIMARY KEY,
  public_id varchar(24) NOT NULL UNIQUE,
  phone_normalized varchar(20) NOT NULL UNIQUE,
  display_name varchar(80) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  available_balance_cents bigint NOT NULL DEFAULT 0 CHECK (available_balance_cents >= 0),
  reserved_balance_cents bigint NOT NULL DEFAULT 0 CHECK (reserved_balance_cents >= 0),
  withdrawal_pending_balance_cents bigint NOT NULL DEFAULT 0 CHECK (withdrawal_pending_balance_cents >= 0),
  provider_customer_id varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_transactions (
  transaction_id uuid PRIMARY KEY,
  public_reference varchar(40) NOT NULL UNIQUE,
  transaction_type varchar(40) NOT NULL,
  status varchar(32) NOT NULL,
  idempotency_key varchar(180) NOT NULL UNIQUE,
  game_code varchar(40),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_ledger_entries (
  entry_id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES financial_transactions(transaction_id),
  account_id uuid REFERENCES financial_accounts(account_id),
  ledger_account varchar(80) NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS financial_ledger_transaction_idx ON financial_ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS financial_ledger_account_idx ON financial_ledger_entries(account_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_financial_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'FINANCIAL_LEDGER_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS financial_ledger_no_update ON financial_ledger_entries;
CREATE TRIGGER financial_ledger_no_update BEFORE UPDATE OR DELETE ON financial_ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_financial_ledger_mutation();

CREATE OR REPLACE FUNCTION reject_confirmed_transaction_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'CONFIRMED' THEN
    RAISE EXCEPTION 'CONFIRMED_FINANCIAL_TRANSACTION_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS financial_transaction_no_mutation ON financial_transactions;
CREATE TRIGGER financial_transaction_no_mutation BEFORE UPDATE OR DELETE ON financial_transactions
FOR EACH ROW EXECUTE FUNCTION reject_confirmed_transaction_mutation();

CREATE TABLE IF NOT EXISTS financial_deposits (
  deposit_id uuid PRIMARY KEY,
  public_reference varchar(40) NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES financial_accounts(account_id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  gross_amount_cents bigint,
  fee_amount_cents bigint,
  net_amount_cents bigint,
  credited_amount_cents bigint,
  status varchar(32) NOT NULL,
  provider varchar(32) NOT NULL,
  provider_payment_id varchar(100) UNIQUE,
  provider_customer_id varchar(100),
  pix_copy_paste text,
  pix_qr_code text,
  expires_at timestamptz,
  credited_transaction_id uuid REFERENCES financial_transactions(transaction_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_match_reservations (
  reservation_id uuid PRIMARY KEY,
  public_reference varchar(40) NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES financial_accounts(account_id),
  game_code varchar(40) NOT NULL,
  entry_id varchar(100) NOT NULL UNIQUE,
  match_id varchar(120),
  table_id varchar(40) NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_match_settlements (
  settlement_id uuid PRIMARY KEY,
  match_id varchar(120) NOT NULL UNIQUE,
  game_code varchar(40) NOT NULL,
  winner_account_id uuid REFERENCES financial_accounts(account_id),
  total_stakes_cents bigint NOT NULL CHECK (total_stakes_cents >= 0),
  platform_fee_cents bigint NOT NULL CHECK (platform_fee_cents >= 0),
  winner_prize_cents bigint NOT NULL CHECK (winner_prize_cents >= 0),
  status varchar(32) NOT NULL,
  transaction_id uuid REFERENCES financial_transactions(transaction_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_withdrawals (
  withdrawal_id uuid PRIMARY KEY,
  public_reference varchar(40) NOT NULL UNIQUE,
  idempotency_key varchar(180) NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES financial_accounts(account_id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  pix_key_type varchar(24) NOT NULL,
  pix_key_ciphertext text NOT NULL,
  holder_name varchar(120) NOT NULL,
  status varchar(40) NOT NULL,
  provider_transfer_id varchar(120) UNIQUE,
  failure_reason varchar(240),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_processed_webhooks (
  webhook_event_id varchar(120) PRIMARY KEY,
  provider varchar(32) NOT NULL,
  event_type varchar(80) NOT NULL,
  payload_hash varchar(64) NOT NULL,
  status varchar(24) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS financial_admin_audit (
  audit_id uuid PRIMARY KEY,
  admin_phone_masked varchar(32) NOT NULL,
  action varchar(80) NOT NULL,
  target_reference varchar(120),
  reason varchar(240),
  previous_state jsonb,
  next_state jsonb,
  amount_cents bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_reconciliations (
  reconciliation_id uuid PRIMARY KEY,
  status varchar(32) NOT NULL,
  provider_balance_cents bigint,
  internal_liability_cents bigint NOT NULL,
  mismatch_cents bigint,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
