CREATE TABLE IF NOT EXISTS whatsapp_channel_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  "channelId" UUID NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  "originalWabaId" TEXT NOT NULL,
  "originalPhoneNumberId" TEXT NOT NULL,
  "originalNormalizedPhone" TEXT NOT NULL,
  "originalConnectionMode" TEXT NOT NULL CHECK ("originalConnectionMode" IN ('API_ONLY')),
  "targetMode" TEXT NOT NULL CHECK ("targetMode" IN ('COEXISTENCE')),
  status TEXT NOT NULL CHECK (status IN (
    'prepared', 'cloud_api_disconnected', 'business_app_ready',
    'coexistence_onboarding', 'completed', 'rollback_pending', 'rolled_back', 'failed'
  )),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  "candidatePhoneNumberId" TEXT NULL,
  "candidateWabaId" TEXT NULL,
  "currentPhoneNumberId" TEXT NULL,
  "currentWabaId" TEXT NULL,
  "failureCode" TEXT NULL CHECK ("failureCode" IS NULL OR length("failureCode") <= 120),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_channel_transition_active_channel
  ON whatsapp_channel_transitions("channelId")
  WHERE status IN ('prepared', 'cloud_api_disconnected', 'business_app_ready', 'coexistence_onboarding', 'rollback_pending');

CREATE INDEX IF NOT EXISTS idx_whatsapp_channel_transition_clinic
  ON whatsapp_channel_transitions("clinicId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS whatsapp_channel_phone_aliases (
  "phoneNumberId" TEXT PRIMARY KEY,
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  "channelId" UUID NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  "transitionId" UUID NOT NULL REFERENCES whatsapp_channel_transitions(id) ON DELETE RESTRICT,
  "wabaId" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (length("phoneNumberId") BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_channel_phone_alias_lookup
  ON whatsapp_channel_phone_aliases("channelId", "expiresAt");
