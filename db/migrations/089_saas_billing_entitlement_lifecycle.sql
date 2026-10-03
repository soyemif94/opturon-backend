-- Additive BILL-007 state. Existing positive effects remain immutable.
ALTER TABLE clinics ADD COLUMN "billingEntitlementRevision" BIGINT NOT NULL DEFAULT 0;
CREATE FUNCTION bump_billing_entitlement_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.settings #> '{portal,policy}' IS DISTINCT FROM OLD.settings #> '{portal,policy}'
    OR NEW.settings #> '{portal,lifecycle}' IS DISTINCT FROM OLD.settings #> '{portal,lifecycle}'
    OR NEW."billingEntitlementRevision" IS DISTINCT FROM OLD."billingEntitlementRevision" THEN
    NEW."billingEntitlementRevision" := OLD."billingEntitlementRevision" + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_entitlement_revision BEFORE UPDATE ON clinics FOR EACH ROW
  EXECUTE FUNCTION bump_billing_entitlement_revision();

CREATE TABLE saas_billing_lifecycles (
  "subscriptionId" UUID PRIMARY KEY REFERENCES saas_subscriptions(id),
  data JSONB NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE saas_billing_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider = 'mercado_pago'),
  "canonicalPaymentId" TEXT NOT NULL CHECK (length("canonicalPaymentId") BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN ('partial_refund','full_refund','refund_unknown','chargeback')),
  "subscriptionId" UUID NOT NULL REFERENCES saas_subscriptions(id),
  "originalEffectId" UUID REFERENCES saas_billing_effects(id),
  "sourceEventId" UUID REFERENCES saas_subscription_events(id),
  "sourceReconciliationRunId" UUID REFERENCES saas_billing_reconciliation_runs(id),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  "refundedAmount" NUMERIC,
  currency TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('reversed','manual_review')),
  reason TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (("sourceEventId" IS NOT NULL)::integer + ("sourceReconciliationRunId" IS NOT NULL)::integer = 1),
  UNIQUE (provider,"canonicalPaymentId",kind)
);
