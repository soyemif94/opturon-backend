CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS "finalizedAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "finalizationVersion" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_orders_finalization_version_non_negative'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_finalization_version_non_negative
      CHECK ("finalizationVersion" >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_orders_finalization_metadata_consistent'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_finalization_metadata_consistent
      CHECK (
        ("finalizationVersion" = 0 AND "finalizedAt" IS NULL)
        OR ("finalizationVersion" > 0 AND "finalizedAt" IS NOT NULL)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_channels_id_clinic_id
  ON channels(id, "clinicId");

CREATE TABLE IF NOT EXISTS order_customer_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  "orderId" UUID NOT NULL,
  "contactId" UUID NULL,
  "conversationId" UUID NULL,
  "channelId" UUID NULL,
  "notificationType" TEXT NOT NULL DEFAULT 'order_summary',
  "finalizationVersion" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  snapshot JSONB NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lockedAt" TIMESTAMPTZ NULL,
  "lockedBy" TEXT NULL,
  "leaseExpiresAt" TIMESTAMPTZ NULL,
  "providerMessageId" TEXT NULL,
  "lastError" TEXT NULL,
  "errorMetadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "sentAt" TIMESTAMPTZ NULL,
  "deliveredAt" TIMESTAMPTZ NULL,
  "readAt" TIMESTAMPTZ NULL,
  CONSTRAINT uq_order_customer_notifications_idempotency_key
    UNIQUE ("idempotencyKey"),
  CONSTRAINT chk_order_customer_notifications_type_non_empty
    CHECK (length(trim("notificationType")) > 0),
  CONSTRAINT chk_order_customer_notifications_version_positive
    CHECK ("finalizationVersion" > 0),
  CONSTRAINT chk_order_customer_notifications_key_non_empty
    CHECK (length(trim("idempotencyKey")) > 0),
  CONSTRAINT chk_order_customer_notifications_status
    CHECK (status IN (
      'pending',
      'sending',
      'sent',
      'delivered',
      'read',
      'failed_retryable',
      'failed_permanent',
      'unknown_delivery',
      'skipped_no_contact'
    )),
  CONSTRAINT chk_order_customer_notifications_snapshot_object
    CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT chk_order_customer_notifications_error_metadata_object
    CHECK (jsonb_typeof("errorMetadata") = 'object'),
  CONSTRAINT chk_order_customer_notifications_attempt_count_non_negative
    CHECK ("attemptCount" >= 0),
  CONSTRAINT fk_order_customer_notifications_order_tenant
    FOREIGN KEY ("orderId", "clinicId")
    REFERENCES orders(id, "clinicId")
    ON DELETE NO ACTION,
  CONSTRAINT fk_order_customer_notifications_contact_tenant
    FOREIGN KEY ("contactId", "clinicId")
    REFERENCES contacts(id, "clinicId")
    ON DELETE NO ACTION,
  CONSTRAINT fk_order_customer_notifications_conversation_tenant
    FOREIGN KEY ("conversationId", "clinicId")
    REFERENCES conversations(id, "clinicId")
    ON DELETE NO ACTION,
  CONSTRAINT fk_order_customer_notifications_channel_tenant
    FOREIGN KEY ("channelId", "clinicId")
    REFERENCES channels(id, "clinicId")
    ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_customer_notifications_finalization
  ON order_customer_notifications(
    "clinicId",
    "orderId",
    "notificationType",
    "finalizationVersion"
  );

CREATE INDEX IF NOT EXISTS idx_order_customer_notifications_available
  ON order_customer_notifications(status, "availableAt", "createdAt")
  WHERE status IN ('pending', 'failed_retryable');

CREATE INDEX IF NOT EXISTS idx_order_customer_notifications_order
  ON order_customer_notifications("clinicId", "orderId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_order_customer_notifications_lease
  ON order_customer_notifications(status, "leaseExpiresAt")
  WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS idx_order_customer_notifications_provider_message
  ON order_customer_notifications("providerMessageId")
  WHERE "providerMessageId" IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_order_customer_notification_snapshot_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW."clinicId" IS DISTINCT FROM OLD."clinicId"
    OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."notificationType" IS DISTINCT FROM OLD."notificationType"
    OR NEW."finalizationVersion" IS DISTINCT FROM OLD."finalizationVersion"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
  THEN
    RAISE EXCEPTION 'order customer notification identity and snapshot are immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_order_customer_notification_snapshot_immutable'
      AND tgrelid = 'order_customer_notifications'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_order_customer_notification_snapshot_immutable
    BEFORE UPDATE OF
      snapshot,
      "clinicId",
      "orderId",
      "notificationType",
      "finalizationVersion",
      "idempotencyKey"
    ON order_customer_notifications
    FOR EACH ROW
    EXECUTE FUNCTION prevent_order_customer_notification_snapshot_change();
  END IF;
END $$;
