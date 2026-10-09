BEGIN;

ALTER TABLE partner_recruitment_applications
  ALTER COLUMN "sponsorPartnerId" DROP NOT NULL;

ALTER TABLE partner_recruitment_applications
  ADD COLUMN IF NOT EXISTS "cuit" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "hasMonotributo" BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS "taxCategory" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "commercialExperience" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "commercialApproach" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "independentRelationshipAcknowledged" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "monotributoAcknowledged" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "documentationStatus" TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE partner_recruitment_applications
  ADD CONSTRAINT partner_recruitment_applications_documentation_status_check
  CHECK ("documentationStatus" IN ('pending', 'received', 'verified', 'rejected'));

CREATE INDEX IF NOT EXISTS partner_recruitment_applications_public_idx
  ON partner_recruitment_applications ("createdAt" DESC)
  WHERE "sponsorPartnerId" IS NULL;

CREATE TABLE IF NOT EXISTS onboarding_email_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "eventKey" TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT NULL,
  "providerMessageId" TEXT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "sentAt" TIMESTAMPTZ NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT onboarding_email_deliveries_status_check CHECK (status IN ('pending', 'sent', 'failed'))
);

COMMIT;
