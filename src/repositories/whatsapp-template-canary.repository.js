const { query, withTransaction } = require('../db/client');

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

const COLUMNS = `id, "clinicId", "channelId", "templateId", "recipientId", "actorId", "idempotencyKey",
  "templateName", language, variables, preview, status, "providerMessageId", "conversationId", "inboxMessageId",
  "errorCode", "errorDetail", "errorMetadata", "sentAt", "deliveredAt", "readAt", "failedAt", "createdAt", "updatedAt"`;

function qualifyColumns(alias) {
  const prefix = String(alias || '').trim();
  return prefix ? `${prefix}.${COLUMNS.replace(/,\s+/g, `, ${prefix}.`)}` : COLUMNS;
}

async function findByIdempotencyKey(clinicId, idempotencyKey, client = null) {
  const result = await dbQuery(client, `SELECT ${COLUMNS} FROM whatsapp_template_canary_attempts WHERE "clinicId"=$1 AND "idempotencyKey"=$2 LIMIT 1`, [clinicId, idempotencyKey]);
  return result.rows[0] || null;
}

async function createAttempt(input, client = null) {
  const result = await dbQuery(client, `INSERT INTO whatsapp_template_canary_attempts (
    "clinicId", "channelId", "templateId", "recipientId", "actorId", "idempotencyKey", "templateName", language, variables, preview
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
  ON CONFLICT ("clinicId", "idempotencyKey") DO NOTHING RETURNING ${COLUMNS}`, [
    input.clinicId, input.channelId, input.templateId, input.recipientId, input.actorId, input.idempotencyKey,
    input.templateName, input.language, JSON.stringify(input.variables || {}), JSON.stringify(input.preview || {})
  ]);
  if (result.rows[0]) return { created: true, row: result.rows[0] };
  return { created: false, row: await findByIdempotencyKey(input.clinicId, input.idempotencyKey, client) };
}

async function updateAttempt(id, clinicId, patch, client = null) {
  const result = await dbQuery(client, `UPDATE whatsapp_template_canary_attempts SET
    status=COALESCE($3,status), "providerMessageId"=COALESCE($4,"providerMessageId"),
    "conversationId"=COALESCE($5,"conversationId"), "inboxMessageId"=COALESCE($6,"inboxMessageId"),
    "errorCode"=$7, "errorDetail"=$8, "errorMetadata"=$9::jsonb,
    "sentAt"=COALESCE($10::timestamptz,"sentAt"), "deliveredAt"=COALESCE($11::timestamptz,"deliveredAt"),
    "readAt"=COALESCE($12::timestamptz,"readAt"), "failedAt"=COALESCE($13::timestamptz,"failedAt"), "updatedAt"=NOW()
    WHERE id=$1 AND "clinicId"=$2 RETURNING ${COLUMNS}`, [id, clinicId, patch.status || null,
    patch.providerMessageId || null, patch.conversationId || null, patch.inboxMessageId || null,
    patch.errorCode || null, patch.errorDetail || null, patch.errorMetadata ? JSON.stringify(patch.errorMetadata) : null,
    patch.sentAt || null, patch.deliveredAt || null, patch.readAt || null, patch.failedAt || null]);
  return result.rows[0] || null;
}

async function listRecent(clinicId, limit = 10, client = null) {
  const result = await dbQuery(client, `SELECT ${qualifyColumns('a')}, r.name AS "recipientName"
    FROM whatsapp_template_canary_attempts a JOIN operational_alert_recipients r ON r.id=a."recipientId" AND r."clinicId"=a."clinicId"
    WHERE a."clinicId"=$1 ORDER BY a."createdAt" DESC LIMIT $2`, [clinicId, Math.max(1, Math.min(25, Number(limit) || 10))]);
  return result.rows;
}

async function reconcileStatus(input, client = null) {
  const timestampColumn = input.status === 'delivered' ? '"deliveredAt"' : input.status === 'read' ? '"readAt"' : input.status === 'failed' ? '"failedAt"' : '"sentAt"';
  const result = await dbQuery(client, `UPDATE whatsapp_template_canary_attempts SET status=$4, ${timestampColumn}=COALESCE($5::timestamptz,NOW()),
      "errorCode"=CASE WHEN $4='failed' THEN 'whatsapp_delivery_failed' ELSE "errorCode" END,
      "errorMetadata"=CASE WHEN $4='failed' THEN $6::jsonb ELSE "errorMetadata" END, "updatedAt"=NOW()
    WHERE "clinicId"=$1 AND "channelId"=$2 AND "providerMessageId"=$3
      AND (
        ($4='sent' AND status IN ('processing','sent'))
        OR ($4='delivered' AND status IN ('processing','sent','delivered'))
        OR ($4='read' AND status IN ('processing','sent','delivered','read'))
        OR ($4='failed' AND status IN ('processing','sent','failed'))
      )
    RETURNING ${COLUMNS}`, [input.clinicId, input.channelId, input.providerMessageId, input.status, input.occurredAt || null, input.failureMetadata ? JSON.stringify(input.failureMetadata) : null]);
  return result.rows[0] || null;
}

module.exports = { withTransaction, findByIdempotencyKey, createAttempt, updateAttempt, listRecent, reconcileStatus, _internals: { qualifyColumns } };
