const { query } = require('../db/client');

const AGENDA_ITEM_SELECT = `ai.id,
ai."clinicId",
ai.date,
ai."startAt",
ai."endAt",
ai."contactId",
ai."conversationId",
ai."assignedUserId",
ai."assignedUserName",
ai.type,
ai.title,
ai.description,
ai.status,
ai."commercialActionType",
ai."commercialOutcome",
ai.origin,
ai.location,
ai."resultNote",
ai."nextStepNote",
ai."nextActionAt",
ai."reminderClaimedAt",
ai."reminderSentAt",
ai."reminderLastError",
ai."createdAt",
ai."updatedAt",
c.id AS "linkedContactId",
c.name AS "linkedContactName",
c.phone AS "linkedContactPhone",
c."waId" AS "linkedContactWaId"`;

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizeDateOnly(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  const safeValue = String(value).trim();
  const isoMatch = safeValue.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return isoMatch[1];
  }

  const parsed = new Date(safeValue);
  return Number.isNaN(parsed.getTime()) ? safeValue : parsed.toISOString().slice(0, 10);
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const safeValue = String(value).trim();
  if (!safeValue) return null;

  const parsed = new Date(safeValue);
  return Number.isNaN(parsed.getTime()) ? safeValue : parsed.toISOString();
}

function normalizeAgendaItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    date: normalizeDateOnly(row.date),
    startAt: normalizeTimestamp(row.startAt),
    endAt: normalizeTimestamp(row.endAt),
    contactId: row.contactId || null,
    conversationId: row.conversationId || null,
    assignedUserId: row.assignedUserId || null,
    assignedUserName: row.assignedUserName || null,
    type: row.type,
    title: row.title,
    description: row.description || null,
    status: row.status,
    commercialActionType: row.commercialActionType || null,
    commercialOutcome: row.commercialOutcome || null,
    origin: row.origin || null,
    location: row.location || null,
    resultNote: row.resultNote || null,
    nextStepNote: row.nextStepNote || null,
    nextActionAt: normalizeTimestamp(row.nextActionAt),
    reminderClaimedAt: normalizeTimestamp(row.reminderClaimedAt),
    reminderSentAt: normalizeTimestamp(row.reminderSentAt),
    reminderLastError: row.reminderLastError || null,
    createdAt: normalizeTimestamp(row.createdAt),
    updatedAt: normalizeTimestamp(row.updatedAt),
    contact: row.linkedContactId
      ? {
          id: row.linkedContactId,
          name: String(row.linkedContactName || '').trim() || row.linkedContactPhone || row.linkedContactWaId || 'Contacto',
          phone: row.linkedContactPhone || row.linkedContactWaId || null,
          waId: row.linkedContactWaId || null
        }
      : null
  };
}

async function listAgendaItemsByClinicAndRange(clinicId, fromDate, toDate, client = null) {
  const result = await dbQuery(
    client,
    `SELECT ${AGENDA_ITEM_SELECT}
     FROM agenda_items ai
     LEFT JOIN contacts c
       ON c.id = ai."contactId"
      AND c."clinicId" = ai."clinicId"
     WHERE ai."clinicId" = $1::uuid
       AND ai.date >= $2::date
       AND ai.date <= $3::date
     ORDER BY ai.date ASC, COALESCE(ai."startAt", ai."createdAt") ASC, ai."createdAt" ASC`,
    [clinicId, fromDate, toDate]
  );

  return result.rows.map(normalizeAgendaItem);
}

