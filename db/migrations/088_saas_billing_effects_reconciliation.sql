CREATE TABLE saas_billing_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider = 'mercado_pago'),
  "resourceId" TEXT NOT NULL CHECK (length("resourceId") BETWEEN 1 AND 128),
  "sourceEventId" UUID REFERENCES saas_subscription_events(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'manual_review', 'terminal')),
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 12),
  "nextAttemptAt" TIMESTAMPTZ NOT NULL,
  "leaseId" UUID,
  "leaseExpiresAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, "resourceId"),
  CHECK ((status = 'processing') = ("leaseId" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL))
);
CREATE INDEX saas_billing_reconciliations_due_idx
  ON saas_billing_reconciliations ("nextAttemptAt", "createdAt") WHERE status IN ('pending', 'processing');

CREATE TABLE saas_billing_reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "reconciliationId" UUID REFERENCES saas_billing_reconciliations(id),
  kind TEXT NOT NULL CHECK (kind IN ('automatic', 'historical')),
  "leaseId" UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'no_action', 'failed', 'manual_review', 'stale')),
  reason TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "completedAt" TIMESTAMPTZ,
  CHECK (kind <> 'automatic' OR "reconciliationId" IS NOT NULL)
);
CREATE INDEX saas_billing_reconciliation_runs_job_idx ON saas_billing_reconciliation_runs ("reconciliationId", "createdAt");

CREATE TABLE saas_billing_effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider = 'mercado_pago'),
  "effectType" TEXT NOT NULL CHECK ("effectType" = 'billing_payment_applied'),
  "canonicalPaymentId" TEXT NOT NULL CHECK (length("canonicalPaymentId") BETWEEN 1 AND 128),
  "effectKey" TEXT NOT NULL,
  "providerPreapprovalId" TEXT NOT NULL,
  "providerAccountId" TEXT,
  "subscriptionId" UUID NOT NULL REFERENCES saas_subscriptions(id),
  "clinicId" UUID NOT NULL REFERENCES clinics(id),
  "externalTenantId" TEXT NOT NULL,
  "sourceEventId" UUID REFERENCES saas_subscription_events(id),
  "sourceReconciliationRunId" UUID REFERENCES saas_billing_reconciliation_runs(id),
  status TEXT NOT NULL CHECK (status = 'applied'),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (("sourceEventId" IS NOT NULL)::integer + ("sourceReconciliationRunId" IS NOT NULL)::integer = 1),
  UNIQUE (provider, "effectType", "canonicalPaymentId"),
  UNIQUE ("effectKey")
);
