const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function mapPartnerRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt || null,
    profile: {
      code: row.code,
      displayName: row.displayName,
      legalName: row.legalName || null,
      phone: row.phone || null,
      notes: row.notes || null,
      metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    },
    sponsorPartnerId: row.sponsorPartnerId || null,
    activeAttributionCount: Number(row.activeAttributionCount || 0),
    currentRankCode: row.currentRankCode || null
  };
}

const PARTNER_SELECT = `SELECT pa.id,
       pa.email,
       pa.status,
       pa."createdAt",
       pa."updatedAt",
       pa."lastLoginAt",
       pp.code,
       pp."displayName",
       pp."legalName",
       pp.phone,
       pp.notes,
       pp.metadata,
       rel."sponsorPartnerId",
       (
         SELECT COUNT(*)::INT
         FROM partner_client_attributions pca
         WHERE pca."partnerId" = pa.id
           AND pca.status = 'active'
       ) AS "activeAttributionCount",
       (
         SELECT prh."rankCode"
         FROM partner_rank_history prh
         WHERE prh."partnerId" = pa.id
           AND prh."effectiveTo" IS NULL
         ORDER BY prh."effectiveFrom" DESC
         LIMIT 1
       ) AS "currentRankCode"
FROM partner_accounts pa
INNER JOIN partner_profiles pp ON pp."partnerId" = pa.id
LEFT JOIN partner_relationships rel
  ON rel."partnerId" = pa.id
 AND rel.status = 'active'`;

async function findPartnerById(partnerId, client = null) {
  const result = await dbQuery(
    client,
    `${PARTNER_SELECT}
     WHERE pa.id = $1
     LIMIT 1`,
    [partnerId]
  );
  return mapPartnerRow(result.rows[0] || null);
}

async function findPartnerByEmail(email, client = null) {
  const result = await dbQuery(
    client,
    `${PARTNER_SELECT}
     WHERE LOWER(pa.email) = LOWER($1)
     LIMIT 1`,
    [email]
  );
  return mapPartnerRow(result.rows[0] || null);
}

async function findRawPartnerAuthByEmail(email, client = null) {
  const result = await dbQuery(
    client,
    `SELECT pa.id,
            pa.email,
            pa."passwordHash",
            pa.status,
            pa."lastLoginAt",
            pp."displayName"
     FROM partner_accounts pa
     INNER JOIN partner_profiles pp ON pp."partnerId" = pa.id
     WHERE LOWER(pa.email) = LOWER($1)
     LIMIT 1`,
    [email]
  );
  return result.rows[0] || null;
}

async function listPartners(options = {}, client = null) {
  const statuses = Array.isArray(options.statuses) ? options.statuses.filter(Boolean) : [];
  const params = [];
  const where = [];

  if (statuses.length > 0) {
    params.push(statuses);
    where.push(`pa.status = ANY($${params.length}::text[])`);
  }

  const result = await dbQuery(
    client,
    `${PARTNER_SELECT}
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY pp."displayName" ASC, pa."createdAt" ASC`,
    params
  );
  return result.rows.map(mapPartnerRow);
}

async function createPartnerAccount(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_accounts (email, "passwordHash", status, "updatedAt")
     VALUES ($1, $2, $3, NOW())
     RETURNING id, email, status, "createdAt", "updatedAt", "lastLoginAt"`,
    [input.email, input.passwordHash, input.status]
  );
  return result.rows[0] || null;
}

async function createPartnerProfile(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_profiles ("partnerId", code, "displayName", "legalName", phone, notes, metadata, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
     RETURNING "partnerId", code, "displayName", "legalName", phone, notes, metadata, "createdAt", "updatedAt"`,
    [
      input.partnerId,
      input.code,
      input.displayName,
      input.legalName || null,
      input.phone || null,
      input.notes || null,
      JSON.stringify(input.metadata || {})
    ]
  );
  return result.rows[0] || null;
}

async function createPartnerRelationship(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_relationships ("partnerId", "sponsorPartnerId", status, "startsAt", "createdByStaffUserId", "updatedAt")
     VALUES ($1, $2, 'active', COALESCE($3::timestamptz, NOW()), $4::uuid, NOW())
     RETURNING id, "partnerId", "sponsorPartnerId", status, "startsAt", "endsAt", "createdAt", "updatedAt"`,
    [input.partnerId, input.sponsorPartnerId || null, input.startsAt || null, input.createdByStaffUserId || null]
  );
  return result.rows[0] || null;
}

async function endActivePartnerRelationship(partnerId, endedAt, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_relationships
     SET status = 'ended',
         "endsAt" = COALESCE($2::timestamptz, NOW()),
         "updatedAt" = NOW()
     WHERE "partnerId" = $1
       AND status = 'active'
     RETURNING id`,
    [partnerId, endedAt || null]
  );
  return result.rowCount;
}

