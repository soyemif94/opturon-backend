CREATE SEQUENCE IF NOT EXISTS opturon_internal_document_number_seq;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS "documentKind" TEXT NOT NULL DEFAULT 'internal_invoice',
  ADD COLUMN IF NOT EXISTS "fiscalStatus" TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "internalDocumentNumber" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "customerTaxId" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "customerTaxIdType" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "customerLegalName" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "customerVatCondition" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "issuerLegalName" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "issuerTaxId" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "issuerVatCondition" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "suggestedFiscalVoucherType" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "accountantNotes" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "deliveredToAccountantAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "invoicedByAccountantAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "accountantReferenceNumber" TEXT NULL;

UPDATE invoices i
SET
  "documentKind" = CASE
    WHEN LOWER(COALESCE(i.status, 'draft')) = 'draft' THEN 'proforma'
    ELSE 'internal_invoice'
  END,
  "fiscalStatus" = CASE
    WHEN LOWER(COALESCE(i.status, 'draft')) = 'draft' THEN 'draft'
    ELSE 'ready_for_accountant'
  END,
  "internalDocumentNumber" = COALESCE(
    i."internalDocumentNumber",
    'OPT-' || LPAD(nextval('opturon_internal_document_number_seq')::text, 8, '0')
  ),
  "customerTaxId" = COALESCE(
    i."customerTaxId",
    (SELECT c."taxId" FROM contacts c WHERE c.id = i."contactId" AND c."clinicId" = i."clinicId" LIMIT 1)
  ),
  "customerTaxIdType" = CASE
    WHEN COALESCE(i."customerTaxIdType", '') IN ('DNI', 'CUIT', 'CUIL', 'NONE') THEN i."customerTaxIdType"
    WHEN LENGTH(REGEXP_REPLACE(COALESCE((SELECT c."taxId" FROM contacts c WHERE c.id = i."contactId" AND c."clinicId" = i."clinicId" LIMIT 1), ''), '\D', '', 'g')) = 11 THEN 'CUIT'
    WHEN LENGTH(REGEXP_REPLACE(COALESCE((SELECT c."taxId" FROM contacts c WHERE c.id = i."contactId" AND c."clinicId" = i."clinicId" LIMIT 1), ''), '\D', '', 'g')) BETWEEN 7 AND 8 THEN 'DNI'
    ELSE 'NONE'
  END,
  "customerLegalName" = COALESCE(
    i."customerLegalName",
    NULLIF((SELECT c."companyName" FROM contacts c WHERE c.id = i."contactId" AND c."clinicId" = i."clinicId" LIMIT 1), ''),
    NULLIF((SELECT c.name FROM contacts c WHERE c.id = i."contactId" AND c."clinicId" = i."clinicId" LIMIT 1), '')
  ),
  "customerVatCondition" = COALESCE(
    i."customerVatCondition",
    NULLIF((SELECT c."taxCondition" FROM contacts c WHERE c.id = i."contactId" AND c."clinicId" = i."clinicId" LIMIT 1), '')
  ),
  "issuerLegalName" = COALESCE(
    i."issuerLegalName",
    NULLIF((SELECT cl.name FROM clinics cl WHERE cl.id = i."clinicId" LIMIT 1), '')
  ),
  "suggestedFiscalVoucherType" = CASE
    WHEN COALESCE(i."suggestedFiscalVoucherType", '') IN ('A', 'B', 'C', 'NONE') THEN i."suggestedFiscalVoucherType"
    WHEN LOWER(COALESCE(i.metadata ->> 'documentKind', '')) = 'invoice_a' THEN 'A'
    WHEN LOWER(COALESCE(i.metadata ->> 'documentKind', '')) = 'invoice_b' THEN 'B'
    WHEN LOWER(COALESCE(i.metadata ->> 'documentKind', '')) = 'invoice_c' THEN 'C'
    ELSE 'NONE'
  END;

UPDATE invoices
SET "internalDocumentNumber" = 'OPT-' || LPAD(nextval('opturon_internal_document_number_seq')::text, 8, '0')
WHERE "internalDocumentNumber" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_prefact_document_kind') THEN
    ALTER TABLE invoices DROP CONSTRAINT chk_invoices_prefact_document_kind;
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT chk_invoices_prefact_document_kind
  CHECK ("documentKind" IN ('internal_invoice', 'proforma', 'order_summary'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_prefact_fiscal_status') THEN
    ALTER TABLE invoices DROP CONSTRAINT chk_invoices_prefact_fiscal_status;
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT chk_invoices_prefact_fiscal_status
  CHECK ("fiscalStatus" IN ('draft', 'ready_for_accountant', 'delivered_to_accountant', 'invoiced_by_accountant'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_prefact_customer_tax_id_type') THEN
    ALTER TABLE invoices DROP CONSTRAINT chk_invoices_prefact_customer_tax_id_type;
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT chk_invoices_prefact_customer_tax_id_type
  CHECK ("customerTaxIdType" IN ('DNI', 'CUIT', 'CUIL', 'NONE'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_prefact_suggested_voucher_type') THEN
    ALTER TABLE invoices DROP CONSTRAINT chk_invoices_prefact_suggested_voucher_type;
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT chk_invoices_prefact_suggested_voucher_type
  CHECK ("suggestedFiscalVoucherType" IN ('A', 'B', 'C', 'NONE'));

CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_clinic_internal_document_number
  ON invoices("clinicId", "internalDocumentNumber")
  WHERE "internalDocumentNumber" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_clinic_fiscal_status
  ON invoices("clinicId", "fiscalStatus", COALESCE("issuedAt", "createdAt") DESC);
