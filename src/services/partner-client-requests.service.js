const { withTransaction } = require('../db/client');
const { findPartnerById, createPartnerAuditLog } = require('../repositories/partners.repository');
const {
  createPartnerClientRequest,
  updatePartnerClientRequest,
  transitionPartnerClientRequest,
  findPartnerClientRequestById,
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(normalizeString(value));
}

function parsePositiveMoney(value) {
  const normalized = normalizeString(value).replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number.toFixed(2);
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

async function assertPartnerExists(partnerId, client = null) {
  if (!isUuid(partnerId)) return { ok: false, reason: 'partner_not_found' };
  const partner = await findPartnerById(partnerId, client);
  if (!partner) return { ok: false, reason: 'partner_not_found' };
  if (partner.status !== 'active') return { ok: false, reason: 'partner_inactive' };
  return { ok: true, partner };
}

async function createRequestForPartner(partnerId, payload, file) {
  const normalized = normalizePayload(payload);
  if (!normalized.ok) return normalized;

  return withTransaction(async (client) => {
    const partnerResult = await assertPartnerExists(partnerId, client);
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

async function listRequestsForPartner(partnerId, query = {}) {
  const partnerResult = await assertPartnerExists(partnerId);
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
  getReceiptForAdmin,
  normalizePayload,
  canTransition
};
