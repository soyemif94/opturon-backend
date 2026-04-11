ALTER TABLE agenda_items
  ADD COLUMN IF NOT EXISTS "reminderClaimedAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "reminderLastError" TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_items_reminder_due
  ON agenda_items ("clinicId", "startAt")
  WHERE type = 'appointment' AND status IN ('pending', 'confirmed') AND "reminderSentAt" IS NULL;
