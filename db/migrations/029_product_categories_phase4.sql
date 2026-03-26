CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_product_categories_clinic_name
  ON product_categories ("clinicId", lower(name));

CREATE INDEX IF NOT EXISTS idx_product_categories_clinic_active
  ON product_categories ("clinicId", "isActive", "createdAt" DESC);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS "categoryId" UUID NULL REFERENCES product_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_clinic_category
  ON products ("clinicId", "categoryId");
