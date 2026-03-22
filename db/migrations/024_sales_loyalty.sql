CREATE TABLE IF NOT EXISTS loyalty_programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  "spendAmount" NUMERIC(12, 2) NOT NULL DEFAULT 1000,
  "pointsAmount" INTEGER NOT NULL DEFAULT 10,
  "programText" TEXT NULL,
  "redemptionPolicyText" TEXT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_loyalty_programs_spend_amount_positive CHECK ("spendAmount" > 0),
  CONSTRAINT chk_loyalty_programs_points_amount_positive CHECK ("pointsAmount" > 0),
  CONSTRAINT uq_loyalty_programs_clinic UNIQUE ("clinicId")
);

CREATE INDEX IF NOT EXISTS idx_loyalty_programs_clinic
  ON loyalty_programs("clinicId");

CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NULL,
  "pointsCost" INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_loyalty_rewards_points_cost_positive CHECK ("pointsCost" > 0)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_clinic_active
  ON loyalty_rewards("clinicId", active, "createdAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_rewards_id_clinic
  ON loyalty_rewards(id, "clinicId");

CREATE TABLE IF NOT EXISTS loyalty_points_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "contactId" UUID NOT NULL,
  direction TEXT NOT NULL,
  points INTEGER NOT NULL,
  "pointsDelta" INTEGER NOT NULL,
  reason TEXT NOT NULL,
  "referenceType" TEXT NULL,
  "referenceId" TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_loyalty_points_ledger_direction CHECK (direction IN ('earn', 'redeem', 'adjust', 'reverse')),
  CONSTRAINT chk_loyalty_points_ledger_points_positive CHECK (points > 0),
  CONSTRAINT chk_loyalty_points_ledger_nonzero_delta CHECK ("pointsDelta" <> 0)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_points_ledger_clinic_contact_created
  ON loyalty_points_ledger("clinicId", "contactId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_loyalty_points_ledger_clinic_created
  ON loyalty_points_ledger("clinicId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_loyalty_points_ledger_reference
  ON loyalty_points_ledger("clinicId", "referenceType", "referenceId");

CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_points_ledger_payment_earn
  ON loyalty_points_ledger("clinicId", "referenceId")
  WHERE "referenceType" = 'payment' AND direction = 'earn';

CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_points_ledger_payment_reverse
  ON loyalty_points_ledger("clinicId", "referenceId")
  WHERE "referenceType" = 'payment' AND direction = 'reverse';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_loyalty_points_ledger_contact_scope'
  ) THEN
    ALTER TABLE loyalty_points_ledger
      ADD CONSTRAINT fk_loyalty_points_ledger_contact_scope
      FOREIGN KEY ("contactId", "clinicId")
      REFERENCES contacts(id, "clinicId")
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_loyalty_program_fields()
RETURNS trigger AS $$
BEGIN
  NEW."spendAmount" := ROUND(COALESCE(NEW."spendAmount", 1000)::numeric, 2);
  NEW."pointsAmount" := COALESCE(NEW."pointsAmount", 10);
  NEW.enabled := COALESCE(NEW.enabled, FALSE);
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_loyalty_program_fields ON loyalty_programs;
CREATE TRIGGER trg_sync_loyalty_program_fields
BEFORE INSERT OR UPDATE ON loyalty_programs
FOR EACH ROW
EXECUTE FUNCTION sync_loyalty_program_fields();

CREATE OR REPLACE FUNCTION sync_loyalty_reward_fields()
RETURNS trigger AS $$
BEGIN
  NEW.name := BTRIM(COALESCE(NEW.name, ''));
  NEW.description := NULLIF(BTRIM(COALESCE(NEW.description, '')), '');
  NEW."pointsCost" := COALESCE(NEW."pointsCost", 0);
  NEW.active := COALESCE(NEW.active, TRUE);
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_loyalty_reward_fields ON loyalty_rewards;
CREATE TRIGGER trg_sync_loyalty_reward_fields
BEFORE INSERT OR UPDATE ON loyalty_rewards
FOR EACH ROW
EXECUTE FUNCTION sync_loyalty_reward_fields();

CREATE OR REPLACE FUNCTION sync_loyalty_points_ledger_fields()
RETURNS trigger AS $$
BEGIN
  NEW.direction := LOWER(COALESCE(NEW.direction, 'adjust'));
  NEW.points := COALESCE(NEW.points, ABS(COALESCE(NEW."pointsDelta", 0)));
  NEW."pointsDelta" := COALESCE(NEW."pointsDelta", 0);
  NEW.reason := BTRIM(COALESCE(NEW.reason, ''));
  NEW."referenceType" := NULLIF(BTRIM(COALESCE(NEW."referenceType", '')), '');
  NEW."referenceId" := NULLIF(BTRIM(COALESCE(NEW."referenceId", '')), '');
  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_loyalty_points_ledger_fields ON loyalty_points_ledger;
CREATE TRIGGER trg_sync_loyalty_points_ledger_fields
BEFORE INSERT OR UPDATE ON loyalty_points_ledger
FOR EACH ROW
EXECUTE FUNCTION sync_loyalty_points_ledger_fields();
