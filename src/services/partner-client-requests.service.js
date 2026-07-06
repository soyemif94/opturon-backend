const { randomUUID } = require('crypto');
const { withTransaction } = require('../db/client');
const {
  findPartnerById,
  createPartnerAuditLog,
  findClinicTenantByExternalTenantId,
  findActiveAttributionByTenantId,
  createPartnerAttribution,
  findPublishedCommissionPlanVersion,
  findCommissionEntriesBySource,
  createCommissionEntry,
  countActivePartnerAttributions,
  sumGeneratedCommissionsForPartner,
  createRankEvaluation,
  closeActiveRankHistory,
  createRankHistory
} = require('../repositories/partners.repository');
const { provisionCleanClinicForExternalTenant } = require('../repositories/tenant.repository');
const {
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
} = require('../repositories/partner-client-requests.repository');
const {
  saveClientRequestReceipt,
  readClientRequestReceipt
} = require('./partner-client-request-receipts.service');

const PAYMENT_METHODS = new Set(['transfer', 'mercado_pago', 'cash', 'card', 'other']);
const CURRENCIES = new Set(['ARS', 'USD']);
const EDITABLE_STATUSES = new Set(['draft', 'changes_requested']);
const PARTNER_CANCEL_STATUSES = new Set(['draft', 'pending_review', 'changes_requested']);
const TRANSITIONS = new Map([
  ['draft', new Set(['pending_review', 'cancelled'])],
  ['pending_review', new Set(['approved', 'rejected', 'changes_requested', 'cancelled'])],
  ['changes_requested', new Set(['pending_review', 'cancelled'])]
]);
const ADMIN_REVIEW_AUDIT_ACTIONS = {
  approved: 'partner_client_request_approved',
  rejected: 'partner_client_request_rejected',
  changes_requested: 'partner_client_request_changes_requested'
};
const CLIENT_REQUEST_ACTIVATION_SOURCE = 'partner_client_request';
const CLIENT_REQUEST_SIGNUP_EVENT = 'subscription_signup_accredited';
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizePhone(value) {
  return normalizeString(value).replace(/[^\d]+/g, '');
}

function normalizeTaxId(value) {
  return normalizeString(value).replace(/[^\da-zA-Z]+/g, '').toUpperCase() || null;
}

function normalizePaymentReference(value) {
  return normalizeString(value).toLowerCase().replace(/\s+/g, '') || null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizeString(value));
}

function logPartnerIdentityTrace(payload = {}) {
  if (!payload.traceId) return;
  console.info('partner_identity_trace', {
    event: 'partner_identity_trace',
    layer: 'client_requests_service',
    lookupTable: 'partner_accounts',
    ...payload
  });
}

function parsePositiveMoney(value) {
  const normalized = normalizeString(value).replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number.toFixed(2);
}

function parseMoneyToCents(value) {
  const normalized = normalizeString(value).replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [wholePart, decimalPart = ''] = normalized.split('.');
  const cents = (BigInt(wholePart) * 100n) + BigInt((decimalPart + '00').slice(0, 2));
  if (cents > MAX_SAFE_INTEGER_BIGINT) return null;
  return Number(cents);
}

function centsToMoney(cents) {
  const safe = BigInt(Number(cents) || 0);
  return `${safe / 100n}.${String(Number(safe % 100n)).padStart(2, '0')}`;
}

function parsePercentToBasisPoints(value) {
  return parseMoneyToCents(value);
}

function basisPointsToPercentString(basisPoints) {
  return centsToMoney(basisPoints);
}

function calculateCommissionAmountCents(baseCents, rateBasisPoints) {
  const rounded = ((BigInt(baseCents) * BigInt(rateBasisPoints)) + 5000n) / 10000n;
  if (rounded > MAX_SAFE_INTEGER_BIGINT) throw new Error('partner_commission_amount_out_of_range');
  return Number(rounded);
}

