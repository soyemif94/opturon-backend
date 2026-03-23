ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS email TEXT NULL,
  ADD COLUMN IF NOT EXISTS "whatsappPhone" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "taxId" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "taxCondition" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "companyName" TEXT NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
  ALTER TABLE contacts
    ADD CONSTRAINT contacts_status_check
    CHECK (status IN ('active', 'archived'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_clinic_status
  ON contacts("clinicId", status);