async function updatePartnerStatus(partnerId, status, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_accounts
     SET status = $2,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id`,
    [partnerId, status]
  );
  return result.rowCount > 0;
}

async function touchPartnerLogin(partnerId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_accounts
     SET "lastLoginAt" = NOW(),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id`,
    [partnerId]
  );
  return result.rowCount > 0;
}

async function findClinicTenantByExternalTenantId(tenantId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, name, timezone, "externalTenantId"
     FROM clinics
     WHERE "externalTenantId" = $1
     LIMIT 1`,
    [tenantId]
  );
  return result.rows[0] || null;
}

async function findActiveAttributionByTenantId(tenantId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT pca.id,
            pca."partnerId",
            pca."clinicId",
            pca."tenantId",
            pca.status,
            pca."attributionSource",
            pca.notes,
            pca."attributedAt",
            pca."endedAt",
            pca."createdByStaffUserId",
            pca."createdAt",
            pca."updatedAt"
     FROM partner_client_attributions pca
     WHERE pca."tenantId" = $1
       AND pca.status = 'active'
     LIMIT 1`,
    [tenantId]
  );
  return result.rows[0] || null;
}

async function findAttributionById(attributionId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            "partnerId",
            "clinicId",
            "tenantId",
            status,
            "attributionSource",
            notes,
            "attributedAt",
            "endedAt",
            "createdByStaffUserId",
            "createdAt",
            "updatedAt"
     FROM partner_client_attributions
     WHERE id = $1
     LIMIT 1`,
    [attributionId]
  );
  return result.rows[0] || null;
}

async function listPartnerAttributions(partnerId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT pca.id,
            pca."partnerId",
            pca."clinicId",
            pca."tenantId",
            pca.status,
            pca."attributionSource",
            pca.notes,
            pca."attributedAt",
            pca."endedAt",
            c.name AS "clinicName",
            ss."planCode" AS "billingPlanCode",
            ss."localStatus" AS "billingSubscriptionStatus",
            ss."lastPaymentStatus" AS "billingLastPaymentStatus",
            ss."nextBillingDate" AS "billingNextPaymentAt",
            CASE
              WHEN LOWER(COALESCE(ss."lastPaymentStatus", '')) IN ('approved', 'accredited', 'active', 'authorized')
                THEN ss.metadata -> 'mercadoPagoPayment' ->> 'dateApproved'
              ELSE NULL
            END AS "billingLastAccreditedPaymentAt",
            pca."createdAt",
            pca."updatedAt"
     FROM partner_client_attributions pca
     INNER JOIN clinics c ON c.id = pca."clinicId"
     LEFT JOIN LATERAL (
       SELECT ss."planCode",
              ss."localStatus",
              ss."lastPaymentStatus",
              ss."nextBillingDate",
              ss.metadata
       FROM saas_subscriptions ss
       WHERE ss."externalTenantId" = pca."tenantId"
       ORDER BY ss."createdAt" DESC
       LIMIT 1
     ) ss ON TRUE
     WHERE pca."partnerId" = $1
     ORDER BY pca."attributedAt" DESC, pca."createdAt" DESC`,
    [partnerId]
  );
  return result.rows;
}

async function createPartnerAttribution(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_client_attributions
      ("partnerId", "clinicId", "tenantId", status, "attributionSource", notes, "attributedAt", "createdByStaffUserId", "updatedAt")
     VALUES ($1, $2, $3, 'active', $4, $5, COALESCE($6::timestamptz, NOW()), $7::uuid, NOW())
     RETURNING id, "partnerId", "clinicId", "tenantId", status, "attributionSource", notes, "attributedAt", "endedAt", "createdAt", "updatedAt"`,
    [
      input.partnerId,
      input.clinicId,
      input.tenantId,
      input.attributionSource,
      input.notes || null,
      input.attributedAt || null,
      input.createdByStaffUserId || null
    ]
  );
  return result.rows[0] || null;
}

async function cancelActiveAttribution(attributionId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_client_attributions
     SET status = 'cancelled',
         "endedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE id = $1
       AND status = 'active'
     RETURNING id`,
    [attributionId]
  );
  return result.rowCount > 0;
}