function buildPeriodKey(eventAt) {
  const date = new Date(eventAt);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function resolveRequestConfirmedAmount(request, fallbackAmount) {
  return parsePositiveMoney(
    fallbackAmount ||
    (request && request.paymentConfirmation && request.paymentConfirmation.amount) ||
    (request && request.commissionSnapshot && request.commissionSnapshot.baseAmount) ||
    (request && request.confirmedAmount)
  );
}

function resolveRequestConfirmedCurrency(request, fallbackCurrency) {
  return normalizeString(
    fallbackCurrency ||
    (request && request.paymentConfirmation && request.paymentConfirmation.currency) ||
    (request && request.commissionSnapshot && request.commissionSnapshot.currency) ||
    (request && request.confirmedCurrency) ||
    'ARS'
  ).toUpperCase();
}

function resolveRequestPaymentMethod(request, fallbackMethod) {
  return normalizeString(
    fallbackMethod ||
    (request && request.paymentConfirmation && request.paymentConfirmation.method) ||
    (request && request.paymentMethod) ||
    'manual_admin'
  );
}

function getPartnerRankCode(partner) {
  return normalizeString(partner && partner.currentRankCode).toLowerCase() || 'asesor';
}

function resolveOwnSignupRule(planVersion, partner) {
  const rules = planVersion && planVersion.rules && typeof planVersion.rules === 'object' ? planVersion.rules : null;
  const rankConfigs = Array.isArray(rules && rules.rankConfigs) ? rules.rankConfigs : [];
  const rankCode = getPartnerRankCode(partner);
  const config = rankConfigs.find((item) => normalizeString(item && item.code).toLowerCase() === rankCode) || rankConfigs[0] || null;
  const rateBasisPoints = parsePercentToBasisPoints(config && config.ownSignupRatePercent);
  if (!config || rateBasisPoints === null) return null;
  return {
    rankCode,
    ruleCode: `own_signup:${normalizeString(config.code).toLowerCase() || rankCode}`,
    rateBasisPoints,
    rate: basisPointsToPercentString(rateBasisPoints)
  };
}

function resolveRankThresholds(planVersion) {
  const rules = planVersion && planVersion.rules && typeof planVersion.rules === 'object' ? planVersion.rules : null;
  const thresholds = Array.isArray(rules && rules.rankThresholds) ? rules.rankThresholds : [];
  const rankConfigs = Array.isArray(rules && rules.rankConfigs) ? rules.rankConfigs : [];
  const source = thresholds.length > 0
    ? thresholds
    : rankConfigs.map((config) => ({ code: config.code, minActiveClients: 0, minGeneratedCommission: '0.00' }));
  return source.map((threshold) => ({
    code: normalizeString(threshold && threshold.code).toLowerCase(),
    minActiveClients: Math.max(0, Number(threshold && threshold.minActiveClients) || 0),
    minGeneratedCommission: parseMoneyToCents(threshold && threshold.minGeneratedCommission) === null
      ? '0.00'
      : centsToMoney(parseMoneyToCents(threshold && threshold.minGeneratedCommission))
  })).filter((threshold) => threshold.code);
}

async function evaluatePartnerCareerAfterActivation(partnerId, planVersion, actorStaffUserId, client) {
  const thresholds = resolveRankThresholds(planVersion);
  if (thresholds.length === 0) return null;
  const now = new Date().toISOString();
  const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const activeClients = await countActivePartnerAttributions(partnerId, client);
  const generatedCommission = await sumGeneratedCommissionsForPartner(partnerId, windowStart, now, client);
  let currentRank = thresholds[0];
  let nextRank = null;
  const generatedCommissionCents = parseMoneyToCents(generatedCommission) || 0;

  for (let index = 0; index < thresholds.length; index += 1) {
    const threshold = thresholds[index];
    const thresholdCommissionCents = parseMoneyToCents(threshold.minGeneratedCommission) || 0;
    if (activeClients >= threshold.minActiveClients && generatedCommissionCents >= thresholdCommissionCents) {
      currentRank = threshold;
      nextRank = thresholds[index + 1] || null;
    }
  }

  const evaluation = await createRankEvaluation({
    partnerId,
    planVersionId: planVersion.id,
    currentRankCode: currentRank.code,
    nextRankCode: nextRank ? nextRank.code : null,
    metrics: {
      activeClients,
      generatedCommission: centsToMoney(generatedCommissionCents),
      thresholdMatched: currentRank,
      event: 'client_request_processed'
    },
    windowStart,
    windowEnd: now,
    evaluatedAt: now,
    createdByStaffUserId: actorStaffUserId || null
  }, client);
  await closeActiveRankHistory(partnerId, evaluation.evaluatedAt, client);
  await createRankHistory({
    partnerId,
    rankCode: currentRank.code,
    effectiveFrom: evaluation.evaluatedAt,
    evaluationId: evaluation.id,
    notes: 'client_request_processed',
    createdByStaffUserId: actorStaffUserId || null
  }, client);
  return evaluation;
}

async function ensureOwnSignupCommissionForClientRequest(input, client) {
  const {
    request,
    partner,
    planVersion,
    attributionId,
    clinicId,
    externalTenantId,
    actorStaffUserId,
    confirmedAmount,
    confirmedCurrency,
    paymentMethod,
    tenantCreated
  } = input || {};

  if (!request || !request.id) return { ok: false, reason: 'client_request_not_found' };
  const baseAmount = resolveRequestConfirmedAmount(request, confirmedAmount);
  if (!baseAmount) return { ok: false, reason: 'invalid_confirmed_amount' };
  const currency = resolveRequestConfirmedCurrency(request, confirmedCurrency);
  if (!CURRENCIES.has(currency)) return { ok: false, reason: 'invalid_confirmed_currency' };
  if (!attributionId) return { ok: false, reason: 'client_request_missing_attribution' };
  if (!clinicId) return { ok: false, reason: 'client_request_missing_linked_tenant' };
  if (!externalTenantId) return { ok: false, reason: 'client_request_missing_external_tenant' };
  if (!planVersion) return { ok: false, reason: 'partner_commission_plan_version_not_found' };
  if (normalizeString(planVersion.currency).toUpperCase() !== currency) {
    return { ok: false, reason: 'partner_commission_currency_mismatch' };
  }

  const rule = resolveOwnSignupRule(planVersion, partner);
  if (!rule) return { ok: false, reason: 'partner_commission_rule_not_found' };
  const baseCents = parseMoneyToCents(baseAmount);
  if (baseCents === null) return { ok: false, reason: 'invalid_confirmed_amount' };
  const commissionAmount = centsToMoney(calculateCommissionAmountCents(baseCents, rule.rateBasisPoints));
  const sourceRef = request.id;
  const sourceEventId = request.id;
  const existingEntries = await findCommissionEntriesBySource(CLIENT_REQUEST_ACTIVATION_SOURCE, sourceRef, sourceEventId, client);
  const existingOwnSignup = existingEntries.find((entry) => entry.payoutKind === 'own_signup' && entry.status === 'generated');
  if (existingOwnSignup) {
    return {
      ok: true,
      commissionEntry: existingOwnSignup,
      baseAmount,
      currency,
      rule,
      commissionAmount: existingOwnSignup.commissionAmount || commissionAmount,
      alreadyExisted: true
    };
  }

  const eventAt = (request.paymentConfirmation && request.paymentConfirmation.confirmedAt) || request.processedAt || new Date().toISOString();
  const commissionEntry = await createCommissionEntry({
    partnerId: request.partnerId,
    attributionId,
    planVersionId: planVersion.id,
    clinicId,
    tenantId: externalTenantId,
    sourceType: CLIENT_REQUEST_ACTIVATION_SOURCE,
    sourceRef,
    sourceEventId,
    eventType: CLIENT_REQUEST_SIGNUP_EVENT,
    eventAt,
    periodKey: buildPeriodKey(eventAt),
    currency,
    planCodeSnapshot: planVersion.planCode,
    planVersionNumberSnapshot: planVersion.versionNumber,
    payoutKind: 'own_signup',
    paymentStatus: 'accredited',
    status: 'generated',
    basisAmount: baseAmount,
    commissionRate: rule.rate,
    commissionAmount,
    depthLevel: 0,
    idempotencyKey: `${CLIENT_REQUEST_ACTIVATION_SOURCE}:${request.id}:own_signup:${request.partnerId}`,
    details: {
      requestId: request.id,
      clientName: request.clientName,
      planCode: request.planCode || null,
      ruleCode: rule.ruleCode,
      partnerRankCode: rule.rankCode,
      tenantCreated: Boolean(tenantCreated),
      paymentConfirmationMethod: resolveRequestPaymentMethod(request, paymentMethod),
      basisSource: 'confirmed_amount'
    },
    createdByStaffUserId: actorStaffUserId || null
  }, client);

  return {
    ok: true,
    commissionEntry,
    baseAmount,
    currency,
    rule,
    commissionAmount,
    alreadyExisted: false
  };
}

function normalizeDate(value) {
  const raw = normalizeString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return raw;
}

function normalizePayload(payload = {}) {
  const clientName = normalizeString(payload.clientName);
  const email = normalizeEmail(payload.email);
  const phone = normalizeString(payload.phone);
  const normalizedPhone = normalizePhone(phone);
  const paymentMethod = normalizeString(payload.paymentMethod).toLowerCase();
  const reportedAmount = parsePositiveMoney(payload.reportedAmount);
  const reportedCurrency = normalizeString(payload.reportedCurrency || 'ARS').toUpperCase();
  const reportedPaymentDate = normalizeDate(payload.reportedPaymentDate);

  if (!clientName) return { ok: false, reason: 'missing_client_name' };
  if (!email || !email.includes('@')) return { ok: false, reason: 'invalid_client_email' };
  if (!phone || normalizedPhone.length < 6) return { ok: false, reason: 'invalid_client_phone' };
  if (!PAYMENT_METHODS.has(paymentMethod)) return { ok: false, reason: 'invalid_payment_method' };
  if (!reportedAmount) return { ok: false, reason: 'invalid_reported_amount' };
  if (!CURRENCIES.has(reportedCurrency)) return { ok: false, reason: 'invalid_reported_currency' };
  if (!reportedPaymentDate) return { ok: false, reason: 'invalid_reported_payment_date' };

  const normalizedEmail = normalizeEmail(email);
  const normalizedTaxId = normalizeTaxId(payload.taxId);
  const normalizedPaymentReference = normalizePaymentReference(payload.paymentReference);

  return {
    ok: true,
    data: {
      clientName,
      businessName: normalizeString(payload.businessName) || null,
      email,
      normalizedEmail,
      phone,
      normalizedPhone,
      taxId: normalizeString(payload.taxId) || null,
      normalizedTaxId,
      planCode: normalizeString(payload.planCode) || null,
      paymentMethod,
      reportedAmount,
      reportedCurrency,
      reportedPaymentDate,
      paymentReference: normalizeString(payload.paymentReference) || null,
      normalizedPaymentReference,
      notes: normalizeString(payload.notes) || null
    }
  };
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS.get(from) && TRANSITIONS.get(from).has(to));
}

