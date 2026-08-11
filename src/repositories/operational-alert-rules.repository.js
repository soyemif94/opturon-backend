const { query, withTransaction } = require('../db/client');
const { assertOperationalAlertRuleConfig } = require('../operational-alerts/operational-alert-registry');
const {
  normalizeString,
  normalizeNullableString,
  normalizeDateTime,
  isUuid,
  contractError
} = require('../operational-alerts/operational-alert-validation');

const RULE_COLUMNS = `
  id,
  "clinicId",
  name,
  "eventType",
  "eventVersion",
  "triggerMode",
  "configVersion",
  enabled,
  "enabledAt",
  "archivedAt",
  conditions,
  schedule,
  "deliveryPolicy",
  "channelId",
  "templateKey",
  "templateLanguage",
  "formatterKey",
  "formatterVersion",
  "nextEvaluationAt",
  "lastEvaluatedAt",
  "lastTriggeredAt",
  "schedulerLockedAt",
  "schedulerLockedBy",
  "schedulerLeaseExpiresAt",
  "createdAt",
  "updatedAt"`;

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

function normalizeRuleRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    name: row.name,
    eventType: row.eventType,
    eventVersion: Number(row.eventVersion),
    triggerMode: row.triggerMode,
    configVersion: Number(row.configVersion),
    enabled: row.enabled === true,
    enabledAt: row.enabledAt || null,
    archivedAt: row.archivedAt || null,
    conditions: row.conditions || {},
    schedule: row.schedule || {},
    deliveryPolicy: row.deliveryPolicy || {},
    channelId: row.channelId || null,
    templateKey: row.templateKey || null,
    templateLanguage: row.templateLanguage || null,
    formatterKey: row.formatterKey,
    formatterVersion: Number(row.formatterVersion),
    nextEvaluationAt: row.nextEvaluationAt || null,
    lastEvaluatedAt: row.lastEvaluatedAt || null,
    lastTriggeredAt: row.lastTriggeredAt || null,
    schedulerLockedAt: row.schedulerLockedAt || null,
    schedulerLockedBy: row.schedulerLockedBy || null,
    schedulerLeaseExpiresAt: row.schedulerLeaseExpiresAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeRuleIdentity(input) {
  const clinicId = normalizeString(input && input.clinicId);
  const name = normalizeString(input && input.name);
  const channelId = normalizeNullableString(input && input.channelId);
  const templateKey = normalizeNullableString(input && input.templateKey);
  const templateLanguage = normalizeNullableString(input && input.templateLanguage);
  const nextEvaluationAt = normalizeDateTime(input && input.nextEvaluationAt);

  if (!isUuid(clinicId)) throw contractError('operational_alert_rule_clinic_id_invalid');
  if (!name || name.length > 200) throw contractError('operational_alert_rule_name_invalid');
  if (channelId && !isUuid(channelId)) throw contractError('operational_alert_rule_channel_id_invalid');
  if (input && input.nextEvaluationAt && !nextEvaluationAt) {
    throw contractError('operational_alert_rule_next_evaluation_at_invalid');
  }
  if (templateKey && templateKey.length > 200) throw contractError('operational_alert_rule_template_key_invalid');
  if (templateLanguage && templateLanguage.length > 35) {
    throw contractError('operational_alert_rule_template_language_invalid');
  }
  return { clinicId, name, channelId, templateKey, templateLanguage, nextEvaluationAt };
}

async function runInTransaction(client, work) {
  if (client && typeof client.query === 'function') return work(client);
  return withTransaction(work);
}