async function listCommissionPlans(client = null) {
  const result = await dbQuery(
    client,
    `SELECT p.id,
            p.code,
            p.name,
            p.status,
            p."createdAt",
            p."updatedAt",
            (
              SELECT row_to_json(v)
              FROM (
                SELECT pv.id,
                       pv."versionNumber",
                       pv.status,
                       pv.currency,
                       pv.rules,
                       pv."maxPayoutPercent",
                       pv."effectiveFrom",
                       pv."effectiveTo",
                       pv."publishedAt",
                       pv."createdAt",
                       pv."updatedAt"
                FROM partner_commission_plan_versions pv
                WHERE pv."planId" = p.id
                ORDER BY pv."versionNumber" DESC
                LIMIT 1
              ) v
            ) AS "latestVersion"
     FROM partner_commission_plans p
     ORDER BY p.name ASC, p."createdAt" ASC`
  );
  return result.rows;
}

async function findCommissionPlanByCode(code, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, code, name, status, "createdAt", "updatedAt"
     FROM partner_commission_plans
     WHERE code = $1
     LIMIT 1`,
    [code]
  );
  return result.rows[0] || null;
}

async function createCommissionPlan(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_commission_plans (code, name, status, "createdByStaffUserId", "updatedAt")
     VALUES ($1, $2, $3, $4::uuid, NOW())
     RETURNING id, code, name, status, "createdAt", "updatedAt"`,
    [input.code, input.name, input.status, input.createdByStaffUserId || null]
  );
  return result.rows[0] || null;
}

async function countPlanVersions(planId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT COUNT(*)::INT AS count
     FROM partner_commission_plan_versions
     WHERE "planId" = $1`,
    [planId]
  );
  return Number(result.rows[0] && result.rows[0].count) || 0;
}

async function createCommissionPlanVersion(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_commission_plan_versions
      ("planId", "versionNumber", status, currency, rules, "maxPayoutPercent", "effectiveFrom", "effectiveTo", "publishedAt", "createdByStaffUserId", "updatedAt")
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::uuid, NOW())
     RETURNING id, "planId", "versionNumber", status, currency, rules, "maxPayoutPercent", "effectiveFrom", "effectiveTo", "publishedAt", "createdAt", "updatedAt"`,
    [
      input.planId,
      input.versionNumber,
      input.status,
      input.currency,
      JSON.stringify(input.rules || {}),
      input.maxPayoutPercent,
      input.effectiveFrom || null,
      input.effectiveTo || null,
      input.publishedAt || null,
      input.createdByStaffUserId || null
    ]
  );
  return result.rows[0] || null;
}

