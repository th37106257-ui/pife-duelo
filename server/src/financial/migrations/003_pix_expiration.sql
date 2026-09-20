CREATE INDEX IF NOT EXISTS financial_deposits_expiration_idx
  ON financial_deposits(expires_at)
  WHERE status = 'PENDING';
