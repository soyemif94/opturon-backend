CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "contactId" UUID NULL,
  "invoiceId" UUID NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ARS',
  method TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'recorded',
  "paidAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "externalReference" TEXT NULL,
  notes TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_payments_amount_positive CHECK (amount > 0),
  CONSTRAINT chk_payments_status CHECK (status IN ('recorded', 'void')),
  CONSTRAINT chk_payments_method CHECK (method IN ('cash', 'bank_transfer', 'card', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_payments_clinic_created_at
  ON payments("clinicId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_payments_clinic_status
  ON payments("clinicId", status);

CREATE INDEX IF NOT EXISTS idx_payments_clinic_invoice
  ON payments("clinicId", "invoiceId")
  WHERE "invoiceId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_clinic_contact
  ON payments("clinicId", "contactId")
  WHERE "contactId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_id_clinic_id
  ON payments(id, "clinicId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_contact_scope'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT fk_payments_contact_scope
      FOREIGN KEY ("contactId", "clinicId")
      REFERENCES contacts(id, "clinicId")
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_invoice_scope'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT fk_payments_invoice_scope
      FOREIGN KEY ("invoiceId", "clinicId")
      REFERENCES invoices(id, "clinicId")
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_payments_fields()
RETURNS trigger AS $$
BEGIN
  NEW.amount := ROUND(COALESCE(NEW.amount, 0)::numeric, 2);
  NEW.currency := UPPER(COALESCE(NEW.currency, 'ARS'));
  NEW.method := LOWER(COALESCE(NEW.method, 'other'));
  NEW.status := LOWER(COALESCE(NEW.status, 'recorded'));
  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb);
  NEW."paidAt" := COALESCE(NEW."paidAt", NOW());

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_payments_fields ON payments;
CREATE TRIGGER trg_sync_payments_fields
BEFORE INSERT OR UPDATE ON payments
FOR EACH ROW
EXECUTE FUNCTION sync_payments_fields();