async function findCommissionPlanVersionById(versionId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT pv.id,
            pv."planId",
            p.code AS "planCode",
            p.name AS "planName",
            pv."versionNumber",
            pv.status,
            pv.currency,
            pv.rules,
            pv."maxPayoutPercent",
            pv."effectiveFrom",
            pv."effectiveTo",
            pv."publishedAt",
            pv."createdAt",
            pv."updatedAt"
     FROM partner_commission_plan_versions pv
     INNER JOIN partner_commission_plans p ON p.id = pv."planId"
     WHERE pv.id = $1
     LIMIT 1`,
    [versionId]
  );
  return result.rows[0] || null;
}

async function findPublishedCommissionPlanVersion(versionId = null, client = null) {
  const params = [];
  let where = `pv.status = 'published'`;
  if (versionId) {
    params.push(versionId);
    where += ` AND pv.id = $${params.length}`;
  }
  const result = await dbQuery(
    client,
    `SELECT pv.id,
            pv."planId",
            p.code AS "planCode",
            p.name AS "planName",
            pv."versionNumber",
            pv.status,
            pv.currency,
            pv.rules,
            pv."maxPayoutPercent",
            pv."effectiveFrom",
            pv."effectiveTo",
            pv."publishedAt",
            pv."createdAt",
            pv."updatedAt"
     FROM partner_commission_plan_versions pv
     INNER JOIN partner_commission_plans p ON p.id = pv."planId"
     WHERE ${where}
     ORDER BY COALESCE(pv."effectiveFrom", pv."publishedAt", pv."createdAt") DESC, pv."versionNumber" DESC
     LIMIT 1`,
    params
  );
  return result.rows[0] || null;
}

async function listPartnerCommissionEntries(partnerId, options = {}, client = null) {
  const params = [partnerId];
  const where = [`"partnerId" = $1`];

  if (options.status) {
    params.push(options.status);
    where.push(`status = $${params.length}`);
  }

  const result = await dbQuery(
    client,
    `SELECT id,
            "partnerId",
            "attributionId",
            "planVersionId",
            "clinicId",
            "tenantId",
            "sourceType",
            "sourceRef",
            "sourceEventId",
            "eventType",
            "eventAt",
            "periodKey",
            currency,
            "planCodeSnapshot",
            "planVersionNumberSnapshot",
            "payoutKind",
            "paymentStatus",
            status,
            "basisAmount",
            "commissionRate",
            "commissionAmount",
            "depthLevel",
            "idempotencyKey",
            "reversalOfEntryId",
            details,
            "createdAt",
            "updatedAt"
     FROM partner_commission_entries
     WHERE ${where.join(' AND ')}
     ORDER BY "eventAt" DESC, "createdAt" DESC`,
    params
  );
  return result.rows;
}

function buildPartnerCommissionLedgerWhere(partnerId, options = {}) {
  const params = [partnerId, Array.isArray(options.statuses) && options.statuses.length > 0 ? options.statuses : ['generated', 'reversed']];
  const where = [`pce."partnerId" = $1`, `pce.status = ANY($2::text[])`];

  if (options.payoutKind) {
    params.push(options.payoutKind);
    where.push(`pce."payoutKind" = $${params.length}`);
  }

  if (options.from) {
    params.push(options.from);
    where.push(`pce."eventAt" >= $${params.length}::timestamptz`);
  }

  if (options.to) {
    params.push(options.to);
    where.push(`pce."eventAt" <= $${params.length}::timestamptz`);
  }

  return { params, where };
}

async function listPartnerCommissionLedger(partnerId, options = {}, client = null) {
  const safePage = Math.max(1, Number(options.page) || 1);
  const safePageSize = Math.max(1, Math.min(50, Number(options.pageSize) || 20));
  const offset = (safePage - 1) * safePageSize;
  const { params, where } = buildPartnerCommissionLedgerWhere(partnerId, options);
  const filteredFrom = `FROM partner_commission_entries pce
     LEFT JOIN partner_client_attributions pca ON pca.id = pce."attributionId"
     LEFT JOIN clinics entry_clinic ON entry_clinic.id = pce."clinicId"
     LEFT JOIN clinics attributed_clinic ON attributed_clinic.id = pca."clinicId"
     WHERE ${where.join(' AND ')}`;

  const summaryResult = await dbQuery(
    client,
    `SELECT COUNT(*)::INT AS total,
            COALESCE(SUM(CASE WHEN pce.status = 'generated' THEN pce."commissionAmount" ELSE 0 END), 0)::TEXT AS "totalGenerated",
            COALESCE(SUM(CASE WHEN pce.status = 'reversed' THEN ABS(pce."commissionAmount") ELSE 0 END), 0)::TEXT AS "totalReversed",
            COALESCE(SUM(pce."commissionAmount"), 0)::TEXT AS "netAmount",
            CASE WHEN COUNT(DISTINCT pce.currency) = 1 THEN MIN(pce.currency) ELSE NULL END AS currency
     ${filteredFrom}`,
    params
  );

  const rowParams = params.concat([safePageSize, offset]);
  const rowsResult = await dbQuery(
    client,
    `SELECT pce.id,
            pce."partnerId",
            pce."attributionId",
            pce."planVersionId",
            pce."clinicId",
            pce."tenantId",
            pce."sourceType",
            pce."sourceRef",
            pce."sourceEventId",
            pce."eventType",
            pce."eventAt",
            pce."periodKey",
            pce.currency,
            pce."planCodeSnapshot",
            pce."planVersionNumberSnapshot",
            pce."payoutKind",
            pce."paymentStatus",
            pce.status,
            pce."basisAmount",
            pce."commissionRate",
            pce."commissionAmount",
            pce."depthLevel",
            pce."reversalOfEntryId",
            pce.details,
            pce."createdAt",
            pce."updatedAt",
            COALESCE(entry_clinic.name, attributed_clinic.name) AS "clientName"
     ${filteredFrom}
     ORDER BY pce."eventAt" DESC, pce."createdAt" DESC
     LIMIT $${rowParams.length - 1}
     OFFSET $${rowParams.length}`,
    rowParams
  );

  return {
    summary: summaryResult.rows[0] || {
      total: 0,
      totalGenerated: '0.00',
      totalReversed: '0.00',
      netAmount: '0.00',
      currency: null
    },
    rows: rowsResult.rows,
    page: safePage,
    pageSize: safePageSize
  };
}

async function findCommissionEntriesBySource(sourceType, sourceRef, sourceEventId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            "partnerId",
            "attributionId",
            "planVersionId",
            "clinicId",
            "tenantId",
            "sourceType",
            "sourceRef",
            "sourceEventId",
            "eventType",
            "eventAt",
            "periodKey",
            currency,
            "planCodeSnapshot",
            "planVersionNumberSnapshot",
            "payoutKind",
            "paymentStatus",
            status,
            "basisAmount",
            "commissionRate",
            "commissionAmount",
            "depthLevel",
            "idempotencyKey",
            "reversalOfEntryId",
            details,
            "createdAt",
            "updatedAt"
     FROM partner_commission_entries
     WHERE "sourceType" = $1
       AND "sourceRef" = $2
       AND "sourceEventId" = $3
     ORDER BY "depthLevel" ASC, "createdAt" ASC`,
    [sourceType, sourceRef, sourceEventId]
  );
  return result.rows;
}

