const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function parseMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeContact(row) {
  if (!row) return null;

  return {
    id: row.id,
    clinicId: row.clinicId,
    waId: row.waId || null,
    phone: row.phone || null,
    whatsappPhone: row.whatsappPhone || row.phone || null,
    email: row.email || null,
    name: row.name || null,
    fullName: row.name || null,
    taxId: row.taxId || null,
    taxCondition: row.taxCondition || null,
    companyName: row.companyName || null,
    notes: row.notes || null,
    metadata: parseMetadata(row.metadata),
    status: row.status || 'active',
    optedOut: row.optedOut === true,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    lastInteractionAt: row.lastInteractionAt || row.updatedAt || null,
    conversationCount: Number(row.conversationCount || 0)
  };
}

function normalizeIdentity(value) {
  return String(value || '').trim().toLowerCase() || null;
}

async function upsertContact({ clinicId, waId, phone, name }, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO contacts ("clinicId", "waId", phone, "whatsappPhone", name, status, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 'active', NOW())
     ON CONFLICT ("clinicId", "waId")
     DO UPDATE SET
       phone = COALESCE(EXCLUDED.phone, contacts.phone),
       "whatsappPhone" = COALESCE(EXCLUDED."whatsappPhone", contacts."whatsappPhone"),
       name = COALESCE(EXCLUDED.name, contacts.name),
       status = CASE WHEN contacts.status = 'archived' THEN contacts.status ELSE 'active' END,
       "updatedAt" = NOW()
     RETURNING
       id,
       "clinicId",
       "waId",
       phone,
       "whatsappPhone",
       email,
       name,
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       metadata,
       status,
       "optedOut",
       "createdAt",
       "updatedAt"`,
    [clinicId, waId, phone || null, phone || null, name || null]
  );

  return normalizeContact(result.rows[0]);
}

async function createContact(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO contacts (
       "clinicId",
       "waId",
       phone,
       "whatsappPhone",
       email,
       name,
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       metadata,
       status,
       "updatedAt"
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, NOW())
     RETURNING id`,
    [
      input.clinicId,
      input.waId || null,
      input.phone || null,
      input.whatsappPhone || input.phone || null,
      input.email || null,
      input.name,
      input.taxId || null,
      input.taxCondition || null,
      input.companyName || null,
      input.notes || null,
      JSON.stringify(input.metadata || {}),
      input.status || 'active'
    ]
  );

  return findContactByIdAndClinicId(result.rows[0].id, input.clinicId, client);
}

async function findContactByIdentity({ clinicId, waId = null, email = null, taxId = null, phone = null, whatsappPhone = null, excludeContactId = null } = {}, client = null) {
  const safeClinicId = String(clinicId || '').trim();
  if (!safeClinicId) {
    return null;
  }

  const conditions = [];
  const params = [safeClinicId];
  let idx = 2;

  const safeWaId = String(waId || '').trim() || null;
  if (safeWaId) {
    conditions.push(`c."waId" = $${idx}`);
    params.push(safeWaId);
    idx += 1;
  }

  const safeEmail = normalizeIdentity(email);
  if (safeEmail) {
    conditions.push(`LOWER(c.email) = $${idx}`);
    params.push(safeEmail);
    idx += 1;
  }

  const safeTaxId = normalizeIdentity(taxId);
  if (safeTaxId) {
    conditions.push(`LOWER(c."taxId") = $${idx}`);
    params.push(safeTaxId);
    idx += 1;
  }

  const safePhone = String(phone || '').trim() || null;
  if (safePhone) {
    conditions.push(`c.phone = $${idx}`);
    params.push(safePhone);
    idx += 1;
  }

  const safeWhatsAppPhone = String(whatsappPhone || '').trim() || null;
  if (safeWhatsAppPhone) {
    conditions.push(`c."whatsappPhone" = $${idx}`);
    params.push(safeWhatsAppPhone);
    idx += 1;
  }

  if (!conditions.length) {
    return null;
  }

  const result = await dbQuery(
    client,
    `SELECT
       c.id,
       c."clinicId",
       c."waId",
       c.phone,
       c."whatsappPhone",
       c.email,
       c.name,
       c."taxId",
       c."taxCondition",
       c."companyName",
       c.notes,
       c.metadata,
       c.status,
       c."optedOut",
       c."createdAt",
       c."updatedAt"
     FROM contacts c
     WHERE c."clinicId" = $1
       ${excludeContactId ? `AND c.id <> $${idx}` : ''}
       AND (${conditions.join(' OR ')})
     ORDER BY c."createdAt" ASC
     LIMIT 1`,
    excludeContactId ? [...params, excludeContactId] : params
  );

  return normalizeContact(result.rows[0] || null);
}

