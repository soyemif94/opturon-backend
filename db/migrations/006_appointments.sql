DO $$
BEGIN
  -- normalize legacy lowercase columns to quoted camelCase used by app queries
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'clinicid'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'clinicId'
  ) THEN
    ALTER TABLE appointments RENAME COLUMN clinicid TO "clinicId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'conversationid'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'conversationId'
  ) THEN
    ALTER TABLE appointments RENAME COLUMN conversationid TO "conversationId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'contactid'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'contactId'
  ) THEN
    ALTER TABLE appointments RENAME COLUMN contactid TO "contactId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'channelid'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'channelId'
  ) THEN
    ALTER TABLE appointments RENAME COLUMN channelid TO "channelId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'waid'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'waId'
  ) THEN
    ALTER TABLE appointments RENAME COLUMN waid TO "waId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'patientname'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'patientName'
  ) THEN
    ALTER TABLE appointments RENAME COLUMN patientname TO "patientName";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'requestedtext'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'requestedText'
  ) THEN
    ALTER TABLE appointments RENAME COLUMN requestedtext TO "requestedText";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'startat'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'startAt'
  ) THEN
    ALTER TABLE appointments RENAME COLUMN startat TO "startAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'endat'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'endAt'
  ) THEN
    ALTER TABLE appointments RENAME COLUMN endat TO "endAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'timewindow'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments' AND column_name = 'timeWindow'
  ) THEN
    ALTER TABLE appointments RENAME COLUMN timewindow TO "timeWindow";
  END IF;
END $$;

ALTER TABLE appointments
  ALTER COLUMN "leadId" DROP NOT NULL,
  ALTER COLUMN "slotId" DROP NOT NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS "channelId" UUID NULL REFERENCES channels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "waId" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "patientName" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'human_panel',
  ADD COLUMN IF NOT EXISTS "requestedText" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "startAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "endAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "timeWindow" TEXT NULL;

DROP INDEX IF EXISTS idx_appointments_clinic_start_at;
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_start_at
  ON appointments("clinicId", "startAt");

DROP INDEX IF EXISTS idx_appointments_conversation_id;
CREATE INDEX IF NOT EXISTS idx_appointments_conversation_id
  ON appointments("conversationId");

DROP INDEX IF EXISTS uniq_appointments_confirmed_start_at;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_appointments_confirmed_start_at
  ON appointments("clinicId", "startAt")
  WHERE "startAt" IS NOT NULL AND status = 'confirmed';
