CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "externalTenantId" TEXT NOT NULL,
  "channelId" UUID NULL REFERENCES channels(id) ON DELETE SET NULL,
  "wabaId" TEXT NOT NULL,
  "templateKey" TEXT NOT NULL,
  "metaTemplateId" TEXT NULL,
  "metaTemplateName" TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'es_AR',
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  "rejectionReason" TEXT NULL,
  definition JSONB NOT NULL,
  "lastSyncedAt" TIMESTAMPTZ NULL,
  metadata JSONB NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_templates_clinic_key_language
  ON whatsapp_templates("clinicId", "templateKey", language);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_templates_clinic_meta_name
  ON whatsapp_templates("clinicId", "metaTemplateName");

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_clinic_status
  ON whatsapp_templates("clinicId", status, "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_waba
  ON whatsapp_templates("wabaId", "updatedAt" DESC);
