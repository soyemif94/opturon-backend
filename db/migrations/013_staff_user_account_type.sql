ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS "accountType" TEXT NULL;

UPDATE staff_users
SET "accountType" = CASE
  WHEN email IS NOT NULL
    AND role IN ('owner', 'manager', 'seller', 'viewer', 'editor')
    THEN 'client_portal'
  ELSE 'internal_staff'
END
WHERE "accountType" IS NULL;

ALTER TABLE staff_users
  ALTER COLUMN "accountType" SET DEFAULT 'internal_staff';

ALTER TABLE staff_users
  ALTER COLUMN "accountType" SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_users_clinic_account_type
  ON staff_users ("clinicId", "accountType");
