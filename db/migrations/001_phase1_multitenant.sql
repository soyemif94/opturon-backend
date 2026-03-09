CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS clinics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'whatsapp_cloud',
  "phoneNumberId" TEXT NOT NULL UNIQUE,
  "wabaId" TEXT NULL,
  "accessToken" TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channels_clinic_id ON channels("clinicId");

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "waId" TEXT NOT NULL,
  phone TEXT NULL,
  name TEXT NULL,
  "optedOut" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("clinicId", "waId")
);
CREATE INDEX IF NOT EXISTS idx_contacts_clinic_id ON contacts("clinicId");

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "channelId" UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  "contactId" UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',
  stage TEXT NOT NULL DEFAULT 'new',
  "lastInboundAt" TIMESTAMPTZ NULL,
  "lastOutboundAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("clinicId", "channelId", "contactId")
);
CREATE INDEX IF NOT EXISTS idx_conversations_clinic_id ON conversations("clinicId");
CREATE INDEX IF NOT EXISTS idx_conversations_channel_id ON conversations("channelId");
CREATE INDEX IF NOT EXISTS idx_conversations_contact_id ON conversations("contactId");

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "channelId" UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  "conversationId" UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  "providerMessageId" TEXT NULL,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_clinic_id ON messages("clinicId");
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages("channelId");
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages("conversationId");
CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_clinic_provider_msg_id
  ON messages("clinicId", "providerMessageId")
  WHERE "providerMessageId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "channelId" UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  "maxAttempts" INT NOT NULL DEFAULT 10,
  "runAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lockedAt" TIMESTAMPTZ NULL,
  "lockedBy" TEXT NULL,
  "lastError" TEXT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at ON jobs(status, "runAt");
CREATE INDEX IF NOT EXISTS idx_jobs_clinic_id ON jobs("clinicId");
CREATE INDEX IF NOT EXISTS idx_jobs_channel_id ON jobs("channelId");