async function updateContact(contactId, clinicId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE contacts
     SET
       "waId" = $3,
       phone = $4,
       "whatsappPhone" = $5,
       email = $6,
       name = $7,
       "taxId" = $8,
       "taxCondition" = $9,
       "companyName" = $10,
       notes = $11,
       metadata = $12::jsonb,
       status = $13,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [
      contactId,
      clinicId,
      input.waId || null,
      input.phone || null,
      input.whatsappPhone || input.phone || null,
      input.email || null,
      input.name || null,
      input.taxId || null,
      input.taxCondition || null,
      input.companyName || null,
      input.notes || null,
      JSON.stringify(input.metadata || {}),
      input.status || 'active'
    ]
  );

  if (!result.rows[0]) return null;
  return findContactByIdAndClinicId(contactId, clinicId, client);
}

async function findContactById(contactId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       c.id,
       c."clinicId",
       c."waId",
       c.phone,
       c."whatsappPhone",
       c.email,
       c.name,
       c."taxId",
       c."taxCondition",
       c."companyName",
       c.notes,
       c.metadata,
       c.status,
       c."optedOut",
       c."createdAt",
       c."updatedAt"
     FROM contacts c
     WHERE c.id = $1
     LIMIT 1`,
    [contactId]
  );

  return normalizeContact(result.rows[0] || null);
}

async function findContactByIdAndClinicId(contactId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       c.id,
       c."clinicId",
       c."waId",
       c.phone,
       c."whatsappPhone",
       c.email,
       c.name,
       c."taxId",
       c."taxCondition",
       c."companyName",
       c.notes,
       c.metadata,
       c.status,
       c."optedOut",
       c."createdAt",
       c."updatedAt",
       COALESCE(MAX(conv."updatedAt"), c."updatedAt") AS "lastInteractionAt",
       COUNT(DISTINCT conv.id)::int AS "conversationCount"
     FROM contacts c
     LEFT JOIN conversations conv
       ON conv."contactId" = c.id
      AND conv."clinicId" = c."clinicId"
     WHERE c.id = $1
       AND c."clinicId" = $2
     GROUP BY
       c.id,
       c."clinicId",
       c."waId",
       c.phone,
       c."whatsappPhone",
       c.email,
       c.name,
       c."taxId",
       c."taxCondition",
       c."companyName",
       c.notes,
       c.metadata,
       c.status,
       c."optedOut",
       c."createdAt",
       c."updatedAt"
     LIMIT 1`,
    [contactId, clinicId]
  );

  return normalizeContact(result.rows[0] || null);
}

async function listContactsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       c.id,
       c."clinicId",
       c."waId",
       c.phone,
       c."whatsappPhone",
       c.email,
       c.name,
       c."taxId",
       c."taxCondition",
       c."companyName",
       c.notes,
       c.metadata,
       c.status,
       c."optedOut",
       c."createdAt",
       c."updatedAt",
       COALESCE(MAX(conv."updatedAt"), c."updatedAt") AS "lastInteractionAt",
       COUNT(DISTINCT conv.id)::int AS "conversationCount"
     FROM contacts c
     LEFT JOIN conversations conv
       ON conv."contactId" = c.id
      AND conv."clinicId" = c."clinicId"
     WHERE c."clinicId" = $1
     GROUP BY
       c.id,
       c."clinicId",
       c."waId",
       c.phone,
       c."whatsappPhone",
       c.email,
       c.name,
       c."taxId",
       c."taxCondition",
       c."companyName",
       c.notes,
       c.metadata,
       c.status,
       c."optedOut",
       c."createdAt",
       c."updatedAt"
     ORDER BY COALESCE(MAX(conv."updatedAt"), c."updatedAt") DESC, c."createdAt" DESC`,
    [clinicId]
  );

  return result.rows.map(normalizeContact);
}

module.exports = {
  upsertContact,
  createContact,
  updateContact,
  findContactByIdentity,
  findContactById,
  findContactByIdAndClinicId,
  listContactsByClinicId
};
