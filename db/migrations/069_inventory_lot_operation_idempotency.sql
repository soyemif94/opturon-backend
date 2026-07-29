CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS inventory_lot_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "productId" UUID NOT NULL,
  "lotId" UUID NULL,
  "operationType" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  "requestMetadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdBy" UUID NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ NULL,
  "failureCode" TEXT NULL,
  CONSTRAINT chk_inventory_lot_operations_status
    CHECK (status IN ('pending', 'processing', 'completed', 'partially_completed', 'failed')),
  CONSTRAINT chk_inventory_lot_operations_operation_type_non_empty
    CHECK (length(trim("operationType")) > 0),
  CONSTRAINT chk_inventory_lot_operations_idempotency_key_non_empty
    CHECK (length(trim("idempotencyKey")) > 0),
  CONSTRAINT fk_inventory_lot_operations_product_tenant
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES products(id, "clinicId")
    ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_lot_operations_lot_tenant_product
    FOREIGN KEY ("lotId", "tenantId", "productId")
    REFERENCES inventory_lots(id, "tenantId", "productId")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_lot_operations_tenant_type_key
  ON inventory_lot_operations("tenantId", "operationType", "idempotencyKey");

CREATE INDEX IF NOT EXISTS idx_inventory_lot_operations_tenant_created_at
  ON inventory_lot_operations("tenantId", "createdAt" DESC);
