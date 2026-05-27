CREATE TABLE IF NOT EXISTS cash_session_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "cashSessionId" UUID NOT NULL,
  type TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  method TEXT NOT NULL,
  reason TEXT NULL,
  "createdByUserId" UUID NOT NULL,
  "createdByNameSnapshot" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cash_session_movements_type CHECK (type IN ('manual_in', 'manual_out')),
  CONSTRAINT chk_cash_session_movements_method CHECK (method IN ('cash', 'transfer', 'card', 'other')),
  CONSTRAINT chk_cash_session_movements_amount_positive CHECK (amount > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_session_movements_id_clinic_id
  ON cash_session_movements(id, "clinicId");

CREATE INDEX IF NOT EXISTS idx_cash_session_movements_session_created
  ON cash_session_movements("clinicId", "cashSessionId", "createdAt" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_cash_session_movements_session_scope'
  ) THEN
    ALTER TABLE cash_session_movements
      ADD CONSTRAINT fk_cash_session_movements_session_scope
      FOREIGN KEY ("cashSessionId", "clinicId")
      REFERENCES cash_sessions(id, "clinicId")
      ON DELETE CASCADE;
  END IF;
END $$;
