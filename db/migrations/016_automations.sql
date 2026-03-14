CREATE TABLE IF NOT EXISTS automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "externalTenantId" TEXT NULL,
  name TEXT NOT NULL,
  trigger JSONB NOT NULL DEFAULT '{}'::jsonb,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automations_clinic_id ON automations("clinicId");
CREATE INDEX IF NOT EXISTS idx_automations_external_tenant_id ON automations("externalTenantId");
