ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS "externalTenantId" TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_clinics_external_tenant_id
  ON clinics("externalTenantId")
  WHERE "externalTenantId" IS NOT NULL;
