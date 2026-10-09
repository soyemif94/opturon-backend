const { query } = require('../db/client');

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

function periodBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

async function ensureAiProvisioning(client, { clinicId, planKey, botTier, includedResponses, activatedAt = null }) {
  const available = await dbQuery(client, `SELECT to_regclass('public.ai_tenant_provisioning') AS table_name`);
  if (!available.rows[0]?.table_name) return null;
  const { start, end } = periodBounds(activatedAt ? new Date(activatedAt) : new Date());
  const result = await dbQuery(client, `
    INSERT INTO ai_tenant_provisioning
      ("clinicId","planKey","botTier",status,"includedResponses","periodStart","periodEnd","activatedAt","provisioningStartedAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $4='pending' THEN clock_timestamp() ELSE NULL END)
    ON CONFLICT ("clinicId") DO UPDATE SET
      "planKey"=EXCLUDED."planKey", "botTier"=EXCLUDED."botTier",
      "includedResponses"=EXCLUDED."includedResponses", "updatedAt"=clock_timestamp()
    RETURNING *`, [clinicId, planKey, botTier, botTier === 'none' ? 'not_required' : 'pending', includedResponses ?? 0, start, end, activatedAt]);
  return result.rows[0] || null;
}

async function findAiProvisioning(clinicId, client = null) {
  const result = await dbQuery(client, 'SELECT * FROM ai_tenant_provisioning WHERE "clinicId"=$1', [clinicId]);
  return result.rows[0] || null;
}

async function reserveAiUsage(client, input) {
  const { clinicId, conversationId = null, messageId = null, periodStart, periodEnd, botTier, route } = input;
  const result = await dbQuery(client, `
    WITH existing AS (
      SELECT id, status FROM ai_usage_events
      WHERE "clinicId"=$1 AND "conversationId" IS NOT DISTINCT FROM $2 AND "messageId" IS NOT DISTINCT FROM $3
    ), counts AS (
      SELECT COUNT(*)::int AS used FROM ai_usage_events
      WHERE "clinicId"=$1 AND "periodStart"=$4 AND status IN ('reserved','succeeded')
    )
    INSERT INTO ai_usage_events ("clinicId","conversationId","messageId","periodStart","periodEnd","botTier",route,status)
    SELECT $1,$2,$3,$4,$5,$6,$7,'reserved'
    WHERE NOT EXISTS (SELECT 1 FROM existing)
      AND (SELECT used FROM counts) < COALESCE((SELECT "includedResponses" FROM ai_tenant_provisioning WHERE "clinicId"=$1), 0)
    ON CONFLICT ("clinicId","conversationId","messageId") DO NOTHING
    RETURNING id, status`, [clinicId, conversationId, messageId, periodStart, periodEnd, botTier, route]);
  if (result.rows[0]) return { ok: true, id: result.rows[0].id, duplicate: false };
  const existing = await dbQuery(client, `SELECT id,status FROM ai_usage_events
    WHERE "clinicId"=$1 AND "conversationId" IS NOT DISTINCT FROM $2 AND "messageId" IS NOT DISTINCT FROM $3`, [clinicId, conversationId, messageId]);
  if (existing.rows[0]) return { ok: true, id: existing.rows[0].id, duplicate: true, status: existing.rows[0].status };
  return { ok: false, reason: 'ai_quota_exhausted' };
}

async function completeAiUsage(client, id, result, status = 'succeeded') {
  if (!id) return null;
  const usage = result && result.usage ? result.usage : {};
  const updated = await dbQuery(client, `UPDATE ai_usage_events SET status=$2, model=$3,
    "promptTokens"=$4,"completionTokens"=$5,"totalTokens"=$6,"estimatedCostUsd"=$7,"updatedAt"=clock_timestamp()
    WHERE id=$1 RETURNING *`, [id, status, result?.model || null, usage.promptTokens ?? null,
    usage.completionTokens ?? null, usage.totalTokens ?? null, result?.estimatedCostUsd ?? null]);
  return updated.rows[0] || null;
}