async function findAgendaItemById(clinicId, itemId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT ${AGENDA_ITEM_SELECT}
     FROM agenda_items ai
     LEFT JOIN contacts c
       ON c.id = ai."contactId"
      AND c."clinicId" = ai."clinicId"
     WHERE ai."clinicId" = $1::uuid
       AND ai.id = $2::uuid
     LIMIT 1`,
    [clinicId, itemId]
  );

  return normalizeAgendaItem(result.rows[0] || null);
}

async function listTimedAgendaConflicts(
  clinicId,
  {
    startAt,
    endAt,
    excludeItemId = null,
    conflictTypes = ['appointment', 'blocked']
  } = {},
  client = null
) {
  if (!clinicId || !startAt || !endAt || !Array.isArray(conflictTypes) || !conflictTypes.length) {
    return [];
  }

  const params = [clinicId, startAt, endAt, conflictTypes];
  let excludeClause = '';

  if (excludeItemId) {
    params.push(excludeItemId);
    excludeClause = `AND ai.id <> $${params.length}::uuid`;
  }

  const result = await dbQuery(
    client,
    `SELECT ${AGENDA_ITEM_SELECT}
     FROM agenda_items ai
     LEFT JOIN contacts c
       ON c.id = ai."contactId"
      AND c."clinicId" = ai."clinicId"
     WHERE ai."clinicId" = $1::uuid
       AND ai.status <> 'cancelled'
       AND ai.type = ANY($4::text[])
       AND ai."startAt" IS NOT NULL
       AND ai."endAt" IS NOT NULL
       AND ai."startAt" < $3::timestamptz
       AND ai."endAt" > $2::timestamptz
       ${excludeClause}
     ORDER BY ai."startAt" ASC, ai."createdAt" ASC`,
    params
  );

  return result.rows.map(normalizeAgendaItem);
}

async function createAgendaItem(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO agenda_items (
       "clinicId",
       date,
       "startAt",
       "endAt",
       "contactId",
       "conversationId",
       "assignedUserId",
       "assignedUserName",
       type,
       title,
       description,
       status,
       "commercialActionType",
       "commercialOutcome",
       origin,
       location,
       "resultNote",
       "nextStepNote",
       "nextActionAt",
       "updatedAt"
     )
     VALUES (
       $1::uuid, $2::date, $3::timestamptz, $4::timestamptz, $5::uuid, $6::uuid, $7::uuid, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::timestamptz, NOW()
     )
     RETURNING id`,
    [
      input.clinicId,
      input.date,
      input.startAt || null,
      input.endAt || null,
      input.contactId || null,
      input.conversationId || null,
      input.assignedUserId || null,
      input.assignedUserName || null,
      input.type,
      input.title,
      input.description || null,
      input.status,
      input.commercialActionType || null,
      input.commercialOutcome || null,
      input.origin || null,
      input.location || null,
      input.resultNote || null,
      input.nextStepNote || null,
      input.nextActionAt || null
    ]
  );

  return findAgendaItemById(input.clinicId, result.rows[0] && result.rows[0].id, client);
}

async function updateAgendaItemById(clinicId, itemId, patch, client = null) {
  const updates = [];
  const params = [clinicId, itemId];

  function add(fieldSql, value, cast = '') {
    params.push(value);
    updates.push(`${fieldSql} = $${params.length}${cast}`);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'date')) add('date', patch.date, '::date');
  if (Object.prototype.hasOwnProperty.call(patch, 'startAt')) add('"startAt"', patch.startAt, '::timestamptz');
  if (Object.prototype.hasOwnProperty.call(patch, 'endAt')) add('"endAt"', patch.endAt, '::timestamptz');
  if (Object.prototype.hasOwnProperty.call(patch, 'contactId')) add('"contactId"', patch.contactId, '::uuid');
  if (Object.prototype.hasOwnProperty.call(patch, 'conversationId')) add('"conversationId"', patch.conversationId, '::uuid');
  if (Object.prototype.hasOwnProperty.call(patch, 'assignedUserId')) add('"assignedUserId"', patch.assignedUserId, '::uuid');
  if (Object.prototype.hasOwnProperty.call(patch, 'assignedUserName')) add('"assignedUserName"', patch.assignedUserName);
  if (Object.prototype.hasOwnProperty.call(patch, 'type')) add('type', patch.type);
  if (Object.prototype.hasOwnProperty.call(patch, 'title')) add('title', patch.title);
  if (Object.prototype.hasOwnProperty.call(patch, 'description')) add('description', patch.description);
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) add('status', patch.status);
  if (Object.prototype.hasOwnProperty.call(patch, 'commercialActionType')) add('"commercialActionType"', patch.commercialActionType);
  if (Object.prototype.hasOwnProperty.call(patch, 'commercialOutcome')) add('"commercialOutcome"', patch.commercialOutcome);
  if (Object.prototype.hasOwnProperty.call(patch, 'origin')) add('origin', patch.origin);
  if (Object.prototype.hasOwnProperty.call(patch, 'location')) add('location', patch.location);
  if (Object.prototype.hasOwnProperty.call(patch, 'resultNote')) add('"resultNote"', patch.resultNote);
  if (Object.prototype.hasOwnProperty.call(patch, 'nextStepNote')) add('"nextStepNote"', patch.nextStepNote);
  if (Object.prototype.hasOwnProperty.call(patch, 'nextActionAt')) add('"nextActionAt"', patch.nextActionAt, '::timestamptz');
  if (Object.prototype.hasOwnProperty.call(patch, 'reminderClaimedAt')) add('"reminderClaimedAt"', patch.reminderClaimedAt, '::timestamptz');
  if (Object.prototype.hasOwnProperty.call(patch, 'reminderSentAt')) add('"reminderSentAt"', patch.reminderSentAt, '::timestamptz');
  if (Object.prototype.hasOwnProperty.call(patch, 'reminderLastError')) add('"reminderLastError"', patch.reminderLastError);

  if (!updates.length) {
    return findAgendaItemById(clinicId, itemId, client);
  }

  const result = await dbQuery(
    client,
    `UPDATE agenda_items
     SET ${updates.join(', ')},
         "updatedAt" = NOW()
     WHERE "clinicId" = $1::uuid
       AND id = $2::uuid
     RETURNING id`,
    params
  );

  return findAgendaItemById(clinicId, result.rows[0] && result.rows[0].id, client);
}

