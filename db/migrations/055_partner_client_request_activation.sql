BEGIN;

ALTER TABLE partner_client_requests
  ADD COLUMN IF NOT EXISTS "processingStatus" TEXT NOT NULL DEFAULT 'not_processed',
  ADD COLUMN IF NOT EXISTS "paymentConfirmedAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "paymentConfirmedBy" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "paymentConfirmationMethod" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "confirmedAmount" NUMERIC(14,2) NULL,
  ADD COLUMN IF NOT EXISTS "confirmedCurrency" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "paymentConfirmationReference" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "paymentConfirmationNotes" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "linkedExternalTenantId" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "commissionEntryId" UUID NULL REFERENCES partner_commission_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "processedBy" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "processingErrorCode" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "commissionBaseAmount" NUMERIC(14,2) NULL,
  ADD COLUMN IF NOT EXISTS "commissionCurrency" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "commissionRate" NUMERIC(5,2) NULL,
  ADD COLUMN IF NOT EXISTS "commissionAmount" NUMERIC(14,2) NULL,
  ADD COLUMN IF NOT EXISTS "commissionRuleCode" TEXT NULL;

ALTER TABLE partner_client_requests
  DROP CONSTRAINT IF EXISTS partner_client_requests_processing_status_check;

ALTER TABLE partner_client_requests
  ADD CONSTRAINT partner_client_requests_processing_status_check
  CHECK ("processingStatus" IN ('not_processed', 'processing', 'processed', 'processing_failed'));

CREATE UNIQUE INDEX IF NOT EXISTS partner_client_requests_processed_once_idx
  ON partner_client_requests (id)
  WHERE "processingStatus" = 'processed';

CREATE UNIQUE INDEX IF NOT EXISTS partner_commission_entries_client_request_signup_unique_idx
  ON partner_commission_entries ("sourceType", "sourceRef", "eventType", "payoutKind", "partnerId")
  WHERE status = 'generated'
    AND "sourceType" = 'partner_client_request'
    AND "eventType" = 'subscription_signup_accredited'
    AND "payoutKind" = 'own_signup';

CREATE INDEX IF NOT EXISTS partner_client_requests_processing_status_idx
  ON partner_client_requests ("processingStatus", status, "updatedAt" DESC);

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP INDEX IF EXISTS partner_client_requests_processing_status_idx;
-- DROP INDEX IF EXISTS partner_commission_entries_client_request_signup_unique_idx;
-- DROP INDEX IF EXISTS partner_client_requests_processed_once_idx;
-- ALTER TABLE partner_client_requests DROP CONSTRAINT IF EXISTS partner_client_requests_processing_status_check;
-- ALTER TABLE partner_client_requests
--   DROP COLUMN IF EXISTS "commissionRuleCode",
--   DROP COLUMN IF EXISTS "commissionAmount",
--   DROP COLUMN IF EXISTS "commissionRate",
--   DROP COLUMN IF EXISTS "commissionCurrency",
--   DROP COLUMN IF EXISTS "commissionBaseAmount",
--   DROP COLUMN IF EXISTS "processingErrorCode",
--   DROP COLUMN IF EXISTS "processedBy",
--   DROP COLUMN IF EXISTS "commissionEntryId",
--   DROP COLUMN IF EXISTS "linkedExternalTenantId",
--   DROP COLUMN IF EXISTS "paymentConfirmationNotes",
--   DROP COLUMN IF EXISTS "paymentConfirmationReference",
--   DROP COLUMN IF EXISTS "confirmedCurrency",
--   DROP COLUMN IF EXISTS "confirmedAmount",
--   DROP COLUMN IF EXISTS "paymentConfirmationMethod",
--   DROP COLUMN IF EXISTS "paymentConfirmedBy",
--   DROP COLUMN IF EXISTS "paymentConfirmedAt",
--   DROP COLUMN IF EXISTS "processingStatus";
-- COMMIT;
