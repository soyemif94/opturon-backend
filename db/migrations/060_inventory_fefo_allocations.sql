CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE inventory_movements
  DROP CONSTRAINT IF EXISTS chk_inventory_movements_type;

ALTER TABLE inventory_movements
  ADD CONSTRAINT chk_inventory_movements_type
    CHECK ("movementType" IN (
      'initial_stock',
      'purchase_receipt',
      'manual_adjustment_in',
      'manual_adjustment_out',
      'expired_writeoff',
      'cancellation',
      'sale'
    ));

CREATE TABLE IF NOT EXISTS inventory_lot_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "orderId" UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  "orderItemId" UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  "productId" UUID NOT NULL,
  "lotId" UUID NOT NULL,
  quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'consumed',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "releasedAt" TIMESTAMPTZ NULL,
  CONSTRAINT chk_inventory_lot_allocations_status
    CHECK (status IN ('allocated', 'consumed', 'released', 'cancelled')),
  CONSTRAINT fk_inventory_lot_allocations_product_tenant
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES products(id, "clinicId")
    ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_lot_allocations_lot_tenant_product
    FOREIGN KEY ("lotId", "tenantId", "productId")
    REFERENCES inventory_lots(id, "tenantId", "productId")
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_lot_allocations_order
  ON inventory_lot_allocations ("tenantId", "orderId");

CREATE INDEX IF NOT EXISTS idx_inventory_lot_allocations_order_item
  ON inventory_lot_allocations ("orderItemId");

CREATE INDEX IF NOT EXISTS idx_inventory_lot_allocations_lot
  ON inventory_lot_allocations ("tenantId", "lotId", status);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_lot_allocations_active_order_item_lot
  ON inventory_lot_allocations ("orderItemId", "lotId")
  WHERE status IN ('allocated', 'consumed');

-- Rollback, if required:
-- DROP TABLE IF EXISTS inventory_lot_allocations;
-- ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS chk_inventory_movements_type;
-- ALTER TABLE inventory_movements ADD CONSTRAINT chk_inventory_movements_type
--   CHECK ("movementType" IN ('initial_stock','purchase_receipt','manual_adjustment_in','manual_adjustment_out','expired_writeoff','cancellation'));