async function listDueAgendaReminderCandidates({ fromStartAt, toStartAt, limit = 25 } = {}, client = null) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const result = await dbQuery(
    client,
    `SELECT ${AGENDA_ITEM_SELECT}
     FROM agenda_items ai
     LEFT JOIN contacts c
       ON c.id = ai."contactId"
      AND c."clinicId" = ai."clinicId"
     WHERE ai.type = 'appointment'
       AND ai.status IN ('pending', 'confirmed')
       AND ai."startAt" IS NOT NULL
       AND ai."startAt" > $1::timestamptz
       AND ai."startAt" <= $2::timestamptz
       AND ai."reminderSentAt" IS NULL
     ORDER BY ai."startAt" ASC
     LIMIT $3`,
    [fromStartAt, toStartAt, safeLimit]
  );

  return result.rows.map(normalizeAgendaItem);
}

async function claimAgendaItemReminder(clinicId, itemId, staleBefore, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE agenda_items
     SET "reminderClaimedAt" = NOW(),
         "reminderLastError" = NULL,
         "updatedAt" = NOW()
     WHERE "clinicId" = $1::uuid
       AND id = $2::uuid
       AND type = 'appointment'
       AND status IN ('pending', 'confirmed')
       AND "reminderSentAt" IS NULL
       AND ("reminderClaimedAt" IS NULL OR "reminderClaimedAt" < $3::timestamptz)
     RETURNING id`,
    [clinicId, itemId, staleBefore]
  );

  if (!result.rows[0] || !result.rows[0].id) {
    return null;
  }

  return findAgendaItemById(clinicId, itemId, client);
}

async function markAgendaItemReminderSent(clinicId, itemId, sentAt, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE agenda_items
     SET "reminderSentAt" = $3::timestamptz,
         "reminderClaimedAt" = NULL,
         "reminderLastError" = NULL,
         "updatedAt" = NOW()
     WHERE "clinicId" = $1::uuid
       AND id = $2::uuid
     RETURNING id`,
    [clinicId, itemId, sentAt]
  );

  return result.rows[0] && result.rows[0].id ? findAgendaItemById(clinicId, itemId, client) : null;
}

async function releaseAgendaItemReminderClaim(clinicId, itemId, reason = null, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE agenda_items
     SET "reminderClaimedAt" = NULL,
         "reminderLastError" = $3,
         "updatedAt" = NOW()
     WHERE "clinicId" = $1::uuid
       AND id = $2::uuid
     RETURNING id`,
    [clinicId, itemId, reason || null]
  );

  return result.rows[0] && result.rows[0].id ? findAgendaItemById(clinicId, itemId, client) : null;
}

async function deleteAgendaItemById(clinicId, itemId, client = null) {
  const existing = await findAgendaItemById(clinicId, itemId, client);
  if (!existing) {
    return null;
  }

  const result = await dbQuery(
    client,
    `DELETE FROM agenda_items
     WHERE "clinicId" = $1::uuid
       AND id = $2::uuid
     RETURNING id`,
    [clinicId, itemId]
  );

  return result.rows[0] && result.rows[0].id ? existing : null;
}

module.exports = {
  listAgendaItemsByClinicAndRange,
  findAgendaItemById,
  listTimedAgendaConflicts,
  createAgendaItem,
  updateAgendaItemById,
  deleteAgendaItemById,
  listDueAgendaReminderCandidates,
  claimAgendaItemReminder,
  markAgendaItemReminderSent,
  releaseAgendaItemReminderClaim
};
