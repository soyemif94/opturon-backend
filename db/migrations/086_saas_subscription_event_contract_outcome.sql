-- Internal outcomes are separate from the original provider notification.
-- Nullable, no default/backfill; previous runtimes can ignore this column.
ALTER TABLE saas_subscription_events
  ADD COLUMN IF NOT EXISTS "contractOutcome" JSONB NULL;
