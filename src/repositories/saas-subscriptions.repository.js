const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function mapSubscriptionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    externalTenantId: row.externalTenantId,
    clientId: row.clientId || null,
    planCode: row.planCode,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    currency: row.currency,
    billingInterval: row.billingInterval,
    mercadoPagoPreapprovalId: row.mercadoPagoPreapprovalId || null,
    mercadoPagoPayerEmail: row.mercadoPagoPayerEmail || null,
    mercadoPagoStatus: row.mercadoPagoStatus || null,
    localStatus: row.localStatus,
    currentPeriodStart: row.currentPeriodStart || null,
    currentPeriodEnd: row.currentPeriodEnd || null,
    nextBillingDate: row.nextBillingDate || null,
    lastPaymentId: row.lastPaymentId || null,
    lastPaymentStatus: row.lastPaymentStatus || null,
    externalReference: row.externalReference,
    authorizationUrl: row.authorizationUrl || null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

async function insertSaasSubscription(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO saas_subscriptions (
      id,
      "clinicId",
      "externalTenantId",
      "clientId",
      "planCode",
      amount,
      currency,
      "billingInterval",
      "mercadoPagoPreapprovalId",
      "mercadoPagoPayerEmail",
      "mercadoPagoStatus",
      "localStatus",
      "currentPeriodStart",
      "currentPeriodEnd",
      "nextBillingDate",
      "lastPaymentId",
      "lastPaymentStatus",
      "externalReference",
      "authorizationUrl",
      metadata,
      "updatedAt"
    ) VALUES (
      $1::uuid,
      $2::uuid,
      $3,
      $4::uuid,
      $5,
      $6::numeric,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13::timestamptz,
      $14::timestamptz,
      $15::timestamptz,
      $16,
      $17,
      $18,
      $19,
      $20::jsonb,
      NOW()
    )
    RETURNING
      id,
      "clinicId",
      "externalTenantId",
      "clientId",
      "planCode",
      amount,
      currency,
      "billingInterval",
      "mercadoPagoPreapprovalId",
      "mercadoPagoPayerEmail",
      "mercadoPagoStatus",
      "localStatus",
      "currentPeriodStart",
      "currentPeriodEnd",
      "nextBillingDate",
      "lastPaymentId",
      "lastPaymentStatus",
      "externalReference",
      "authorizationUrl",
      metadata,
      "createdAt",
      "updatedAt"`,
    [
      input.id,
      input.clinicId,
      input.externalTenantId,
      input.clientId || null,
      input.planCode,
      input.amount,
      input.currency,
      input.billingInterval,
      input.mercadoPagoPreapprovalId || null,
      input.mercadoPagoPayerEmail || null,
      input.mercadoPagoStatus || null,
      input.localStatus,
      input.currentPeriodStart || null,
      input.currentPeriodEnd || null,
      input.nextBillingDate || null,
      input.lastPaymentId || null,
      input.lastPaymentStatus || null,
      input.externalReference,
      input.authorizationUrl || null,
      JSON.stringify(input.metadata || {})
    ]
  );

  return mapSubscriptionRow(result.rows[0] || null);
}

async function updateSaasSubscriptionById(id, patch, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE saas_subscriptions
     SET "planCode" = COALESCE($2, "planCode"),
         amount = COALESCE($3::numeric, amount),
         currency = COALESCE($4, currency),
         "billingInterval" = COALESCE($5, "billingInterval"),
         "mercadoPagoPreapprovalId" = COALESCE($6, "mercadoPagoPreapprovalId"),
         "mercadoPagoPayerEmail" = COALESCE($7, "mercadoPagoPayerEmail"),
         "mercadoPagoStatus" = COALESCE($8, "mercadoPagoStatus"),
         "localStatus" = COALESCE($9, "localStatus"),
         "currentPeriodStart" = COALESCE($10::timestamptz, "currentPeriodStart"),
         "currentPeriodEnd" = COALESCE($11::timestamptz, "currentPeriodEnd"),
         "nextBillingDate" = COALESCE($12::timestamptz, "nextBillingDate"),
         "lastPaymentId" = COALESCE($13, "lastPaymentId"),
         "lastPaymentStatus" = COALESCE($14, "lastPaymentStatus"),
         "authorizationUrl" = COALESCE($15, "authorizationUrl"),
         metadata = CASE
           WHEN $16::jsonb IS NULL THEN metadata
           ELSE COALESCE(metadata, '{}'::jsonb) || $16::jsonb
         END,
         "updatedAt" = NOW()
     WHERE id = $1::uuid
     RETURNING
      id,
      "clinicId",
      "externalTenantId",
      "clientId",
      "planCode",
      amount,
      currency,
      "billingInterval",
      "mercadoPagoPreapprovalId",
      "mercadoPagoPayerEmail",
      "mercadoPagoStatus",
      "localStatus",
      "currentPeriodStart",
      "currentPeriodEnd",
      "nextBillingDate",
      "lastPaymentId",
      "lastPaymentStatus",
      "externalReference",
      "authorizationUrl",
      metadata,
      "createdAt",
      "updatedAt"`,
    [
      id,
      patch.planCode || null,
      patch.amount ?? null,
      patch.currency || null,
      patch.billingInterval || null,
      patch.mercadoPagoPreapprovalId || null,
      patch.mercadoPagoPayerEmail || null,
      patch.mercadoPagoStatus || null,
      patch.localStatus || null,
      patch.currentPeriodStart || null,
      patch.currentPeriodEnd || null,
      patch.nextBillingDate || null,
      patch.lastPaymentId || null,
      patch.lastPaymentStatus || null,
      patch.authorizationUrl || null,
      patch.metadata ? JSON.stringify(patch.metadata) : null
    ]
  );

  return mapSubscriptionRow(result.rows[0] || null);
}

