BEGIN;

CREATE TABLE IF NOT EXISTS partner_recruitment_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "sponsorPartnerId" UUID NOT NULL REFERENCES partner_accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft',
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  email TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  phone TEXT NOT NULL,
  "normalizedPhone" TEXT NOT NULL,
  "documentId" TEXT NULL,
  "normalizedDocumentId" TEXT NULL,
  city TEXT NULL,
  province TEXT NULL,
  country TEXT NULL DEFAULT 'Argentina',
  notes TEXT NULL,
  "consentConfirmed" BOOLEAN NOT NULL DEFAULT FALSE,
  "adminNotes" TEXT NULL,
  "reviewedBy" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "reviewedAt" TIMESTAMPTZ NULL,
  "invitationId" UUID NULL REFERENCES partner_invitations(id) ON DELETE SET NULL,
  "createdPartnerId" UUID NULL REFERENCES partner_accounts(id) ON DELETE SET NULL,
  "submittedAt" TIMESTAMPTZ NULL,
  "approvedAt" TIMESTAMPTZ NULL,
  "invitedAt" TIMESTAMPTZ NULL,
  "acceptedAt" TIMESTAMPTZ NULL,
  "expiresAt" TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_recruitment_applications_status_check
    CHECK (status IN (
      'draft',
      'pending_review',
      'changes_requested',
      'approved',
      'rejected',
      'cancelled',
      'invitation_sent',
      'invitation_accepted',
      'expired'
    ))
);

CREATE INDEX IF NOT EXISTS partner_recruitment_applications_sponsor_idx
  ON partner_recruitment_applications ("sponsorPartnerId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_recruitment_applications_status_idx
  ON partner_recruitment_applications (status, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_recruitment_applications_created_partner_idx
  ON partner_recruitment_applications ("createdPartnerId")
  WHERE "createdPartnerId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_recruitment_applications_created_idx
  ON partner_recruitment_applications ("createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_recruitment_applications_email_idx
  ON partner_recruitment_applications ("normalizedEmail", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_recruitment_applications_phone_idx
  ON partner_recruitment_applications ("normalizedPhone", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_recruitment_applications_document_idx
  ON partner_recruitment_applications ("normalizedDocumentId")
  WHERE "normalizedDocumentId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS partner_recruitment_applications_active_email_unique_idx
  ON partner_recruitment_applications ("normalizedEmail")
  WHERE status IN ('pending_review', 'changes_requested', 'approved', 'invitation_sent');

CREATE UNIQUE INDEX IF NOT EXISTS partner_recruitment_applications_active_phone_unique_idx
  ON partner_recruitment_applications ("normalizedPhone")
  WHERE status IN ('pending_review', 'changes_requested', 'approved', 'invitation_sent');

CREATE UNIQUE INDEX IF NOT EXISTS partner_recruitment_applications_active_document_unique_idx
  ON partner_recruitment_applications ("normalizedDocumentId")
  WHERE "normalizedDocumentId" IS NOT NULL
    AND status IN ('pending_review', 'changes_requested', 'approved', 'invitation_sent');

ALTER TABLE partner_invitations
  ADD COLUMN IF NOT EXISTS "sourceType" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "sourceId" UUID NULL,
  ADD COLUMN IF NOT EXISTS "sponsorPartnerId" UUID NULL REFERENCES partner_accounts(id) ON DELETE SET NULL;

ALTER TABLE partner_invitations
  DROP CONSTRAINT IF EXISTS partner_invitations_source_type_check;

ALTER TABLE partner_invitations
  ADD CONSTRAINT partner_invitations_source_type_check
  CHECK ("sourceType" IS NULL OR "sourceType" IN ('partner_invite', 'partner_recruitment_application'));

CREATE INDEX IF NOT EXISTS partner_invitations_source_idx
  ON partner_invitations ("sourceType", "sourceId", "createdAt" DESC);

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS partner_invitations_source_idx;
-- ALTER TABLE partner_invitations DROP CONSTRAINT IF EXISTS partner_invitations_source_type_check;
-- ALTER TABLE partner_invitations
--   DROP COLUMN IF EXISTS "sponsorPartnerId",
--   DROP COLUMN IF EXISTS "sourceId",
--   DROP COLUMN IF EXISTS "sourceType";
-- DROP INDEX IF EXISTS partner_recruitment_applications_active_document_unique_idx;
-- DROP INDEX IF EXISTS partner_recruitment_applications_active_phone_unique_idx;
-- DROP INDEX IF EXISTS partner_recruitment_applications_active_email_unique_idx;
-- DROP INDEX IF EXISTS partner_recruitment_applications_document_idx;
-- DROP INDEX IF EXISTS partner_recruitment_applications_phone_idx;
-- DROP INDEX IF EXISTS partner_recruitment_applications_email_idx;
-- DROP INDEX IF EXISTS partner_recruitment_applications_created_idx;
-- DROP INDEX IF EXISTS partner_recruitment_applications_created_partner_idx;
-- DROP INDEX IF EXISTS partner_recruitment_applications_status_idx;
-- DROP INDEX IF EXISTS partner_recruitment_applications_sponsor_idx;
-- DROP TABLE IF EXISTS partner_recruitment_applications;
-- COMMIT;
