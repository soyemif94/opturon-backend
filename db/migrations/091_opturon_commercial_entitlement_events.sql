-- BILL-008: append-only, Opturon-controlled commercial entitlement grants.
-- No tenant-facing route or checkout is introduced by this migration.
CREATE TABLE IF NOT EXISTS tenant_commercial_entitlement_events (
  id BIGSERIAL PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  entitlement_key TEXT NOT NULL CHECK (entitlement_key IN ('bot_standard')),
  action TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
  actor_user_id UUID NOT NULL REFERENCES staff_users(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tenant_commercial_entitlement_events_latest_idx
  ON tenant_commercial_entitlement_events (clinic_id, entitlement_key, id DESC);

CREATE OR REPLACE FUNCTION reject_tenant_commercial_entitlement_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commercial entitlement audit events are append-only';
END $$;

DROP TRIGGER IF EXISTS tenant_commercial_entitlement_events_immutable
  ON tenant_commercial_entitlement_events;
CREATE TRIGGER tenant_commercial_entitlement_events_immutable
  BEFORE UPDATE OR DELETE ON tenant_commercial_entitlement_events
  FOR EACH ROW EXECUTE FUNCTION reject_tenant_commercial_entitlement_event_mutation();
