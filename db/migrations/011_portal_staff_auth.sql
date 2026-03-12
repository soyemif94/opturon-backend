ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS email TEXT NULL,
  ADD COLUMN IF NOT EXISTS "passwordHash" TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_staff_users_email_lower
  ON staff_users (LOWER(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_users_clinic_email
  ON staff_users ("clinicId", LOWER(email))
  WHERE email IS NOT NULL;
