-- Nullable fields preserve historical rows, including unresolved provider IDs.
-- NULL means legacy/unknown: the create flow must never resume such a row.
-- No unique tenant index or deduplication: historical duplicates are preserved.
ALTER TABLE saas_subscriptions
  ADD COLUMN IF NOT EXISTS "provisioningState" TEXT,
  ADD COLUMN IF NOT EXISTS "providerCallStartedAt" TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'saas_subscriptions'::regclass
      AND conname = 'chk_saas_subscriptions_provisioning_state'
  ) THEN
    ALTER TABLE saas_subscriptions
      ADD CONSTRAINT chk_saas_subscriptions_provisioning_state
      CHECK ("provisioningState" IN (
        'reserved', 'provider_call_started', 'provider_created',
        'ready', 'reconciliation_required'
      ));
  END IF;
END $$;
