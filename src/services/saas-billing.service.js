const { randomUUID } = require('crypto');
const { withTransaction } = require('../db/client');
const { requireGeneration } = require('../repositories/saas-billing-runtime.repository');
async function withBillingTransaction(fn) {
  return withTransaction(async client => {
    await requireGeneration(2, client, { lock: true });
    return fn(client);
  });
}
const { findClinicByExternalTenantId } = require('../repositories/tenant.repository');
const {
  insertSaasSubscription,
  findBlockingSaasSubscriptions,
  claimSaasSubscriptionProviderCall,
  markSaasSubscriptionReconciliationRequired,
  updateSaasSubscriptionById,
  findSaasSubscriptionById,
  findLatestSaasSubscriptionByTenantId,
  findSaasSubscriptionByPreapprovalId,
  listSaasSubscriptions
} = require('../repositories/saas-subscriptions.repository');
const {
  createPreapproval,
  getPreapproval,
  getPreapprovalPlan,
  signedDeliveryIdentity,
  pausePreapproval,
  cancelPreapproval,
  reactivatePreapproval,
  getPayment,
  getAuthorizedPayment,
  searchAuthorizedPaymentsByPaymentId,
  mapMercadoPagoPreapprovalStatus,
  mapMercadoPagoPaymentStatus
} = require('./mercado-pago.service');
const { resolveSaasPlanDefinition } = require('./saas-billing-plans.service');
const { captureLocalBillingContract, resolveLocalBillingContract, canonicalizeExternalReferenceUuid } = require('./saas-billing-contract');
const { contractRejected, manualReview } = require('./saas-billing-webhook-outcomes');
const contractProof = require('./saas-billing-provider-contract');
const { reserveEffect } = require('./saas-billing-effects');
const { processSubscriptionWebhookEvent } = require('./saas-billing-webhook-claims');
const { sendBillingSubscriptionAuthorizationEmail } = require('./saas-billing-email.service');
const { logError, logInfo } = require('../utils/logger');

const ALLOWED_PLAN_CODES = new Set(['inicial', 'crecimiento', 'empresa']);
const ALLOWED_LOCAL_STATUSES = new Set(['pending', 'active', 'paused', 'canceled', 'payment_failed', 'suspended']);
const TENANT_PLAN_MAP = Object.freeze({
  inicial: 'basic',
  crecimiento: 'growth',
  empresa: 'enterprise'
});

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  const email = normalizeString(value).toLowerCase();
  return email && email.includes('@') ? email : null;
}

function normalizePlanCode(value) {
  const code = normalizeString(value).toLowerCase();
  return ALLOWED_PLAN_CODES.has(code) ? code : null;
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Number(amount.toFixed(2));
}

function normalizeCurrency(value) {
  return normalizeString(value).toUpperCase() || 'ARS';
}

function planLabel(planCode) {
  const definition = resolveSaasPlanDefinition(planCode);
  return definition ? definition.label : normalizeString(planCode) || 'Plan Opturon';
}

function maskEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  return `${local.slice(0, 2) || '*'}***@${domain}`;
}

