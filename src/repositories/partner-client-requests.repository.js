const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

const CLIENT_REQUEST_SELECT = `SELECT pcr.id,
       pcr."partnerId",
       pcr.status,
       pcr."clientName",
       pcr."businessName",
       pcr.email,
       pcr."normalizedEmail",
       pcr.phone,
       pcr."normalizedPhone",
       pcr."taxId",
       pcr."normalizedTaxId",
       pcr."planCode",
       pcr."paymentMethod",
       pcr."reportedAmount"::TEXT AS "reportedAmount",
       pcr."reportedCurrency",
       pcr."reportedPaymentDate",
       pcr."paymentReference",
       pcr."normalizedPaymentReference",
       pcr.notes,
       pcr."receiptStorageKey",
       pcr."receiptOriginalName",
       pcr."receiptMimeType",
       pcr."receiptSizeBytes",
       pcr."receiptSha256",
       pcr."adminNotes",
       pcr."reviewedBy",
       pcr."reviewedAt",
       pcr."linkedTenantId",
       pcr."linkedExternalTenantId",
       pcr."attributionId",
       pcr."commissionEntryId",
       pcr."processedAt",
       pcr."processedBy",
       pcr."processingStatus",
       pcr."processingErrorCode",
       pcr."paymentConfirmedAt",
       pcr."paymentConfirmedBy",
       pcr."paymentConfirmationMethod",
       pcr."confirmedAmount"::TEXT AS "confirmedAmount",
       pcr."confirmedCurrency",
       pcr."paymentConfirmationReference",
       pcr."paymentConfirmationNotes",
       pcr."commissionBaseAmount"::TEXT AS "commissionBaseAmount",
       pcr."commissionCurrency",
       pcr."commissionRate"::TEXT AS "commissionRate",
       pcr."commissionAmount"::TEXT AS "commissionAmount",
       pcr."commissionRuleCode",
       pcr.metadata,
       pcr."createdAt",
       pcr."updatedAt",
       pcr."submittedAt",
       pa.email AS "partnerEmail",
       pp."displayName" AS "partnerDisplayName",
       pp.code AS "partnerCode"
FROM partner_client_requests pcr
INNER JOIN partner_accounts pa ON pa.id = pcr."partnerId"
INNER JOIN partner_profiles pp ON pp."partnerId" = pcr."partnerId"`;

function mapClientRequestRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    partnerId: row.partnerId,
    status: row.status,
    clientName: row.clientName,
    businessName: row.businessName || null,
    email: row.email,
    normalizedEmail: row.normalizedEmail,
    phone: row.phone,
    normalizedPhone: row.normalizedPhone,
    taxId: row.taxId || null,
    normalizedTaxId: row.normalizedTaxId || null,
    planCode: row.planCode || null,
    paymentMethod: row.paymentMethod,
    reportedAmount: row.reportedAmount,
    reportedCurrency: row.reportedCurrency,
    reportedPaymentDate: row.reportedPaymentDate || null,
    paymentReference: row.paymentReference || null,
    normalizedPaymentReference: row.normalizedPaymentReference || null,
    notes: row.notes || null,
    receipt: {
      storageKey: row.receiptStorageKey,
      originalName: row.receiptOriginalName,
      mimeType: row.receiptMimeType,
      sizeBytes: Number(row.receiptSizeBytes || 0),
      sha256: row.receiptSha256 || null
    },
    adminNotes: row.adminNotes || null,
    reviewedBy: row.reviewedBy || null,
    reviewedAt: row.reviewedAt || null,
    linkedTenantId: row.linkedTenantId || null,
    linkedExternalTenantId: row.linkedExternalTenantId || null,
    attributionId: row.attributionId || null,
    commissionEntryId: row.commissionEntryId || null,
    processedAt: row.processedAt || null,
    processedBy: row.processedBy || null,
    processingStatus: row.processingStatus || 'not_processed',
    processingErrorCode: row.processingErrorCode || null,
    paymentConfirmation: {
      confirmedAt: row.paymentConfirmedAt || null,
      confirmedBy: row.paymentConfirmedBy || null,
      method: row.paymentConfirmationMethod || null,
      amount: row.confirmedAmount || null,
      currency: row.confirmedCurrency || null,
      reference: row.paymentConfirmationReference || null,
      notes: row.paymentConfirmationNotes || null
    },
    commissionSnapshot: {
      baseAmount: row.commissionBaseAmount || null,
      currency: row.commissionCurrency || null,
      rate: row.commissionRate || null,
      amount: row.commissionAmount || null,
      ruleCode: row.commissionRuleCode || null
    },
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt || null,
    partner: {
      id: row.partnerId,
      email: row.partnerEmail || null,
      displayName: row.partnerDisplayName || null,
      code: row.partnerCode || null
    }
  };
}

