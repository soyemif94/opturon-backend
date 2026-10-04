-- BILL-008. Preserve contracts; normalize recognized legacy entitlement plans.
-- Unknown legacy plans retain a restricted settings snapshot; no provider calls.
ALTER TABLE saas_subscriptions DROP CONSTRAINT IF EXISTS chk_saas_subscriptions_plan_code;
ALTER TABLE saas_subscriptions ADD CONSTRAINT chk_saas_subscriptions_plan_code
  CHECK ("planCode" IN ('inicial','crecimiento','empresa','core','growth','distribution','enterprise'));

WITH source AS (
  SELECT id, settings,
    CASE WHEN jsonb_typeof(settings->'portal')='object' THEN settings->'portal' ELSE '{}'::jsonb END AS portal,
    CASE WHEN jsonb_typeof(settings#>'{portal,policy}')='object' THEN settings#>'{portal,policy}' ELSE '{}'::jsonb END AS policy,
    CASE WHEN jsonb_typeof(COALESCE(settings#>'{portal,policy,capabilities}', settings#>'{businessProfile,capabilities}'))='array'
      THEN COALESCE(settings#>'{portal,policy,capabilities}', settings#>'{businessProfile,capabilities}')
      ELSE '[]'::jsonb END AS caps
  FROM clinics
  WHERE jsonb_typeof(settings)='object'
    AND (settings->'portal' IS NULL OR jsonb_typeof(settings->'portal') IN ('object','null'))
    AND (settings#>'{portal,policy}' IS NULL OR jsonb_typeof(settings#>'{portal,policy}') IN ('object','null'))
    AND settings#>'{portal,entitlements}' IS NULL
), configured AS (
  SELECT *, (policy->>'policyVersion' ~ '^[1-9][0-9]*$'
    OR jsonb_typeof(policy->'operatingProfile')='object'
    OR (jsonb_typeof(policy->'capabilities')='array' AND policy->'capabilities'<>'[]'::jsonb)
    OR (jsonb_typeof(policy->'enabledModules')='object' AND policy->'enabledModules'<>'{}'::jsonb)) IS TRUE AS explicit,
    CASE lower(btrim(COALESCE(policy->>'planCode', portal->>'planCode', 'unknown')))
      WHEN 'inicial' THEN 'core' WHEN 'basic' THEN 'core' WHEN 'core' THEN 'core'
      WHEN 'crecimiento' THEN 'growth' WHEN 'growth' THEN 'growth'
      WHEN 'distribution' THEN 'distribution'
      WHEN 'empresa' THEN 'enterprise' WHEN 'enterprise' THEN 'enterprise'
      ELSE NULL
    END AS canonical_plan_key
  FROM source
), modules AS (
  SELECT s.*, m.enabled FROM configured s CROSS JOIN LATERAL (
    SELECT jsonb_object_agg(capability,
      ((module IN ('contacts','orders','invoices','cash','inventory') AND s.caps ? old_capability)
        OR (module NOT IN ('contacts','orders','invoices','cash','inventory') AND (NOT s.explicit OR s.caps ? old_capability)))
      AND COALESCE(s.policy->'enabledModules'->module <> 'false'::jsonb, true)) AS enabled
    FROM (VALUES ('inbox','inbox','inbox'),('contacts','contacts','crm'),('sales','sales_pipeline','pipeline'),
      ('agenda','appointments','agenda'),('catalog','catalog','catalog'),('orders','orders','orders'),
      ('invoices','receipts','receipts'),('payments','payments','payments'),('cash','cash_management','cash'),
      ('loyalty','loyalty','loyalty'),('automations','automations','automations'),('metrics','metrics','metrics'),
      ('inventory','inventory','inventory')) AS mapping(module,old_capability,capability)
  ) m
), profiles AS (
  SELECT *, enabled || jsonb_build_object(
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
    'inventory_lots',enabled->'inventory','expiration_tracking',enabled->'inventory') AS capabilities
  FROM modules
)
UPDATE clinics c SET settings = p.settings || jsonb_build_object(
  'botActive', CASE
    WHEN jsonb_typeof(p.settings->'botActive')='boolean' THEN p.settings->'botActive'
    WHEN p.settings#>'{bot,enabled}'='false'::jsonb OR p.settings#>'{bot,active}'='false'::jsonb
      OR p.settings->'botEnabled'='false'::jsonb THEN 'false'::jsonb
    ELSE 'true'::jsonb END,
  'portal', p.portal || jsonb_build_object('entitlements',jsonb_build_object(
    'planKey','legacy_grandfathered','entitlementProfileVersion',1,'source','legacy_090',
    'legacyPlanCode',COALESCE(p.policy->>'planCode',p.portal->>'planCode','unknown'),
    'capabilities',p.capabilities)))
FROM profiles p WHERE c.id=p.id;

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
