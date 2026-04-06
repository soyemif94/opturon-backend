ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS "leadStatus" TEXT NOT NULL DEFAULT 'NEW';

UPDATE conversations
SET "leadStatus" = 'NEW'
WHERE "leadStatus" IS NULL
   OR NULLIF(TRIM("leadStatus"), '') IS NULL;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_lead_status_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_lead_status_check
  CHECK ("leadStatus" IN ('NEW', 'IN_CONVERSATION', 'FOLLOW_UP', 'CLOSED'));

CREATE INDEX IF NOT EXISTS idx_conversations_lead_status
  ON conversations("clinicId", "leadStatus");
