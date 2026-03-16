CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_id_clinic_id
  ON invoices(id, "clinicId");

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS "documentMode" TEXT NOT NULL DEFAULT 'internal_only',
  ADD COLUMN IF NOT EXISTS "parentInvoiceId" UUID NULL,
  ADD COLUMN IF NOT EXISTS "providerStatus" TEXT NULL;

UPDATE invoices
SET "documentMode" = CASE
  WHEN COALESCE("externalProvider", '') <> '' OR COALESCE("externalReference", '') <> '' THEN 'external_provider'
  ELSE 'internal_only'
END
WHERE "documentMode" IS NULL OR "documentMode" NOT IN ('internal_only', 'external_provider', 'synced_external');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_document_mode') THEN
    ALTER TABLE invoices DROP CONSTRAINT chk_invoices_document_mode;
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT chk_invoices_document_mode
  CHECK ("documentMode" IN ('internal_only', 'external_provider', 'synced_external'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_parent_scope'
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT fk_invoices_parent_scope
      FOREIGN KEY ("parentInvoiceId", "clinicId")
      REFERENCES invoices(id, "clinicId")
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_credit_note_parent') THEN
    ALTER TABLE invoices DROP CONSTRAINT chk_invoices_credit_note_parent;
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT chk_invoices_credit_note_parent
  CHECK (
    (type = 'credit_note' AND "parentInvoiceId" IS NOT NULL)
    OR (type = 'invoice' AND "parentInvoiceId" IS NULL)
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_self_parent') THEN
    ALTER TABLE invoices DROP CONSTRAINT chk_invoices_self_parent;
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT chk_invoices_self_parent
  CHECK ("parentInvoiceId" IS NULL OR "parentInvoiceId" <> id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_billing_amounts') THEN
    ALTER TABLE invoices DROP CONSTRAINT chk_invoices_billing_amounts;
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT chk_invoices_billing_amounts
  CHECK (
    (
      type = 'invoice'
      AND "subtotalAmount" >= 0
      AND "taxAmount" >= 0
      AND "totalAmount" = "subtotalAmount" + "taxAmount"
    )
    OR
    (
      type = 'credit_note'
      AND "subtotalAmount" <= 0
      AND "taxAmount" <= 0
      AND "totalAmount" = "subtotalAmount" + "taxAmount"
    )
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoice_items_billing_amounts') THEN
    ALTER TABLE invoice_items DROP CONSTRAINT chk_invoice_items_billing_amounts;
  END IF;
END $$;

ALTER TABLE invoice_items
  ADD CONSTRAINT chk_invoice_items_billing_amounts
  CHECK (
    "taxRate" >= 0
    AND "subtotalAmount" = ROUND(("unitPrice" * quantity)::numeric, 2)
    AND "totalAmount" = ROUND(("subtotalAmount" + ROUND("subtotalAmount" * "taxRate" / 100.0, 2))::numeric, 2)
  );

CREATE OR REPLACE FUNCTION enforce_invoice_lifecycle_mutability()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'issued' THEN
    IF
      NEW."clinicId" IS DISTINCT FROM OLD."clinicId" OR
      NEW."contactId" IS DISTINCT FROM OLD."contactId" OR
      NEW."orderId" IS DISTINCT FROM OLD."orderId" OR
      NEW."invoiceNumber" IS DISTINCT FROM OLD."invoiceNumber" OR
      NEW.type IS DISTINCT FROM OLD.type OR
      NEW.currency IS DISTINCT FROM OLD.currency OR
      NEW."subtotalAmount" IS DISTINCT FROM OLD."subtotalAmount" OR
      NEW."taxAmount" IS DISTINCT FROM OLD."taxAmount" OR
      NEW."totalAmount" IS DISTINCT FROM OLD."totalAmount" OR
      NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" OR
      NEW."dueAt" IS DISTINCT FROM OLD."dueAt" OR
      NEW."parentInvoiceId" IS DISTINCT FROM OLD."parentInvoiceId"
    THEN
      RAISE EXCEPTION 'issued invoices are immutable except lifecycle/provider fields';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'void' THEN
    IF
      NEW.status IS DISTINCT FROM OLD.status OR
      NEW."clinicId" IS DISTINCT FROM OLD."clinicId" OR
      NEW."contactId" IS DISTINCT FROM OLD."contactId" OR
      NEW."orderId" IS DISTINCT FROM OLD."orderId" OR
      NEW."invoiceNumber" IS DISTINCT FROM OLD."invoiceNumber" OR
      NEW.type IS DISTINCT FROM OLD.type OR
      NEW.currency IS DISTINCT FROM OLD.currency OR
      NEW."subtotalAmount" IS DISTINCT FROM OLD."subtotalAmount" OR
      NEW."taxAmount" IS DISTINCT FROM OLD."taxAmount" OR
      NEW."totalAmount" IS DISTINCT FROM OLD."totalAmount" OR
      NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" OR
      NEW."dueAt" IS DISTINCT FROM OLD."dueAt" OR
      NEW."parentInvoiceId" IS DISTINCT FROM OLD."parentInvoiceId"
    THEN
      RAISE EXCEPTION 'void invoices are immutable except provider/metadata fields';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_invoice_lifecycle_mutability ON invoices;
CREATE TRIGGER trg_enforce_invoice_lifecycle_mutability
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION enforce_invoice_lifecycle_mutability();

CREATE OR REPLACE FUNCTION guard_invoice_items_mutability()
RETURNS trigger AS $$
DECLARE
  invoice_status TEXT;
BEGIN
  SELECT status
  INTO invoice_status
  FROM invoices
  WHERE id = COALESCE(NEW."invoiceId", OLD."invoiceId");

  IF COALESCE(invoice_status, 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'invoice items can only be modified while invoice is draft';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_invoice_items_insert ON invoice_items;
CREATE TRIGGER trg_guard_invoice_items_insert
BEFORE INSERT ON invoice_items
FOR EACH ROW
EXECUTE FUNCTION guard_invoice_items_mutability();

DROP TRIGGER IF EXISTS trg_guard_invoice_items_update ON invoice_items;
CREATE TRIGGER trg_guard_invoice_items_update
BEFORE UPDATE ON invoice_items
FOR EACH ROW
EXECUTE FUNCTION guard_invoice_items_mutability();

DROP TRIGGER IF EXISTS trg_guard_invoice_items_delete ON invoice_items;
CREATE TRIGGER trg_guard_invoice_items_delete
BEFORE DELETE ON invoice_items
FOR EACH ROW
EXECUTE FUNCTION guard_invoice_items_mutability();
