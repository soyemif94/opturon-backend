ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS chk_payments_method;

ALTER TABLE payments
  ADD CONSTRAINT chk_payments_method
  CHECK (method IN ('cash', 'bank_transfer', 'card', 'other', 'combined'));