function parseSettings(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toIsoDate(value) {
  const text = normalizeString(value);
  return text || null;
}

function deriveTenantLifecycleStatus(localStatus) {
  if (localStatus === 'active') return 'active';
  if (localStatus === 'pending') return 'trial';
  if (localStatus === 'suspended' || localStatus === 'canceled') return 'suspended';
  if (localStatus === 'paused' || localStatus === 'payment_failed') return 'at_risk';
  return 'trial';
}

function buildTenantBillingSnapshot(subscription) {
  return {
    provider: 'mercado_pago',
    subscriptionId: subscription.id,
    preapprovalId: subscription.mercadoPagoPreapprovalId,
    status: subscription.localStatus,
    mercadoPagoStatus: subscription.mercadoPagoStatus,
    planCode: subscription.planCode,
    amount: subscription.amount,
    currency: subscription.currency,
    billingInterval: subscription.billingInterval,
    payerEmail: subscription.mercadoPagoPayerEmail,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    nextBillingDate: subscription.nextBillingDate,
    lastPaymentId: subscription.lastPaymentId,
    lastPaymentStatus: subscription.lastPaymentStatus,
    authorizationUrl: subscription.authorizationUrl,
    externalReference: subscription.externalReference,
    updatedAt: subscription.updatedAt
  };
}

async function syncTenantBillingState(client, clinic, subscription) {
  const settings = parseSettings(clinic.settings);
  const portal = settings.portal && typeof settings.portal === 'object' ? { ...settings.portal } : {};
  const policy = portal.policy && typeof portal.policy === 'object' ? { ...portal.policy } : {};
  const lifecycle = portal.lifecycle && typeof portal.lifecycle === 'object' ? { ...portal.lifecycle } : {};
  const billing = portal.billing && typeof portal.billing === 'object' ? { ...portal.billing } : {};

  const mappedPlanCode = TENANT_PLAN_MAP[subscription.planCode] || policy.planCode || 'basic';
  policy.planCode = mappedPlanCode;
  lifecycle.status = deriveTenantLifecycleStatus(subscription.localStatus);
  billing.status = subscription.localStatus;
  billing.subscription = buildTenantBillingSnapshot(subscription);

  const nextSettings = {
    ...settings,
    portal: {
      ...portal,
      policy,
      lifecycle,
      billing
    }
  };

  await client.query(
    `UPDATE clinics
     SET settings = $2::jsonb,
         "updatedAt" = NOW()
     WHERE id = $1::uuid`,
    [clinic.id, JSON.stringify(nextSettings)]
  );
}

function mapPreapprovalToSubscriptionPatch(preapproval) {
  const autoRecurring = preapproval && preapproval.auto_recurring && typeof preapproval.auto_recurring === 'object'
    ? preapproval.auto_recurring
    : {};
  const amount = autoRecurring.transaction_amount === undefined || autoRecurring.transaction_amount === null
    ? null
    : Number(autoRecurring.transaction_amount);
  return {
    amount: Number.isFinite(amount) ? amount : null,
    currency: normalizeCurrency(autoRecurring.currency_id),
    mercadoPagoPreapprovalId: normalizeString(preapproval && preapproval.id) || null,
    mercadoPagoPayerEmail: normalizeEmail(preapproval && preapproval.payer_email),
    mercadoPagoStatus: normalizeString(preapproval && preapproval.status).toLowerCase() || null,
    localStatus: mapMercadoPagoPreapprovalStatus(preapproval && preapproval.status),
    currentPeriodStart: toIsoDate(autoRecurring.start_date),
    currentPeriodEnd: toIsoDate(autoRecurring.end_date),
    nextBillingDate: toIsoDate(preapproval && (preapproval.next_payment_date || preapproval.next_date || autoRecurring.next_payment_date)),
    authorizationUrl:
      normalizeString(preapproval && preapproval.init_point) ||
      normalizeString(preapproval && preapproval.sandbox_init_point) ||
      normalizeString(preapproval && preapproval.authorization_url) ||
      null,
    metadata: {
      mercadoPagoPreapproval: preapproval || {}
    }
  };
}

function buildPreapprovalReason(planCode, tenantId) {
  return `Opturon ${planCode} - ${tenantId}`;
}

function buildExternalReference(tenantId, subscriptionId) {
  return `opturon:${tenantId}:${subscriptionId}`;
}

function sanitizeMercadoPagoErrorBody(body) {
  if (!body || typeof body !== 'object') return body || null;
  const safe = {};
  for (const [key, value] of Object.entries(body)) {
    if (key.toLowerCase().includes('token')) continue;
    safe[key] = value;
  }
  return safe;
}

function existingCreationResult(subscription) {
  // Legacy NULL state is never safe to resume, even with no provider ID.
  if (subscription && subscription.localStatus === 'pending'
    && subscription.mercadoPagoPreapprovalId && subscription.authorizationUrl
    && (!subscription.provisioningState || subscription.provisioningState === 'ready')) {
    return { ok: true, subscription, reused: true };
  }
  const unfinished = subscription && subscription.provisioningState
    && subscription.provisioningState !== 'ready';
  return {
    ok: false,
    reason: unfinished ? 'subscription_provisioning_requires_reconciliation' : 'subscription_already_exists',
    status: 409
  };
}

async function finishSubscriptionProvisioning(subscriptionId) {
  const subscription = await withBillingTransaction(async (client) => {
    const current = await findSaasSubscriptionById(subscriptionId, client, { forUpdate: true });
    if (current && current.provisioningState === 'ready') return current;
    if (!current || current.provisioningState !== 'provider_created' || !current.mercadoPagoPreapprovalId) {
      throw new Error('subscription_provisioning_not_ready');
    }
    // Match the webhook lock order: subscription, then clinic. Use fresh settings.
    const clinic = await findClinicByExternalTenantId(current.externalTenantId, client, { forUpdate: true });
    if (!clinic) throw new Error('tenant_not_found');
    const ready = await updateSaasSubscriptionById(current.id, { provisioningState: 'ready' }, client);
    await syncTenantBillingState(client, clinic, ready);
    return ready;
  });
  return { ok: true, subscription };
}

async function createSaasSubscriptionForTenant(input) {
  const tenantId = normalizeString(input.tenantId);
  const planCode = normalizePlanCode(input.planCode);
  const payerEmail = normalizeEmail(input.payerEmail);
  const planDefinition = resolveSaasPlanDefinition(planCode);
  const amount = planDefinition ? normalizeAmount(planDefinition.amount) : null;
  const currency = planDefinition ? normalizeCurrency(planDefinition.currency) : 'ARS';

  if (!tenantId) return { ok: false, reason: 'missing_tenant_id', status: 400 };
  if (!planCode) return { ok: false, reason: 'invalid_plan_code', status: 400 };
  if (!planDefinition) return { ok: false, reason: 'plan_definition_not_found', status: 400 };
  if (!payerEmail) return { ok: false, reason: 'invalid_payer_email', status: 400 };
  if (!amount) return { ok: false, reason: 'invalid_amount', status: 400 };

  // Transaction A must COMMIT before a provider call can even be claimed.
  const reservation = await withBillingTransaction(async (client) => {
    const clinic = await findClinicByExternalTenantId(tenantId, client, { forUpdate: true });
    if (!clinic) return { ok: false, reason: 'tenant_not_found', status: 404 };
    const existing = await findBlockingSaasSubscriptions(clinic.id, clinic.externalTenantId, client);
    if (existing.length > 1) {
      return { ok: false, reason: 'subscription_multiple_non_terminal', status: 409 };
    }
    if (existing.length === 1) {
      const subscription = existing[0];
      if (subscription.planCode !== planCode || normalizeEmail(subscription.mercadoPagoPayerEmail) !== payerEmail) {
        return { ok: false, reason: 'subscription_already_exists', status: 409 };
      }
      return { ok: true, subscription };
    }
    const subscriptionId = randomUUID();
    const externalReference = buildExternalReference(clinic.externalTenantId, subscriptionId);
    const contract = captureLocalBillingContract({
      plan: planDefinition, subscriptionId, clinicId: clinic.id,
      externalTenantId: clinic.externalTenantId, externalReference,
      capturedAt: new Date().toISOString()
    });
    const subscription = await insertSaasSubscription({
      id: subscriptionId,
      clinicId: clinic.id,
      externalTenantId: clinic.externalTenantId,
      planCode,
      amount,
      currency,
      billingInterval: 'monthly',
      mercadoPagoPayerEmail: payerEmail,
      localStatus: 'pending',
      provisioningState: 'reserved',
      externalReference,
      metadata: { billingModel: 'pending_link', plan: planDefinition, contract }
    }, client);
    return { ok: true, subscription };
  });
  if (!reservation.ok) return reservation;
  const reserved = reservation.subscription;
  if (reserved.provisioningState === 'provider_created') {
    return finishSubscriptionProvisioning(reserved.id);
  }
  if (reserved.provisioningState !== 'reserved') return existingCreationResult(reserved);

  // Separate durable CAS: exactly one process may POST; an uncertain commit
  // must never trigger a call. A retry can resume only a still-reserved row.
  const claimResult = await withBillingTransaction(async (client) => {
    const current = await findSaasSubscriptionById(reserved.id, client, { forUpdate: true });
    if (!current || current.provisioningState !== 'reserved') return { ok: true, subscription: null };
    // Re-read durable evidence under the claim lock; legacy projections cannot
    // authorize a POST and must never be silently backfilled on retry.
    const resolved = resolveLocalBillingContract(current);
    if (resolved.status !== 'KNOWN' || resolved.source !== 'contract') {
      return { ok: false, reason: 'subscription_contract_required', status: 409 };
    }
    return { ok: true, subscription: await claimSaasSubscriptionProviderCall(current.id, client) };
  });
  if (!claimResult.ok) return claimResult;
  const claimed = claimResult.subscription;
  if (!claimed) return existingCreationResult(await findSaasSubscriptionById(reserved.id));

  let preapproval;
  try {
    preapproval = await createPreapproval({
      reason: buildPreapprovalReason(claimed.metadata.plan.label, claimed.externalTenantId),
      externalReference: claimed.externalReference,
      payerEmail: claimed.mercadoPagoPayerEmail,
      amount: claimed.amount,
      currency: claimed.currency
    });
    if (!normalizeString(preapproval && preapproval.id)) {
      throw new Error('subscription_provider_response_missing_id');
    }
  } catch (error) {
    // Includes timeouts and malformed success: neither proves that MP did not
    // create an object. Keep the durable attempt blocked, without another POST.
    try {
      await withBillingTransaction(client => markSaasSubscriptionReconciliationRequired(claimed.id, client));
    } catch {
      // provider_call_started is already durable and also blocks every retry.
      logError('billing_subscription_reconciliation_update_failed', { subscriptionId: claimed.id });
    }
    logError('billing_subscription_create_mp_failed', {
      subscriptionId: claimed.id,
      mpStatus: Number.isInteger(Number(error && error.status)) ? Number(error.status) : null,
      mpBody: sanitizeMercadoPagoErrorBody(error && error.body)
    });
    throw error;
  }

  // Persist the provider identity independently of policy/snapshot completion.
  // A webhook may already have completed this reservation; never regress it.
  await withBillingTransaction(async (client) => {
    const current = await findSaasSubscriptionById(claimed.id, client, { forUpdate: true });
    if (current.mercadoPagoPreapprovalId && current.mercadoPagoPreapprovalId !== normalizeString(preapproval.id)) {
      throw new Error('subscription_provider_identity_conflict');
    }
    if (current.provisioningState === 'ready') return;
    const initialPatch = mapPreapprovalToSubscriptionPatch(preapproval);
    await updateSaasSubscriptionById(current.id, {
      ...initialPatch,
      amount: initialPatch.amount || current.amount,
      localStatus: current.localStatus,
      provisioningState: 'provider_created'
    }, client);
  });
  return finishSubscriptionProvisioning(claimed.id);
}

async function getSaasSubscriptionDetails(subscriptionId) {
  const subscription = await findSaasSubscriptionById(subscriptionId);
  if (!subscription) return { ok: false, reason: 'subscription_not_found', status: 404 };
  return { ok: true, subscription };
}

async function listSaasSubscriptionsForAdmin(filters = {}) {
  const tenantId = normalizeString(filters.tenantId);
  const items = await listSaasSubscriptions({ externalTenantId: tenantId || null });
  return { ok: true, subscriptions: items };
}

async function sendSaasSubscriptionAuthorizationLinkEmail(input) {
  await requireGeneration(2);
  const tenantId = normalizeString(input && input.tenantId);
  if (!tenantId) return { ok: false, reason: 'missing_tenant_id', status: 400 };

  const clinic = await findClinicByExternalTenantId(tenantId);
  if (!clinic) return { ok: false, reason: 'tenant_not_found', status: 404 };

  const subscription = await findLatestSaasSubscriptionByTenantId(tenantId);
  if (!subscription) return { ok: false, reason: 'subscription_not_found', status: 404 };
  if (subscription.localStatus !== 'pending') {
    return { ok: false, reason: 'subscription_not_pending', status: 409 };
  }
  if (!normalizeString(subscription.authorizationUrl)) {
    return { ok: false, reason: 'subscription_authorization_link_missing', status: 409 };
  }

  const metadata = subscription.metadata && typeof subscription.metadata === 'object' ? subscription.metadata : {};
  const billingLinkEmail = metadata.billingLinkEmail && typeof metadata.billingLinkEmail === 'object'
    ? metadata.billingLinkEmail
    : {};
  const lastSentAt = normalizeString(billingLinkEmail.lastSentAt);
  if (lastSentAt) {
    const lastSentAtMs = new Date(lastSentAt).getTime();
    if (Number.isFinite(lastSentAtMs) && Date.now() - lastSentAtMs < 60 * 1000) {
      return { ok: false, reason: 'subscription_authorization_email_recently_sent', status: 409 };
    }
  }

  const destinationEmail = normalizeEmail(subscription.mercadoPagoPayerEmail);
  if (!destinationEmail) {
    return { ok: false, reason: 'subscription_payer_email_missing', status: 409 };
  }

  try {
    const delivery = await sendBillingSubscriptionAuthorizationEmail({
      email: destinationEmail,
      clientName: normalizeString(clinic.name) || tenantId,
      planLabel: planLabel(subscription.planCode),
      amount: subscription.amount,
      currency: subscription.currency,
      authorizationUrl: subscription.authorizationUrl
    });

    const sentAt = new Date().toISOString();
    const updated = await withBillingTransaction(client => updateSaasSubscriptionById(subscription.id, {
      metadata: {
        billingLinkEmail: {
          lastSentAt: sentAt,
          lastSentTo: destinationEmail,
          provider: delivery.provider,
          providerMessageId: delivery.id || null,
          status: 'sent'
        }
      }
    }, client));

    logInfo('billing_subscription_authorization_email_sent', {
      tenantId,
      subscriptionId: subscription.id,
      planCode: subscription.planCode,
      localStatus: subscription.localStatus,
      email: maskEmail(destinationEmail),
      provider: delivery.provider
    });

    return {
      ok: true,
      subscription: updated,
      delivery: {
        to: destinationEmail,
        provider: delivery.provider,
        sentAt
      }
    };
  } catch (error) {
    logError('billing_subscription_authorization_email_failed', {
      tenantId,
      subscriptionId: subscription.id,
      planCode: subscription.planCode,
      email: maskEmail(destinationEmail),
      provider: 'resend',
      status: Number.isInteger(Number(error && error.status)) ? Number(error.status) : null,
      body: error && error.body ? error.body : null,
      cause: error && error.message ? error.message : 'unknown_error'
    });

    const reason = error && error.code ? String(error.code) : 'billing_link_email_send_failed';
    return { ok: false, reason, status: reason === 'billing_link_email_not_configured' ? 503 : 502 };
  }
}

async function executeSubscriptionAction(subscriptionId, action) {
  await requireGeneration(2);
  const subscription = await findSaasSubscriptionById(subscriptionId);
  if (!subscription) return { ok: false, reason: 'subscription_not_found', status: 404 };

  const clinic = await findClinicByExternalTenantId(subscription.externalTenantId);
  if (!clinic) return { ok: false, reason: 'tenant_not_found', status: 404 };

  let remote = null;
  if (!subscription.mercadoPagoPreapprovalId) {
    return { ok: false, reason: 'missing_preapproval_id', status: 409 };
  }

  if (action === 'cancel') {
    remote = await cancelPreapproval(subscription.mercadoPagoPreapprovalId);
  } else if (action === 'pause') {
    remote = await pausePreapproval(subscription.mercadoPagoPreapprovalId);
  } else if (action === 'reactivate') {
    remote = await reactivatePreapproval(subscription.mercadoPagoPreapprovalId);
  } else {
    return { ok: false, reason: 'unsupported_action', status: 400 };
  }

  const patch = mapPreapprovalToSubscriptionPatch(remote);

  const updated = await withBillingTransaction(async (client) => {
    const next = await updateSaasSubscriptionById(subscription.id, patch, client);
    await syncTenantBillingState(client, clinic, next);
    return next;
  });

  return { ok: true, subscription: updated };
}

async function refreshSubscriptionFromMercadoPagoByPreapprovalId(preapprovalId) {
  await requireGeneration(2);
  const subscription = await findSaasSubscriptionByPreapprovalId(preapprovalId);
  if (!subscription) return { ok: false, reason: 'subscription_not_found', status: 404 };
  const clinic = await findClinicByExternalTenantId(subscription.externalTenantId);
  if (!clinic) return { ok: false, reason: 'tenant_not_found', status: 404 };

  const remote = await getPreapproval(preapprovalId);
  const patch = mapPreapprovalToSubscriptionPatch(remote);
  const updated = await withBillingTransaction(async (client) => {
    const next = await updateSaasSubscriptionById(subscription.id, patch, client);
    await syncTenantBillingState(client, clinic, next);
    return next;
  });

  return { ok: true, subscription: updated };
}

function resolveSubscriptionIdFromPayment(payment) {
  return (
    normalizeString(payment && payment.metadata && payment.metadata.preapproval_id) ||
    normalizeString(payment && payment.subscription_id) ||
    normalizeString(payment && payment.preapproval_id) ||
    null
  );
}

function resolveExternalReferenceFromPayment(payment) {
  return (
    normalizeString(payment && payment.external_reference) ||
    normalizeString(payment && payment.metadata && payment.metadata.external_reference) ||
    null
  );
}

function extractMercadoPagoResourceId(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  if (!raw.includes('/')) {
    return raw;
  }

  const normalized = raw.split('?')[0].replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length ? normalizeString(parts[parts.length - 1]) : null;
}

function extractMercadoPagoWebhookTopic(payload) {
  return normalizeString(payload && (payload.type || payload.topic)).toLowerCase() || null;
}

function extractMercadoPagoWebhookAction(payload) {
  return normalizeString(payload && payload.action).toLowerCase() || null;
}

function extractMercadoPagoWebhookNotificationId(payload) {
  return contractProof.resourceId(payload && payload.id);
}

function extractMercadoPagoWebhookResourceId(payload) {
  return (
    normalizeString(payload && payload.data && payload.data.id) ||
    extractMercadoPagoResourceId(payload && payload.resource) ||
    normalizeString(payload && payload.resource_id) ||
    normalizeString(payload && payload['data.id']) ||
    null
  );
}

function buildWebhookEventSnapshot(payload, meta = {}) {
  return {
    topic: extractMercadoPagoWebhookTopic(payload),
    action: extractMercadoPagoWebhookAction(payload),
    notificationId: extractMercadoPagoWebhookNotificationId(payload),
    resourceId: extractMercadoPagoWebhookResourceId(payload),
    requestId: normalizeString(meta.requestId) || null,
    signatureValid:
      meta.signatureValid === null || meta.signatureValid === undefined
        ? null
        : meta.signatureValid === true
  };
}

function deriveWebhookDedupeKey(snapshot) {
  const topic = snapshot.topic || 'unknown';
  const action = snapshot.action || 'unknown';
  const resourceId = snapshot.resourceId || 'unknown';
  const notificationId = snapshot.notificationId || null;
  if (notificationId) {
    return `${topic}:${action}:${resourceId}:notification:${notificationId}`;
  }
  return `${topic}:${action}:${resourceId}`;
}

function buildPreapprovalWebhookMetadata(preapproval, payload, meta) {
  return {
    mercadoPagoPreapproval: preapproval || {},
    mercadoPagoWebhook: {
      topic: extractMercadoPagoWebhookTopic(payload),
      action: extractMercadoPagoWebhookAction(payload),
      notificationId: extractMercadoPagoWebhookNotificationId(payload),
      resourceId: extractMercadoPagoWebhookResourceId(payload),
      requestId: normalizeString(meta && meta.requestId) || null,
      receivedAt: new Date().toISOString(),
      signatureValid:
        meta && (meta.signatureValid === true || meta.signatureValid === false)
          ? meta.signatureValid
          : null
    }
  };
}

function buildPaymentWebhookMetadata(payment, payload, meta) {
  return {
    mercadoPagoPayment: payment || {},
    mercadoPagoPaymentSnapshot: {
      id: normalizeString(payment && payment.id) || null,
      status: normalizeString(payment && payment.status).toLowerCase() || null,
      statusDetail: normalizeString(payment && payment.status_detail).toLowerCase() || null,
      dateApproved: toIsoDate(payment && (payment.date_approved || payment.date_last_updated || payment.date_created)),
      dateCreated: toIsoDate(payment && payment.date_created),
      transactionAmount:
        payment && payment.transaction_amount !== undefined && payment.transaction_amount !== null
          ? Number(payment.transaction_amount)
          : null,
      currency: normalizeCurrency(payment && payment.currency_id),
      externalReference: resolveExternalReferenceFromPayment(payment)
    },
    mercadoPagoWebhook: {
      topic: extractMercadoPagoWebhookTopic(payload),
      action: extractMercadoPagoWebhookAction(payload),
      notificationId: extractMercadoPagoWebhookNotificationId(payload),
      resourceId: extractMercadoPagoWebhookResourceId(payload),
      requestId: normalizeString(meta && meta.requestId) || null,
      receivedAt: new Date().toISOString(),
      signatureValid:
        meta && (meta.signatureValid === true || meta.signatureValid === false)
          ? meta.signatureValid
          : null
    }
  };
}

function invoiceIdentity(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null;
  return normalizeString(value) || null;
}

async function fetchMercadoPagoChargeResource(kind, resourceId, signal) {
  signal?.throwIfAborted();
  if (!resourceId) throw new Error('charge_resource_id_missing');
  if (kind === 'authorized_payment') {
    const invoice = await getAuthorizedPayment(resourceId, { signal });
    if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)
      || !invoiceIdentity(invoice.id)
      || (invoice.payment != null && (typeof invoice.payment !== 'object' || Array.isArray(invoice.payment)))
      || (invoice.payment?.id != null && !invoiceIdentity(invoice.payment.id))) {
      throw new Error('authorized_payment_response_incomplete');
    }
    // Preserve the provider response without amount/status interpretation. These
    // three IDs describe different resources; preapproval is only a candidate.
    return {
      kind, id: invoiceIdentity(invoice.id), invoiceId: invoiceIdentity(invoice.id),
      paymentId: invoiceIdentity(invoice.payment?.id),
      preapprovalId: invoiceIdentity(invoice.preapproval_id), data: invoice
    };
  }
  if (kind !== 'payment') throw new Error('charge_resource_kind_unsupported');
  const payment = await getPayment(resourceId, { signal });
  if (!normalizeString(payment && payment.id) || !normalizeString(payment && payment.status)) {
    throw new Error('payment_response_incomplete');
  }
  return {
    kind, id: normalizeString(payment.id), invoiceId: null,
    paymentId: normalizeString(payment.id),
    preapprovalId: resolveSubscriptionIdFromPayment(payment), data: payment
  };
}

