ALTER TABLE agenda_items
  DROP CONSTRAINT IF EXISTS chk_agenda_items_status;

ALTER TABLE agenda_items
  ADD CONSTRAINT chk_agenda_items_status
  CHECK (status IN ('pending', 'confirmed', 'done', 'reschedule', 'cancelled'));

ALTER TABLE agenda_items
  ADD COLUMN IF NOT EXISTS "conversationId" UUID NULL,
  ADD COLUMN IF NOT EXISTS "assignedUserId" UUID NULL,
  ADD COLUMN IF NOT EXISTS "assignedUserName" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "commercialActionType" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "commercialOutcome" TEXT NULL,
  ADD COLUMN IF NOT EXISTS origin TEXT NULL,
  ADD COLUMN IF NOT EXISTS location TEXT NULL,
  ADD COLUMN IF NOT EXISTS "resultNote" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "nextStepNote" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "nextActionAt" TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_items_clinic_conversation
  ON agenda_items ("clinicId", "conversationId")
  WHERE "conversationId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_items_clinic_assigned_user
  ON agenda_items ("clinicId", "assignedUserId")
  WHERE "assignedUserId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_items_clinic_commercial
  ON agenda_items ("clinicId", "commercialActionType", date)
  WHERE "commercialActionType" IS NOT NULL;