async function createOperationalAlertRule(input, client = null) {
  if (input && input.enabled === true) throw contractError('operational_alert_rule_create_enabled_forbidden');
  const identity = normalizeRuleIdentity(input);
  const config = assertOperationalAlertRuleConfig(input);
  const result = await dbQuery(
    client,
    `INSERT INTO operational_alert_rules (
       "clinicId",
       name,
       "eventType",
       "eventVersion",
       "triggerMode",
       "configVersion",
       enabled,
       conditions,
       schedule,
       "deliveryPolicy",
       "channelId",
       "templateKey",
       "templateLanguage",
       "formatterKey",
       "formatterVersion",
       "nextEvaluationAt",
       "updatedAt"
     )
     VALUES (
       $1::uuid,
       $2,
       $3,
       $4,
       $5,
       1,
       FALSE,
       $6::jsonb,
       $7::jsonb,
       $8::jsonb,
       $9::uuid,
       $10,
       $11,
       $12,
       $13,
       $14::timestamptz,
       NOW()
     )
     RETURNING ${RULE_COLUMNS}`,
    [
      identity.clinicId,
      identity.name,
      config.eventType,
      config.eventVersion,
      config.triggerMode,
      JSON.stringify(config.conditions),
      JSON.stringify(config.schedule),
      JSON.stringify(config.deliveryPolicy),
      identity.channelId,
      identity.templateKey,
      identity.templateLanguage,
      config.formatterKey,
      config.formatterVersion,
      identity.nextEvaluationAt
    ]
  );
  return normalizeRuleRow(result.rows[0]);
}

async function findOperationalAlertRuleById(ruleId, clinicId, client = null, options = {}) {
  const result = await dbQuery(
    client,
    `SELECT ${RULE_COLUMNS}
     FROM operational_alert_rules
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1
     ${options.forUpdate ? 'FOR UPDATE' : ''}`,
    [ruleId, clinicId]
  );
  return normalizeRuleRow(result.rows[0]);
}

async function listOperationalAlertRules(clinicId, options = {}, client = null) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
  const params = [clinicId];
  const conditions = ['"clinicId" = $1::uuid'];
  if (options.eventType) {
    params.push(normalizeString(options.eventType));
    conditions.push(`"eventType" = $${params.length}`);
  }
  if (typeof options.enabled === 'boolean') {
    params.push(options.enabled);
    conditions.push(`enabled = $${params.length}`);
  }
  if (options.includeArchived !== true) conditions.push('"archivedAt" IS NULL');
  params.push(limit);
  const result = await dbQuery(
    client,
    `SELECT ${RULE_COLUMNS}
     FROM operational_alert_rules
     WHERE ${conditions.join(' AND ')}
     ORDER BY "createdAt" DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map(normalizeRuleRow);
}

async function updateOperationalAlertRuleConfig(ruleId, clinicId, input, client = null) {
  return runInTransaction(client, async (tx) => {
    const current = await findOperationalAlertRuleById(ruleId, clinicId, tx, { forUpdate: true });
    if (!current) return null;
    const identity = normalizeRuleIdentity({ ...current, ...input, clinicId });
    const config = assertOperationalAlertRuleConfig({ ...current, ...input });
    const result = await tx.query(
      `UPDATE operational_alert_rules
       SET name = $3,
           "eventType" = $4,
           "eventVersion" = $5,
           "triggerMode" = $6,
           conditions = $7::jsonb,
           schedule = $8::jsonb,
           "deliveryPolicy" = $9::jsonb,
           "channelId" = $10::uuid,
           "templateKey" = $11,
           "templateLanguage" = $12,
           "formatterKey" = $13,
           "formatterVersion" = $14,
           "nextEvaluationAt" = $15::timestamptz,
           "configVersion" = "configVersion" + CASE WHEN
             "eventType" IS DISTINCT FROM $4
             OR "eventVersion" IS DISTINCT FROM $5
             OR "triggerMode" IS DISTINCT FROM $6
             OR conditions IS DISTINCT FROM $7::jsonb
             OR schedule IS DISTINCT FROM $8::jsonb
             OR "deliveryPolicy" IS DISTINCT FROM $9::jsonb
             OR "channelId" IS DISTINCT FROM $10::uuid
             OR "templateKey" IS DISTINCT FROM $11
             OR "templateLanguage" IS DISTINCT FROM $12
             OR "formatterKey" IS DISTINCT FROM $13
             OR "formatterVersion" IS DISTINCT FROM $14
             THEN 1 ELSE 0 END,
           "updatedAt" = NOW()
       WHERE id = $1::uuid
         AND "clinicId" = $2::uuid
       RETURNING ${RULE_COLUMNS}`,
      [
        ruleId,
        clinicId,
        identity.name,
        config.eventType,
        config.eventVersion,
        config.triggerMode,
        JSON.stringify(config.conditions),
        JSON.stringify(config.schedule),
        JSON.stringify(config.deliveryPolicy),
        identity.channelId,
        identity.templateKey,
        identity.templateLanguage,
        config.formatterKey,
        config.formatterVersion,
        identity.nextEvaluationAt
      ]
    );
    return normalizeRuleRow(result.rows[0]);
  });
}

async function disableOperationalAlertRule(ruleId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE operational_alert_rules
     SET enabled = FALSE,
         "schedulerLockedAt" = NULL,
         "schedulerLockedBy" = NULL,
         "schedulerLeaseExpiresAt" = NULL,
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING ${RULE_COLUMNS}`,
    [ruleId, clinicId]
  );
  return normalizeRuleRow(result.rows[0]);
}

