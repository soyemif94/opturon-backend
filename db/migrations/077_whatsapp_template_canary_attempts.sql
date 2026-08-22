CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_templates_id_clinic_id ON whatsapp_templates(id, "clinicId");
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_id_clinic_id ON conversations(id, "clinicId");

CREATE TABLE IF NOT EXISTS whatsapp_template_canary_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "channelId" UUID NOT NULL,
  "templateId" UUID NOT NULL,
  "recipientId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "templateName" TEXT NOT NULL,
  language TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'processing',
  "providerMessageId" TEXT NULL,
  "conversationId" UUID NULL,
  "inboxMessageId" UUID NULL REFERENCES conversation_messages(id) ON DELETE SET NULL,
  "errorCode" TEXT NULL,
  "errorDetail" TEXT NULL,
  "errorMetadata" JSONB NULL,
  "sentAt" TIMESTAMPTZ NULL,
  "deliveredAt" TIMESTAMPTZ NULL,
  "readAt" TIMESTAMPTZ NULL,
  "failedAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_whatsapp_template_canary_attempts_tenant_key UNIQUE ("clinicId", "idempotencyKey"),
  CONSTRAINT chk_whatsapp_template_canary_key CHECK (length(trim("idempotencyKey")) BETWEEN 16 AND 200),
  CONSTRAINT chk_whatsapp_template_canary_status CHECK (status IN ('processing', 'sent', 'delivered', 'read', 'failed', 'unknown_delivery')),
  CONSTRAINT chk_whatsapp_template_canary_variables CHECK (jsonb_typeof(variables) = 'object'),
  CONSTRAINT chk_whatsapp_template_canary_preview CHECK (jsonb_typeof(preview) = 'object'),
  CONSTRAINT chk_whatsapp_template_canary_error_metadata CHECK ("errorMetadata" IS NULL OR jsonb_typeof("errorMetadata") = 'object'),
  CONSTRAINT fk_whatsapp_template_canary_channel_tenant FOREIGN KEY ("channelId", "clinicId") REFERENCES channels(id, "clinicId") ON DELETE NO ACTION,
  CONSTRAINT fk_whatsapp_template_canary_template_tenant FOREIGN KEY ("templateId", "clinicId") REFERENCES whatsapp_templates(id, "clinicId") ON DELETE NO ACTION,
  CONSTRAINT fk_whatsapp_template_canary_conversation_tenant FOREIGN KEY ("conversationId", "clinicId") REFERENCES conversations(id, "clinicId") ON DELETE NO ACTION,
  CONSTRAINT fk_whatsapp_template_canary_recipient_tenant FOREIGN KEY ("recipientId", "clinicId") REFERENCES operational_alert_recipients(id, "clinicId") ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_template_canary_provider_message
  ON whatsapp_template_canary_attempts("clinicId", "channelId", "providerMessageId")
  WHERE "providerMessageId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_template_canary_recent
  ON whatsapp_template_canary_attempts("clinicId", "createdAt" DESC);
