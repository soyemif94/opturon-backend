CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS catalog_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" TEXT NOT NULL,
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "actorId" TEXT NULL,
  "actorName" TEXT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  "originalFileName" TEXT NOT NULL,
  "safeFileName" TEXT NOT NULL,
  "fileType" TEXT NOT NULL,
  "mimeType" TEXT NULL,
  "fileSizeBytes" INT NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  "confirmedAt" TIMESTAMPTZ NULL,
  "completedAt" TIMESTAMPTZ NULL,
  "cancelledAt" TIMESTAMPTZ NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_catalog_import_jobs_status
    CHECK (status IN ('uploaded', 'analyzed', 'ready', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_catalog_import_jobs_clinic_created_at
  ON catalog_import_jobs ("clinicId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_import_jobs_tenant_created_at
  ON catalog_import_jobs ("tenantId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_import_jobs_status_expires_at
  ON catalog_import_jobs (status, "expiresAt");

CREATE TABLE IF NOT EXISTS catalog_import_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "importId" UUID NOT NULL REFERENCES catalog_import_jobs(id) ON DELETE CASCADE,
  "tenantId" TEXT NOT NULL,
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "actorId" TEXT NULL,
  "actorName" TEXT NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_catalog_import_audit_log_import_created_at
  ON catalog_import_audit_log ("importId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_import_audit_log_tenant_created_at
  ON catalog_import_audit_log ("tenantId", "createdAt" DESC);