async function processMercadoPagoWebhook(payload, meta = {}) {
  await requireGeneration(2);
  const requestId = normalizeString(meta.requestId);
  const snapshot = buildWebhookEventSnapshot(payload, meta);
  const dedupeKey = signedDeliveryIdentity(meta.verifiedDelivery);
  snapshot.resourceId = meta.verifiedDelivery.resourceId;

  return processSubscriptionWebhookEvent({
    subscriptionId: null,
    provider: 'mercado_pago',
    topic: snapshot.topic,
    action: snapshot.action,
    resourceId: snapshot.resourceId,
    notificationId: snapshot.notificationId,
    requestId: requestId || null,
    dedupeKey,
    signatureValid: meta.signatureValid,
    raw: payload,
    processingStatus: 'received',
    processingError: null
  }, (client, event, prepared) => applyPreparedWebhook(prepared, payload, meta, client, { eventId: event.id }),
  async signal => {
    const prepared = await prepareMercadoPagoWebhook(snapshot, signal);
    signal.throwIfAborted();
    // Preliminary validation uses ordinary reads; finalization repeats local
    // authority checks under locks. This snapshot never authorizes a write.
    await validatePreparedWebhook(prepared, null);
    signal.throwIfAborted();
    return prepared;
  });
}

function providerDecision(result, resource, subscription = null) {
  if (result.type === 'NO_ACTION') return result;
  const make = result.type === 'CONTRACT_REJECTED' ? contractRejected : manualReview;
  return make({ reasonCode: result.reasonCode, details: result.details || {},
    subscriptionId: subscription?.id || null, resource });
}