function summarizeDuplicates(request, requestMatches, clientMatches) {
  const warnings = [];
  for (const match of requestMatches || []) {
    if (request.normalizedEmail && normalizeEmail(match.email) === request.normalizedEmail) warnings.push('Existe otra solicitud con este email.');
    if (request.normalizedPhone && normalizePhone(match.phone) === request.normalizedPhone) warnings.push('Existe otra solicitud con este telefono.');
    if (request.normalizedTaxId && normalizeTaxId(match.taxId) === request.normalizedTaxId) warnings.push('Existe otra solicitud con este CUIT/DNI.');
    if (request.normalizedPaymentReference && normalizePaymentReference(match.paymentReference) === request.normalizedPaymentReference) warnings.push('La referencia de pago ya aparece en otra solicitud.');
    if (request.receipt && request.receipt.sha256 && match.receiptSha256 === request.receipt.sha256) warnings.push('Este comprobante podria haber sido cargado anteriormente.');
  }
  for (const match of clientMatches || []) {
    if (request.normalizedEmail && normalizeEmail(match.email) === request.normalizedEmail) warnings.push('El email coincide con un cliente existente.');
    if (request.normalizedPhone && normalizePhone(match.phone) === request.normalizedPhone) warnings.push('El telefono coincide con un cliente existente.');
  }
  return Array.from(new Set(warnings));
}

