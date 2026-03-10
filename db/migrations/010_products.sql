CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NULL,
  price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'ARS',
  stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  status TEXT NOT NULL DEFAULT 'active',
  sku TEXT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_products_status CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS idx_products_clinic_created_at
  ON products("clinicId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_products_clinic_status
  ON products("clinicId", status);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_products_clinic_sku
  ON products("clinicId", sku)
  WHERE sku IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_order_items_product_id'
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT fk_order_items_product_id
      FOREIGN KEY ("productId")
      REFERENCES products(id)
      ON DELETE SET NULL;
  END IF;
END $$;
