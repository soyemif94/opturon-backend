CREATE TABLE IF NOT EXISTS payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "paymentId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_payment_allocations_amount_positive CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_clinic_payment
  ON payment_allocations("clinicId", "paymentId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_clinic_invoice
  ON payment_allocations("clinicId", "invoiceId", "createdAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_allocations_id_clinic_id
  ON payment_allocations(id, "clinicId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_allocations_payment_scope'
  ) THEN
    ALTER TABLE payment_allocations
      ADD CONSTRAINT fk_payment_allocations_payment_scope
      FOREIGN KEY ("paymentId", "clinicId")
      REFERENCES payments(id, "clinicId")
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_allocations_invoice_scope'
  ) THEN
    ALTER TABLE payment_allocations
      ADD CONSTRAINT fk_payment_allocations_invoice_scope
      FOREIGN KEY ("invoiceId", "clinicId")
      REFERENCES invoices(id, "clinicId")
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_payment_allocations_fields()
RETURNS trigger AS $$
BEGIN
  NEW.amount := ROUND(COALESCE(NEW.amount, 0)::numeric, 2);
  NEW."updatedAt" := NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_payment_allocations_fields ON payment_allocations;
CREATE TRIGGER trg_sync_payment_allocations_fields
BEFORE INSERT OR UPDATE ON payment_allocations
FOR EACH ROW
EXECUTE FUNCTION sync_payment_allocations_fields();

CREATE OR REPLACE FUNCTION guard_payment_allocations_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW."clinicId" IS DISTINCT FROM OLD."clinicId"
    OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
    OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
    OR NEW.amount IS DISTINCT FROM OLD.amount THEN
    RAISE EXCEPTION 'payment_allocations_are_immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_zz_guard_payment_allocations_immutable ON payment_allocations;
CREATE TRIGGER trg_zz_guard_payment_allocations_immutable
BEFORE UPDATE ON payment_allocations
FOR EACH ROW
EXECUTE FUNCTION guard_payment_allocations_immutable();

INSERT INTO payment_allocations (
  "clinicId",
  "paymentId",
  "invoiceId",
  amount
)
SELECT
  p."clinicId",
  p.id,
  p."invoiceId",
  p.amount
FROM payments p
WHERE p."invoiceId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM payment_allocations pa
    WHERE pa."paymentId" = p.id
      AND pa."clinicId" = p."clinicId"
  );
