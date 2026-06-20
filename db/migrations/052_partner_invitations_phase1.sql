ALTER TABLE partner_accounts
  ALTER COLUMN "passwordHash" DROP NOT NULL;

CREATE TABLE IF NOT EXISTS partner_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "partnerId" UUID NOT NULL REFERENCES partner_accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "acceptedAt" TIMESTAMPTZ NULL,
  "revokedAt" TIMESTAMPTZ NULL,
  "createdByStaffUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS partner_invitations_partner_idx
  ON partner_invitations ("partnerId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_invitations_email_idx
  ON partner_invitations ((LOWER(email)), "createdAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS partner_invitations_token_hash_unique_idx
  ON partner_invitations ("tokenHash");
