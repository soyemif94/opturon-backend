const { query, withTransaction } = require('../db/client');
const {
  assertOperationalAlertRecipient,
  hasRecipientMaterialChange
} = require('../operational-alerts/operational-alert-recipient-contract');
const { normalizeDateTime, contractError } = require('../operational-alerts/operational-alert-validation');

const RECIPIENT_COLUMNS = `
  id,
  "clinicId",
  "staffUserId",
  name,
  "phoneE164",
  "roleLabel",
  "areaKeys",
  active,
  "consentStatus",
  "consentSource",
  "consentedAt",
  "revokedAt",
  version,
  "disabledAt",
  "createdAt",
  "updatedAt"`;

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

function normalizeRecipientRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    staffUserId: row.staffUserId || null,
    name: row.name,
    phoneE164: row.phoneE164,
    roleLabel: row.roleLabel || null,
    areaKeys: Array.isArray(row.areaKeys) ? row.areaKeys : [],
    active: row.active === true,
    consentStatus: row.consentStatus,
    consentSource: row.consentSource || null,
    consentedAt: row.consentedAt || null,
    revokedAt: row.revokedAt || null,
    version: Number(row.version || 1),
    disabledAt: row.disabledAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function runInTransaction(client, work) {
  if (client && typeof client.query === 'function') return work(client);
  return withTransaction(work);
}

async function createOperationalAlertRecipient(input, client = null) {
  const recipient = assertOperationalAlertRecipient({ ...input, version: 1 });
  const result = await dbQuery(
    client,
    `INSERT INTO operational_alert_recipients (
       "clinicId",
       "staffUserId",
       name,
       "phoneE164",
       "roleLabel",
       "areaKeys",
       active,
       "consentStatus",
       "consentSource",
       "consentedAt",
       "revokedAt",
       version,
       "disabledAt",
       "updatedAt"
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3,
       $4,
       $5,
       $6::text[],
       $7,
       $8,
       $9,
       $10::timestamptz,
       $11::timestamptz,
       1,
       $12::timestamptz,
       NOW()
     )
     RETURNING ${RECIPIENT_COLUMNS}`,
    [
      recipient.clinicId,
      recipient.staffUserId,
      recipient.name,
      recipient.phoneE164,
      recipient.roleLabel,
      recipient.areaKeys,
      recipient.active,
      recipient.consentStatus,
      recipient.consentSource,
      recipient.consentedAt,
      recipient.revokedAt,
      recipient.disabledAt
    ]
  );
  return normalizeRecipientRow(result.rows[0]);
}

async function findOperationalAlertRecipientById(recipientId, clinicId, client = null, options = {}) {
  const result = await dbQuery(
    client,
    `SELECT ${RECIPIENT_COLUMNS}
     FROM operational_alert_recipients
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1
     ${options.forUpdate ? 'FOR UPDATE' : ''}`,
    [recipientId, clinicId]
  );
  return normalizeRecipientRow(result.rows[0]);
}

async function listOperationalAlertRecipients(clinicId, options = {}, client = null) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
  const params = [clinicId];
  const conditions = ['"clinicId" = $1::uuid'];
  if (typeof options.active === 'boolean') {
    params.push(options.active);
    conditions.push(`active = $${params.length}`);
  }
  params.push(limit);
  const result = await dbQuery(
    client,
    `SELECT ${RECIPIENT_COLUMNS}
     FROM operational_alert_recipients
     WHERE ${conditions.join(' AND ')}
     ORDER BY active DESC, name ASC, id ASC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map(normalizeRecipientRow);
}

function mergeRecipientPatch(current, patch) {
  const allowed = [
    'staffUserId',
    'name',
    'phoneE164',
    'roleLabel',
    'areaKeys',
    'active',
    'consentStatus',
    'consentSource',
    'consentedAt',
    'revokedAt',
    'disabledAt'
  ];
  const next = { ...current, clinicId: current.clinicId, version: current.version };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) next[key] = patch[key];
  }

  if (next.active === true) {
    next.disabledAt = null;
  } else if (current.active === true && !Object.prototype.hasOwnProperty.call(patch || {}, 'disabledAt')) {
    next.disabledAt = new Date().toISOString();
  }
  return next;
}

async function updateOperationalAlertRecipient(recipientId, clinicId, patch, client = null) {
  return runInTransaction(client, async (tx) => {
    const current = await findOperationalAlertRecipientById(recipientId, clinicId, tx, { forUpdate: true });
    if (!current) return null;

    const candidate = assertOperationalAlertRecipient(mergeRecipientPatch(current, patch));
    const nextVersion = current.version + (hasRecipientMaterialChange(current, candidate) ? 1 : 0);
    const result = await tx.query(
      `UPDATE operational_alert_recipients
       SET "staffUserId" = $3::uuid,
           name = $4,
           "phoneE164" = $5,
           "roleLabel" = $6,
           "areaKeys" = $7::text[],
           active = $8,
           "consentStatus" = $9,
           "consentSource" = $10,
           "consentedAt" = $11::timestamptz,
           "revokedAt" = $12::timestamptz,
           version = $13,
           "disabledAt" = $14::timestamptz,
           "updatedAt" = NOW()
       WHERE id = $1::uuid
         AND "clinicId" = $2::uuid
       RETURNING ${RECIPIENT_COLUMNS}`,
      [
        recipientId,
        clinicId,
        candidate.staffUserId,
        candidate.name,
        candidate.phoneE164,
        candidate.roleLabel,
        candidate.areaKeys,
        candidate.active,
        candidate.consentStatus,
        candidate.consentSource,
        candidate.consentedAt,
        candidate.revokedAt,
        nextVersion,
        candidate.disabledAt
      ]
    );
    return normalizeRecipientRow(result.rows[0]);
  });
}

async function disableOperationalAlertRecipient(recipientId, clinicId, options = {}, client = null) {
  const disabledAt = normalizeDateTime(options.disabledAt || new Date());
  if (!disabledAt) throw contractError('operational_alert_recipient_disabled_at_invalid');
  return updateOperationalAlertRecipient(recipientId, clinicId, { active: false, disabledAt }, client);
}

module.exports = {
  createOperationalAlertRecipient,
  findOperationalAlertRecipientById,
  listOperationalAlertRecipients,
  updateOperationalAlertRecipient,
  disableOperationalAlertRecipient
};
