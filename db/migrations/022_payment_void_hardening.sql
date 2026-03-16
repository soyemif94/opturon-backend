CREATE OR REPLACE FUNCTION guard_payments_lifecycle_mutations()
RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'recorded' THEN
    IF LOWER(COALESCE(NEW.status, OLD.status)) = 'recorded' AND (
      NEW."clinicId" IS DISTINCT FROM OLD."clinicId"
      OR NEW."contactId" IS DISTINCT FROM OLD."contactId"
      OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
      OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.method IS DISTINCT FROM OLD.method
      OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt"
    ) THEN
      RAISE EXCEPTION 'recorded_payments_are_financially_immutable';
    END IF;

    IF LOWER(COALESCE(NEW.status, OLD.status)) = 'void' AND (
      NEW."clinicId" IS DISTINCT FROM OLD."clinicId"
      OR NEW."contactId" IS DISTINCT FROM OLD."contactId"
      OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
      OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.method IS DISTINCT FROM OLD.method
      OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt"
    ) THEN
      RAISE EXCEPTION 'payment_void_transition_cannot_mutate_financial_fields';
    END IF;
  END IF;

  IF OLD.status = 'void' AND (
    LOWER(COALESCE(NEW.status, OLD.status)) IS DISTINCT FROM LOWER(COALESCE(OLD.status, 'void'))
    OR NEW."clinicId" IS DISTINCT FROM OLD."clinicId"
    OR NEW."contactId" IS DISTINCT FROM OLD."contactId"
    OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt"
  ) THEN
    RAISE EXCEPTION 'void_payments_are_immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_zz_guard_payments_lifecycle_mutations ON payments;
CREATE TRIGGER trg_zz_guard_payments_lifecycle_mutations
BEFORE UPDATE ON payments
FOR EACH ROW
EXECUTE FUNCTION guard_payments_lifecycle_mutations();
