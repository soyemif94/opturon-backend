ALTER TABLE agenda_items
ADD COLUMN IF NOT EXISTS "contactId" UUID NULL REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_items_clinic_contact
ON agenda_items ("clinicId", "contactId")
WHERE "contactId" IS NOT NULL;
