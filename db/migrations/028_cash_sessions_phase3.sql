CREATE TABLE IF NOT EXISTS cash_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "paymentDestinationId" UUID NOT NULL,
  "openedByUserId" UUID NOT NULL,
  "openedByNameSnapshot" TEXT NOT NULL,
  "openedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "openingAmount" NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  "closedByUserId" UUID NULL,
  "closedByNameSnapshot" TEXT NULL,
  "closedAt" TIMESTAMPTZ NULL,
  "countedAmount" NUMERIC(12, 2) NULL,
  "expectedAmount" NUMERIC(12, 2) NULL,
  "differenceAmount" NUMERIC(12, 2) NULL,
  notes TEXT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cash_sessions_status CHECK (status IN ('open', 'closed')),
  CONSTRAINT chk_cash_sessions_opening_amount_non_negative CHECK ("openingAmount" >= 0),
  CONSTRAINT chk_cash_sessions_counted_amount_non_negative CHECK ("countedAmount" IS NULL OR "countedAmount" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_sessions_id_clinic_id
  ON cash_sessions(id, "clinicId");

CREATE INDEX IF NOT EXISTS idx_cash_sessions_clinic_destination
  ON cash_sessions("clinicId", "paymentDestinationId", "openedAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_sessions_open_destination
  ON cash_sessions("paymentDestinationId")
  WHERE status = 'open';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_cash_sessions_destination_scope'
  ) THEN
    ALTER TABLE cash_sessions
      ADD CONSTRAINT fk_cash_sessions_destination_scope
      FOREIGN KEY ("paymentDestinationId", "clinicId")
      REFERENCES payment_destinations(id, "clinicId")
      ON DELETE RESTRICT;
  END IF;
END $$;