async function listAiProvisioningQueue(client = null) {
  const result = await dbQuery(client, `SELECT p.*, c.name AS "clinicName",
    COALESCE(u.used_responses, 0)::int AS "usedResponses",
    GREATEST(p."includedResponses" - COALESCE(u.used_responses, 0), 0)::int AS "remainingResponses",
    CASE WHEN p."provisioningStartedAt" IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (clock_timestamp() - p."provisioningStartedAt"))/3600 END AS "hoursElapsed",
    CASE WHEN p."provisioningStartedAt" IS NOT NULL AND p.status IN ('pending','blocked','failed') AND clock_timestamp() >= p."provisioningStartedAt" + interval '48 hours' THEN true ELSE false END AS "over48Hours"
    FROM ai_tenant_provisioning p JOIN clinics c ON c.id=p."clinicId"
    LEFT JOIN (SELECT "clinicId", COUNT(*) FILTER (WHERE status='succeeded') AS used_responses FROM ai_usage_events GROUP BY "clinicId") u ON u."clinicId"=p."clinicId"
    ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END, p."updatedAt" ASC`);
  return result.rows;
}

async function updateAiProvisioningStatus(clinicId, status, reason = null, client = null) {
  const allowed = new Set(['pending', 'ready', 'blocked', 'failed']);
  if (!allowed.has(status)) return null;
  const result = await dbQuery(client, `UPDATE ai_tenant_provisioning SET status=$2,
    "readyAt"=CASE WHEN $2='ready' THEN COALESCE("readyAt",clock_timestamp()) ELSE "readyAt" END,
    "blockedReason"=CASE WHEN $2='blocked' THEN $3 ELSE NULL END,
    "lastError"=CASE WHEN $2='failed' THEN $3 ELSE NULL END,
    "updatedAt"=clock_timestamp() WHERE "clinicId"=$1 RETURNING *`, [clinicId, status, reason]);
  return result.rows[0] || null;
}

function summarizeAiUsage({ includedResponses = null, succeededResponses = 0, reservedResponses = 0, periodStart = null, periodEnd = null } = {}) {
  const included = includedResponses == null ? null : Math.max(0, Number(includedResponses) || 0);
  const used = Math.max(0, Number(succeededResponses) || 0);
  const reserved = Math.max(0, Number(reservedResponses) || 0);
  const committed = used + reserved;
  const remaining = included == null ? null : Math.max(included - committed, 0);
  const percent = included == null || included === 0 ? null : Math.min(100, Math.floor((committed / included) * 100));
  return {
    usedResponses: used,
    reservedResponses: reserved,
    includedResponses: included,
    remainingResponses: remaining,
    percent,
    quotaAvailable: included == null || committed < included,
    periodStart,
    periodEnd
  };
}

function crossedQuotaThresholds(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return [];
  return [50, 70, 100].filter((threshold) => value >= threshold);
}

async function getAiUsageSummary(clinicId, provisioning, client = null) {
  if (!clinicId || !provisioning) return null;
  const result = await dbQuery(client, `
    SELECT
      COUNT(*) FILTER (WHERE status='succeeded')::int AS succeeded_responses,
      COUNT(*) FILTER (WHERE status='reserved')::int AS reserved_responses
    FROM ai_usage_events
    WHERE "clinicId"=$1 AND "periodStart"=$2 AND "periodEnd"=$3`,
    [clinicId, provisioning.periodStart, provisioning.periodEnd]);
  const row = result.rows[0] || {};
  return summarizeAiUsage({
    includedResponses: provisioning.includedResponses,
    succeededResponses: row.succeeded_responses,
    reservedResponses: row.reserved_responses,
    periodStart: provisioning.periodStart,
    periodEnd: provisioning.periodEnd
  });
}

async function claimAiQuotaWarnings(clinicId, periodStart, thresholds, client = null) {
  if (!clinicId || !periodStart || !Array.isArray(thresholds) || thresholds.length === 0) return [];
  const claimed = [];
  for (const threshold of thresholds.filter((value) => [50, 70, 100].includes(value))) {
    const result = await dbQuery(client, `
      INSERT INTO ai_quota_warning_deliveries ("clinicId","periodStart",threshold)
      VALUES ($1,$2,$3)
      ON CONFLICT ("clinicId","periodStart",threshold) DO NOTHING
      RETURNING threshold`, [clinicId, periodStart, threshold]);
    if (result.rows[0]) claimed.push(Number(result.rows[0].threshold));
  }
  return claimed;
}

module.exports = {
  periodBounds,
  ensureAiProvisioning,
  findAiProvisioning,
  reserveAiUsage,
  completeAiUsage,
  listAiProvisioningQueue,
  updateAiProvisioningStatus,
  summarizeAiUsage,
  crossedQuotaThresholds,
  getAiUsageSummary,
  claimAiQuotaWarnings
};
