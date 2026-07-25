CREATE TABLE IF NOT EXISTS tenant_policy_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "tenantId" TEXT NOT NULL,
  "actorUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "actorRole" TEXT NULL,
  "actorScope" TEXT NULL,
  action TEXT NOT NULL,
  "beforeSnapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "afterSnapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_policy_audit_log_tenant_created_at
  ON tenant_policy_audit_log ("tenantId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_policy_audit_log_clinic_created_at
  ON tenant_policy_audit_log ("clinicId", "createdAt" DESC);