// Phase B reads without locks. Phase C re-reads and locks the same local
// authority; only its result may authorize a mutation. No provider I/O here.
async function lockProviderSubscription(client, preapprovalId, preapproval) {
  if (!contractProof.resourceId(preapproval?.id) || typeof preapproval?.status !== 'string' || !preapproval.status.trim()) {
    throw new Error('preapproval_response_incomplete');
  }
  let candidate = await findSaasSubscriptionByPreapprovalId(preapprovalId, client);
  if (!candidate) {
    const reference = canonicalizeExternalReferenceUuid(preapproval?.external_reference);
    if (reference?.startsWith('opturon:')) {
      candidate = await findSaasSubscriptionById(reference.slice(reference.lastIndexOf(':') + 1), client);
    }
  }
  if (!candidate) return { decision: contractProof.review() };
  const subscription = await findSaasSubscriptionById(candidate.id, client, { forUpdate: Boolean(client) });
  if (!subscription) throw new Error('subscription_not_found');
  const expected = contractProof.resolveExpectedContract(subscription);
  if (expected.type !== 'VALID') return { subscription, decision: expected };
  const clinic = await findClinicByExternalTenantId(subscription.externalTenantId, client, { forUpdate: Boolean(client) });
  const decision = contractProof.validatePreapproval({ subscription, clinic, preapproval,
    preapprovalId, contract: expected.contract });
  return { subscription, clinic, contract: expected.contract, decision };
}

