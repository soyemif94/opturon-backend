DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_contacts_status'
      AND conrelid = 'contacts'::regclass
  ) THEN
    ALTER TABLE contacts DROP CONSTRAINT chk_contacts_status;
  END IF;

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