function buildListWhere(options = {}) {
  const params = [];
  const where = [];

  if (options.partnerId) {
    params.push(options.partnerId);
    where.push(`pcr."partnerId" = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    where.push(`pcr.status = $${params.length}`);
  }
  if (options.partnerFilter) {
    params.push(options.partnerFilter);
    where.push(`pcr."partnerId" = $${params.length}`);
  }
  if (options.from) {
    params.push(options.from);
    where.push(`pcr."createdAt" >= $${params.length}::timestamptz`);
  }
  if (options.to) {
    params.push(options.to);
    where.push(`pcr."createdAt" <= $${params.length}::timestamptz`);
  }
  if (options.search) {
    params.push(`%${String(options.search).toLowerCase()}%`);
    where.push(`(
      LOWER(pcr."clientName") LIKE $${params.length}
      OR LOWER(COALESCE(pcr."businessName", '')) LIKE $${params.length}
      OR LOWER(pcr.email) LIKE $${params.length}
      OR LOWER(COALESCE(pcr.phone, '')) LIKE $${params.length}
      OR LOWER(COALESCE(pp."displayName", '')) LIKE $${params.length}
    )`);
  }

  return { params, where };
}

async function createPartnerClientRequest(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_client_requests (
      "partnerId", status, "clientName", "businessName", email, "normalizedEmail", phone, "normalizedPhone",
      "taxId", "normalizedTaxId", "planCode", "paymentMethod", "reportedAmount", "reportedCurrency",
      "reportedPaymentDate", "paymentReference", "normalizedPaymentReference", notes,
      "receiptStorageKey", "receiptOriginalName", "receiptMimeType", "receiptSizeBytes", "receiptSha256",
      metadata, "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::numeric, $14, $15::date, $16, $17, $18,
             $19, $20, $21, $22::int, $23, $24::jsonb, NOW())
     RETURNING *`,
    [
      input.partnerId,
      input.status || 'draft',
      input.clientName,
      input.businessName || null,
      input.email,
      input.normalizedEmail,
      input.phone,
      input.normalizedPhone,
      input.taxId || null,
      input.normalizedTaxId || null,
      input.planCode || null,
      input.paymentMethod,
      input.reportedAmount,
      input.reportedCurrency,
      input.reportedPaymentDate,
      input.paymentReference || null,
      input.normalizedPaymentReference || null,
      input.notes || null,
      input.receiptStorageKey,
      input.receiptOriginalName,
      input.receiptMimeType,
      input.receiptSizeBytes,
      input.receiptSha256 || null,
      JSON.stringify(input.metadata || {})
    ]
  );
  return findPartnerClientRequestById(result.rows[0].id, client);
}

async function updatePartnerClientRequest(requestId, patch, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_client_requests
     SET "clientName" = COALESCE($2, "clientName"),
         "businessName" = $3,
         email = COALESCE($4, email),
         "normalizedEmail" = COALESCE($5, "normalizedEmail"),
         phone = COALESCE($6, phone),
         "normalizedPhone" = COALESCE($7, "normalizedPhone"),
         "taxId" = $8,
         "normalizedTaxId" = $9,
         "planCode" = $10,
         "paymentMethod" = COALESCE($11, "paymentMethod"),
         "reportedAmount" = COALESCE($12::numeric, "reportedAmount"),
         "reportedCurrency" = COALESCE($13, "reportedCurrency"),
         "reportedPaymentDate" = COALESCE($14::date, "reportedPaymentDate"),
         "paymentReference" = $15,
         "normalizedPaymentReference" = $16,
         notes = $17,
         "receiptStorageKey" = COALESCE($18, "receiptStorageKey"),
         "receiptOriginalName" = COALESCE($19, "receiptOriginalName"),
         "receiptMimeType" = COALESCE($20, "receiptMimeType"),
         "receiptSizeBytes" = COALESCE($21::int, "receiptSizeBytes"),
         "receiptSha256" = COALESCE($22, "receiptSha256"),
         metadata = COALESCE($23::jsonb, metadata),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id`,
    [
      requestId,
      patch.clientName || null,
      patch.businessName || null,
      patch.email || null,
      patch.normalizedEmail || null,
      patch.phone || null,
      patch.normalizedPhone || null,
      patch.taxId || null,
      patch.normalizedTaxId || null,
      patch.planCode || null,
      patch.paymentMethod || null,
      patch.reportedAmount || null,
      patch.reportedCurrency || null,
      patch.reportedPaymentDate || null,
      patch.paymentReference || null,
      patch.normalizedPaymentReference || null,
      patch.notes || null,
      patch.receiptStorageKey || null,
      patch.receiptOriginalName || null,
      patch.receiptMimeType || null,
      patch.receiptSizeBytes || null,
      patch.receiptSha256 || null,
      patch.metadata ? JSON.stringify(patch.metadata) : null
    ]
  );
  if (result.rowCount === 0) return null;
  return findPartnerClientRequestById(requestId, client);
}

async function transitionPartnerClientRequest(requestId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_client_requests
     SET status = $2,
         "adminNotes" = COALESCE($3, "adminNotes"),
         "reviewedBy" = COALESCE($4::uuid, "reviewedBy"),
         "reviewedAt" = CASE WHEN $4::uuid IS NULL THEN "reviewedAt" ELSE NOW() END,
         "submittedAt" = CASE WHEN $2 = 'pending_review' THEN NOW() ELSE "submittedAt" END,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id`,
    [requestId, input.status, input.adminNotes || null, input.reviewedBy || null]
  );
  if (result.rowCount === 0) return null;
  return findPartnerClientRequestById(requestId, client);
}

