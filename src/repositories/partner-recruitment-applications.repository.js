const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

const APPLICATION_SELECT = `SELECT app.id,
       app."sponsorPartnerId",
       app.status,
       app."firstName",
       app."lastName",
       app.email,
       app."normalizedEmail",
       app.phone,
       app."normalizedPhone",
       app."documentId",
       app."normalizedDocumentId",
       app.city,
       app.province,
       app.country,
       app.notes,
       app."consentConfirmed",
       app."adminNotes",
       app."reviewedBy",
       app."reviewedAt",
       app."invitationId",
       app."createdPartnerId",
       app."submittedAt",
       app."approvedAt",
       app."invitedAt",
       app."acceptedAt",
       app."expiresAt",
       app.metadata,
       app."createdAt",
       app."updatedAt",
       sponsor.email AS "sponsorEmail",
       sponsor.status AS "sponsorStatus",
       sponsor_profile."displayName" AS "sponsorDisplayName",
       sponsor_profile.code AS "sponsorCode",
       invited.email AS "createdPartnerEmail",
       invited.status AS "createdPartnerStatus",
       invited_profile."displayName" AS "createdPartnerDisplayName"
FROM partner_recruitment_applications app
INNER JOIN partner_accounts sponsor ON sponsor.id = app."sponsorPartnerId"
INNER JOIN partner_profiles sponsor_profile ON sponsor_profile."partnerId" = sponsor.id
LEFT JOIN partner_accounts invited ON invited.id = app."createdPartnerId"
LEFT JOIN partner_profiles invited_profile ON invited_profile."partnerId" = invited.id`;

function mapApplicationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sponsorPartnerId: row.sponsorPartnerId,
    status: row.status,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName: [row.firstName, row.lastName].filter(Boolean).join(' ').trim(),
    email: row.email,
    normalizedEmail: row.normalizedEmail,
    phone: row.phone,
    normalizedPhone: row.normalizedPhone,
    documentId: row.documentId || null,
    normalizedDocumentId: row.normalizedDocumentId || null,
    city: row.city || null,
    province: row.province || null,
    country: row.country || null,
    notes: row.notes || null,
    consentConfirmed: row.consentConfirmed === true,
    adminNotes: row.adminNotes || null,
    reviewedBy: row.reviewedBy || null,
    reviewedAt: row.reviewedAt || null,
    invitationId: row.invitationId || null,
    createdPartnerId: row.createdPartnerId || null,
    submittedAt: row.submittedAt || null,
    approvedAt: row.approvedAt || null,
    invitedAt: row.invitedAt || null,
    acceptedAt: row.acceptedAt || null,
    expiresAt: row.expiresAt || null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sponsor: {
      id: row.sponsorPartnerId,
      email: row.sponsorEmail || null,
      status: row.sponsorStatus || null,
      displayName: row.sponsorDisplayName || null,
      code: row.sponsorCode || null
    },
    createdPartner: row.createdPartnerId ? {
      id: row.createdPartnerId,
      email: row.createdPartnerEmail || null,
      status: row.createdPartnerStatus || null,
      displayName: row.createdPartnerDisplayName || null
    } : null
  };
}

