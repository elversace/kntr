-- Run with: psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f migrations/001_delivery_integrity.sql
-- Preserve the financial ledger. Historical duplicates need explicit accounting
-- reconciliation before this protection can be installed.
BEGIN;
LOCK TABLE transactions IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  duplicate_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT order_id, type
    FROM transactions
    WHERE order_id IS NOT NULL AND status = 'completed'
      AND type IN ('order_payment', 'order_refund')
    GROUP BY order_id, type
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Delivery integrity migration blocked: % duplicate completed order payment/refund groups require accounting reconciliation. No ledger rows were deleted.', duplicate_count
      USING HINT = 'Inspect SELECT order_id,type,array_agg(id),sum(amount) FROM transactions WHERE order_id IS NOT NULL AND status=''completed'' AND type IN (''order_payment'',''order_refund'') GROUP BY order_id,type HAVING count(*)>1; preserve and reconcile the financial history, then rerun this migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_completed_order_event
  ON transactions (order_id, type)
  WHERE order_id IS NOT NULL AND status = 'completed'
    AND type IN ('order_payment', 'order_refund');
COMMIT;