async function findPartnerClientRequestById(requestId, client = null) {
  const result = await dbQuery(
    client,
    `${CLIENT_REQUEST_SELECT}
     WHERE pcr.id = $1
     LIMIT 1`,
    [requestId]
  );
  return mapClientRequestRow(result.rows[0] || null);
}

async function findPartnerClientRequestByIdForUpdate(requestId, client = null) {
  const result = await dbQuery(
    client,
    `${CLIENT_REQUEST_SELECT}
     WHERE pcr.id = $1
     LIMIT 1
     FOR UPDATE OF pcr`,
    [requestId]
  );
  return mapClientRequestRow(result.rows[0] || null);
}

async function markPartnerClientRequestProcessing(requestId, actorStaffUserId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_client_requests
     SET "processingStatus" = 'processing',
         "processedBy" = $2::uuid,
         "processingErrorCode" = NULL,
         "updatedAt" = NOW()
     WHERE id = $1
       AND "processingStatus" IN ('not_processed', 'processing_failed')
     RETURNING id`,
    [requestId, actorStaffUserId || null]
  );
  return result.rowCount > 0;
}

async function markPartnerClientRequestProcessingFailed(requestId, errorCode, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_client_requests
     SET "processingStatus" = 'processing_failed',
         "processingErrorCode" = $2,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id`,
    [requestId, errorCode || 'client_request_processing_failed']
  );
  return result.rowCount > 0;
}

