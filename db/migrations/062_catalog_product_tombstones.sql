ALTER TABLE products
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "deletedBy" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "deleteReason" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "deletionMetadata" JSONB NOT NULL DEFAULT '{}'::jsonb;

DROP INDEX IF EXISTS uniq_products_clinic_sku;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_products_clinic_sku
  ON products("clinicId", sku)
  WHERE sku IS NOT NULL AND "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS idx_products_clinic_deleted_at
  ON products("clinicId", "deletedAt");

-- Tombstones intentionally retain the product row. Inventory, orders and invoices
-- keep their existing references and historical snapshots; no destructive cascade
-- is introduced by this migration.
