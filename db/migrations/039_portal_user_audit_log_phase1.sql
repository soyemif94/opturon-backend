CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS portal_user_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" TEXT NOT NULL,
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "actorUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  "targetUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_user_audit_log_clinic_created_at
  ON portal_user_audit_log ("clinicId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_portal_user_audit_log_tenant_created_at
  ON portal_user_audit_log ("tenantId", "createdAt" DESC);