async function findSaasSubscriptionById(id, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
      id,
      "clinicId",
      "externalTenantId",
      "clientId",
      "planCode",
      amount,
      currency,
      "billingInterval",
      "mercadoPagoPreapprovalId",
      "mercadoPagoPayerEmail",
      "mercadoPagoStatus",
      "localStatus",
      "currentPeriodStart",
      "currentPeriodEnd",
      "nextBillingDate",
      "lastPaymentId",
      "lastPaymentStatus",
      "externalReference",
      "authorizationUrl",
      metadata,
      "createdAt",
      "updatedAt"
     FROM saas_subscriptions
     WHERE id = $1::uuid
     LIMIT 1`,
    [id]
  );
  return mapSubscriptionRow(result.rows[0] || null);
}

async function findLatestSaasSubscriptionByTenantId(externalTenantId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
      id,
      "clinicId",
      "externalTenantId",
      "clientId",
      "planCode",
      amount,
      currency,
      "billingInterval",
      "mercadoPagoPreapprovalId",
      "mercadoPagoPayerEmail",
      "mercadoPagoStatus",
      "localStatus",
      "currentPeriodStart",
      "currentPeriodEnd",
      "nextBillingDate",
      "lastPaymentId",
      "lastPaymentStatus",
      "externalReference",
      "authorizationUrl",
      metadata,
      "createdAt",
      "updatedAt"
     FROM saas_subscriptions
     WHERE "externalTenantId" = $1
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [externalTenantId]
  );
  return mapSubscriptionRow(result.rows[0] || null);
}

async function findSaasSubscriptionByPreapprovalId(preapprovalId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
      id,
      "clinicId",
      "externalTenantId",
      "clientId",
      "planCode",
      amount,
      currency,
      "billingInterval",
      "mercadoPagoPreapprovalId",
      "mercadoPagoPayerEmail",
      "mercadoPagoStatus",
      "localStatus",
      "currentPeriodStart",
      "currentPeriodEnd",
      "nextBillingDate",
      "lastPaymentId",
      "lastPaymentStatus",
      "externalReference",
      "authorizationUrl",
      metadata,
      "createdAt",
      "updatedAt"
     FROM saas_subscriptions
     WHERE "mercadoPagoPreapprovalId" = $1
     LIMIT 1`,
    [preapprovalId]
  );
  return mapSubscriptionRow(result.rows[0] || null);
}