async function buildDuplicateWarnings(request, client = null) {
  const [requestMatches, clientMatches] = await Promise.all([
    findPartnerClientRequestDuplicates({
      normalizedEmail: request.normalizedEmail,
      normalizedPhone: request.normalizedPhone,
      normalizedTaxId: request.normalizedTaxId,
      normalizedPaymentReference: request.normalizedPaymentReference,
      receiptSha256: request.receipt && request.receipt.sha256,
      excludeRequestId: request.id
    }, client),
    findExistingClientDuplicates({
      normalizedEmail: request.normalizedEmail,
      normalizedPhone: request.normalizedPhone
    }, client)
  ]);
  return summarizeDuplicates(request, requestMatches, clientMatches);
}

async function auditClientRequest(input, client = null) {
  return createPartnerAuditLog({
    partnerId: input.partnerId,
    entityType: 'partner_client_request',
    entityId: input.requestId,
    action: input.action,
    reason: input.reason || null,
    actorType: input.actorType,
    actorStaffUserId: input.actorStaffUserId || null,
    actorPartnerId: input.actorPartnerId || null,
    metadata: {
      previousStatus: input.previousStatus || null,
      nextStatus: input.nextStatus || null,
      duplicateWarnings: input.duplicateWarnings || []
    }
  }, client);
}

async function assertPartnerExists(partnerId, client = null, trace = {}) {
  if (!isUuid(partnerId)) {
    logPartnerIdentityTrace({
      ...trace,
      repositoryLookupId: partnerId || null,
      found: false,
      active: false
    });
    return { ok: false, reason: 'partner_unauthorized' };
  }
  const partner = await findPartnerById(partnerId, client);
  logPartnerIdentityTrace({
    ...trace,
    repositoryLookupId: partnerId,
    found: Boolean(partner),
    active: Boolean(partner && partner.status === 'active')
  });
  if (!partner) return { ok: false, reason: 'partner_identity_invalid' };
  if (partner.status !== 'active') return { ok: false, reason: 'partner_inactive' };
  return { ok: true, partner };
}

async function createRequestForPartner(partnerId, payload, file, trace = {}) {
  const normalized = normalizePayload(payload);
  if (!normalized.ok) return normalized;

  return withTransaction(async (client) => {
    const partnerResult = await assertPartnerExists(partnerId, client, trace);
    if (!partnerResult.ok) return partnerResult;

    const savedReceipt = await saveClientRequestReceipt(partnerId, file);
    if (!savedReceipt.ok) return savedReceipt;

    const request = await createPartnerClientRequest({
      partnerId,
      status: 'draft',
      ...normalized.data,
      ...{
        receiptStorageKey: savedReceipt.receipt.storageKey,
        receiptOriginalName: savedReceipt.receipt.originalName,
        receiptMimeType: savedReceipt.receipt.mimeType,
        receiptSizeBytes: savedReceipt.receipt.sizeBytes,
        receiptSha256: savedReceipt.receipt.sha256
      }
    }, client);
    const duplicateWarnings = await buildDuplicateWarnings(request, client);
    await auditClientRequest({
      partnerId,
      requestId: request.id,
      action: 'partner_client_request_created',
      actorType: 'partner',
      actorPartnerId: partnerId,
      nextStatus: request.status,
      duplicateWarnings
    }, client);
    return { ok: true, request, duplicateWarnings };
  });
}