async function findCommissionEntryById(entryId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            "partnerId",
            "attributionId",
            "planVersionId",
            "clinicId",
            "tenantId",
            "sourceType",
            "sourceRef",
            "sourceEventId",
            "eventType",
            "eventAt",
            "periodKey",
            currency,
            "planCodeSnapshot",
            "planVersionNumberSnapshot",
            "payoutKind",
            "paymentStatus",
            status,
            "basisAmount",
            "commissionRate",
            "commissionAmount",
            "depthLevel",
            "idempotencyKey",
            "reversalOfEntryId",
            details,
            "createdAt",
            "updatedAt"
     FROM partner_commission_entries
     WHERE id = $1
     LIMIT 1`,
    [entryId]
  );
  return result.rows[0] || null;
}

async function createCommissionEntry(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_commission_entries
      ("partnerId", "attributionId", "planVersionId", "clinicId", "tenantId", "sourceType", "sourceRef", "sourceEventId", "eventType", "eventAt", "periodKey", currency, "planCodeSnapshot", "planVersionNumberSnapshot", "payoutKind", "paymentStatus", status, "basisAmount", "commissionRate", "commissionAmount", "depthLevel", "idempotencyKey", "reversalOfEntryId", details, "createdByStaffUserId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, $25::uuid)
     RETURNING id,
               "partnerId",
               "attributionId",
               "planVersionId",
               "clinicId",
               "tenantId",
               "sourceType",
               "sourceRef",
               "sourceEventId",
               "eventType",
               "eventAt",
               "periodKey",
               currency,
               "planCodeSnapshot",
               "planVersionNumberSnapshot",
               "payoutKind",
               "paymentStatus",
               status,
               "basisAmount",
               "commissionRate",
               "commissionAmount",
               "depthLevel",
               "idempotencyKey",
               "reversalOfEntryId",
               details,
               "createdAt",
               "updatedAt"`,
    [
      input.partnerId,
      input.attributionId || null,
      input.planVersionId,
      input.clinicId || null,
      input.tenantId || null,
      input.sourceType,
      input.sourceRef,
      input.sourceEventId,
      input.eventType,
      input.eventAt,
      input.periodKey,
      input.currency,
      input.planCodeSnapshot,
      input.planVersionNumberSnapshot,
      input.payoutKind,
      input.paymentStatus,
      input.status,
      input.basisAmount,
      input.commissionRate,
      input.commissionAmount,
      input.depthLevel,
      input.idempotencyKey,
      input.reversalOfEntryId || null,
      JSON.stringify(input.details || {}),
      input.createdByStaffUserId || null
    ]
  );
  return result.rows[0] || null;
}

