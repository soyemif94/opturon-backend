CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "requestId" TEXT NULL,
  provider TEXT NOT NULL DEFAULT 'meta_whatsapp',
  object TEXT NULL,
  "eventType" TEXT NULL,
  "waMessageId" TEXT NULL,
  "waFrom" TEXT NULL,
  "waTo" TEXT NULL,
  raw JSONB NOT NULL,
  headers JSONB NULL,
  "signatureValid" BOOLEAN NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at_desc
  ON webhook_events ("receivedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_events_wa_message_id
  ON webhook_events ("waMessageId");

CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type
  ON webhook_events ("eventType");