async function prepareInvoice(invoiceId, signal, knownPayment = null, expectedPaymentId = null, knownInvoice = null) {
  signal.throwIfAborted();
  const resource = { type: 'authorized_payment', id: invoiceId };
  const invoice = knownInvoice || (await fetchMercadoPagoChargeResource('authorized_payment', invoiceId, signal)).data;
  const checked = contractProof.identity(invoice.id, invoiceId);
  if (checked.type !== 'VALID') return { decision: providerDecision(checked, resource) };
  const preapprovalId = contractProof.resourceId(invoice.preapproval_id);
  if (!preapprovalId) return { decision: providerDecision(contractProof.review(), resource) };
  const paymentId = contractProof.resourceId(invoice.payment?.id);
  if (expectedPaymentId) {
    const relationship = contractProof.identity(paymentId, expectedPaymentId);
    if (relationship.type !== 'VALID') return { decision: providerDecision(relationship, resource) };
  }
  signal.throwIfAborted();
  const preapproval = await getPreapproval(preapprovalId, { signal });
  signal.throwIfAborted();
  const payment = paymentId ? knownPayment || await getPayment(paymentId, { signal }) : null;
  return { kind: 'invoice', resource, invoiceId, invoice, preapprovalId, preapproval, paymentId, payment };
}