async function markCommissionEntryReversed(entryId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_commission_entries
     SET status = 'reversed',
         "updatedAt" = NOW()
     WHERE id = $1
       AND status = 'generated'
     RETURNING id`,
    [entryId]
  );
  return result.rowCount > 0;
}

async function findReversalEntryByOriginalEntryId(entryId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            "partnerId",
            "attributionId",
            "planVersionId",
            "clinicId",
            "tenantId",
            "sourceType",
            "sourceRef",
            "sourceEventId",
            "eventType",
            "eventAt",
            "periodKey",
            currency,
            "planCodeSnapshot",
            "planVersionNumberSnapshot",
            "payoutKind",
            "paymentStatus",
            status,
            "basisAmount",
            "commissionRate",
            "commissionAmount",
            "depthLevel",
            "idempotencyKey",
            "reversalOfEntryId",
            details,
            "createdAt",
            "updatedAt"
     FROM partner_commission_entries
     WHERE "reversalOfEntryId" = $1
     LIMIT 1`,
    [entryId]
  );
  return result.rows[0] || null;
}

async function sumGeneratedCommissionsForPartner(partnerId, windowStart, windowEnd, client = null) {
  const result = await dbQuery(
    client,
    `SELECT COALESCE(SUM("commissionAmount"), 0)::TEXT AS total
     FROM partner_commission_entries
     WHERE "partnerId" = $1
       AND status = 'generated'
       AND "eventAt" >= $2::timestamptz
       AND "eventAt" < $3::timestamptz`,
    [partnerId, windowStart, windowEnd]
  );
  return result.rows[0] ? result.rows[0].total : '0';
}

async function countActivePartnerAttributions(partnerId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT COUNT(*)::INT AS count
     FROM partner_client_attributions
     WHERE "partnerId" = $1
       AND status = 'active'`,
    [partnerId]
  );
  return Number(result.rows[0] && result.rows[0].count) || 0;
}

async function createRankEvaluation(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_rank_evaluations
      ("partnerId", "planVersionId", status, "currentRankCode", "nextRankCode", metrics, "windowStart", "windowEnd", "evaluatedAt", "createdByStaffUserId")
     VALUES ($1, $2, 'completed', $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz, COALESCE($8::timestamptz, NOW()), $9::uuid)
     RETURNING id, "partnerId", "planVersionId", status, "currentRankCode", "nextRankCode", metrics, "windowStart", "windowEnd", "evaluatedAt", "createdAt"`,
    [
      input.partnerId,
      input.planVersionId || null,
      input.currentRankCode,
      input.nextRankCode || null,
      JSON.stringify(input.metrics || {}),
      input.windowStart,
      input.windowEnd,
      input.evaluatedAt || null,
      input.createdByStaffUserId || null
    ]
  );
  return result.rows[0] || null;
}

async function findLatestRankEvaluationByPartnerId(partnerId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            "partnerId",
            "planVersionId",
            status,
            "currentRankCode",
            "nextRankCode",
            metrics,
            "windowStart",
            "windowEnd",
            "evaluatedAt",
            "createdAt"
     FROM partner_rank_evaluations
     WHERE "partnerId" = $1
     ORDER BY "evaluatedAt" DESC, "createdAt" DESC
     LIMIT 1`,
    [partnerId]
  );
  return result.rows[0] || null;
}

async function listPartnerNetworkNodes(partnerId, maxDepth = 3, client = null) {
  const safeDepth = Math.max(1, Math.min(3, Number(maxDepth) || 3));
  const result = await dbQuery(
    client,
    `WITH RECURSIVE partner_network AS (
       SELECT child.id,
              child.status,
              child."createdAt",
              pp."displayName",
              rel."startsAt" AS "relationshipStartsAt",
              1 AS depth,
              ARRAY[$1::uuid, child.id] AS path
       FROM partner_relationships rel
       INNER JOIN partner_accounts child ON child.id = rel."partnerId"
       INNER JOIN partner_profiles pp ON pp."partnerId" = child.id
       WHERE rel.status = 'active'
         AND rel."sponsorPartnerId" = $1

       UNION ALL

       SELECT child.id,
              child.status,
              child."createdAt",
              pp."displayName",
              rel."startsAt" AS "relationshipStartsAt",
              network.depth + 1 AS depth,
              network.path || child.id
       FROM partner_network network
       INNER JOIN partner_relationships rel
         ON rel."sponsorPartnerId" = network.id
        AND rel.status = 'active'
       INNER JOIN partner_accounts child ON child.id = rel."partnerId"
       INNER JOIN partner_profiles pp ON pp."partnerId" = child.id
       WHERE network.depth < $2
         AND NOT (child.id = ANY(network.path))
     )
     SELECT network.id,
            network.status,
            network.depth,
            network."createdAt",
            network."displayName",
            network."relationshipStartsAt",
            (
              SELECT prh."rankCode"
              FROM partner_rank_history prh
              WHERE prh."partnerId" = network.id
                AND prh."effectiveTo" IS NULL
              ORDER BY prh."effectiveFrom" DESC
              LIMIT 1
            ) AS "currentRankCode",
            (
              SELECT COUNT(*)::INT
              FROM partner_client_attributions pca
              WHERE pca."partnerId" = network.id
                AND pca.status = 'active'
            ) AS "activeClientCount"
     FROM partner_network network
     ORDER BY network.depth ASC, network."relationshipStartsAt" ASC NULLS LAST, network."createdAt" ASC`,
    [partnerId, safeDepth]
  );
  return result.rows;
}

async function closeActiveRankHistory(partnerId, effectiveTo, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_rank_history
     SET "effectiveTo" = $2::timestamptz
     WHERE "partnerId" = $1
       AND "effectiveTo" IS NULL
     RETURNING id`,
    [partnerId, effectiveTo]
  );
  return result.rowCount;
}

