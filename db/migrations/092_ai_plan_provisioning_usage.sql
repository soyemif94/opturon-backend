-- BILL-011: durable AI entitlement provisioning and response metering.
-- Additive only: legacy tenants resolve as ready when their existing billing
-- entitlement is active; no existing billing rows are rewritten here.
CREATE TABLE ai_tenant_provisioning (
  "clinicId" UUID PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
  "planKey" TEXT NOT NULL,
  "botTier" TEXT NOT NULL CHECK ("botTier" IN ('none','standard','advanced','custom')),
  status TEXT NOT NULL CHECK (status IN ('not_required','pending','ready','blocked','failed')),
  "includedResponses" INTEGER NOT NULL DEFAULT 0 CHECK ("includedResponses" >= 0),
  "periodStart" TIMESTAMPTZ,
  "periodEnd" TIMESTAMPTZ,
  "activatedAt" TIMESTAMPTZ,
  "provisioningStartedAt" TIMESTAMPTZ,
  "readyAt" TIMESTAMPTZ,
  "blockedReason" TEXT,
  "lastError" TEXT,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'not_required' AND "botTier" = 'none') OR status <> 'not_required')
);

CREATE INDEX ai_tenant_provisioning_queue_idx
  ON ai_tenant_provisioning(status, "updatedAt");

CREATE TABLE ai_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "conversationId" UUID REFERENCES conversations(id) ON DELETE SET NULL,
  "messageId" TEXT,
  "periodStart" TIMESTAMPTZ NOT NULL,
  "periodEnd" TIMESTAMPTZ NOT NULL,
  "botTier" TEXT NOT NULL CHECK ("botTier" IN ('standard','advanced','custom')),
  route TEXT NOT NULL,
  model TEXT,
  "promptTokens" INTEGER,
  "completionTokens" INTEGER,
  "totalTokens" INTEGER,
  "estimatedCostUsd" NUMERIC,
  status TEXT NOT NULL CHECK (status IN ('reserved','succeeded','failed')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("clinicId", "conversationId", "messageId")
);

CREATE INDEX ai_usage_events_quota_idx
  ON ai_usage_events("clinicId", "periodStart", status);

CREATE TABLE ai_notification_deliveries (
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('activation','ai_ready')),
  "sourceKey" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("clinicId", kind, "sourceKey")
);
