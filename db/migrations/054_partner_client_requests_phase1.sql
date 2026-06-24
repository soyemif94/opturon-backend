CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS partner_client_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "partnerId" UUID NOT NULL REFERENCES partner_accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft',
  "clientName" TEXT NOT NULL,
  "businessName" TEXT NULL,
  email TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  phone TEXT NOT NULL,
  "normalizedPhone" TEXT NOT NULL,
  "taxId" TEXT NULL,
  "normalizedTaxId" TEXT NULL,
  "planCode" TEXT NULL,
  "paymentMethod" TEXT NOT NULL,
  "reportedAmount" NUMERIC(14,2) NOT NULL,
  "reportedCurrency" TEXT NOT NULL DEFAULT 'ARS',
  "reportedPaymentDate" DATE NOT NULL,
  "paymentReference" TEXT NULL,
  "normalizedPaymentReference" TEXT NULL,
  notes TEXT NULL,
  "receiptStorageKey" TEXT NOT NULL,
  "receiptOriginalName" TEXT NOT NULL,
  "receiptMimeType" TEXT NOT NULL,
  "receiptSizeBytes" INTEGER NOT NULL,
  "receiptSha256" TEXT NULL,
  "adminNotes" TEXT NULL,
  "reviewedBy" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "reviewedAt" TIMESTAMPTZ NULL,
  "linkedTenantId" UUID NULL,
  "attributionId" UUID NULL REFERENCES partner_client_attributions(id) ON DELETE SET NULL,
  "processedAt" TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "submittedAt" TIMESTAMPTZ NULL,
  CONSTRAINT partner_client_requests_status_check CHECK (status IN ('draft', 'pending_review', 'changes_requested', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT partner_client_requests_payment_method_check CHECK ("paymentMethod" IN ('transfer', 'mercado_pago', 'cash', 'card', 'other')),
  CONSTRAINT partner_client_requests_currency_check CHECK ("reportedCurrency" IN ('ARS', 'USD')),
  CONSTRAINT partner_client_requests_amount_check CHECK ("reportedAmount" > 0),
  CONSTRAINT partner_client_requests_receipt_size_check CHECK ("receiptSizeBytes" > 0)
);

CREATE INDEX IF NOT EXISTS partner_client_requests_partner_idx
  ON partner_client_requests ("partnerId", status, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_client_requests_status_idx
  ON partner_client_requests (status, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_client_requests_created_idx
  ON partner_client_requests ("createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_client_requests_email_idx
  ON partner_client_requests ("normalizedEmail", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_client_requests_phone_idx
  ON partner_client_requests ("normalizedPhone", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_client_requests_tax_idx
  ON partner_client_requests ("normalizedTaxId")
  WHERE "normalizedTaxId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_client_requests_receipt_sha_idx
  ON partner_client_requests ("receiptSha256")
  WHERE "receiptSha256" IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_client_requests_payment_reference_idx
  ON partner_client_requests ("normalizedPaymentReference")
  WHERE "normalizedPaymentReference" IS NOT NULL;
