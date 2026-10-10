CREATE TABLE IF NOT EXISTS whatsapp_coexistence_channel_state (
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "channelId" UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  "isOnBizApp" BOOLEAN NULL,
  "platformType" TEXT NULL,
  "coexistenceStatus" TEXT NOT NULL DEFAULT 'unknown'
    CHECK ("coexistenceStatus" IN ('unknown', 'active', 'reconnection_required', 'disconnected')),
  "providerStatusCheckedAt" TIMESTAMPTZ NULL,
  "historySyncStatus" TEXT NOT NULL DEFAULT 'not_requested'
    CHECK ("historySyncStatus" IN ('not_requested', 'requested', 'syncing', 'completed', 'declined', 'failed', 'expired')),
  "contactsSyncStatus" TEXT NOT NULL DEFAULT 'not_requested'
    CHECK ("contactsSyncStatus" IN ('not_requested', 'requested', 'syncing', 'completed', 'declined', 'failed')),
  "historyLastPhase" TEXT NULL,
  "historyLastChunkOrder" INTEGER NULL,
  "historyProgress" NUMERIC(5,2) NULL CHECK ("historyProgress" IS NULL OR ("historyProgress" >= 0 AND "historyProgress" <= 100)),
  "historyStartedAt" TIMESTAMPTZ NULL,
  "historyUpdatedAt" TIMESTAMPTZ NULL,
  "contactsUpdatedAt" TIMESTAMPTZ NULL,
  "lastWebhookAt" TIMESTAMPTZ NULL,
  "lastEchoAt" TIMESTAMPTZ NULL,
  "lastAccountEvent" TEXT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_coexistence_state_clinic
  ON whatsapp_coexistence_channel_state("clinicId", "channelId");

CREATE TABLE IF NOT EXISTS whatsapp_coexistence_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "channelId" UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  "wabaId" TEXT NOT NULL,
  "phoneNumberId" TEXT NULL,
  field TEXT NOT NULL CHECK (field IN ('history', 'smb_app_state_sync', 'account_update')),
  "eventHash" CHAR(64) NOT NULL,
  payload JSONB NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'done', 'failed')),
  "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "processedAt" TIMESTAMPTZ NULL,
  "lastErrorCode" TEXT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("channelId", field, "eventHash")
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_coexistence_events_queue
  ON whatsapp_coexistence_events(status, "receivedAt")
  WHERE status IN ('queued', 'processing');

CREATE INDEX IF NOT EXISTS idx_whatsapp_coexistence_events_tenant
  ON whatsapp_coexistence_events("clinicId", "channelId", field, "receivedAt" DESC);
