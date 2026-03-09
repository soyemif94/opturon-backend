CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS "waFrom" TEXT,
  ADD COLUMN IF NOT EXISTS "waTo" TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'NEW',
  ADD COLUMN IF NOT EXISTS context JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE conversations c
SET
  "waFrom" = COALESCE(c."waFrom", ct."waId"),
  "waTo" = COALESCE(c."waTo", ch."phoneNumberId")
FROM contacts ct, channels ch
WHERE c."contactId" = ct.id
  AND c."channelId" = ch.id
  AND (c."waFrom" IS NULL OR c."waTo" IS NULL);

ALTER TABLE conversations
  ALTER COLUMN "waFrom" SET DEFAULT '',
  ALTER COLUMN "waTo" SET DEFAULT '';

UPDATE conversations
SET "waFrom" = COALESCE("waFrom", ''),
    "waTo" = COALESCE("waTo", '');

ALTER TABLE conversations
  ALTER COLUMN "waFrom" SET NOT NULL,
  ALTER COLUMN "waTo" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_wa_from_wa_to
  ON conversations("waFrom", "waTo");

CREATE INDEX IF NOT EXISTS idx_conversations_created_at
  ON conversations("createdAt");

CREATE TABLE IF NOT EXISTS conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversationId" UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  "waMessageId" TEXT UNIQUE,
  "from" TEXT NULL,
  "to" TEXT NULL,
  type TEXT NULL,
  text TEXT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_created
  ON conversation_messages("conversationId", "createdAt");

