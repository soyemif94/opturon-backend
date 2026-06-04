CREATE TABLE IF NOT EXISTS saas_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "externalTenantId" TEXT NOT NULL,
  "clientId" UUID NULL,
  "planCode" TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ARS',
  "billingInterval" TEXT NOT NULL DEFAULT 'monthly',
  "mercadoPagoPreapprovalId" TEXT NULL,
  "mercadoPagoPayerEmail" TEXT NULL,
  "mercadoPagoStatus" TEXT NULL,
  "localStatus" TEXT NOT NULL DEFAULT 'pending',
  "currentPeriodStart" TIMESTAMPTZ NULL,
  "currentPeriodEnd" TIMESTAMPTZ NULL,
  "nextBillingDate" TIMESTAMPTZ NULL,
  "lastPaymentId" TEXT NULL,
  "lastPaymentStatus" TEXT NULL,
  "externalReference" TEXT NOT NULL,
  "authorizationUrl" TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_saas_subscriptions_external_reference
  ON saas_subscriptions ("externalReference");

CREATE UNIQUE INDEX IF NOT EXISTS uniq_saas_subscriptions_mp_preapproval
  ON saas_subscriptions ("mercadoPagoPreapprovalId")
  WHERE "mercadoPagoPreapprovalId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_saas_subscriptions_tenant_created
  ON saas_subscriptions ("externalTenantId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_saas_subscriptions_clinic_created
  ON saas_subscriptions ("clinicId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_saas_subscriptions_status_created
  ON saas_subscriptions ("localStatus", "createdAt" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_saas_subscriptions_plan_code'
  ) THEN
    ALTER TABLE saas_subscriptions
      ADD CONSTRAINT chk_saas_subscriptions_plan_code
      CHECK ("planCode" IN ('inicial', 'crecimiento', 'empresa'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_saas_subscriptions_billing_interval'
  ) THEN
    ALTER TABLE saas_subscriptions
      ADD CONSTRAINT chk_saas_subscriptions_billing_interval
      CHECK ("billingInterval" IN ('monthly'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_saas_subscriptions_local_status'
  ) THEN
    ALTER TABLE saas_subscriptions
      ADD CONSTRAINT chk_saas_subscriptions_local_status
      CHECK ("localStatus" IN ('pending', 'active', 'paused', 'canceled', 'payment_failed', 'suspended'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS saas_subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscriptionId" UUID NULL REFERENCES saas_subscriptions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'mercado_pago',
  topic TEXT NULL,
  action TEXT NULL,
  "resourceId" TEXT NULL,
  "notificationId" TEXT NULL,
  "requestId" TEXT NULL,
  "dedupeKey" TEXT NOT NULL,
  "signatureValid" BOOLEAN NULL,
  raw JSONB NOT NULL,
  "processingStatus" TEXT NOT NULL DEFAULT 'received',
  "processingError" TEXT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_saas_subscription_events_dedupe
  ON saas_subscription_events ("dedupeKey");

CREATE INDEX IF NOT EXISTS idx_saas_subscription_events_subscription_created
  ON saas_subscription_events ("subscriptionId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_saas_subscription_events_resource_created
  ON saas_subscription_events ("resourceId", "createdAt" DESC);
