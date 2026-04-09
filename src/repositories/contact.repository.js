const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function normalizePhoneDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits || null;
}

async function findFirstContactByPhone(clinicId, phone, client = null) {
  const normalizedPhone = normalizePhoneDigits(phone);
  if (!normalizedPhone) return null;

  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId",
       "waId",
       phone,
       name,
       email,
       "profileImageUrl",
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "archivedAt",
       "deletedAt",
       "optedOut",
       "createdAt",
       "updatedAt"
     FROM contacts
     WHERE "clinicId" = $1
       AND (
         regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
         OR regexp_replace(COALESCE("whatsappPhone", ''), '\\D', '', 'g') = $2
         OR regexp_replace(COALESCE("waId", ''), '\\D', '', 'g') = $2
       )
     ORDER BY "updatedAt" DESC NULLS LAST, "createdAt" DESC
     LIMIT 1`,
    [clinicId, normalizedPhone]
  );

  return result.rows[0] || null;
}

async function upsertContact({ clinicId, waId, phone, name }, client = null) {
  const reusableContact = await findFirstContactByPhone(clinicId, phone || waId, client);
  if (reusableContact) {
    const result = await dbQuery(
      client,
      `UPDATE contacts
       SET
         "waId" = COALESCE($3, "waId"),
         phone = COALESCE($4, phone),
         name = COALESCE($5, name),
         status = 'active',
         "archivedAt" = NULL,
         "deletedAt" = NULL,
         "updatedAt" = NOW()
       WHERE id = $1
         AND "clinicId" = $2
       RETURNING id, "clinicId", "waId", phone, name, email, "profileImageUrl", status, "archivedAt", "deletedAt", "optedOut"`,
      [reusableContact.id, clinicId, waId || null, phone || null, name || null]
    );

    return result.rows[0] || null;
  }

  const result = await dbQuery(
    client,
    `INSERT INTO contacts ("clinicId", "waId", phone, name, "updatedAt")
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT ("clinicId", "waId")
     DO UPDATE SET
       phone = EXCLUDED.phone,
       name = COALESCE(EXCLUDED.name, contacts.name),
       status = 'active',
       "archivedAt" = NULL,
       "deletedAt" = NULL,
       "updatedAt" = NOW()
     RETURNING id, "clinicId", "waId", phone, name, email, "profileImageUrl", status, "archivedAt", "deletedAt", "optedOut"`,
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
       "profileImageUrl",
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "archivedAt",
       "deletedAt",
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
       "profileImageUrl",
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "archivedAt",
       "deletedAt",
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
       "profileImageUrl",
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "archivedAt",
       "deletedAt",
       "optedOut",
       "createdAt",
       "updatedAt"
     FROM contacts
     WHERE "clinicId" = $1
       AND id = $2
       AND COALESCE(status, 'active') <> 'deleted'
     LIMIT 1`,
    [clinicId, contactId]
  );

  return result.rows[0] || null;
}

async function listContactsByClinicId(clinicId, options = {}, client = null) {
  const visibility = String(options && options.visibility ? options.visibility : 'active').trim().toLowerCase();
  const whereStatusClause =
    visibility === 'archived'
      ? `AND COALESCE(c.status, 'active') = 'archived'`
      : `AND COALESCE(c.status, 'active') = 'active'`;

  const result = await dbQuery(
    client,
    `SELECT
       c.id,
       c."clinicId",
       c."waId",
       c.phone,
       c.name,
       c.email,
       c."profileImageUrl",
       c."whatsappPhone",
       c."taxId",
       c."taxCondition",
       c."companyName",
       c.notes,
       c.status,
       c."archivedAt",
       c."deletedAt",
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
       ${whereStatusClause}
     GROUP BY
       c.id,
       c."clinicId",
       c."waId",
       c.phone,
       c.name,
       c.email,
       c."profileImageUrl",
       c."whatsappPhone",
       c."taxId",
       c."taxCondition",
       c."companyName",
       c.notes,
       c.status,
       c."archivedAt",
       c."deletedAt",
       c."optedOut",
       c."createdAt",
       c."updatedAt"
     ORDER BY COALESCE(MAX(conv."updatedAt"), c."updatedAt") DESC, c."createdAt" DESC`,
    [clinicId]
  );

  return result.rows;
}

