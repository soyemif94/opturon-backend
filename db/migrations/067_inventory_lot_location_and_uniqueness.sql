ALTER TABLE inventory_lots
  ADD COLUMN IF NOT EXISTS "locationId" UUID NULL,
  ADD COLUMN IF NOT EXISTS "normalizedLotNumber" TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_inventory_lots_location_tenant'
  ) THEN
    ALTER TABLE inventory_lots
      ADD CONSTRAINT fk_inventory_lots_location_tenant
      FOREIGN KEY ("locationId", "tenantId")
      REFERENCES inventory_locations(id, "tenantId")
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_lots_tenant_location_id
  ON inventory_lots("tenantId", "locationId");

CREATE INDEX IF NOT EXISTS idx_inventory_lots_tenant_product_lot_number
  ON inventory_lots("tenantId", "productId", "lotNumber")
  WHERE "lotNumber" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_lots_tenant_product_normalized_lot
  ON inventory_lots("tenantId", "productId", "normalizedLotNumber", "locationId")
  WHERE "normalizedLotNumber" IS NOT NULL;
