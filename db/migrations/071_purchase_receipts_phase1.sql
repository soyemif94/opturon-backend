CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS purchase_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "supplierId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  "documentNumber" TEXT NULL,
  "receivedAt" TIMESTAMPTZ NOT NULL,
  notes TEXT NULL,
  "idempotencyKey" TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdBy" UUID NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "confirmedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_purchase_receipts_idempotency_key_non_empty
    CHECK (length(trim("idempotencyKey")) > 0)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_purchase_receipts_id_tenant'
  ) THEN
    ALTER TABLE purchase_receipts
      ADD CONSTRAINT uq_purchase_receipts_id_tenant
      UNIQUE (id, "tenantId");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_purchase_receipts_supplier_tenant'
  ) THEN
    ALTER TABLE purchase_receipts
      ADD CONSTRAINT fk_purchase_receipts_supplier_tenant
      FOREIGN KEY ("supplierId", "tenantId")
      REFERENCES suppliers(id, "tenantId")
      ON DELETE RESTRICT
      ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_purchase_receipts_location_tenant'
  ) THEN
    ALTER TABLE purchase_receipts
      ADD CONSTRAINT fk_purchase_receipts_location_tenant
      FOREIGN KEY ("locationId", "tenantId")
      REFERENCES inventory_locations(id, "tenantId")
      ON DELETE RESTRICT
      ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_purchase_receipts_tenant_idempotency
  ON purchase_receipts("tenantId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS idx_purchase_receipts_tenant_received_at
  ON purchase_receipts("tenantId", "receivedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_receipts_tenant_supplier_received_at
  ON purchase_receipts("tenantId", "supplierId", "receivedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_receipts_tenant_location_received_at
  ON purchase_receipts("tenantId", "locationId", "receivedAt" DESC);

CREATE TABLE IF NOT EXISTS purchase_receipt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "receiptId" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  quantity NUMERIC(14, 3) NOT NULL,
  "unitCost" NUMERIC(14, 4) NULL,
  "lotNumber" TEXT NULL,
  "normalizedLotNumber" TEXT NULL,
  "expiresAt" DATE NULL,
  "inventoryLotId" UUID NULL,
  "inventoryMovementId" UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_purchase_receipt_items_quantity_positive
    CHECK (quantity > 0),
  CONSTRAINT chk_purchase_receipt_items_unit_cost_non_negative
    CHECK ("unitCost" IS NULL OR "unitCost" >= 0),
  CONSTRAINT fk_purchase_receipt_items_receipt_tenant
    FOREIGN KEY ("receiptId", "tenantId")
    REFERENCES purchase_receipts(id, "tenantId")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT fk_purchase_receipt_items_product_tenant
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES products(id, "clinicId")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT fk_purchase_receipt_items_inventory_lot_tenant_product
    FOREIGN KEY ("inventoryLotId", "tenantId", "productId")
    REFERENCES inventory_lots(id, "tenantId", "productId")
    ON DELETE RESTRICT
    ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_receipt_tenant
  ON purchase_receipt_items("receiptId", "tenantId");

CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_tenant_product
  ON purchase_receipt_items("tenantId", "productId");

CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_inventory_lot
  ON purchase_receipt_items("inventoryLotId")
  WHERE "inventoryLotId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_inventory_movement
  ON purchase_receipt_items("inventoryMovementId")
  WHERE "inventoryMovementId" IS NOT NULL;