async function listRequestsForPartner(partnerId, query = {}, trace = {}) {
  const partnerResult = await assertPartnerExists(partnerId, null, trace);
  if (!partnerResult.ok) return partnerResult;
  const result = await listPartnerClientRequests({
    partnerId,
    status: normalizeString(query.status) || null,
    page: query.page,
    pageSize: query.pageSize
  });
  return { ok: true, ...result };
}

async function getRequestForPartner(partnerId, requestId) {
  const request = await findPartnerClientRequestById(requestId);
  if (!request || String(request.partnerId) !== String(partnerId)) return { ok: false, reason: 'client_request_not_found' };
  const duplicateWarnings = await buildDuplicateWarnings(request);
  return { ok: true, request, duplicateWarnings };
}

async function updateRequestForPartner(partnerId, requestId, payload, file) {
  return withTransaction(async (client) => {
    const current = await findPartnerClientRequestById(requestId, client);
    if (!current || String(current.partnerId) !== String(partnerId)) return { ok: false, reason: 'client_request_not_found' };
    if (!EDITABLE_STATUSES.has(current.status)) return { ok: false, reason: 'client_request_not_editable' };
    const normalized = normalizePayload(payload);
    if (!normalized.ok) return normalized;

    let receiptPatch = {};
    if (file) {
      const savedReceipt = await saveClientRequestReceipt(partnerId, file);
      if (!savedReceipt.ok) return savedReceipt;
      receiptPatch = {
        receiptStorageKey: savedReceipt.receipt.storageKey,
        receiptOriginalName: savedReceipt.receipt.originalName,
        receiptMimeType: savedReceipt.receipt.mimeType,
        receiptSizeBytes: savedReceipt.receipt.sizeBytes,
        receiptSha256: savedReceipt.receipt.sha256
      };
    }

    const request = await updatePartnerClientRequest(requestId, {
      ...normalized.data,
      ...receiptPatch
    }, client);
    const duplicateWarnings = await buildDuplicateWarnings(request, client);
    await auditClientRequest({
      partnerId,
      requestId,
      action: current.status === 'changes_requested' ? 'partner_client_request_corrected' : 'partner_client_request_edited',
      actorType: 'partner',
      actorPartnerId: partnerId,
      previousStatus: current.status,
      nextStatus: request.status,
      duplicateWarnings
    }, client);
    return { ok: true, request, duplicateWarnings };
  });
}

async function submitRequestForPartner(partnerId, requestId) {
  return withTransaction(async (client) => {
    const current = await findPartnerClientRequestById(requestId, client);
    if (!current || String(current.partnerId) !== String(partnerId)) return { ok: false, reason: 'client_request_not_found' };
    if (!canTransition(current.status, 'pending_review')) return { ok: false, reason: 'invalid_client_request_transition' };
    if (!current.receipt || !current.receipt.storageKey) return { ok: false, reason: 'missing_client_request_receipt' };
    const duplicateWarnings = await buildDuplicateWarnings(current, client);
    const request = await transitionPartnerClientRequest(requestId, { status: 'pending_review' }, client);
    await auditClientRequest({
      partnerId,
      requestId,
      action: current.status === 'changes_requested' ? 'partner_client_request_resubmitted' : 'partner_client_request_submitted',
      actorType: 'partner',
      actorPartnerId: partnerId,
      previousStatus: current.status,
      nextStatus: request.status,
      duplicateWarnings
    }, client);
    return { ok: true, request, duplicateWarnings };
  });
}

async function cancelRequestForPartner(partnerId, requestId) {
  return withTransaction(async (client) => {
    const current = await findPartnerClientRequestById(requestId, client);
    if (!current || String(current.partnerId) !== String(partnerId)) return { ok: false, reason: 'client_request_not_found' };
    if (!PARTNER_CANCEL_STATUSES.has(current.status)) return { ok: false, reason: 'invalid_client_request_transition' };
    const request = await transitionPartnerClientRequest(requestId, { status: 'cancelled' }, client);
    await auditClientRequest({
      partnerId,
      requestId,
      action: 'partner_client_request_cancelled',
      actorType: 'partner',
      actorPartnerId: partnerId,
      previousStatus: current.status,
      nextStatus: request.status
    }, client);
    return { ok: true, request };
  });
}

