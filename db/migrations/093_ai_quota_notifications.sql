CREATE TABLE IF NOT EXISTS ai_quota_warning_deliveries (
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "periodStart" TIMESTAMPTZ NOT NULL,
  threshold INTEGER NOT NULL CHECK (threshold IN (50, 70, 100)),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("clinicId", "periodStart", threshold)
);

CREATE INDEX IF NOT EXISTS ai_quota_warning_deliveries_clinic_period_idx
  ON ai_quota_warning_deliveries ("clinicId", "periodStart");
