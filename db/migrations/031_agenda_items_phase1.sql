CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agenda_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  "startAt" TIMESTAMPTZ NULL,
  "endAt" TIMESTAMPTZ NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_agenda_items_type CHECK (type IN ('note', 'follow_up', 'task', 'appointment')),
  CONSTRAINT chk_agenda_items_status CHECK (status IN ('pending', 'done', 'cancelled')),
  CONSTRAINT chk_agenda_items_title_non_empty CHECK (length(btrim(title)) > 0),
  CONSTRAINT chk_agenda_items_end_after_start CHECK ("endAt" IS NULL OR "startAt" IS NULL OR "endAt" >= "startAt")
);

CREATE INDEX IF NOT EXISTS idx_agenda_items_clinic_date
  ON agenda_items ("clinicId", date, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_agenda_items_clinic_start_at
  ON agenda_items ("clinicId", "startAt")
  WHERE "startAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_items_clinic_status
  ON agenda_items ("clinicId", status, date);
