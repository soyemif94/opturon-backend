ALTER TABLE cash_sessions
  ADD COLUMN IF NOT EXISTS "cashCountedAmount" NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS "transferCountedAmount" NUMERIC(12, 2);
