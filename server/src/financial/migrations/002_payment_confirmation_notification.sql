CREATE TABLE IF NOT EXISTS financial_payment_notifications (
  notification_id uuid PRIMARY KEY,
  deposit_id uuid NOT NULL UNIQUE REFERENCES financial_deposits(deposit_id),
  notification_key varchar(220) NOT NULL UNIQUE,
  status varchar(24) NOT NULL,
  phone_normalized varchar(20) NOT NULL,
  message text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error varchar(240),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS financial_payment_notifications_retry_idx
  ON financial_payment_notifications(status, updated_at);
