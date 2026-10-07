CREATE TABLE IF NOT EXISTS demo_credit_accounts (
  player_id varchar(20) PRIMARY KEY,
  available_units bigint NOT NULL DEFAULT 0 CHECK (available_units >= 0),
  reserved_units bigint NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  lifetime_granted_units bigint NOT NULL DEFAULT 0 CHECK (lifetime_granted_units >= 0),
  lifetime_consumed_units bigint NOT NULL DEFAULT 0 CHECK (lifetime_consumed_units >= 0),
  lifetime_rewarded_units bigint NOT NULL DEFAULT 0 CHECK (lifetime_rewarded_units >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_credit_reservations (
  reservation_id varchar(80) PRIMARY KEY,
  player_id varchar(20) NOT NULL REFERENCES demo_credit_accounts(player_id),
  amount_units bigint NOT NULL CHECK (amount_units > 0),
  status varchar(24) NOT NULL CHECK (status IN ('reserved', 'consumed', 'released', 'compensated')),
  public_reference varchar(120) NOT NULL,
  entry_id varchar(100) UNIQUE,
  pre_match_id varchar(120),
  match_id varchar(120),
  match_player_id varchar(120),
  table_id integer,
  release_reason varchar(180),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS demo_credit_one_active_reservation_per_player
  ON demo_credit_reservations(player_id) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS demo_credit_reservations_match_idx
  ON demo_credit_reservations(match_id, status);

CREATE TABLE IF NOT EXISTS demo_credit_ledger (
  sequence bigserial PRIMARY KEY,
  event_id varchar(80) NOT NULL UNIQUE,
  player_id varchar(20) NOT NULL REFERENCES demo_credit_accounts(player_id),
  event_type varchar(48) NOT NULL,
  amount_units bigint NOT NULL,
  previous_available_units bigint NOT NULL CHECK (previous_available_units >= 0),
  new_available_units bigint NOT NULL CHECK (new_available_units >= 0),
  previous_reserved_units bigint NOT NULL CHECK (previous_reserved_units >= 0),
  new_reserved_units bigint NOT NULL CHECK (new_reserved_units >= 0),
  public_reference varchar(120),
  match_id varchar(120),
  table_id integer,
  entry_id varchar(100),
  reason varchar(180),
  actor varchar(80) NOT NULL,
  created_at timestamptz NOT NULL,
  idempotency_key varchar(220) NOT NULL UNIQUE,
  origin varchar(32) NOT NULL DEFAULT 'TEST_CREDIT' CHECK (origin = 'TEST_CREDIT'),
  withdrawable boolean NOT NULL DEFAULT false CHECK (withdrawable = false),
  convertible_to_real_money boolean NOT NULL DEFAULT false CHECK (convertible_to_real_money = false)
);

CREATE INDEX IF NOT EXISTS demo_credit_ledger_player_idx
  ON demo_credit_ledger(player_id, sequence DESC);
