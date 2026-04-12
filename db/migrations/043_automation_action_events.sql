CREATE TABLE IF NOT EXISTS automation_action_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "externalTenantId" TEXT NULL,
  "templateKey" TEXT NOT NULL REFERENCES automation_templates(key) ON DELETE CASCADE,
  action TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" UUID NULL,
  "suggestedValue" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "appliedValue" JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_action_events_clinic_template
  ON automation_action_events ("clinicId", "templateKey", "createdAt" DESC);
