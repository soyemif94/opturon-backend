const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function upsertContact({ clinicId, waId, phone, name }, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO contacts ("clinicId", "waId", phone, name, "updatedAt")
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT ("clinicId", "waId")
     DO UPDATE SET
       phone = EXCLUDED.phone,
       name = COALESCE(EXCLUDED.name, contacts.name),
       "updatedAt" = NOW()
     RETURNING id, "clinicId", "waId", phone, name, "optedOut"`,
    [clinicId, waId, phone || null, name || null]
  );

  return result.rows[0];
}

// Generic/internal lookup. Do not use this in portal/client-facing flows unless
// the caller already established scope through a trusted parent entity.
async function findContactById(contactId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId",
       "waId",
       phone,
       name,
       email,
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "optedOut",
       "createdAt",
       "updatedAt"
     FROM contacts WHERE id = $1 LIMIT 1`,
    [contactId]
  );

  return result.rows[0] || null;
}

// Safe scoped lookup for runtime flows that already know the clinic boundary.
async function findContactByIdAndClinicId(contactId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId",
       "waId",
       phone,
       name,
       email,
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "optedOut",
       "createdAt",
       "updatedAt"
     FROM contacts
     WHERE id = $1
       AND "clinicId" = $2
     LIMIT 1`,
    [contactId, clinicId]
  );

  return result.rows[0] || null;
}

// Portal/client-facing lookup. Keep tenant scope explicit at the repository boundary.
async function findPortalContactById(clinicId, contactId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId",
       "waId",
       phone,
       name,
       email,
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "optedOut",
       "createdAt",
       "updatedAt"
     FROM contacts
     WHERE "clinicId" = $1
       AND id = $2
     LIMIT 1`,
    [clinicId, contactId]
  );

  return result.rows[0] || null;
}

async function listContactsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       c.id,
       c."clinicId",
       c."waId",
       c.phone,
       c.name,
       c.email,
       c."whatsappPhone",
       c."taxId",
       c."taxCondition",
       c."companyName",
       c.notes,
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
       c.name,
       c.email,
       c."whatsappPhone",
       c."taxId",
       c."taxCondition",
       c."companyName",
       c.notes,
       c.status,
       c."optedOut",
       c."createdAt",
       c."updatedAt"
     ORDER BY COALESCE(MAX(conv."updatedAt"), c."updatedAt") DESC, c."createdAt" DESC`,
    [clinicId]
  );

  return result.rows;
}

// Portal/client-facing create. The caller must resolve clinic scope from route/context,
// never from client-controlled tenant/body values.
async function createPortalContact(clinicId, input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO contacts (
       "clinicId",
       name,
       email,
       phone,
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NOW())
     RETURNING
       id,
       "clinicId",
       "waId",
       phone,
       name,
       email,
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "optedOut",
       "createdAt",
       "updatedAt"`,
    [
      clinicId,
      input.name,
      input.email,
      input.phone,
      input.whatsappPhone,
      input.taxId,
      input.taxCondition,
      input.companyName,
      input.notes
    ]
  );

  return result.rows[0] || null;
}

// Generic/internal update. Prefer scoped portal helpers for client-facing mutations.
async function updateContact(contactId, clinicId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE contacts
     SET
       name = $3,
       email = $4,
       phone = $5,
       "whatsappPhone" = $6,
       "taxId" = $7,
       "taxCondition" = $8,
       "companyName" = $9,
       notes = $10,
       "updatedAt" = NOW()
     WHERE id = $1
       AND "clinicId" = $2
     RETURNING
       id,
       "clinicId",
       "waId",
       phone,
       name,
       email,
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "optedOut",
       "createdAt",
       "updatedAt"`,
    [
      contactId,
      clinicId,
      input.name,
      input.email,
      input.phone,
      input.whatsappPhone,
      input.taxId,
      input.taxCondition,
      input.companyName,
      input.notes
    ]
  );

  return result.rows[0] || null;
}

// Portal/client-facing update with explicit clinic scope in the repository call.
async function updatePortalContactById(clinicId, contactId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE contacts
     SET
       name = $3,
       email = $4,
       phone = $5,
       "whatsappPhone" = $6,
       "taxId" = $7,
       "taxCondition" = $8,
       "companyName" = $9,
       notes = $10,
       "updatedAt" = NOW()
     WHERE "clinicId" = $1
       AND id = $2
     RETURNING
       id,
       "clinicId",
       "waId",
       phone,
       name,
       email,
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "optedOut",
       "createdAt",
       "updatedAt"`,
    [
      clinicId,
      contactId,
      input.name,
      input.email,
      input.phone,
      input.whatsappPhone,
      input.taxId,
      input.taxCondition,
      input.companyName,
      input.notes
    ]
  );

  return result.rows[0] || null;
}

module.exports = {
  // Generic/internal helpers.
  upsertContact,
  findContactById,
  findContactByIdAndClinicId,
  listContactsByClinicId,
  updateContact,
  // Portal/client-facing scoped helpers.
  findPortalContactById,
  createPortalContact,
  updatePortalContactById
};
