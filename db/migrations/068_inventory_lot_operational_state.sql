ALTER TABLE inventory_lots
  ADD COLUMN IF NOT EXISTS "operationalStatus" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "blockedBy" UUID NULL,
  ADD COLUMN IF NOT EXISTS "blockReason" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "writtenOffAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "writtenOffBy" UUID NULL,
  ADD COLUMN IF NOT EXISTS "writeoffReason" TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_inventory_lots_operational_status'
  ) THEN
    ALTER TABLE inventory_lots
      ADD CONSTRAINT chk_inventory_lots_operational_status
      CHECK ("operationalStatus" IS NULL OR "operationalStatus" IN ('active', 'blocked', 'written_off'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_lots_tenant_operational_status
  ON inventory_lots("tenantId", "operationalStatus");
