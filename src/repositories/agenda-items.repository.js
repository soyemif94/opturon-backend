const { query } = require('../db/client');

const AGENDA_ITEM_SELECT = `ai.id,
ai."clinicId",
ai.date,
ai."startAt",
ai."endAt",
ai."contactId",
ai.type,
ai.title,
ai.description,
ai.status,
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
    type: row.type,
    title: row.title,
    description: row.description || null,
    status: row.status,
    createdAt: normalizeTimestamp(row.createdAt),
    updatedAt: normalizeTimestamp(row.updatedAt),
    contact: row.linkedContactId
      ? {
          id: row.linkedContactId,
          name: String(row.linkedContactName || '').trim() || row.linkedContactPhone || row.linkedContactWaId || 'Contacto',
          phone: row.linkedContactPhone || row.linkedContactWaId || null
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
       type,
       title,
       description,
       status,
       "updatedAt"
     )
     VALUES ($1::uuid, $2::date, $3::timestamptz, $4::timestamptz, $5::uuid, $6, $7, $8, $9, NOW())
     RETURNING id`,
    [
      input.clinicId,
      input.date,
      input.startAt || null,
      input.endAt || null,
      input.contactId || null,
      input.type,
      input.title,
      input.description || null,
      input.status
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
  if (Object.prototype.hasOwnProperty.call(patch, 'type')) add('type', patch.type);
  if (Object.prototype.hasOwnProperty.call(patch, 'title')) add('title', patch.title);
  if (Object.prototype.hasOwnProperty.call(patch, 'description')) add('description', patch.description);
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) add('status', patch.status);

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
  deleteAgendaItemById
};
