CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "legalName" TEXT NOT NULL,
  "tradeName" TEXT NULL,
  "normalizedTaxId" TEXT NULL,
  "taxId" TEXT NULL,
  email TEXT NULL,
  phone TEXT NULL,
  address TEXT NULL,
  notes TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  "createdBy" UUID NULL,
  "updatedBy" UUID NULL,
  "deactivatedAt" TIMESTAMPTZ NULL,
  "deactivatedBy" UUID NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_suppliers_legal_name_non_empty
    CHECK (length(trim("legalName")) > 0),
  CONSTRAINT chk_suppliers_status
    CHECK (status IN ('active', 'inactive')),
  CONSTRAINT chk_suppliers_normalized_tax_id_non_empty
    CHECK ("normalizedTaxId" IS NULL OR length(trim("normalizedTaxId")) > 0),
  CONSTRAINT chk_suppliers_email_format
    CHECK (
      email IS NULL
      OR email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
    ),
  CONSTRAINT chk_suppliers_notes_length
    CHECK (notes IS NULL OR char_length(notes) <= 2000)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_suppliers_id_tenant'
  ) THEN
    ALTER TABLE suppliers
      ADD CONSTRAINT uq_suppliers_id_tenant
      UNIQUE (id, "tenantId");
  END IF;
END $$;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS "defaultSupplierId" UUID NULL;

CREATE INDEX IF NOT EXISTS idx_products_clinic_default_supplier
  ON products("clinicId", "defaultSupplierId")
  WHERE "defaultSupplierId" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_products_default_supplier_tenant'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT fk_products_default_supplier_tenant
      FOREIGN KEY ("defaultSupplierId", "clinicId")
      REFERENCES suppliers(id, "tenantId")
      ON DELETE NO ACTION
      ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_suppliers_tenant_status
  ON suppliers("tenantId", status);

CREATE INDEX IF NOT EXISTS idx_suppliers_tenant_updated_at
  ON suppliers("tenantId", "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_suppliers_tenant_name
  ON suppliers("tenantId", "legalName", "tradeName");

CREATE UNIQUE INDEX IF NOT EXISTS uniq_suppliers_tenant_normalized_tax_id
  ON suppliers("tenantId", "normalizedTaxId")
  WHERE "normalizedTaxId" IS NOT NULL;
