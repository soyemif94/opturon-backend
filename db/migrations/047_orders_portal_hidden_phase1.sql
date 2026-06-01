ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS "portalHiddenAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "portalHiddenByUserId" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "portalHiddenByName" TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_clinic_portal_hidden_at
  ON orders ("clinicId", "portalHiddenAt");
