ALTER TABLE orders
  ALTER COLUMN "customerName" DROP NOT NULL,
  ALTER COLUMN "customerPhone" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "customerType" TEXT NOT NULL DEFAULT 'registered_contact',
  ADD COLUMN IF NOT EXISTS "sellerUserId" UUID NULL,
  ADD COLUMN IF NOT EXISTS "sellerNameSnapshot" TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_orders_customer_type'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_customer_type
      CHECK ("customerType" IN ('registered_contact', 'final_consumer'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_orders_seller_user_id'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT fk_orders_seller_user_id
      FOREIGN KEY ("sellerUserId")
      REFERENCES staff_users(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_clinic_seller_user
  ON orders("clinicId", "sellerUserId");
