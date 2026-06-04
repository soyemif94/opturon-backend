CREATE TABLE IF NOT EXISTS portal_user_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "tenantId" TEXT NOT NULL,
  "userId" UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "acceptedAt" TIMESTAMPTZ NULL,
  "revokedAt" TIMESTAMPTZ NULL,
  "createdByUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_user_invitations_token_hash
  ON portal_user_invitations ("tokenHash");

CREATE INDEX IF NOT EXISTS idx_portal_user_invitations_clinic_user_created
  ON portal_user_invitations ("clinicId", "userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_portal_user_invitations_tenant_email_created
  ON portal_user_invitations ("tenantId", LOWER(email), "createdAt" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_portal_user_invitations_role'
  ) THEN
    ALTER TABLE portal_user_invitations
      ADD CONSTRAINT chk_portal_user_invitations_role
      CHECK (role IN ('owner', 'manager', 'seller', 'viewer'));
  END IF;
END $$;
