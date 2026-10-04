-- BILL-008. Preserve contracts; normalize recognized legacy entitlement plans.
-- Unknown legacy plans retain a restricted settings snapshot; no provider calls.
ALTER TABLE saas_subscriptions DROP CONSTRAINT IF EXISTS chk_saas_subscriptions_plan_code;
ALTER TABLE saas_subscriptions ADD CONSTRAINT chk_saas_subscriptions_plan_code
  CHECK ("planCode" IN ('inicial','crecimiento','empresa','core','growth','distribution','enterprise'));

-- Compute from the row supplied by UPDATE, so a concurrent settings write is
-- evaluated against its current tuple after PostgreSQL obtains the row lock.
CREATE FUNCTION billing_090_legacy_entitlement_profile(source_settings JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  WITH source AS (
    SELECT
      CASE WHEN jsonb_typeof(source_settings->'portal')='object' THEN source_settings->'portal' ELSE '{}'::jsonb END AS portal,
      CASE WHEN jsonb_typeof(source_settings#>'{portal,policy}')='object' THEN source_settings#>'{portal,policy}' ELSE '{}'::jsonb END AS policy,
      CASE WHEN jsonb_typeof(COALESCE(source_settings#>'{portal,policy,capabilities}', source_settings#>'{businessProfile,capabilities}'))='array'
        THEN COALESCE(source_settings#>'{portal,policy,capabilities}', source_settings#>'{businessProfile,capabilities}')
        ELSE '[]'::jsonb END AS caps
  ), configured AS (
    SELECT *, ((policy->>'policyVersion' ~ '^[1-9][0-9]*$'
      OR jsonb_typeof(policy->'operatingProfile')='object'
      OR (jsonb_typeof(policy->'capabilities')='array' AND policy->'capabilities'<>'[]'::jsonb)
      OR (jsonb_typeof(policy->'enabledModules')='object' AND policy->'enabledModules'<>'{}'::jsonb)) IS TRUE) AS explicit,
      CASE lower(btrim(COALESCE(policy->>'planCode', portal->>'planCode', 'unknown')))
        WHEN 'inicial' THEN 'core' WHEN 'basic' THEN 'core' WHEN 'core' THEN 'core'
        WHEN 'crecimiento' THEN 'growth' WHEN 'growth' THEN 'growth'
        WHEN 'distribution' THEN 'distribution'
        WHEN 'empresa' THEN 'enterprise' WHEN 'enterprise' THEN 'enterprise'
        ELSE NULL
      END AS canonical_plan_key
    FROM source
  ), capabilities AS (
    SELECT s.*,
      (SELECT jsonb_object_agg(capability,
        (((module IN ('contacts','orders','invoices','cash','inventory') AND s.caps ? old_capability)
          OR (module NOT IN ('contacts','orders','invoices','cash','inventory') AND (NOT s.explicit OR s.caps ? old_capability)))
          AND COALESCE(s.policy->'enabledModules'->module <> 'false'::jsonb, true)))
       FROM (VALUES ('inbox','inbox','inbox'),('contacts','contacts','crm'),('sales','sales_pipeline','pipeline'),
         ('agenda','appointments','agenda'),('catalog','catalog','catalog'),('orders','orders','orders'),
         ('invoices','receipts','receipts'),('payments','payments','payments'),('cash','cash_management','cash'),
         ('loyalty','loyalty','loyalty'),('automations','automations','automations'),('metrics','metrics','metrics'),
         ('inventory','inventory','inventory')) AS mapping(module,old_capability,capability)) AS enabled
    FROM configured s
  )
  SELECT jsonb_build_object('planKey','legacy_grandfathered','entitlementProfileVersion',1,'source','legacy_090',
    'legacyPlanCode',COALESCE(policy->>'planCode',portal->>'planCode','unknown'),
    'capabilities',enabled || jsonb_build_object(
      'channels.whatsapp',true,'channels.instagram',true,
      'bot.enabled',COALESCE(canonical_plan_key IN ('growth','distribution','enterprise'),false),
      'bot.tier',CASE canonical_plan_key WHEN 'growth' THEN 'standard' WHEN 'distribution' THEN 'advanced' WHEN 'enterprise' THEN 'custom' ELSE 'none' END,
      'bot.ai_catalog',COALESCE(canonical_plan_key IN ('growth','distribution','enterprise'),false),
      'bot.ai_orders',COALESCE(canonical_plan_key IN ('growth','distribution','enterprise'),false),
      'bot.ai_inventory',COALESCE(canonical_plan_key IN ('distribution','enterprise'),false),
      'bot.ai_customer_history',COALESCE(canonical_plan_key IN ('distribution','enterprise'),false),
      'bot.ai_custom_instructions',COALESCE(canonical_plan_key='enterprise',false),
      'purchases',enabled->'inventory','suppliers',enabled->'inventory',
      'sellers',true,'advanced_reports',true,'advanced_permissions',true,'operational_alerts',true,
      'inventory_lots',enabled->'inventory','expiration_tracking',enabled->'inventory'))
  FROM capabilities
$$;

-- Patch only botActive (when it has no boolean preference yet) and the
-- entitlement profile path. Every other settings value comes from c.settings
-- at UPDATE time and survives concurrent or future writes.
UPDATE clinics c SET settings = jsonb_set(
  jsonb_set(
    CASE WHEN jsonb_typeof(c.settings->'portal')='object' THEN c.settings
      ELSE jsonb_set(c.settings,'{portal}','{}'::jsonb,true) END,
    '{botActive}',
    CASE
      WHEN jsonb_typeof(c.settings->'botActive')='boolean' THEN c.settings->'botActive'
      WHEN c.settings#>'{bot,enabled}'='false'::jsonb OR c.settings#>'{bot,active}'='false'::jsonb
        OR c.settings->'botEnabled'='false'::jsonb THEN 'false'::jsonb
      ELSE 'true'::jsonb END,
    true),
  '{portal,entitlements}',billing_090_legacy_entitlement_profile(c.settings),true)
WHERE jsonb_typeof(c.settings)='object'
  AND (c.settings->'portal' IS NULL OR jsonb_typeof(c.settings->'portal') IN ('object','null'))
  AND (c.settings#>'{portal,policy}' IS NULL OR jsonb_typeof(c.settings#>'{portal,policy}') IN ('object','null'))
  AND c.settings#>'{portal,entitlements}' IS NULL;

DROP FUNCTION billing_090_legacy_entitlement_profile(JSONB);

-- Backfill above does not advance existing BILL-007 ownership revisions.
-- Subsequent authoritative profile changes must participate in its same CAS.
CREATE OR REPLACE FUNCTION bump_billing_entitlement_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.settings #> '{portal,policy}' IS DISTINCT FROM OLD.settings #> '{portal,policy}'
    OR NEW.settings #> '{portal,lifecycle}' IS DISTINCT FROM OLD.settings #> '{portal,lifecycle}'
    OR NEW.settings #> '{portal,entitlements}' IS DISTINCT FROM OLD.settings #> '{portal,entitlements}'
    OR NEW."billingEntitlementRevision" IS DISTINCT FROM OLD."billingEntitlementRevision" THEN
    NEW."billingEntitlementRevision" := OLD."billingEntitlementRevision" + 1;
  END IF;
  RETURN NEW;
END $$;