async function getReceiptForPartner(partnerId, requestId, actor = {}) {
  const current = await findPartnerClientRequestById(requestId);
  if (!current || String(current.partnerId) !== String(partnerId)) return { ok: false, reason: 'client_request_not_found' };
  const receipt = await readClientRequestReceipt(current.receipt.storageKey);
  if (!receipt.ok) return receipt;
  await auditClientRequest({
    partnerId,
    requestId,
    action: 'partner_client_request_receipt_viewed',
    actorType: actor.actorType || 'partner',
    actorPartnerId: actor.actorPartnerId || partnerId
  });
  return {
    ok: true,
    buffer: receipt.buffer,
    mimeType: current.receipt.mimeType || receipt.mimeType,
    fileName: current.receipt.originalName || 'comprobante'
  };
}

async function listRequestsForAdmin(query = {}) {
  const result = await listPartnerClientRequests({
    status: normalizeString(query.status) || null,
    partnerFilter: isUuid(query.partnerId) ? query.partnerId : null,
    search: normalizeString(query.search) || null,
    from: normalizeString(query.from) || null,
    to: normalizeString(query.to) || null,
    page: query.page,
    pageSize: query.pageSize
  });
  return { ok: true, ...result };
}

async function getRequestForAdmin(requestId) {
  const request = await findPartnerClientRequestById(requestId);
  if (!request) return { ok: false, reason: 'client_request_not_found' };
  const duplicateWarnings = await buildDuplicateWarnings(request);
  return { ok: true, request, duplicateWarnings };
}

async function reviewRequestAsAdmin(requestId, action, payload = {}, actorStaffUserId) {
  const actionMap = {
    approve: 'approved',
    reject: 'rejected',
    request_changes: 'changes_requested'
  };
  const nextStatus = actionMap[normalizeString(action)];
  if (!nextStatus) return { ok: false, reason: 'invalid_client_request_review_action' };

  const adminNotes = normalizeString(payload.adminNotes);
  if ((nextStatus === 'rejected' || nextStatus === 'changes_requested') && !adminNotes) {
    return { ok: false, reason: 'admin_notes_required' };
  }

  return withTransaction(async (client) => {
    const current = await findPartnerClientRequestById(requestId, client);
    if (!current) return { ok: false, reason: 'client_request_not_found' };
    if (!canTransition(current.status, nextStatus)) return { ok: false, reason: 'invalid_client_request_transition' };
    const duplicateWarnings = await buildDuplicateWarnings(current, client);
    const request = await transitionPartnerClientRequest(requestId, {
      status: nextStatus,
      adminNotes: adminNotes || null,
      reviewedBy: actorStaffUserId
    }, client);
    await auditClientRequest({
      partnerId: current.partnerId,
      requestId,
      action: ADMIN_REVIEW_AUDIT_ACTIONS[nextStatus],
      reason: adminNotes || null,
      actorType: 'staff',
      actorStaffUserId,
      previousStatus: current.status,
      nextStatus,
      duplicateWarnings
    }, client);
    return { ok: true, request, duplicateWarnings };
  });
}

async function resolveActivationTenant(request, payload, actorStaffUserId, client) {
  const mode = normalizeString(payload.tenantMode || payload.mode || 'new').toLowerCase();
  if (mode === 'existing') {
    const externalTenantId = normalizeString(payload.existingTenantId || payload.tenantId);
    if (!externalTenantId) return { ok: false, reason: 'missing_existing_tenant_id' };
    const clinic = await findClinicTenantByExternalTenantId(externalTenantId, client);
    if (!clinic) return { ok: false, reason: 'tenant_not_found' };
    return { ok: true, clinic, externalTenantId: clinic.externalTenantId, created: false };
  }

  const externalTenantId = normalizeString(payload.newTenantId) || randomUUID();
  const clinic = await provisionCleanClinicForExternalTenant({
    externalTenantId,
    name: normalizeString(payload.tenantName) || request.businessName || request.clientName,
    timezone: normalizeString(payload.timezone) || 'America/Argentina/Buenos_Aires'
  }, client);
  return { ok: true, clinic, externalTenantId: clinic.externalTenantId, created: true };
}