async function listOperationalAlertRuleRecipients(ruleId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT "clinicId", "ruleId", "recipientId", position, "createdAt"
     FROM operational_alert_rule_recipients
     WHERE "ruleId" = $1::uuid
       AND "clinicId" = $2::uuid
     ORDER BY position ASC, "recipientId" ASC`,
    [ruleId, clinicId]
  );
  return result.rows;
}

async function replaceOperationalAlertRuleRecipients(ruleId, clinicId, recipientIds, client = null) {
  if (!Array.isArray(recipientIds)) throw contractError('operational_alert_rule_recipient_ids_invalid');
  const normalizedIds = [];
  const seen = new Set();
  for (const value of recipientIds) {
    const recipientId = normalizeString(value);
    if (!isUuid(recipientId)) throw contractError('operational_alert_rule_recipient_id_invalid');
    if (!seen.has(recipientId)) {
      seen.add(recipientId);
      normalizedIds.push(recipientId);
    }
  }

  return runInTransaction(client, async (tx) => {
    const rule = await findOperationalAlertRuleById(ruleId, clinicId, tx, { forUpdate: true });
    if (!rule) return null;
    const current = await listOperationalAlertRuleRecipients(ruleId, clinicId, tx);
    const currentIds = current.map((item) => String(item.recipientId));
    const changed = currentIds.length !== normalizedIds.length || currentIds.some((id, index) => id !== normalizedIds[index]);
    if (!changed) return current;

    await tx.query(
      `DELETE FROM operational_alert_rule_recipients
       WHERE "ruleId" = $1::uuid
         AND "clinicId" = $2::uuid`,
      [ruleId, clinicId]
    );
    for (let position = 0; position < normalizedIds.length; position += 1) {
      await tx.query(
        `INSERT INTO operational_alert_rule_recipients (
           "clinicId", "ruleId", "recipientId", position
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        [clinicId, ruleId, normalizedIds[position], position]
      );
    }
    await tx.query(
      `UPDATE operational_alert_rules
       SET "configVersion" = "configVersion" + 1,
           "updatedAt" = NOW()
       WHERE id = $1::uuid
         AND "clinicId" = $2::uuid`,
      [ruleId, clinicId]
    );
    return listOperationalAlertRuleRecipients(ruleId, clinicId, tx);
  });
}

module.exports = {
  createOperationalAlertRule,
  findOperationalAlertRuleById,
  listOperationalAlertRules,
  updateOperationalAlertRuleConfig,
  disableOperationalAlertRule,
  listOperationalAlertRuleRecipients,
  replaceOperationalAlertRuleRecipients
};
