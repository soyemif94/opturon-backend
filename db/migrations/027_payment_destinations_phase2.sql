CREATE TABLE IF NOT EXISTS payment_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_payment_destinations_type
    CHECK (type IN ('bank', 'wallet', 'cash_box', 'other'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_destinations_id_clinic_id
  ON payment_destinations(id, "clinicId");

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_destinations_clinic_name_lower
  ON payment_destinations("clinicId", LOWER(name));

CREATE INDEX IF NOT EXISTS idx_payment_destinations_clinic_active
  ON payment_destinations("clinicId", "isActive");

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS "paymentDestinationId" UUID NULL,
  ADD COLUMN IF NOT EXISTS "paymentDestinationNameSnapshot" TEXT NULL,
  ADD COLUMN IF NOT EXISTS "paymentDestinationTypeSnapshot" TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_orders_payment_destination_scope'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT fk_orders_payment_destination_scope
      FOREIGN KEY ("paymentDestinationId", "clinicId")
      REFERENCES payment_destinations(id, "clinicId")
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_clinic_payment_destination
  ON orders("clinicId", "paymentDestinationId");
