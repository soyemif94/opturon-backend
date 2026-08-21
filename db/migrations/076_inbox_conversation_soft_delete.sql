ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "deletedByUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "deleteReason" TEXT NULL;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS "conversations_clinicId_channelId_contactId_key";

DROP INDEX IF EXISTS uniq_conversations_channel_wa_from_wa_to;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_active_owner
  ON conversations("clinicId", "channelId", "contactId")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_active_channel_pair
  ON conversations("channelId", "waFrom", "waTo")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_deleted_at
  ON conversations("clinicId", "deletedAt");
