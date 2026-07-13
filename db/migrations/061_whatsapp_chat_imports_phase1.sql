CREATE TABLE IF NOT EXISTS conversation_imports (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "clinicId" TEXT NOT NULL,
  "actorId" TEXT NULL,
  "actorName" TEXT NULL,
  status TEXT NOT NULL,
  "originalFileName" TEXT NULL,
  "fileSizeBytes" INTEGER NOT NULL DEFAULT 0,
  "fileHash" TEXT NOT NULL,
  format TEXT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  "selectedContactId" TEXT NULL,
  "conversationId" TEXT NULL,
  "confirmedAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_conversation_imports_status
    CHECK (status IN ('previewed', 'confirmed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_imports_clinic
  ON conversation_imports ("clinicId");

CREATE INDEX IF NOT EXISTS idx_conversation_imports_tenant
  ON conversation_imports ("tenantId");

CREATE INDEX IF NOT EXISTS idx_conversation_imports_status
  ON conversation_imports (status);

CREATE INDEX IF NOT EXISTS idx_conversation_imports_created_at
  ON conversation_imports ("createdAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversation_imports_preview_file
  ON conversation_imports ("clinicId", "fileHash")
  WHERE status IN ('previewed', 'confirmed');
