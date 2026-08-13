-- Durable, process-level health signal for the existing worker.  This table is
-- intentionally not tenant-scoped: a single worker polls operational alerts
-- for every tenant, and it must not create or mutate alert work itself.
CREATE TABLE IF NOT EXISTS operational_alert_worker_heartbeats (
  "workerId" TEXT PRIMARY KEY,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lastPollStartedAt" TIMESTAMPTZ NULL,
  "lastPollCompletedAt" TIMESTAMPTZ NULL,
  "lastSuccessfulPollAt" TIMESTAMPTZ NULL,
  "lastError" TEXT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_operational_alert_worker_heartbeats_worker_id
    CHECK (length(trim("workerId")) BETWEEN 1 AND 160),
  CONSTRAINT chk_operational_alert_worker_heartbeats_last_error
    CHECK ("lastError" IS NULL OR length("lastError") <= 240)
);

CREATE INDEX IF NOT EXISTS idx_operational_alert_worker_heartbeats_updated_at
  ON operational_alert_worker_heartbeats("updatedAt" DESC, "workerId");