function buildListWhere(options = {}) {
  const params = [];
  const where = [];

  if (options.sponsorPartnerId) {
    params.push(options.sponsorPartnerId);
    where.push(`app."sponsorPartnerId" = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    where.push(`app.status = $${params.length}`);
  }
  if (options.partnerFilter) {
    params.push(options.partnerFilter);
    where.push(`app."sponsorPartnerId" = $${params.length}`);
  }
  if (options.from) {
    params.push(options.from);
    where.push(`app."createdAt" >= $${params.length}::timestamptz`);
  }
  if (options.to) {
    params.push(options.to);
    where.push(`app."createdAt" <= $${params.length}::timestamptz`);
  }
  if (options.search) {
    params.push(`%${String(options.search).toLowerCase()}%`);
    where.push(`(
      LOWER(app."firstName") LIKE $${params.length}
      OR LOWER(app."lastName") LIKE $${params.length}
      OR LOWER(app.email) LIKE $${params.length}
      OR LOWER(app.phone) LIKE $${params.length}
      OR LOWER(COALESCE(app."documentId", '')) LIKE $${params.length}
      OR LOWER(COALESCE(sponsor_profile."displayName", '')) LIKE $${params.length}
    )`);
  }

  return { params, where };
}

async function createRecruitmentApplication(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_recruitment_applications (
      "sponsorPartnerId", status, "firstName", "lastName", email, "normalizedEmail", phone, "normalizedPhone",
      "documentId", "normalizedDocumentId", city, province, country, notes, "consentConfirmed", metadata, "updatedAt"
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, NOW())
    RETURNING id`,
    [
      input.sponsorPartnerId,
      input.status || 'draft',
      input.firstName,
      input.lastName,
      input.email,
      input.normalizedEmail,
      input.phone,
      input.normalizedPhone,
      input.documentId || null,
      input.normalizedDocumentId || null,
      input.city || null,
      input.province || null,
      input.country || null,
      input.notes || null,
      input.consentConfirmed === true,
      JSON.stringify(input.metadata || {})
    ]
  );
  return findRecruitmentApplicationById(result.rows[0].id, client);
}

async function updateRecruitmentApplication(applicationId, patch, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_recruitment_applications
     SET "firstName" = COALESCE($2, "firstName"),
         "lastName" = COALESCE($3, "lastName"),
         email = COALESCE($4, email),
         "normalizedEmail" = COALESCE($5, "normalizedEmail"),
         phone = COALESCE($6, phone),
         "normalizedPhone" = COALESCE($7, "normalizedPhone"),
         "documentId" = $8,
         "normalizedDocumentId" = $9,
         city = $10,
         province = $11,
         country = COALESCE($12, country),
         notes = $13,
         "consentConfirmed" = COALESCE($14, "consentConfirmed"),
         metadata = COALESCE($15::jsonb, metadata),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id`,
    [
      applicationId,
      patch.firstName || null,
      patch.lastName || null,
      patch.email || null,
      patch.normalizedEmail || null,
      patch.phone || null,
      patch.normalizedPhone || null,
      patch.documentId || null,
      patch.normalizedDocumentId || null,
      patch.city || null,
      patch.province || null,
      patch.country || null,
      patch.notes || null,
      typeof patch.consentConfirmed === 'boolean' ? patch.consentConfirmed : null,
      patch.metadata ? JSON.stringify(patch.metadata) : null
    ]
  );
  if (result.rowCount === 0) return null;
  return findRecruitmentApplicationById(applicationId, client);
}

async function transitionRecruitmentApplication(applicationId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_recruitment_applications
     SET status = $2,
         "adminNotes" = CASE WHEN $3::boolean THEN $4 ELSE "adminNotes" END,
         "reviewedBy" = COALESCE($5::uuid, "reviewedBy"),
         "reviewedAt" = CASE WHEN $5::uuid IS NULL THEN "reviewedAt" ELSE NOW() END,
         "submittedAt" = CASE
           WHEN $2 = 'pending_review' AND "submittedAt" IS NULL THEN NOW()
           WHEN $2 = 'pending_review' THEN NOW()
           ELSE "submittedAt"
         END,
         "approvedAt" = CASE WHEN $2 = 'approved' THEN NOW() ELSE "approvedAt" END,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id`,
    [applicationId, input.status, input.setAdminNotes === true, input.adminNotes || null, input.reviewedBy || null]
  );
  if (result.rowCount === 0) return null;
  return findRecruitmentApplicationById(applicationId, client);
}

async function markRecruitmentApplicationInvitationSent(applicationId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_recruitment_applications
     SET status = 'invitation_sent',
         "invitationId" = $2::uuid,
         "createdPartnerId" = COALESCE($3::uuid, "createdPartnerId"),
         "invitedAt" = COALESCE($4::timestamptz, NOW()),
         "expiresAt" = $5::timestamptz,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id`,
    [applicationId, input.invitationId, input.createdPartnerId || null, input.invitedAt || null, input.expiresAt || null]
  );
  if (result.rowCount === 0) return null;
  return findRecruitmentApplicationById(applicationId, client);
}

async function markRecruitmentApplicationAccepted(applicationId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_recruitment_applications
     SET status = 'invitation_accepted',
         "createdPartnerId" = COALESCE($2::uuid, "createdPartnerId"),
         "acceptedAt" = COALESCE($3::timestamptz, NOW()),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id`,
    [applicationId, input.createdPartnerId || null, input.acceptedAt || null]
  );
  if (result.rowCount === 0) return null;
  return findRecruitmentApplicationById(applicationId, client);
}