async function markPartnerClientRequestProcessed(requestId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_client_requests
     SET "processingStatus" = 'processed',
         "paymentConfirmedAt" = COALESCE($2::timestamptz, NOW()),
         "paymentConfirmedBy" = $3::uuid,
         "paymentConfirmationMethod" = $4,
         "confirmedAmount" = $5::numeric,
         "confirmedCurrency" = $6,
         "paymentConfirmationReference" = $7,
         "paymentConfirmationNotes" = $8,
         "linkedTenantId" = $9::uuid,
         "linkedExternalTenantId" = $10,
         "attributionId" = $11::uuid,
         "commissionEntryId" = $12::uuid,
         "processedAt" = NOW(),
         "processedBy" = $13::uuid,
         "processingErrorCode" = NULL,
         "commissionBaseAmount" = $14::numeric,
         "commissionCurrency" = $15,
         "commissionRate" = $16::numeric,
         "commissionAmount" = $17::numeric,
         "commissionRuleCode" = $18,
         metadata = COALESCE(metadata, '{}'::jsonb) || $19::jsonb,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id`,
    [
      requestId,
      input.paymentConfirmedAt || null,
      input.paymentConfirmedBy || null,
      input.paymentConfirmationMethod || null,
      input.confirmedAmount,
      input.confirmedCurrency,
      input.paymentConfirmationReference || null,
      input.paymentConfirmationNotes || null,
      input.linkedTenantId,
      input.linkedExternalTenantId,
      input.attributionId,
      input.commissionEntryId,
      input.processedBy || null,
      input.commissionBaseAmount,
      input.commissionCurrency,
      input.commissionRate,
      input.commissionAmount,
      input.commissionRuleCode,
      JSON.stringify(input.metadata || {})
    ]
  );
  if (result.rowCount === 0) return null;
  return findPartnerClientRequestById(requestId, client);
}

async function listPartnerClientRequests(options = {}, client = null) {
  const safePage = Math.max(1, Number(options.page) || 1);
  const safePageSize = Math.max(1, Math.min(50, Number(options.pageSize) || 20));
  const offset = (safePage - 1) * safePageSize;
  const { params, where } = buildListWhere(options);
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const countResult = await dbQuery(
    client,
    `SELECT COUNT(*)::INT AS total
     FROM partner_client_requests pcr
     INNER JOIN partner_profiles pp ON pp."partnerId" = pcr."partnerId"
     ${whereSql}`,
    params
  );
  const rowParams = params.concat([safePageSize, offset]);
  const rowsResult = await dbQuery(
    client,
    `${CLIENT_REQUEST_SELECT}
     ${whereSql}
     ORDER BY COALESCE(pcr."submittedAt", pcr."createdAt") DESC, pcr."createdAt" DESC
     LIMIT $${rowParams.length - 1}
     OFFSET $${rowParams.length}`,
    rowParams
  );
  const total = Number(countResult.rows[0] && countResult.rows[0].total) || 0;
  return {
    requests: rowsResult.rows.map(mapClientRequestRow),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages: total > 0 ? Math.ceil(total / safePageSize) : 0
    }
  };
}

async function findPartnerClientRequestDuplicates(input, client = null) {
  const params = [
    input.normalizedEmail || null,
    input.normalizedPhone || null,
    input.normalizedTaxId || null,
    input.normalizedPaymentReference || null,
    input.receiptSha256 || null,
    input.excludeRequestId || null
  ];
  const result = await dbQuery(
    client,
    `SELECT id, "partnerId", status, "clientName", "businessName", email, phone, "taxId",
            "paymentReference", "receiptSha256", "createdAt"
     FROM partner_client_requests
     WHERE ($6::uuid IS NULL OR id <> $6::uuid)
       AND (
         ($1::text IS NOT NULL AND "normalizedEmail" = $1)
         OR ($2::text IS NOT NULL AND "normalizedPhone" = $2)
         OR ($3::text IS NOT NULL AND "normalizedTaxId" = $3)
         OR ($4::text IS NOT NULL AND "normalizedPaymentReference" = $4)
         OR ($5::text IS NOT NULL AND "receiptSha256" = $5)
       )
     ORDER BY "createdAt" DESC
     LIMIT 12`,
    params
  );
  return result.rows;
}

async function findExistingClientDuplicates(input, client = null) {
  const params = [input.normalizedEmail || null, input.normalizedPhone || null];
  const result = await dbQuery(
    client,
    `SELECT c.id,
            c.name,
            c.email,
            COALESCE(c."whatsappPhone", c.phone) AS phone,
            c."taxId",
            clinic.name AS "clinicName",
            clinic."externalTenantId",
            c."createdAt"
     FROM contacts c
     INNER JOIN clinics clinic ON clinic.id = c."clinicId"
     WHERE ($1::text IS NOT NULL AND LOWER(COALESCE(c.email, '')) = $1)
        OR ($2::text IS NOT NULL AND regexp_replace(COALESCE(c."whatsappPhone", c.phone, ''), '[^0-9]+', '', 'g') = $2)
     ORDER BY c."createdAt" DESC
     LIMIT 8`,
    params
  );
  return result.rows;
}

module.exports = {
  createPartnerClientRequest,
  updatePartnerClientRequest,
  transitionPartnerClientRequest,
  findPartnerClientRequestById,
  findPartnerClientRequestByIdForUpdate,
  markPartnerClientRequestProcessing,
  markPartnerClientRequestProcessingFailed,
  markPartnerClientRequestProcessed,
  listPartnerClientRequests,
  findPartnerClientRequestDuplicates,
  findExistingClientDuplicates
};