async function createRankHistory(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_rank_history
      ("partnerId", "rankCode", "effectiveFrom", "evaluationId", notes, "createdByStaffUserId")
     VALUES ($1, $2, $3::timestamptz, $4, $5, $6::uuid)
     RETURNING id, "partnerId", "rankCode", "effectiveFrom", "effectiveTo", "evaluationId", notes, "createdAt"`,
    [
      input.partnerId,
      input.rankCode,
      input.effectiveFrom,
      input.evaluationId || null,
      input.notes || null,
      input.createdByStaffUserId || null
    ]
  );
  return result.rows[0] || null;
}

async function listRankHistory(partnerId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "partnerId", "rankCode", "effectiveFrom", "effectiveTo", "evaluationId", notes, "createdAt"
     FROM partner_rank_history
     WHERE "partnerId" = $1
     ORDER BY "effectiveFrom" DESC, "createdAt" DESC`,
    [partnerId]
  );
  return result.rows;
}

async function createPartnerAuditLog(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_audit_log
      ("partnerId", "tenantId", "entityType", "entityId", action, reason, "actorType", "actorStaffUserId", "actorPartnerId", metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10::jsonb)
     RETURNING id, "createdAt"`,
    [
      input.partnerId || null,
      input.tenantId || null,
      input.entityType,
      input.entityId,
      input.action,
      input.reason || null,
      input.actorType || 'system',
      input.actorStaffUserId || null,
      input.actorPartnerId || null,
      JSON.stringify(input.metadata || {})
    ]
  );
  return result.rows[0] || null;
}

async function listPartnerAuditLog(partnerId, limit = 50, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            "partnerId",
            "tenantId",
            "entityType",
            "entityId",
            action,
            reason,
            "actorType",
            "actorStaffUserId",
            "actorPartnerId",
            metadata,
            "createdAt"
     FROM partner_audit_log
     WHERE "partnerId" = $1
     ORDER BY "createdAt" DESC
     LIMIT $2`,
    [partnerId, limit]
  );
  return result.rows;
}

module.exports = {
  listPartners,
  findPartnerById,
  findPartnerByEmail,
  findRawPartnerAuthByEmail,
  createPartnerAccount,
  createPartnerProfile,
  createPartnerRelationship,
  endActivePartnerRelationship,
  updatePartnerStatus,
  touchPartnerLogin,
  findClinicTenantByExternalTenantId,
  findActiveAttributionByTenantId,
  findAttributionById,
  listPartnerAttributions,
  createPartnerAttribution,
  cancelActiveAttribution,
  listCommissionPlans,
  findCommissionPlanByCode,
  createCommissionPlan,
  countPlanVersions,
  createCommissionPlanVersion,
  findCommissionPlanVersionById,
  findPublishedCommissionPlanVersion,
  listPartnerCommissionEntries,
  listPartnerCommissionLedger,
  findCommissionEntriesBySource,
  findCommissionEntryById,
  findReversalEntryByOriginalEntryId,
  createCommissionEntry,
  markCommissionEntryReversed,
  sumGeneratedCommissionsForPartner,
  countActivePartnerAttributions,
  createRankEvaluation,
  findLatestRankEvaluationByPartnerId,
  listPartnerNetworkNodes,
  closeActiveRankHistory,
  createRankHistory,
  listRankHistory,
  createPartnerAuditLog,
  listPartnerAuditLog
};
