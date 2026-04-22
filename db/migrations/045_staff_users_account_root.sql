ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS "accountRootUserId" UUID NULL;

CREATE INDEX IF NOT EXISTS idx_staff_users_clinic_account_root
  ON staff_users ("clinicId", "accountRootUserId")
  WHERE "accountRootUserId" IS NOT NULL;

UPDATE staff_users su
SET "accountRootUserId" = su.id
FROM clinics c
WHERE su."clinicId" = c.id
  AND su."accountType" = 'client_portal'
  AND su."accountRootUserId" IS NULL
  AND c.settings #>> '{portal,primaryPortalUserId}' = su.id::text;

UPDATE staff_users su
SET "accountRootUserId" = (c.settings #>> '{portal,primaryPortalUserId}')::uuid
FROM clinics c
WHERE su."clinicId" = c.id
  AND su."accountType" = 'client_portal'
  AND su."accountRootUserId" IS NULL
  AND c.settings #>> '{portal,primaryPortalUserId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
