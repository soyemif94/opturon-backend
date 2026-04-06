ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS "nextActionAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "nextActionNote" TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_next_action
  ON conversations("clinicId", "nextActionAt");