async function markRecruitmentApplicationExpired(applicationId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_recruitment_applications
     SET status = 'expired',
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id`,
    [applicationId]
  );
  if (result.rowCount === 0) return null;
  return findRecruitmentApplicationById(applicationId, client);
}

async function findRecruitmentApplicationById(applicationId, client = null) {
  const result = await dbQuery(
    client,
    `${APPLICATION_SELECT}
     WHERE app.id = $1
     LIMIT 1`,
    [applicationId]
  );
  return mapApplicationRow(result.rows[0] || null);
}

async function findRecruitmentApplicationByIdForUpdate(applicationId, client = null) {
  const result = await dbQuery(
    client,
    `${APPLICATION_SELECT}
     WHERE app.id = $1
     LIMIT 1
     FOR UPDATE OF app`,
    [applicationId]
  );
  return mapApplicationRow(result.rows[0] || null);
}

async function findRecruitmentApplicationByInvitationId(invitationId, client = null) {
  const result = await dbQuery(
    client,
    `${APPLICATION_SELECT}
     WHERE app."invitationId" = $1
     LIMIT 1`,
    [invitationId]
  );
  return mapApplicationRow(result.rows[0] || null);
}

async function listRecruitmentApplications(options = {}, client = null) {
  const safePage = Math.max(1, Number(options.page) || 1);
  const safePageSize = Math.max(1, Math.min(50, Number(options.pageSize) || 20));
  const offset = (safePage - 1) * safePageSize;
  const { params, where } = buildListWhere(options);
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const countResult = await dbQuery(
    client,
    `SELECT COUNT(*)::INT AS total
     FROM partner_recruitment_applications app
     INNER JOIN partner_profiles sponsor_profile ON sponsor_profile."partnerId" = app."sponsorPartnerId"
     ${whereSql}`,
    params
  );
  const rowParams = params.concat([safePageSize, offset]);
  const rowsResult = await dbQuery(
    client,
    `${APPLICATION_SELECT}
     ${whereSql}
     ORDER BY COALESCE(app."submittedAt", app."createdAt") DESC, app."createdAt" DESC
     LIMIT $${rowParams.length - 1}
     OFFSET $${rowParams.length}`,
    rowParams
  );
  const total = Number(countResult.rows[0] && countResult.rows[0].total) || 0;
  return {
    applications: rowsResult.rows.map(mapApplicationRow),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages: total > 0 ? Math.ceil(total / safePageSize) : 0
    }
  };
}

async function findRecruitmentApplicationDuplicates(input, client = null) {
  const params = [
    input.normalizedEmail || null,
    input.normalizedPhone || null,
    input.normalizedDocumentId || null,
    input.excludeApplicationId || null
  ];
  const result = await dbQuery(
    client,
    `SELECT id,
            "sponsorPartnerId",
            status,
            "firstName",
            "lastName",
            email,
            phone,
            "documentId",
            "createdPartnerId",
            "invitationId",
            "createdAt"
     FROM partner_recruitment_applications
     WHERE ($4::uuid IS NULL OR id <> $4::uuid)
       AND (
         ($1::text IS NOT NULL AND "normalizedEmail" = $1)
         OR ($2::text IS NOT NULL AND "normalizedPhone" = $2)
         OR ($3::text IS NOT NULL AND "normalizedDocumentId" = $3)
       )
     ORDER BY "createdAt" DESC
     LIMIT 12`,
    params
  );
  return result.rows;
}

module.exports = {
  createRecruitmentApplication,
  updateRecruitmentApplication,
  transitionRecruitmentApplication,
  markRecruitmentApplicationInvitationSent,
  markRecruitmentApplicationAccepted,
  markRecruitmentApplicationExpired,
  findRecruitmentApplicationById,
  findRecruitmentApplicationByIdForUpdate,
  findRecruitmentApplicationByInvitationId,
  listRecruitmentApplications,
  findRecruitmentApplicationDuplicates
};
