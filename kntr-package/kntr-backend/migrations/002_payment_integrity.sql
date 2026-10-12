-- Run after 001_delivery_integrity.sql with psql -v ON_ERROR_STOP=1.
-- No balance, payment history or existing payout is rewritten or fabricated.
BEGIN;
LOCK TABLE wallets IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  invalid_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO invalid_count FROM wallets
  WHERE balance IS NULL OR balance < 0 OR balance = 'NaN'::numeric;
  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'Payment integrity migration blocked: % wallets have null, negative or nonfinite balances. No balances were changed.', invalid_count
      USING HINT = 'Reconcile the affected wallet balances against their payment history, preserve the accounting evidence, then rerun this migration.';
  END IF;

  SELECT COUNT(*) INTO invalid_count FROM wallets
  WHERE currency IS NULL OR currency !~ '^[A-Z]{3}$';
  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'Payment integrity migration blocked: % wallets have missing or invalid currencies. No currencies were changed.', invalid_count
      USING HINT = 'Reconcile each affected wallet currency with its payment history before rerunning this migration.';
  END IF;
END $$;

ALTER TABLE wallets ALTER COLUMN balance SET NOT NULL;
ALTER TABLE wallets ALTER COLUMN currency SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'wallets'::regclass AND conname = 'wallets_balance_nonnegative') THEN
    ALTER TABLE wallets ADD CONSTRAINT wallets_balance_nonnegative
      CHECK (balance >= 0 AND balance <> 'NaN'::numeric);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'wallets'::regclass AND conname = 'wallets_currency_valid') THEN
    ALTER TABLE wallets ADD CONSTRAINT wallets_currency_valid CHECK (currency ~ '^[A-Z]{3}$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS payout_items (
  order_id VARCHAR(20) PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  payout_id VARCHAR(20) NOT NULL REFERENCES driver_payouts(id) ON DELETE RESTRICT,
  amount DECIMAL(10,2) NOT NULL
    CONSTRAINT payout_items_amount_positive CHECK (amount > 0 AND amount <> 'NaN'::numeric),
  currency VARCHAR(3) NOT NULL
    CONSTRAINT payout_items_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payout_items_payout ON payout_items(payout_id);

-- Existing payouts deliberately receive no guessed allocations. The API blocks
-- new payouts for a driver with active legacy payouts lacking order allocations
-- until a separate accounting reconciliation establishes which orders they paid.
COMMIT;