async function prepareMercadoPagoWebhook(snapshot, signal) {
  const resourceId = contractProof.resourceId(snapshot.resourceId);
  if (!resourceId) throw new Error('signed_resource_id_required');
  const candidates = [];
  let malformed = null;
  for (const [kind, read] of [['payment', getPayment], ['invoice', getAuthorizedPayment],
    ['preapproval', getPreapproval], ['plan', getPreapprovalPlan]]) {
    signal.throwIfAborted();
    let data;
    try { data = await read(resourceId, { signal }); }
    catch (error) { if (error?.status === 404) continue; throw error; }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !contractProof.resourceId(data.id)
      || (kind === 'invoice' && ((data.payment != null && (typeof data.payment !== 'object' || Array.isArray(data.payment)))
        || (data.payment?.id != null && !contractProof.resourceId(data.payment.id))))) throw new Error('canonical_response_incomplete');
    const identity = contractProof.identity(data?.id, resourceId);
    if (identity.type !== 'VALID') { malformed = identity; continue; }
    if (typeof data?.status !== 'string' || !data.status.trim()) throw new Error('canonical_response_incomplete');
    candidates.push({ kind, data });
  }
  const resource = { type: 'payment', id: resourceId };
  if (candidates.length > 1 || (candidates.length && malformed)) return { decision: providerDecision(contractProof.review(), resource) };
  if (!candidates.length) {
    if (malformed) return { decision: providerDecision(malformed, resource) };
    throw Object.assign(new Error('canonical_resource_not_found'), { status: 404 });
  }
  const { kind, data } = candidates[0];
  if (kind === 'plan') return { decision: contractProof.noAction('preapproval_plan_unsupported') };
  if (kind === 'preapproval') return { kind, resource: { type: kind, id: resourceId }, preapprovalId: resourceId, preapproval: data };
  if (kind === 'invoice') return prepareInvoice(resourceId, signal, null, null, data);
  const search = await searchAuthorizedPaymentsByPaymentId(resourceId, { signal });
  const relationship = contractProof.validateAuthorizedPaymentSearch(search, resourceId);
  if (relationship.type !== 'VALID') return { decision: providerDecision(relationship, resource) };
  return prepareInvoice(relationship.invoiceId, signal, data, resourceId);
}

