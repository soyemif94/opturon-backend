ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ NULL;

UPDATE contacts
SET "archivedAt" = COALESCE("archivedAt", "updatedAt", "createdAt", NOW())
WHERE COALESCE(status, 'active') = 'archived'
  AND "archivedAt" IS NULL;

UPDATE contacts
SET "archivedAt" = NULL
WHERE COALESCE(status, 'active') <> 'archived'
  AND "archivedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_clinic_archived_at
  ON contacts("clinicId", "archivedAt")
  WHERE COALESCE(status, 'active') = 'archived' AND "archivedAt" IS NOT NULL;