async function archivePortalContactsByIds(clinicId, contactIds = [], client = null) {
  const ids = Array.isArray(contactIds) ? contactIds.filter(Boolean) : [];
  if (!ids.length) return [];

  const result = await dbQuery(
    client,
    `UPDATE contacts
     SET
       status = 'archived',
       "archivedAt" = NOW(),
       "updatedAt" = NOW()
     WHERE "clinicId" = $1
       AND id = ANY($2::uuid[])
       AND COALESCE(status, 'active') = 'active'
     RETURNING
       id,
       "clinicId",
       "waId",
       phone,
       name,
       email,
       "profileImageUrl",
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "archivedAt",
       "deletedAt",
       "optedOut",
       "createdAt",
       "updatedAt"`,
    [clinicId, ids]
  );

  return result.rows;
}

async function restorePortalContactsByIds(clinicId, contactIds = [], client = null) {
  const ids = Array.isArray(contactIds) ? contactIds.filter(Boolean) : [];
  if (!ids.length) return [];

  const result = await dbQuery(
    client,
    `UPDATE contacts
     SET
       status = 'active',
       "archivedAt" = NULL,
       "updatedAt" = NOW()
     WHERE "clinicId" = $1
       AND id = ANY($2::uuid[])
       AND COALESCE(status, 'active') = 'archived'
     RETURNING
       id,
       "clinicId",
       "waId",
       phone,
       name,
       email,
       "profileImageUrl",
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "archivedAt",
       "deletedAt",
       "optedOut",
       "createdAt",
       "updatedAt"`,
    [clinicId, ids]
  );

  return result.rows;
}

async function deletePortalArchivedContactsByIds(clinicId, contactIds = [], client = null) {
  const ids = Array.isArray(contactIds) ? contactIds.filter(Boolean) : [];
  if (!ids.length) return [];

  const result = await dbQuery(
    client,
    `WITH target_contacts AS (
       SELECT
         c.id,
         c."clinicId",
         c.name,
         c.phone,
         c.email
       FROM contacts c
       WHERE c."clinicId" = $1
         AND c.id = ANY($2::uuid[])
         AND COALESCE(c.status, 'active') = 'archived'
     ),
     detached_conversations AS (
       UPDATE conversations conv
       SET
         context = COALESCE(conv.context, '{}'::jsonb) || jsonb_strip_nulls(
           jsonb_build_object(
             'portalHiddenAt', to_jsonb(NOW()),
             'portalDeletedReason', 'archived_contact_deleted',
             'portalDeletedContactId', to_jsonb(target.id),
             'portalDeletedContactName', to_jsonb(target.name)
           )
         ),
         "updatedAt" = NOW()
       FROM target_contacts target
       WHERE conv."clinicId" = target."clinicId"
         AND conv."contactId" = target.id
     )
     UPDATE contacts c
     SET
       status = 'deleted',
       "deletedAt" = NOW(),
       "updatedAt" = NOW()
     FROM target_contacts target
     WHERE c.id = target.id
       AND c."clinicId" = target."clinicId"
     RETURNING
       c.id,
       c."clinicId",
       c.name,
       c.phone,
       c.email,
       c.status,
       c."archivedAt",
       c."deletedAt"`,
    [clinicId, ids]
  );

  return result.rows;
}

