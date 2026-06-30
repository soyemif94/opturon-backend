CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_products_id_clinic_id
  ON products(id, "clinicId");

CREATE TABLE IF NOT EXISTS inventory_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "productId" UUID NOT NULL,
  "lotNumber" TEXT NULL,
  "supplierName" TEXT NULL,
  "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "manufacturedAt" DATE NULL,
  "expiresAt" DATE NULL,
  "initialQuantity" NUMERIC(14, 3) NOT NULL CHECK ("initialQuantity" >= 0),
  "availableQuantity" NUMERIC(14, 3) NOT NULL CHECK ("availableQuantity" >= 0),
  "unitCost" NUMERIC(14, 4) NULL CHECK ("unitCost" IS NULL OR "unitCost" >= 0),
  "warehouseName" TEXT NULL,
  "locationName" TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdBy" UUID NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_inventory_lots_status
    CHECK (status IN ('active', 'depleted', 'expired', 'quarantined', 'cancelled')),
  CONSTRAINT fk_inventory_lots_product_tenant
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES products(id, "clinicId")
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_tenant_product
  ON inventory_lots ("tenantId", "productId", status);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_tenant_expires_at
  ON inventory_lots ("tenantId", "expiresAt")
  WHERE "expiresAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_lots_tenant_lot_number
  ON inventory_lots ("tenantId", "lotNumber")
  WHERE "lotNumber" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_lots_tenant_location
  ON inventory_lots ("tenantId", "warehouseName", "locationName");

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_lots_id_tenant_product
  ON inventory_lots(id, "tenantId", "productId");

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "productId" UUID NOT NULL,
  "lotId" UUID NULL,
  "movementType" TEXT NOT NULL,
  quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
  "quantityBefore" NUMERIC(14, 3) NULL CHECK ("quantityBefore" IS NULL OR "quantityBefore" >= 0),
  "quantityAfter" NUMERIC(14, 3) NULL CHECK ("quantityAfter" IS NULL OR "quantityAfter" >= 0),
  "referenceType" TEXT NULL,
  "referenceId" UUID NULL,
  reason TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdBy" UUID NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_inventory_movements_type
    CHECK ("movementType" IN (
      'initial_stock',
      'purchase_receipt',
      'manual_adjustment_in',
      'manual_adjustment_out',
      'expired_writeoff',
      'cancellation'
    )),
  CONSTRAINT fk_inventory_movements_product_tenant
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES products(id, "clinicId")
    ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_movements_lot_tenant_product
    FOREIGN KEY ("lotId", "tenantId", "productId")
    REFERENCES inventory_lots(id, "tenantId", "productId")
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_tenant_created_at
  ON inventory_movements ("tenantId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_lot_created_at
  ON inventory_movements ("lotId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_created_at
  ON inventory_movements ("tenantId", "productId", "createdAt" DESC);

-- Rollback phase 1, if required:
-- DROP TABLE IF EXISTS inventory_movements;
-- DROP TABLE IF EXISTS inventory_lots;
-- DROP INDEX IF EXISTS uniq_products_id_clinic_id;
