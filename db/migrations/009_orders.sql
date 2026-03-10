CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "contactId" UUID NULL REFERENCES contacts(id) ON DELETE SET NULL,
  "customerName" TEXT NOT NULL,
  "customerPhone" TEXT NOT NULL,
  notes TEXT NULL,
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'ARS',
  "paymentStatus" TEXT NOT NULL DEFAULT 'pending',
  "orderStatus" TEXT NOT NULL DEFAULT 'new',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_orders_payment_status
    CHECK ("paymentStatus" IN ('unpaid', 'pending', 'paid', 'refunded', 'cancelled')),
  CONSTRAINT chk_orders_order_status
    CHECK ("orderStatus" IN ('new', 'pending_payment', 'paid', 'preparing', 'ready', 'delivered', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_orders_clinic_created_at
  ON orders("clinicId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_orders_clinic_status
  ON orders("clinicId", "orderStatus");

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  "productId" UUID NULL,
  "nameSnapshot" TEXT NOT NULL,
  "priceSnapshot" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  variant TEXT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_created
  ON order_items("orderId", "createdAt");
