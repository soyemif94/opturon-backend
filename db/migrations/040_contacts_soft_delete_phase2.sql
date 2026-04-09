ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contacts_status_check'
      AND conrelid = 'contacts'::regclass
  ) THEN
    ALTER TABLE contacts DROP CONSTRAINT contacts_status_check;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE contacts
    ADD CONSTRAINT contacts_status_check
    CHECK (status IN ('active', 'archived', 'deleted'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

UPDATE contacts
SET "deletedAt" = NULL
WHERE COALESCE(status, 'active') <> 'deleted'
  AND "deletedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_clinic_deleted_at
  ON contacts("clinicId", "deletedAt")
  WHERE COALESCE(status, 'active') = 'deleted' AND "deletedAt" IS NOT NULL;
