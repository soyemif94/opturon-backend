CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS partner_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lastLoginAt" TIMESTAMPTZ NULL,
  CONSTRAINT partner_accounts_status_check CHECK (status IN ('invited', 'active', 'suspended', 'disabled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_accounts_email_unique_idx
  ON partner_accounts ((LOWER(email)));

CREATE TABLE IF NOT EXISTS partner_profiles (
  "partnerId" UUID PRIMARY KEY REFERENCES partner_accounts(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "legalName" TEXT NULL,
  phone TEXT NULL,
  notes TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_profiles_code_unique_idx
  ON partner_profiles (code);

CREATE TABLE IF NOT EXISTS partner_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "partnerId" UUID NOT NULL REFERENCES partner_accounts(id) ON DELETE CASCADE,
  "sponsorPartnerId" UUID NULL REFERENCES partner_accounts(id) ON DELETE SET NULL,
  "relationshipType" TEXT NOT NULL DEFAULT 'sponsor',
  status TEXT NOT NULL DEFAULT 'active',
  "startsAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "endsAt" TIMESTAMPTZ NULL,
  "createdByStaffUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_relationships_status_check CHECK (status IN ('active', 'inactive', 'ended')),
  CONSTRAINT partner_relationships_type_check CHECK ("relationshipType" IN ('sponsor')),
  CONSTRAINT partner_relationships_self_reference_check CHECK ("partnerId" <> COALESCE("sponsorPartnerId", "partnerId"))
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_relationships_active_partner_idx
  ON partner_relationships ("partnerId")
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS partner_relationships_active_sponsor_idx
  ON partner_relationships ("sponsorPartnerId")
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS partner_client_attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "partnerId" UUID NOT NULL REFERENCES partner_accounts(id) ON DELETE CASCADE,
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  "tenantId" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  "attributionSource" TEXT NOT NULL DEFAULT 'manual_admin',
  notes TEXT NULL,
  "attributedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "endedAt" TIMESTAMPTZ NULL,
  "createdByStaffUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_client_attributions_status_check CHECK (status IN ('active', 'cancelled', 'transferred'))
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_client_attributions_active_clinic_idx
  ON partner_client_attributions ("clinicId")
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS partner_client_attributions_partner_idx
  ON partner_client_attributions ("partnerId", status, "attributedAt" DESC);

CREATE INDEX IF NOT EXISTS partner_client_attributions_tenant_idx
  ON partner_client_attributions ("tenantId", status);

CREATE UNIQUE INDEX IF NOT EXISTS partner_client_attributions_active_tenant_idx
  ON partner_client_attributions ("tenantId")
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS partner_commission_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  "createdByStaffUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_commission_plans_status_check CHECK (status IN ('draft', 'active', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_commission_plans_code_unique_idx
  ON partner_commission_plans (code);

CREATE TABLE IF NOT EXISTS partner_commission_plan_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "planId" UUID NOT NULL REFERENCES partner_commission_plans(id) ON DELETE CASCADE,
  "versionNumber" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL DEFAULT 'ARS',
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  "maxPayoutPercent" NUMERIC(5,2) NOT NULL DEFAULT 15.00,
  "effectiveFrom" TIMESTAMPTZ NULL,
  "effectiveTo" TIMESTAMPTZ NULL,
  "publishedAt" TIMESTAMPTZ NULL,
  "createdByStaffUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_commission_plan_versions_status_check CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT partner_commission_plan_versions_cap_check CHECK ("maxPayoutPercent" >= 0 AND "maxPayoutPercent" <= 15.00),
  CONSTRAINT partner_commission_plan_versions_window_check CHECK ("effectiveTo" IS NULL OR "effectiveFrom" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  CONSTRAINT partner_commission_plan_versions_number_check CHECK ("versionNumber" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_commission_plan_versions_unique_idx
  ON partner_commission_plan_versions ("planId", "versionNumber");

CREATE INDEX IF NOT EXISTS partner_commission_plan_versions_status_idx
  ON partner_commission_plan_versions ("planId", status, "effectiveFrom" DESC);

CREATE TABLE IF NOT EXISTS partner_commission_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "partnerId" UUID NOT NULL REFERENCES partner_accounts(id) ON DELETE RESTRICT,
  "attributionId" UUID NULL REFERENCES partner_client_attributions(id) ON DELETE SET NULL,
  "planVersionId" UUID NOT NULL REFERENCES partner_commission_plan_versions(id) ON DELETE RESTRICT,
  "clinicId" UUID NULL REFERENCES clinics(id) ON DELETE SET NULL,
  "tenantId" TEXT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "sourceEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventAt" TIMESTAMPTZ NOT NULL,
  "periodKey" TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ARS',
  "planCodeSnapshot" TEXT NOT NULL,
  "planVersionNumberSnapshot" INTEGER NOT NULL,
  "payoutKind" TEXT NOT NULL,
  "paymentStatus" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated',
  "basisAmount" NUMERIC(14,2) NOT NULL,
  "commissionRate" NUMERIC(5,2) NOT NULL,
  "commissionAmount" NUMERIC(14,2) NOT NULL,
  "depthLevel" INTEGER NOT NULL DEFAULT 0,
  "idempotencyKey" TEXT NOT NULL,
  "reversalOfEntryId" UUID NULL REFERENCES partner_commission_entries(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdByStaffUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_commission_entries_status_check CHECK (status IN ('simulated', 'generated', 'reversed')),
  CONSTRAINT partner_commission_entries_payout_kind_check CHECK ("payoutKind" IN ('own_signup', 'own_recurring', 'line_recurring_rebate')),
  CONSTRAINT partner_commission_entries_payment_status_check CHECK ("paymentStatus" IN ('accredited')),
  CONSTRAINT partner_commission_entries_amounts_check CHECK ("basisAmount" >= 0 AND "commissionRate" >= 0 AND "commissionRate" <= 100.00),
  CONSTRAINT partner_commission_entries_depth_level_check CHECK ("depthLevel" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_commission_entries_idempotency_unique_idx
  ON partner_commission_entries ("idempotencyKey");

CREATE UNIQUE INDEX IF NOT EXISTS partner_commission_entries_reversal_unique_idx
  ON partner_commission_entries ("reversalOfEntryId")
  WHERE "reversalOfEntryId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_commission_entries_partner_period_idx
  ON partner_commission_entries ("partnerId", "periodKey", status, "eventAt" DESC);

CREATE INDEX IF NOT EXISTS partner_commission_entries_source_idx
  ON partner_commission_entries ("sourceType", "sourceRef", "sourceEventId");

CREATE TABLE IF NOT EXISTS partner_rank_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "partnerId" UUID NOT NULL REFERENCES partner_accounts(id) ON DELETE CASCADE,
  "planVersionId" UUID NULL REFERENCES partner_commission_plan_versions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  "currentRankCode" TEXT NOT NULL,
  "nextRankCode" TEXT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  "windowStart" TIMESTAMPTZ NOT NULL,
  "windowEnd" TIMESTAMPTZ NOT NULL,
  "evaluatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdByStaffUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_rank_evaluations_status_check CHECK (status IN ('completed'))
);

CREATE INDEX IF NOT EXISTS partner_rank_evaluations_partner_idx
  ON partner_rank_evaluations ("partnerId", "evaluatedAt" DESC);

CREATE TABLE IF NOT EXISTS partner_rank_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "partnerId" UUID NOT NULL REFERENCES partner_accounts(id) ON DELETE CASCADE,
  "rankCode" TEXT NOT NULL,
  "effectiveFrom" TIMESTAMPTZ NOT NULL,
  "effectiveTo" TIMESTAMPTZ NULL,
  "evaluationId" UUID NULL REFERENCES partner_rank_evaluations(id) ON DELETE SET NULL,
  notes TEXT NULL,
  "createdByStaffUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_rank_history_active_idx
  ON partner_rank_history ("partnerId")
  WHERE "effectiveTo" IS NULL;

CREATE TABLE IF NOT EXISTS partner_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "partnerId" UUID NULL REFERENCES partner_accounts(id) ON DELETE SET NULL,
  "tenantId" TEXT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NULL,
  "actorType" TEXT NOT NULL DEFAULT 'system',
  "actorStaffUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "actorPartnerId" UUID NULL REFERENCES partner_accounts(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partner_audit_log_actor_type_check CHECK ("actorType" IN ('staff', 'partner', 'system'))
);

CREATE INDEX IF NOT EXISTS partner_audit_log_partner_idx
  ON partner_audit_log ("partnerId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS partner_audit_log_tenant_idx
  ON partner_audit_log ("tenantId", "createdAt" DESC);