async function validatePreparedWebhook(prepared, client) {
  if (prepared.decision) return { decision: prepared.decision };
  const proof = await lockProviderSubscription(client, prepared.preapprovalId, prepared.preapproval);
  if (proof.decision.type !== 'VALID') return {
    decision: providerDecision(proof.decision, prepared.resource, proof.subscription)
  };
  if (prepared.kind === 'invoice') {
    const decision = contractProof.validateCharge({ ...prepared, contract: proof.contract });
    if (decision.type !== 'VALID') return { decision: providerDecision(decision, prepared.resource, proof.subscription) };
  }
  return { ...proof, decision: null };
}

async function applyPreparedWebhook(prepared, payload, meta, client, source) {
  const runtimeState = await requireGeneration(2, client, { lock: true });
  const proof = await validatePreparedWebhook(prepared, client);
  if (proof.decision) return proof.decision;
  const { subscription, clinic } = proof;
  const { preapproval, payment, paymentId } = prepared;
  if (prepared.kind === 'invoice') {
    const effectDecision = await reserveEffect(client, prepared, subscription, runtimeState, source);
    if (effectDecision) return effectDecision;
  }
  // Existing downstream activation/payment policy is unchanged (BILL-007).
  const preapprovalPatch = mapPreapprovalToSubscriptionPatch(preapproval);
  const patch = prepared.kind === 'invoice' ? {
    ...preapprovalPatch,
    provisioningState: subscription.provisioningState && preapprovalPatch.mercadoPagoPreapprovalId ? 'ready' : null,
    lastPaymentId: paymentId,
    lastPaymentStatus: normalizeString(payment.status).toLowerCase(),
    localStatus: mapMercadoPagoPaymentStatus(payment.status) === 'active'
      ? (preapprovalPatch.localStatus || 'active') : mapMercadoPagoPaymentStatus(payment.status),
    metadata: buildPaymentWebhookMetadata(payment, payload, meta)
  } : {
    ...preapprovalPatch,
    provisioningState: subscription.provisioningState && normalizeString(preapproval && preapproval.id) ? 'ready' : null,
    metadata: buildPreapprovalWebhookMetadata(preapproval, payload, meta)
  };
  const next = await updateSaasSubscriptionById(subscription.id, patch, client);
  if (!next) throw new Error('subscription_update_missing');
  await syncTenantBillingState(client, clinic, next);
  return { ok: true, outcome: 'PROCESSED_SUCCESSFULLY', duplicate: false, subscription: next };
}

module.exports = {
  ALLOWED_LOCAL_STATUSES,
  createSaasSubscriptionForTenant,
  getSaasSubscriptionDetails,
  listSaasSubscriptionsForAdmin,
  sendSaasSubscriptionAuthorizationLinkEmail,
  executeSubscriptionAction,
  refreshSubscriptionFromMercadoPagoByPreapprovalId,
  processMercadoPagoWebhook,
  findLatestSaasSubscriptionByTenantId,
  __internal: {
    prepareMercadoPagoWebhook, validatePreparedWebhook, applyPreparedWebhook,
    processSubscriptionWebhookEvent,
    extractMercadoPagoResourceId,
    extractMercadoPagoWebhookTopic,
    extractMercadoPagoWebhookAction,
    extractMercadoPagoWebhookNotificationId,
    extractMercadoPagoWebhookResourceId,
    buildWebhookEventSnapshot,
    deriveWebhookDedupeKey,
    buildPreapprovalWebhookMetadata,
    buildPaymentWebhookMetadata,
    fetchMercadoPagoChargeResource,
    resolveSubscriptionIdFromPayment,
    resolveExternalReferenceFromPayment
  }
};