// Portal/client-facing create. The caller must resolve clinic scope from route/context,
// never from client-controlled tenant/body values.
async function createPortalContact(clinicId, input, client = null) {
  const reusableContact = await findFirstContactByPhone(clinicId, input.phone || input.whatsappPhone, client);
  if (reusableContact) {
    const result = await dbQuery(
      client,
      `UPDATE contacts
       SET
         name = COALESCE($3, name),
         email = COALESCE($4, email),
         phone = COALESCE($5, phone),
         "profileImageUrl" = COALESCE($6, "profileImageUrl"),
         "whatsappPhone" = COALESCE($7, "whatsappPhone"),
         "taxId" = COALESCE($8, "taxId"),
         "taxCondition" = COALESCE($9, "taxCondition"),
         "companyName" = COALESCE($10, "companyName"),
         notes = COALESCE($11, notes),
         status = 'active',
         "archivedAt" = NULL,
         "deletedAt" = NULL,
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
         "profileImageUrl",
         "whatsappPhone",
         "taxId",
         "taxCondition",
        "companyName",
        notes,
        status,
        "archivedAt",
        "deletedAt",
        "optedOut",
        "createdAt",
        "updatedAt"`,
      [
        clinicId,
        reusableContact.id,
        input.name,
        input.email,
        input.phone,
        input.profileImageUrl,
        input.whatsappPhone,
        input.taxId,
        input.taxCondition,
        input.companyName,
        input.notes
      ]
    );

    return result.rows[0] || null;
  }

  const result = await dbQuery(
    client,
    `INSERT INTO contacts (
       "clinicId",
       name,
       email,
       phone,
       "profileImageUrl",
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', NOW())
     RETURNING
       id,
       "clinicId",
       "waId",
       phone,
       name,
       email,
       "profileImageUrl",
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "archivedAt",
       "deletedAt",
       "optedOut",
       "createdAt",
       "updatedAt"`,
    [
      clinicId,
      input.name,
      input.email,
      input.phone,
      input.profileImageUrl,
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
       "profileImageUrl" = $6,
       "whatsappPhone" = $7,
       "taxId" = $8,
       "taxCondition" = $9,
       "companyName" = $10,
       notes = $11,
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
       "profileImageUrl",
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "archivedAt",
       "deletedAt",
       "optedOut",
       "createdAt",
       "updatedAt"`,
    [
      contactId,
      clinicId,
      input.name,
      input.email,
      input.phone,
      input.profileImageUrl,
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
       "profileImageUrl" = $6,
       "whatsappPhone" = $7,
       "taxId" = $8,
       "taxCondition" = $9,
       "companyName" = $10,
       notes = $11,
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
       "profileImageUrl",
       "whatsappPhone",
       "taxId",
       "taxCondition",
       "companyName",
       notes,
       status,
       "archivedAt",
       "deletedAt",
       "optedOut",
       "createdAt",
       "updatedAt"`,
    [
      clinicId,
      contactId,
      input.name,
      input.email,
      input.phone,
      input.profileImageUrl,
      input.whatsappPhone,
      input.taxId,
      input.taxCondition,
      input.companyName,
      input.notes
    ]
  );

  return result.rows[0] || null;
}

async function listArchivedContactCleanupCandidates(retentionDays = 15, limit = 100, client = null) {
  const safeRetentionDays = Number.isInteger(Number(retentionDays)) && Number(retentionDays) > 0 ? Number(retentionDays) : 15;
  const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 100;

  const result = await dbQuery(
    client,
    `WITH stale AS (
       SELECT
         c.id,
         c."clinicId",
         c.name,
         c.phone,
         c.email,
         c.status,
         c."archivedAt",
         c."updatedAt"
       FROM contacts c
       WHERE COALESCE(c.status, 'active') = 'archived'
         AND c."archivedAt" IS NOT NULL
         AND c."archivedAt" <= NOW() - ($1::int * INTERVAL '1 day')
       ORDER BY c."archivedAt" ASC
       LIMIT $2
     )
     SELECT
       s.*,
       EXISTS(SELECT 1 FROM conversations conv WHERE conv."contactId" = s.id) AS "hasConversations",
       EXISTS(SELECT 1 FROM orders o WHERE o."contactId" = s.id AND o."clinicId" = s."clinicId") AS "hasOrders",
       EXISTS(SELECT 1 FROM invoices i WHERE i."contactId" = s.id AND i."clinicId" = s."clinicId") AS "hasInvoices",
       EXISTS(SELECT 1 FROM payments p WHERE p."contactId" = s.id AND p."clinicId" = s."clinicId") AS "hasPayments",
       EXISTS(SELECT 1 FROM loyalty_points_ledger l WHERE l."contactId" = s.id AND l."clinicId" = s."clinicId") AS "hasLoyalty",
       EXISTS(SELECT 1 FROM leads ld WHERE ld."contactId" = s.id AND ld."clinicId" = s."clinicId") AS "hasLeads",
       EXISTS(SELECT 1 FROM appointments a WHERE a."contactId" = s.id AND a."clinicId" = s."clinicId") AS "hasAppointments",
       EXISTS(SELECT 1 FROM handoff_requests hr WHERE hr."contactId" = s.id AND hr."clinicId" = s."clinicId") AS "hasHandoffs",
       EXISTS(SELECT 1 FROM agenda_items ai WHERE ai."contactId" = s.id AND ai."clinicId" = s."clinicId") AS "hasAgendaItems"
     FROM stale s`,
    [safeRetentionDays, safeLimit]
  );

  return result.rows;
}

async function deleteArchivedContactsByIds(contactIds = [], retentionDays = 15, client = null) {
  const ids = Array.isArray(contactIds) ? contactIds.filter(Boolean) : [];
  if (!ids.length) return [];

  const safeRetentionDays = Number.isInteger(Number(retentionDays)) && Number(retentionDays) > 0 ? Number(retentionDays) : 15;
  const result = await dbQuery(
    client,
    `DELETE FROM contacts c
     WHERE c.id = ANY($1::uuid[])
       AND COALESCE(c.status, 'active') = 'archived'
       AND c."archivedAt" IS NOT NULL
       AND c."archivedAt" <= NOW() - ($2::int * INTERVAL '1 day')
       AND NOT EXISTS (SELECT 1 FROM conversations conv WHERE conv."contactId" = c.id)
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o."contactId" = c.id AND o."clinicId" = c."clinicId")
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i."contactId" = c.id AND i."clinicId" = c."clinicId")
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p."contactId" = c.id AND p."clinicId" = c."clinicId")
       AND NOT EXISTS (SELECT 1 FROM loyalty_points_ledger l WHERE l."contactId" = c.id AND l."clinicId" = c."clinicId")
       AND NOT EXISTS (SELECT 1 FROM leads ld WHERE ld."contactId" = c.id AND ld."clinicId" = c."clinicId")
       AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a."contactId" = c.id AND a."clinicId" = c."clinicId")
       AND NOT EXISTS (SELECT 1 FROM handoff_requests hr WHERE hr."contactId" = c.id AND hr."clinicId" = c."clinicId")
       AND NOT EXISTS (SELECT 1 FROM agenda_items ai WHERE ai."contactId" = c.id AND ai."clinicId" = c."clinicId")
     RETURNING
       c.id,
       c."clinicId",
       c.name,
       c.phone,
       c.email,
       c.status,
       c."archivedAt"`,
    [ids, safeRetentionDays]
  );

  return result.rows;
}

module.exports = {
  // Generic/internal helpers.
  upsertContact,
  findFirstContactByPhone,
  findContactById,
  findContactByIdAndClinicId,
  listContactsByClinicId,
  updateContact,
  // Portal/client-facing scoped helpers.
  findPortalContactById,
  createPortalContact,
  updatePortalContactById,
  archivePortalContactsByIds,
  restorePortalContactsByIds,
  deletePortalArchivedContactsByIds,
  listArchivedContactCleanupCandidates,
  deleteArchivedContactsByIds
};
