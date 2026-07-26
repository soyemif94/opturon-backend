CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS "internalCode" TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_products_internal_code_format'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT chk_products_internal_code_format
      CHECK ("internalCode" IS NULL OR "internalCode" ~ '^[A-Z]-[0-9]{4}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_products_clinic_internal_code
  ON products("clinicId", "internalCode")
  WHERE "internalCode" IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_internal_code_allocators (
  "clinicId" UUID PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
  "nextValue" INTEGER NOT NULL DEFAULT 0 CHECK ("nextValue" >= 0 AND "nextValue" <= 260000),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_inventory_locations_code_non_empty CHECK (length(trim(code)) > 0),
  CONSTRAINT chk_inventory_locations_name_non_empty CHECK (length(trim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_locations_tenant_code
  ON inventory_locations("tenantId", code);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_locations_primary_per_tenant
  ON inventory_locations("tenantId")
  WHERE "isPrimary" = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_locations_id_tenant
  ON inventory_locations(id, "tenantId");

CREATE TABLE IF NOT EXISTS inventory_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "productId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  quantity NUMERIC(14, 3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_inventory_balances_product_tenant
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES products(id, "clinicId")
    ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_balances_location_tenant
    FOREIGN KEY ("locationId", "tenantId")
    REFERENCES inventory_locations(id, "tenantId")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_balances_tenant_product_location
  ON inventory_balances("tenantId", "productId", "locationId");

CREATE INDEX IF NOT EXISTS idx_inventory_balances_tenant_product
  ON inventory_balances("tenantId", "productId");

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS "locationId" UUID NULL,
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT NULL,
  ADD COLUMN IF NOT EXISTS unit TEXT NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'posted',
  ADD COLUMN IF NOT EXISTS "reversalOfMovementId" UUID NULL,
  ADD COLUMN IF NOT EXISTS "reversedByMovementId" UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_inventory_movements_status'
  ) THEN
    ALTER TABLE inventory_movements
      ADD CONSTRAINT chk_inventory_movements_status
      CHECK (status IN ('posted', 'reversed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_inventory_movements_location_tenant'
  ) THEN
    ALTER TABLE inventory_movements
      ADD CONSTRAINT fk_inventory_movements_location_tenant
      FOREIGN KEY ("locationId", "tenantId")
      REFERENCES inventory_locations(id, "tenantId")
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_inventory_movements_reversal_of'
  ) THEN
    ALTER TABLE inventory_movements
      ADD CONSTRAINT fk_inventory_movements_reversal_of
      FOREIGN KEY ("reversalOfMovementId")
      REFERENCES inventory_movements(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_inventory_movements_reversed_by'
  ) THEN
    ALTER TABLE inventory_movements
      ADD CONSTRAINT fk_inventory_movements_reversed_by
      FOREIGN KEY ("reversedByMovementId")
      REFERENCES inventory_movements(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_movements_tenant_type_idempotency
  ON inventory_movements("tenantId", "movementType", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_movements_tenant_product_location_created
  ON inventory_movements("tenantId", "productId", "locationId", "createdAt" DESC);
