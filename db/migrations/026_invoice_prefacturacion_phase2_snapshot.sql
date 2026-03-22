ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS "issuerTaxIdType" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "issuerGrossIncomeNumber" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "issuerFiscalAddress" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "issuerCity" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "issuerProvince" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "pointOfSaleSuggested" TEXT NULL;

UPDATE invoices i
SET
  "issuerTaxIdType" = COALESCE(NULLIF(i."issuerTaxIdType", ''), COALESCE(cl.settings -> 'businessProfile' ->> 'taxIdType', 'NONE')),
  "issuerGrossIncomeNumber" = COALESCE(i."issuerGrossIncomeNumber", NULLIF(cl.settings -> 'businessProfile' ->> 'grossIncomeNumber', '')),
  "issuerFiscalAddress" = COALESCE(
    i."issuerFiscalAddress",
    NULLIF(cl.settings -> 'businessProfile' ->> 'fiscalAddress', ''),
    NULLIF(cl.settings -> 'businessProfile' ->> 'address', '')
  ),
  "issuerCity" = COALESCE(i."issuerCity", NULLIF(cl.settings -> 'businessProfile' ->> 'city', '')),
  "issuerProvince" = COALESCE(i."issuerProvince", NULLIF(cl.settings -> 'businessProfile' ->> 'province', '')),
  "pointOfSaleSuggested" = COALESCE(i."pointOfSaleSuggested", NULLIF(cl.settings -> 'businessProfile' ->> 'pointOfSaleSuggested', ''))
FROM clinics cl
WHERE cl.id = i."clinicId";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_prefact_issuer_tax_id_type') THEN
    ALTER TABLE invoices DROP CONSTRAINT chk_invoices_prefact_issuer_tax_id_type;
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT chk_invoices_prefact_issuer_tax_id_type
  CHECK ("issuerTaxIdType" IN ('DNI', 'CUIT', 'CUIL', 'NONE'));
