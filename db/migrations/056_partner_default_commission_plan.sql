BEGIN;

WITH plan AS (
  INSERT INTO partner_commission_plans (code, name, status, "updatedAt")
  VALUES ('opturon_partner_standard', 'Opturon Partner Standard', 'active', NOW())
  ON CONFLICT (code) DO UPDATE
    SET status = 'active',
        "updatedAt" = NOW()
  RETURNING id
),
next_version AS (
  SELECT plan.id AS "planId",
         COALESCE((
           SELECT MAX("versionNumber")
           FROM partner_commission_plan_versions
           WHERE "planId" = plan.id
         ), 0) + 1 AS "versionNumber"
  FROM plan
),
published_exists AS (
  SELECT pv.id
  FROM partner_commission_plan_versions pv
  INNER JOIN plan ON plan.id = pv."planId"
  WHERE pv.status = 'published'
    AND pv.rules -> 'rankConfigs' @> '[{"code":"asesor","ownSignupRatePercent":"25.00"}]'::jsonb
  LIMIT 1
)
INSERT INTO partner_commission_plan_versions
  ("planId", "versionNumber", status, currency, rules, "maxPayoutPercent", "effectiveFrom", "publishedAt", "updatedAt")
SELECT next_version."planId",
       next_version."versionNumber",
       'published',
       'ARS',
       '{
         "recurringCapPercent": "15.00",
         "rankConfigs": [
           { "code": "asesor", "ownSignupRatePercent": "25.00", "ownRecurringRatePercent": "10.00", "lineRecurringRatePercentByDepth": ["0.00", "0.00", "0.00"], "rankOrder": 1 },
           { "code": "lider", "ownSignupRatePercent": "27.50", "ownRecurringRatePercent": "11.00", "lineRecurringRatePercentByDepth": ["2.00", "0.00", "0.00"], "rankOrder": 2 },
           { "code": "coordinador", "ownSignupRatePercent": "30.00", "ownRecurringRatePercent": "12.00", "lineRecurringRatePercentByDepth": ["3.00", "1.50", "0.00"], "rankOrder": 3 },
           { "code": "emperador", "ownSignupRatePercent": "32.50", "ownRecurringRatePercent": "12.00", "lineRecurringRatePercentByDepth": ["4.00", "2.00", "1.00"], "rankOrder": 4 }
         ],
         "rankThresholds": [
           { "code": "asesor", "minActiveClients": 0, "minGeneratedCommission": "0.00" },
           { "code": "lider", "minActiveClients": 3, "minGeneratedCommission": "50000.00" },
           { "code": "coordinador", "minActiveClients": 5, "minGeneratedCommission": "100000.00" },
           { "code": "emperador", "minActiveClients": 8, "minGeneratedCommission": "150000.00" }
         ]
       }'::jsonb,
       15.00,
       NOW(),
       NOW(),
       NOW()
FROM next_version
WHERE NOT EXISTS (SELECT 1 FROM published_exists);

COMMIT;

-- Rollback:
-- UPDATE partner_commission_plan_versions
-- SET status = 'archived', "updatedAt" = NOW()
-- WHERE status = 'published'
--   AND rules -> 'rankConfigs' @> '[{"code":"asesor","ownSignupRatePercent":"25.00"}]'::jsonb
--   AND "planId" IN (SELECT id FROM partner_commission_plans WHERE code = 'opturon_partner_standard');
