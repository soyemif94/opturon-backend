CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS order_stock_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "orderId" UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  "orderItemId" UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  "productId" UUID NOT NULL,
  quantity NUMERIC(14, 3) NOT NULL CHECK (quantity >= 0),
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "releasedAt" TIMESTAMPTZ NULL,
  CONSTRAINT chk_order_stock_reservations_status
    CHECK (status IN ('active', 'released', 'committed', 'cancelled')),
  CONSTRAINT fk_order_stock_reservations_product_tenant
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES products(id, "clinicId")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_stock_reservations_active_item
  ON order_stock_reservations ("orderItemId")
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_order_stock_reservations_product_active
  ON order_stock_reservations ("tenantId", "productId", status);

CREATE INDEX IF NOT EXISTS idx_order_stock_reservations_order
  ON order_stock_reservations ("tenantId", "orderId");

CREATE TABLE IF NOT EXISTS order_automation_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "conversationId" UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  "orderId" UUID NULL REFERENCES orders(id) ON DELETE SET NULL,
  "productId" UUID NULL,
  "sourceMessageId" UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'processing',
  "previousQuantity" NUMERIC(14, 3) NULL,
  "newQuantity" NUMERIC(14, 3) NULL,
  "reservationDelta" NUMERIC(14, 3) NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_order_automation_operations_result
    CHECK (result IN ('processing', 'applied', 'skipped', 'failed')),
  CONSTRAINT fk_order_automation_operations_product_tenant
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES products(id, "clinicId")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_automation_operations_source_message
  ON order_automation_operations ("tenantId", "sourceMessageId");

CREATE INDEX IF NOT EXISTS idx_order_automation_operations_conversation
  ON order_automation_operations ("tenantId", "conversationId", "createdAt" DESC);

-- Rollback, if required:
-- DROP TABLE IF EXISTS order_automation_operations;
-- DROP TABLE IF EXISTS order_stock_reservations;
