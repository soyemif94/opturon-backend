CREATE TABLE saas_billing_runtime_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  "schemaVersion" INTEGER NOT NULL CHECK ("schemaVersion" = 1),
  generation INTEGER NOT NULL,
  "billingContractV2CutoverActive" BOOLEAN NOT NULL,
  "cutoverAt" TIMESTAMPTZ,
  "autoApplyNotBefore" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((generation = 1 AND NOT "billingContractV2CutoverActive" AND "cutoverAt" IS NULL AND "autoApplyNotBefore" IS NULL)
    OR (generation = 2 AND "billingContractV2CutoverActive" AND "cutoverAt" IS NOT NULL
      AND "autoApplyNotBefore" = "cutoverAt" + INTERVAL '24 hours'))
);
INSERT INTO saas_billing_runtime_state (id, "schemaVersion", generation, "billingContractV2CutoverActive")
VALUES (1, 1, 1, false);

-- Activation is irreversible. Row locks also serialize legacy finalization.
CREATE FUNCTION protect_billing_cutover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.generation = 2 AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'billing_cutover_irreversible';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_billing_cutover BEFORE UPDATE OR DELETE ON saas_billing_runtime_state
FOR EACH ROW EXECUTE FUNCTION protect_billing_cutover();
