ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS "displayPhoneNumber" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "verifiedName" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "connectionSource" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS "connectionMetadata" JSONB NULL;

CREATE TABLE IF NOT EXISTS channel_onboarding_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "externalTenantId" TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'whatsapp_embedded_signup',
  status TEXT NOT NULL DEFAULT 'launching',
  "stateToken" TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  "createdByUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "redirectUri" TEXT NOT NULL,
  "graphVersion" TEXT NULL,
  "metaCode" TEXT NULL,
  "metaAccessToken" TEXT NULL,
  "metaTokenType" TEXT NULL,
  "metaTokenExpiresAt" TIMESTAMPTZ NULL,
  "metaBusinessId" TEXT NULL,
  "wabaId" TEXT NULL,
  "phoneNumberId" TEXT NULL,
  "displayPhoneNumber" TEXT NULL,
  "verifiedName" TEXT NULL,
  "channelId" UUID NULL REFERENCES channels(id) ON DELETE SET NULL,
  "errorCode" TEXT NULL,
  "errorMessage" TEXT NULL,
  metadata JSONB NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
  "completedAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_onboarding_sessions_clinic_id
  ON channel_onboarding_sessions("clinicId");

CREATE INDEX IF NOT EXISTS idx_channel_onboarding_sessions_tenant_id
  ON channel_onboarding_sessions("externalTenantId");

CREATE INDEX IF NOT EXISTS idx_channel_onboarding_sessions_status
  ON channel_onboarding_sessions(status, "createdAt" DESC);