async function processApprovedRequestAsAdmin(requestId, payload = {}, actorStaffUserId) {
  const actorId = isUuid(actorStaffUserId) ? actorStaffUserId : null;
  if (!actorId) return { ok: false, reason: 'partner_admin_unauthorized' };
  if (payload.paymentConfirmed !== true) return { ok: false, reason: 'payment_confirmation_required' };

  const confirmedAmount = parsePositiveMoney(payload.confirmedAmount || payload.amount);
  const confirmedCurrency = normalizeString(payload.confirmedCurrency || payload.currency || 'ARS').toUpperCase();
  const paymentMethod = normalizeString(payload.paymentMethod || payload.method || 'manual_admin');
  const paymentReference = normalizeString(payload.paymentReference || payload.reference) || null;
  const paymentNotes = normalizeString(payload.paymentNotes || payload.notes) || null;
  if (!confirmedAmount) return { ok: false, reason: 'invalid_confirmed_amount' };
  if (!CURRENCIES.has(confirmedCurrency)) return { ok: false, reason: 'invalid_confirmed_currency' };

  return withTransaction(async (client) => {
    const request = await findPartnerClientRequestByIdForUpdate(requestId, client);
    if (!request) return { ok: false, reason: 'client_request_not_found' };
    if (request.processingStatus === 'processed') {
      const existingEntries = await findCommissionEntriesBySource(CLIENT_REQUEST_ACTIVATION_SOURCE, request.id, request.id, client);
      const existingOwnSignup = existingEntries.find((entry) => entry.payoutKind === 'own_signup' && entry.status === 'generated');
      if (existingOwnSignup && request.commissionEntryId) {
        return { ok: true, request, commissionEntry: existingOwnSignup, alreadyProcessed: true };
      }

      const partner = await findPartnerById(request.partnerId, client);
      if (!partner) return { ok: false, reason: 'partner_not_found' };
      const planVersion = await findPublishedCommissionPlanVersion(null, client);
      if (!planVersion) return { ok: false, reason: 'partner_commission_plan_version_not_found' };
      const commissionResult = await ensureOwnSignupCommissionForClientRequest({
        request,
        partner,
        planVersion,
        attributionId: request.attributionId,
        clinicId: request.linkedTenantId,
        externalTenantId: request.linkedExternalTenantId,
        actorStaffUserId: actorId,
        confirmedAmount,
        confirmedCurrency,
        paymentMethod,
        tenantCreated: false
      }, client);
      if (!commissionResult.ok) return commissionResult;

      const repaired = await markPartnerClientRequestProcessed(request.id, {
        paymentConfirmedAt: request.paymentConfirmation && request.paymentConfirmation.confirmedAt,
        paymentConfirmedBy: (request.paymentConfirmation && request.paymentConfirmation.confirmedBy) || actorId,
        paymentConfirmationMethod: resolveRequestPaymentMethod(request, paymentMethod),
        confirmedAmount: commissionResult.baseAmount,
        confirmedCurrency: commissionResult.currency,
        paymentConfirmationReference: request.paymentConfirmation && request.paymentConfirmation.reference,
        paymentConfirmationNotes: request.paymentConfirmation && request.paymentConfirmation.notes,
        linkedTenantId: request.linkedTenantId,
        linkedExternalTenantId: request.linkedExternalTenantId,
        attributionId: request.attributionId,
        commissionEntryId: commissionResult.commissionEntry.id,
        processedBy: request.processedBy || actorId,
        commissionBaseAmount: commissionResult.baseAmount,
        commissionCurrency: commissionResult.currency,
        commissionRate: commissionResult.rule.rate,
        commissionAmount: commissionResult.commissionAmount,
        commissionRuleCode: commissionResult.rule.ruleCode,
        metadata: {
          activation: {
            commissionPlanVersionId: planVersion.id,
            commissionPlanCode: planVersion.planCode,
            commissionPlanVersionNumber: planVersion.versionNumber,
            commissionRepaired: !commissionResult.alreadyExisted
          }
        }
      }, client);

      return {
        ok: true,
        request: repaired,
        commissionEntry: commissionResult.commissionEntry,
        alreadyProcessed: true,
        commissionRepaired: !commissionResult.alreadyExisted
      };
    }
    if (request.status !== 'approved') return { ok: false, reason: 'client_request_not_approved' };

    const partner = await findPartnerById(request.partnerId, client);
    if (!partner) return { ok: false, reason: 'partner_not_found' };
    if (partner.status !== 'active') return { ok: false, reason: 'partner_not_active' };

    const tenantResult = await resolveActivationTenant(request, payload, actorId, client);
    if (!tenantResult.ok) return tenantResult;

    const existingAttribution = await findActiveAttributionByTenantId(tenantResult.externalTenantId, client);
    if (existingAttribution && String(existingAttribution.partnerId) !== String(request.partnerId)) {
      return { ok: false, reason: 'tenant_already_attributed', partnerId: existingAttribution.partnerId };
    }

    const attribution = existingAttribution || await createPartnerAttribution({
      partnerId: request.partnerId,
      clinicId: tenantResult.clinic.id,
      tenantId: tenantResult.externalTenantId,
      attributionSource: 'partner_client_request',
      notes: `sourceRequestId:${request.id}`,
      attributedAt: new Date().toISOString(),
      createdByStaffUserId: actorId
    }, client);

    const planVersion = await findPublishedCommissionPlanVersion(null, client);
    if (!planVersion) return { ok: false, reason: 'partner_commission_plan_version_not_found' };
    if (normalizeString(planVersion.currency).toUpperCase() !== confirmedCurrency) {
      return { ok: false, reason: 'partner_commission_currency_mismatch' };
    }

    const eventAt = new Date().toISOString();
    const commissionResult = await ensureOwnSignupCommissionForClientRequest({
      request: {
        ...request,
        paymentConfirmation: {
          ...(request.paymentConfirmation || {}),
          confirmedAt: eventAt,
          amount: confirmedAmount,
          currency: confirmedCurrency,
          method: paymentMethod
        }
      },
      partner,
      planVersion,
      attributionId: attribution.id,
      clinicId: tenantResult.clinic.id,
      externalTenantId: tenantResult.externalTenantId,
      actorStaffUserId: actorId,
      confirmedAmount,
      confirmedCurrency,
      paymentMethod,
      tenantCreated: tenantResult.created
    }, client);
    if (!commissionResult.ok) return commissionResult;
    const { commissionEntry, rule, commissionAmount } = commissionResult;

    const processed = await markPartnerClientRequestProcessed(request.id, {
      paymentConfirmedAt: eventAt,
      paymentConfirmedBy: actorId,
      paymentConfirmationMethod: paymentMethod,
      confirmedAmount,
      confirmedCurrency,
      paymentConfirmationReference: paymentReference,
      paymentConfirmationNotes: paymentNotes,
      linkedTenantId: tenantResult.clinic.id,
      linkedExternalTenantId: tenantResult.externalTenantId,
      attributionId: attribution.id,
      commissionEntryId: commissionEntry.id,
      processedBy: actorId,
      commissionBaseAmount: confirmedAmount,
      commissionCurrency: confirmedCurrency,
      commissionRate: rule.rate,
      commissionAmount,
      commissionRuleCode: rule.ruleCode,
      metadata: {
        activation: {
          tenantMode: tenantResult.created ? 'new' : 'existing',
          commissionPlanVersionId: planVersion.id,
          commissionPlanCode: planVersion.planCode,
          commissionPlanVersionNumber: planVersion.versionNumber
        }
      }
    }, client);

    const careerEvaluation = await evaluatePartnerCareerAfterActivation(request.partnerId, planVersion, actorId, client);

    await auditClientRequest({
      partnerId: request.partnerId,
      requestId: request.id,
      action: 'partner_client_request_processed',
      actorType: 'staff',
      actorStaffUserId: actorId,
      previousStatus: request.status,
      nextStatus: processed.status,
      reason: 'payment_confirmed'
    }, client);
    await createPartnerAuditLog({
      partnerId: request.partnerId,
      tenantId: tenantResult.externalTenantId,
      entityType: 'partner_client_activation',
      entityId: request.id,
      action: 'partner_client_request_activation_completed',
      reason: 'payment_confirmed',
      actorType: 'staff',
      actorStaffUserId: actorId,
      metadata: {
        attributionId: attribution.id,
        commissionEntryId: commissionEntry.id,
        commissionAmount,
        commissionRate: rule.rate,
        commissionBaseAmount: confirmedAmount,
        careerEvaluationId: careerEvaluation ? careerEvaluation.id : null
      }
    }, client);

    return {
      ok: true,
      request: processed,
      tenant: tenantResult.clinic,
      attribution,
      commissionEntry,
      careerEvaluation,
      alreadyProcessed: false
    };
  }).catch(async (error) => {
    try {
      await markPartnerClientRequestProcessingFailed(requestId, error && error.message ? error.message : 'client_request_processing_failed');
    } catch {}
    throw error;
  });
}

async function getReceiptForAdmin(requestId, actorStaffUserId) {
  const current = await findPartnerClientRequestById(requestId);
  if (!current) return { ok: false, reason: 'client_request_not_found' };
  const receipt = await readClientRequestReceipt(current.receipt.storageKey);
  if (!receipt.ok) return receipt;
  await auditClientRequest({
    partnerId: current.partnerId,
    requestId,
    action: 'partner_client_request_receipt_viewed',
    actorType: 'staff',
    actorStaffUserId
  });
  return {
    ok: true,
    buffer: receipt.buffer,
    mimeType: current.receipt.mimeType || receipt.mimeType,
    fileName: current.receipt.originalName || 'comprobante'
  };
}

module.exports = {
  createRequestForPartner,
  listRequestsForPartner,
  getRequestForPartner,
  updateRequestForPartner,
  submitRequestForPartner,
  cancelRequestForPartner,
  getReceiptForPartner,
  listRequestsForAdmin,
  getRequestForAdmin,
  reviewRequestAsAdmin,
  processApprovedRequestAsAdmin,
  getReceiptForAdmin,
  normalizePayload,
  canTransition
};
