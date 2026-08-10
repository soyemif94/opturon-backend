ALTER TABLE order_customer_notifications
  ADD COLUMN IF NOT EXISTS "resultCode" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "graphRequestStartedAt" TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_order_customer_notifications_result_code_non_empty'
      AND conrelid = 'order_customer_notifications'::regclass
  ) THEN
    ALTER TABLE order_customer_notifications
      ADD CONSTRAINT chk_order_customer_notifications_result_code_non_empty
      CHECK ("resultCode" IS NULL OR length(trim("resultCode")) > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_order_customer_notifications_result_code
  ON order_customer_notifications("resultCode", "updatedAt" DESC)
  WHERE "resultCode" IS NOT NULL;