async function findSaasSubscriptionByExternalReference(externalReference, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
      id,
      "clinicId",
      "externalTenantId",
      "clientId",
      "planCode",
      amount,
      currency,
      "billingInterval",
      "mercadoPagoPreapprovalId",
      "mercadoPagoPayerEmail",
      "mercadoPagoStatus",
      "localStatus",
      "currentPeriodStart",
      "currentPeriodEnd",
      "nextBillingDate",
      "lastPaymentId",
      "lastPaymentStatus",
      "externalReference",
      "authorizationUrl",
      metadata,
      "createdAt",
      "updatedAt"
     FROM saas_subscriptions
     WHERE "externalReference" = $1
     LIMIT 1`,
    [externalReference]
  );
  return mapSubscriptionRow(result.rows[0] || null);
}

async function listSaasSubscriptions(filters = {}, client = null) {
  const where = [];
  const params = [];

  if (filters.externalTenantId) {
    params.push(String(filters.externalTenantId).trim());
    where.push(`"externalTenantId" = $${params.length}`);
  }

  if (filters.localStatus) {
    params.push(String(filters.localStatus).trim());
    where.push(`"localStatus" = $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await dbQuery(
    client,
    `SELECT
      id,
      "clinicId",
      "externalTenantId",
      "clientId",
      "planCode",
      amount,
      currency,
      "billingInterval",
      "mercadoPagoPreapprovalId",
      "mercadoPagoPayerEmail",
      "mercadoPagoStatus",
      "localStatus",
      "currentPeriodStart",
      "currentPeriodEnd",
      "nextBillingDate",
      "lastPaymentId",
      "lastPaymentStatus",
      "externalReference",
      "authorizationUrl",
      metadata,
      "createdAt",
      "updatedAt"
     FROM saas_subscriptions
     ${whereSql}
     ORDER BY "createdAt" DESC`,
    params
  );
  return result.rows.map(mapSubscriptionRow);
}

async function insertSubscriptionEvent(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO saas_subscription_events (
      "subscriptionId",
      provider,
      topic,
      action,
      "resourceId",
      "notificationId",
      "requestId",
      "dedupeKey",
      "signatureValid",
      raw,
      "processingStatus",
      "processingError",
      "updatedAt"
    ) VALUES (
      $1::uuid,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10::jsonb,
      $11,
      $12,
      NOW()
    )
    ON CONFLICT ("dedupeKey") DO NOTHING
    RETURNING id, "subscriptionId", "dedupeKey", "processingStatus", "createdAt", "updatedAt"`,
    [
      input.subscriptionId || null,
      input.provider || 'mercado_pago',
      input.topic || null,
      input.action || null,
      input.resourceId || null,
      input.notificationId || null,
      input.requestId || null,
      input.dedupeKey,
      input.signatureValid === null || input.signatureValid === undefined ? null : !!input.signatureValid,
      JSON.stringify(input.raw || {}),
      input.processingStatus || 'received',
      input.processingError || null
    ]
  );

  return result.rows[0] || null;
}

async function updateSubscriptionEventStatus(id, patch, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE saas_subscription_events
     SET "subscriptionId" = COALESCE($2::uuid, "subscriptionId"),
         "processingStatus" = COALESCE($3, "processingStatus"),
         "processingError" = $4,
         "updatedAt" = NOW()
     WHERE id = $1::uuid
     RETURNING id, "subscriptionId", "dedupeKey", "processingStatus", "processingError", "updatedAt"`,
    [id, patch.subscriptionId || null, patch.processingStatus || null, patch.processingError || null]
  );

  return result.rows[0] || null;
}

module.exports = {
  insertSaasSubscription,
  updateSaasSubscriptionById,
  findSaasSubscriptionById,
  findLatestSaasSubscriptionByTenantId,
  findSaasSubscriptionByPreapprovalId,
  findSaasSubscriptionByExternalReference,
  listSaasSubscriptions,
  insertSubscriptionEvent,
  updateSubscriptionEventStatus
};
