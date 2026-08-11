CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_users_id_clinic_id
  ON staff_users(id, "clinicId");

CREATE TABLE IF NOT EXISTS operational_alert_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "staffUserId" UUID NULL,
  name TEXT NOT NULL,
  "phoneE164" TEXT NOT NULL,
  "roleLabel" TEXT NULL,
  "areaKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  active BOOLEAN NOT NULL DEFAULT FALSE,
  "consentStatus" TEXT NOT NULL DEFAULT 'pending',
  "consentSource" TEXT NULL,
  "consentedAt" TIMESTAMPTZ NULL,
  "revokedAt" TIMESTAMPTZ NULL,
  version INTEGER NOT NULL DEFAULT 1,
  "disabledAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_operational_alert_recipients_name_non_empty
    CHECK (length(trim(name)) > 0),
  CONSTRAINT chk_operational_alert_recipients_phone_e164
    CHECK ("phoneE164" ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT chk_operational_alert_recipients_area_keys_no_nulls
    CHECK (array_position("areaKeys", NULL) IS NULL),
  CONSTRAINT chk_operational_alert_recipients_consent_status
    CHECK ("consentStatus" IN ('pending', 'granted', 'revoked')),
  CONSTRAINT chk_operational_alert_recipients_consent_timestamps
    CHECK (
      ("consentStatus" = 'pending' AND "consentedAt" IS NULL AND "revokedAt" IS NULL)
      OR ("consentStatus" = 'granted' AND "consentedAt" IS NOT NULL AND "revokedAt" IS NULL)
      OR ("consentStatus" = 'revoked' AND "revokedAt" IS NOT NULL)
    ),
  CONSTRAINT chk_operational_alert_recipients_version_positive
    CHECK (version >= 1),
  CONSTRAINT fk_operational_alert_recipients_staff_tenant
    FOREIGN KEY ("staffUserId", "clinicId")
    REFERENCES staff_users(id, "clinicId")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_alert_recipients_id_clinic_id
  ON operational_alert_recipients(id, "clinicId");

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_alert_recipients_clinic_phone
  ON operational_alert_recipients("clinicId", "phoneE164");

CREATE INDEX IF NOT EXISTS idx_operational_alert_recipients_clinic_active
  ON operational_alert_recipients("clinicId", "createdAt" DESC)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_operational_alert_recipients_staff
  ON operational_alert_recipients("clinicId", "staffUserId")
  WHERE "staffUserId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS operational_alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventVersion" INTEGER NOT NULL DEFAULT 1,
  "triggerMode" TEXT NOT NULL,
  "configVersion" INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  "enabledAt" TIMESTAMPTZ NULL,
  "archivedAt" TIMESTAMPTZ NULL,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
  "deliveryPolicy" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "channelId" UUID NULL,
  "templateKey" TEXT NULL,
  "templateLanguage" TEXT NULL,
  "formatterKey" TEXT NOT NULL,
  "formatterVersion" INTEGER NOT NULL DEFAULT 1,
  "nextEvaluationAt" TIMESTAMPTZ NULL,
  "lastEvaluatedAt" TIMESTAMPTZ NULL,
  "lastTriggeredAt" TIMESTAMPTZ NULL,
  "schedulerLockedAt" TIMESTAMPTZ NULL,
  "schedulerLockedBy" TEXT NULL,
  "schedulerLeaseExpiresAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_operational_alert_rules_name_non_empty
    CHECK (length(trim(name)) > 0),
  CONSTRAINT chk_operational_alert_rules_event_type
    CHECK ("eventType" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT chk_operational_alert_rules_event_version_positive
    CHECK ("eventVersion" >= 1),
  CONSTRAINT chk_operational_alert_rules_trigger_mode
    CHECK ("triggerMode" IN ('event_driven', 'scheduled')),
  CONSTRAINT chk_operational_alert_rules_config_version_positive
    CHECK ("configVersion" >= 1),
  CONSTRAINT chk_operational_alert_rules_conditions_object
    CHECK (jsonb_typeof(conditions) = 'object'),
  CONSTRAINT chk_operational_alert_rules_schedule_object
    CHECK (jsonb_typeof(schedule) = 'object'),
  CONSTRAINT chk_operational_alert_rules_delivery_policy_object
    CHECK (jsonb_typeof("deliveryPolicy") = 'object'),
  CONSTRAINT chk_operational_alert_rules_formatter_key_non_empty
    CHECK (length(trim("formatterKey")) > 0),
  CONSTRAINT chk_operational_alert_rules_formatter_version_positive
    CHECK ("formatterVersion" >= 1),
  CONSTRAINT chk_operational_alert_rules_enabled_timestamp
    CHECK (enabled = FALSE OR "enabledAt" IS NOT NULL),
  CONSTRAINT chk_operational_alert_rules_archived_disabled
    CHECK ("archivedAt" IS NULL OR enabled = FALSE),
  CONSTRAINT chk_operational_alert_rules_scheduler_lease
    CHECK (
      (
        "schedulerLockedAt" IS NULL
        AND "schedulerLockedBy" IS NULL
        AND "schedulerLeaseExpiresAt" IS NULL
      )
      OR (
        "schedulerLockedAt" IS NOT NULL
        AND length(trim("schedulerLockedBy")) > 0
        AND "schedulerLeaseExpiresAt" IS NOT NULL
      )
    ),
  CONSTRAINT fk_operational_alert_rules_channel_tenant
    FOREIGN KEY ("channelId", "clinicId")
    REFERENCES channels(id, "clinicId")
    ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_alert_rules_id_clinic_id
  ON operational_alert_rules(id, "clinicId");

CREATE INDEX IF NOT EXISTS idx_operational_alert_rules_clinic_event
  ON operational_alert_rules("clinicId", "eventType", "eventVersion", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_operational_alert_rules_enabled_event_driven
  ON operational_alert_rules("clinicId", "eventType", "eventVersion")
  WHERE enabled = TRUE AND "archivedAt" IS NULL AND "triggerMode" = 'event_driven';

CREATE INDEX IF NOT EXISTS idx_operational_alert_rules_scheduled_due
  ON operational_alert_rules("nextEvaluationAt", id)
  WHERE enabled = TRUE AND "archivedAt" IS NULL AND "triggerMode" = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_operational_alert_rules_scheduler_lease
  ON operational_alert_rules("schedulerLeaseExpiresAt", id)
  WHERE "schedulerLeaseExpiresAt" IS NOT NULL;

CREATE TABLE IF NOT EXISTS operational_alert_rule_recipients (
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "ruleId" UUID NOT NULL,
  "recipientId" UUID NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_operational_alert_rule_recipients
    PRIMARY KEY ("clinicId", "ruleId", "recipientId"),
  CONSTRAINT chk_operational_alert_rule_recipients_position_non_negative
    CHECK (position >= 0),
  CONSTRAINT fk_operational_alert_rule_recipients_rule_tenant
    FOREIGN KEY ("ruleId", "clinicId")
    REFERENCES operational_alert_rules(id, "clinicId")
    ON DELETE NO ACTION,
  CONSTRAINT fk_operational_alert_rule_recipients_recipient_tenant
    FOREIGN KEY ("recipientId", "clinicId")
    REFERENCES operational_alert_recipients(id, "clinicId")
    ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_operational_alert_rule_recipients_recipient
  ON operational_alert_rule_recipients("clinicId", "recipientId");

CREATE TABLE IF NOT EXISTS operational_alert_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "eventType" TEXT NOT NULL,
  "eventVersion" INTEGER NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "occurredAt" TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  "deduplicationKey" TEXT NOT NULL,
  "targetRuleId" UUID NULL,
  source TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lockedAt" TIMESTAMPTZ NULL,
  "lockedBy" TEXT NULL,
  "leaseExpiresAt" TIMESTAMPTZ NULL,
  "lastError" TEXT NULL,
  "errorMetadata" JSONB NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "processedAt" TIMESTAMPTZ NULL,
  CONSTRAINT chk_operational_alert_events_event_type
    CHECK ("eventType" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT chk_operational_alert_events_event_version_positive
    CHECK ("eventVersion" >= 1),
  CONSTRAINT chk_operational_alert_events_entity_type_non_empty
    CHECK (length(trim("entityType")) > 0),
  CONSTRAINT chk_operational_alert_events_entity_id_non_empty
    CHECK (length(trim("entityId")) > 0),
  CONSTRAINT chk_operational_alert_events_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT chk_operational_alert_events_deduplication_key_non_empty
    CHECK (length(trim("deduplicationKey")) > 0),
  CONSTRAINT chk_operational_alert_events_source_non_empty
    CHECK (length(trim(source)) > 0),
  CONSTRAINT chk_operational_alert_events_status
    CHECK (status IN ('pending', 'processing', 'processed', 'failed_retryable', 'failed_permanent')),
  CONSTRAINT chk_operational_alert_events_attempt_count_non_negative
    CHECK ("attemptCount" >= 0),
  CONSTRAINT chk_operational_alert_events_error_metadata_object
    CHECK ("errorMetadata" IS NULL OR jsonb_typeof("errorMetadata") = 'object'),
  CONSTRAINT chk_operational_alert_events_lease
    CHECK (
      ("lockedAt" IS NULL AND "lockedBy" IS NULL AND "leaseExpiresAt" IS NULL)
      OR (
        "lockedAt" IS NOT NULL
        AND length(trim("lockedBy")) > 0
        AND "leaseExpiresAt" IS NOT NULL
      )
    ),
  CONSTRAINT fk_operational_alert_events_target_rule_tenant
    FOREIGN KEY ("targetRuleId", "clinicId")
    REFERENCES operational_alert_rules(id, "clinicId")
    ON DELETE NO ACTION,
  CONSTRAINT uq_operational_alert_events_identity
    UNIQUE ("clinicId", "eventType", "eventVersion", "deduplicationKey")
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_alert_events_id_clinic_id
  ON operational_alert_events(id, "clinicId");

CREATE INDEX IF NOT EXISTS idx_operational_alert_events_available
  ON operational_alert_events("availableAt", "createdAt", id)
  WHERE status IN ('pending', 'failed_retryable');

CREATE INDEX IF NOT EXISTS idx_operational_alert_events_lease
  ON operational_alert_events("leaseExpiresAt", id)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_operational_alert_events_entity
  ON operational_alert_events("clinicId", "entityType", "entityId", "occurredAt" DESC);

CREATE TABLE IF NOT EXISTS operational_alert_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "ruleId" UUID NOT NULL,
  "eventId" UUID NOT NULL,
  "ruleVersion" INTEGER NOT NULL,
  "occurrenceKey" TEXT NOT NULL,
  "evaluationWindowKey" TEXT NULL,
  "snapshotVersion" INTEGER NOT NULL DEFAULT 1,
  snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ NULL,
  CONSTRAINT chk_operational_alert_instances_rule_version_positive
    CHECK ("ruleVersion" >= 1),
  CONSTRAINT chk_operational_alert_instances_occurrence_key_non_empty
    CHECK (length(trim("occurrenceKey")) > 0),
  CONSTRAINT chk_operational_alert_instances_evaluation_window_key_non_empty
    CHECK ("evaluationWindowKey" IS NULL OR length(trim("evaluationWindowKey")) > 0),
  CONSTRAINT chk_operational_alert_instances_snapshot_version_positive
    CHECK ("snapshotVersion" >= 1),
  CONSTRAINT chk_operational_alert_instances_snapshot_object
    CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT chk_operational_alert_instances_status
    CHECK (status IN ('pending', 'completed', 'completed_with_errors', 'failed', 'skipped')),
  CONSTRAINT fk_operational_alert_instances_rule_tenant
    FOREIGN KEY ("ruleId", "clinicId")
    REFERENCES operational_alert_rules(id, "clinicId")
    ON DELETE NO ACTION,
  CONSTRAINT fk_operational_alert_instances_event_tenant
    FOREIGN KEY ("eventId", "clinicId")
    REFERENCES operational_alert_events(id, "clinicId")
    ON DELETE NO ACTION,
  CONSTRAINT uq_operational_alert_instances_occurrence
    UNIQUE ("clinicId", "ruleId", "occurrenceKey")
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_alert_instances_id_clinic_id
  ON operational_alert_instances(id, "clinicId");

CREATE INDEX IF NOT EXISTS idx_operational_alert_instances_rule_history
  ON operational_alert_instances("clinicId", "ruleId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_operational_alert_instances_event
  ON operational_alert_instances("clinicId", "eventId");

CREATE TABLE IF NOT EXISTS operational_alert_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "instanceId" UUID NOT NULL,
  "recipientId" UUID NOT NULL,
  "recipientVersion" INTEGER NOT NULL,
  "channelId" UUID NULL,
  "idempotencyKey" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  "recipientSnapshot" JSONB NOT NULL,
  "messageSnapshot" JSONB NULL,
  "templateKey" TEXT NULL,
  "templateLanguage" TEXT NULL,
  "templateVersion" INTEGER NULL,
  "formatterKey" TEXT NOT NULL,
  "formatterVersion" INTEGER NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lockedAt" TIMESTAMPTZ NULL,
  "lockedBy" TEXT NULL,
  "leaseExpiresAt" TIMESTAMPTZ NULL,
  "graphRequestStartedAt" TIMESTAMPTZ NULL,
  "providerMessageId" TEXT NULL,
  "resultCode" TEXT NULL,
  "lastError" TEXT NULL,
  "errorMetadata" JSONB NULL,
  "sentAt" TIMESTAMPTZ NULL,
  "deliveredAt" TIMESTAMPTZ NULL,
  "readAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_operational_alert_deliveries_idempotency_key
    UNIQUE ("idempotencyKey"),
  CONSTRAINT uq_operational_alert_deliveries_instance_recipient
    UNIQUE ("clinicId", "instanceId", "recipientId"),
  CONSTRAINT chk_operational_alert_deliveries_recipient_version_positive
    CHECK ("recipientVersion" >= 1),
  CONSTRAINT chk_operational_alert_deliveries_idempotency_key_non_empty
    CHECK (length(trim("idempotencyKey")) > 0),
  CONSTRAINT chk_operational_alert_deliveries_status
    CHECK (status IN (
      'pending',
      'sending',
      'sent',
      'delivered',
      'read',
      'failed_retryable',
      'failed_permanent',
      'unknown_delivery',
      'skipped'
    )),
  CONSTRAINT chk_operational_alert_deliveries_recipient_snapshot_object
    CHECK (jsonb_typeof("recipientSnapshot") = 'object'),
  CONSTRAINT chk_operational_alert_deliveries_message_snapshot_object
    CHECK ("messageSnapshot" IS NULL OR jsonb_typeof("messageSnapshot") = 'object'),
  CONSTRAINT chk_operational_alert_deliveries_template_version_positive
    CHECK ("templateVersion" IS NULL OR "templateVersion" >= 1),
  CONSTRAINT chk_operational_alert_deliveries_formatter_key_non_empty
    CHECK (length(trim("formatterKey")) > 0),
  CONSTRAINT chk_operational_alert_deliveries_formatter_version_positive
    CHECK ("formatterVersion" >= 1),
  CONSTRAINT chk_operational_alert_deliveries_attempt_count_non_negative
    CHECK ("attemptCount" >= 0),
  CONSTRAINT chk_operational_alert_deliveries_result_code_non_empty
    CHECK ("resultCode" IS NULL OR length(trim("resultCode")) > 0),
  CONSTRAINT chk_operational_alert_deliveries_error_metadata_object
    CHECK ("errorMetadata" IS NULL OR jsonb_typeof("errorMetadata") = 'object'),
  CONSTRAINT chk_operational_alert_deliveries_lease
    CHECK (
      ("lockedAt" IS NULL AND "lockedBy" IS NULL AND "leaseExpiresAt" IS NULL)
      OR (
        "lockedAt" IS NOT NULL
        AND length(trim("lockedBy")) > 0
        AND "leaseExpiresAt" IS NOT NULL
      )
    ),
  CONSTRAINT fk_operational_alert_deliveries_instance_tenant
    FOREIGN KEY ("instanceId", "clinicId")
    REFERENCES operational_alert_instances(id, "clinicId")
    ON DELETE NO ACTION,
  CONSTRAINT fk_operational_alert_deliveries_recipient_tenant
    FOREIGN KEY ("recipientId", "clinicId")
    REFERENCES operational_alert_recipients(id, "clinicId")
    ON DELETE NO ACTION,
  CONSTRAINT fk_operational_alert_deliveries_channel_tenant
    FOREIGN KEY ("channelId", "clinicId")
    REFERENCES channels(id, "clinicId")
    ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_alert_deliveries_id_clinic_id
  ON operational_alert_deliveries(id, "clinicId");

CREATE INDEX IF NOT EXISTS idx_operational_alert_deliveries_available
  ON operational_alert_deliveries("availableAt", "createdAt", id)
  WHERE status IN ('pending', 'failed_retryable');

CREATE INDEX IF NOT EXISTS idx_operational_alert_deliveries_lease
  ON operational_alert_deliveries("leaseExpiresAt", id)
  WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS idx_operational_alert_deliveries_recipient
  ON operational_alert_deliveries("clinicId", "recipientId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_operational_alert_deliveries_result_code
  ON operational_alert_deliveries("clinicId", "resultCode", "updatedAt" DESC)
  WHERE "resultCode" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_alert_deliveries_provider_message
  ON operational_alert_deliveries("clinicId", "channelId", "providerMessageId")
  WHERE "channelId" IS NOT NULL AND "providerMessageId" IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_operational_alert_event_payload_change()
RETURNS trigger AS $$
BEGIN
  IF NEW."clinicId" IS DISTINCT FROM OLD."clinicId"
    OR NEW."eventType" IS DISTINCT FROM OLD."eventType"
    OR NEW."eventVersion" IS DISTINCT FROM OLD."eventVersion"
    OR NEW."entityType" IS DISTINCT FROM OLD."entityType"
    OR NEW."entityId" IS DISTINCT FROM OLD."entityId"
    OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt"
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW."deduplicationKey" IS DISTINCT FROM OLD."deduplicationKey"
    OR NEW."targetRuleId" IS DISTINCT FROM OLD."targetRuleId"
    OR NEW.source IS DISTINCT FROM OLD.source
  THEN
    RAISE EXCEPTION 'operational alert event identity and payload are immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_operational_alert_event_payload_immutable'
      AND tgrelid = 'operational_alert_events'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_operational_alert_event_payload_immutable
    BEFORE UPDATE OF
      "clinicId",
      "eventType",
      "eventVersion",
      "entityType",
      "entityId",
      "occurredAt",
      payload,
      "deduplicationKey",
      "targetRuleId",
      source
    ON operational_alert_events
    FOR EACH ROW
    EXECUTE FUNCTION prevent_operational_alert_event_payload_change();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION prevent_operational_alert_instance_snapshot_change()
RETURNS trigger AS $$
BEGIN
  IF NEW."clinicId" IS DISTINCT FROM OLD."clinicId"
    OR NEW."ruleId" IS DISTINCT FROM OLD."ruleId"
    OR NEW."eventId" IS DISTINCT FROM OLD."eventId"
    OR NEW."ruleVersion" IS DISTINCT FROM OLD."ruleVersion"
    OR NEW."occurrenceKey" IS DISTINCT FROM OLD."occurrenceKey"
    OR NEW."evaluationWindowKey" IS DISTINCT FROM OLD."evaluationWindowKey"
    OR NEW."snapshotVersion" IS DISTINCT FROM OLD."snapshotVersion"
    OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
  THEN
    RAISE EXCEPTION 'operational alert instance identity and snapshot are immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_operational_alert_instance_snapshot_immutable'
      AND tgrelid = 'operational_alert_instances'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_operational_alert_instance_snapshot_immutable
    BEFORE UPDATE OF
      "clinicId",
      "ruleId",
      "eventId",
      "ruleVersion",
      "occurrenceKey",
      "evaluationWindowKey",
      "snapshotVersion",
      snapshot
    ON operational_alert_instances
    FOR EACH ROW
    EXECUTE FUNCTION prevent_operational_alert_instance_snapshot_change();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION prevent_operational_alert_delivery_snapshot_change()
RETURNS trigger AS $$
BEGIN
  IF NEW."clinicId" IS DISTINCT FROM OLD."clinicId"
    OR NEW."instanceId" IS DISTINCT FROM OLD."instanceId"
    OR NEW."recipientId" IS DISTINCT FROM OLD."recipientId"
    OR NEW."recipientVersion" IS DISTINCT FROM OLD."recipientVersion"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."recipientSnapshot" IS DISTINCT FROM OLD."recipientSnapshot"
    OR (
      OLD."messageSnapshot" IS NOT NULL
      AND NEW."messageSnapshot" IS DISTINCT FROM OLD."messageSnapshot"
    )
  THEN
    RAISE EXCEPTION 'operational alert delivery identity and snapshots are immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_operational_alert_delivery_snapshot_immutable'
      AND tgrelid = 'operational_alert_deliveries'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_operational_alert_delivery_snapshot_immutable
    BEFORE UPDATE OF
      "clinicId",
      "instanceId",
      "recipientId",
      "recipientVersion",
      "idempotencyKey",
      "recipientSnapshot",
      "messageSnapshot"
    ON operational_alert_deliveries
    FOR EACH ROW
    EXECUTE FUNCTION prevent_operational_alert_delivery_snapshot_change();
  END IF;
END $$;
