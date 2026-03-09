CREATE TABLE IF NOT EXISTS inbound_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL,
  "phoneNumberId" TEXT NULL,
  "providerMessageId" TEXT NULL,
  "requestId" TEXT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbound_failures_reason_received_at
  ON inbound_failures(reason, "receivedAt" DESC);

CREATE INDEX IF NOT EXISTS idx_inbound_failures_phone_number_id
  ON inbound_failures("phoneNumberId");

ALTER TABLE messages
  ADD CONSTRAINT messages_direction_check
  CHECK (direction IN ('inbound', 'outbound'));

CREATE INDEX IF NOT EXISTS idx_jobs_status_locked_at
  ON jobs(status, "lockedAt");
