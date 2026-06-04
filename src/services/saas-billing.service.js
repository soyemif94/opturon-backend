const { randomUUID } = require('crypto');
const { withTransaction } = require('../db/client');
const { findClinicByExternalTenantId } = require('../repositories/tenant.repository');
const {
  insertSaasSubscription,
  updateSaasSubscriptionById,
  findSaasSubscriptionById,
  findLatestSaasSubscriptionByTenantId,
  findSaasSubscriptionByPreapprovalId,
  findSaasSubscriptionByExternalReference,
  listSaasSubscriptions,
  insertSubscriptionEvent,
  updateSubscriptionEventStatus
} = require('../repositories/saas-subscriptions.repository');
const {
  createPreapproval,
  getPreapproval,
  pausePreapproval,
  cancelPreapproval,
  reactivatePreapproval,
  getPayment,
  mapMercadoPagoPreapprovalStatus,
  mapMercadoPagoPaymentStatus
} = require('./mercado-pago.service');
const { resolveSaasPlanDefinition } = require('./saas-billing-plans.service');
const { logError } = require('../utils/logger');

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

  const clinic = await findClinicByExternalTenantId(tenantId);
  if (!clinic) return { ok: false, reason: 'tenant_not_found', status: 404 };

  const subscriptionId = randomUUID();
  const externalReference = buildExternalReference(tenantId, subscriptionId);

  let preapproval = null;
  try {
    preapproval = await createPreapproval({
      reason: buildPreapprovalReason(planDefinition.label, tenantId),
      externalReference,
      payerEmail,
      amount,
      currency
    });
  } catch (error) {
    logError('billing_subscription_create_mp_failed', {
      tenantId,
      planCode,
      amount,
      currency,
      payerEmail,
      mpStatus: Number.isInteger(Number(error && error.status)) ? Number(error.status) : null,
      mpBody: sanitizeMercadoPagoErrorBody(error && error.body),
      cause: error && error.message ? error.message : 'unknown_error'
    });
    throw error;
  }

  const initialPatch = mapPreapprovalToSubscriptionPatch(preapproval);

  const subscription = await withTransaction(async (client) => {
    const created = await insertSaasSubscription(
      {
        id: subscriptionId,
        clinicId: clinic.id,
        externalTenantId: tenantId,
        clientId: null,
        planCode,
        amount: initialPatch.amount || amount,
        currency: initialPatch.currency || currency,
        billingInterval: 'monthly',
        mercadoPagoPreapprovalId: initialPatch.mercadoPagoPreapprovalId,
        mercadoPagoPayerEmail: initialPatch.mercadoPagoPayerEmail || payerEmail,
        mercadoPagoStatus: initialPatch.mercadoPagoStatus,
        localStatus: 'pending',
        currentPeriodStart: initialPatch.currentPeriodStart,
        currentPeriodEnd: initialPatch.currentPeriodEnd,
        nextBillingDate: initialPatch.nextBillingDate,
        lastPaymentId: null,
        lastPaymentStatus: null,
        externalReference,
        authorizationUrl: initialPatch.authorizationUrl,
        metadata: {
          ...initialPatch.metadata,
          billingModel: 'pending_link',
          plan: planDefinition
        }
      },
      client
    );

    await syncTenantBillingState(client, clinic, created);
    return created;
  });

  return {
    ok: true,
    subscription
  };
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

async function executeSubscriptionAction(subscriptionId, action) {
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

  const updated = await withTransaction(async (client) => {
    const next = await updateSaasSubscriptionById(subscription.id, patch, client);
    await syncTenantBillingState(client, clinic, next);
    return next;
  });

  return { ok: true, subscription: updated };
}

async function refreshSubscriptionFromMercadoPagoByPreapprovalId(preapprovalId) {
  const subscription = await findSaasSubscriptionByPreapprovalId(preapprovalId);
  if (!subscription) return { ok: false, reason: 'subscription_not_found', status: 404 };
  const clinic = await findClinicByExternalTenantId(subscription.externalTenantId);
  if (!clinic) return { ok: false, reason: 'tenant_not_found', status: 404 };

  const remote = await getPreapproval(preapprovalId);
  const patch = mapPreapprovalToSubscriptionPatch(remote);
  const updated = await withTransaction(async (client) => {
    const next = await updateSaasSubscriptionById(subscription.id, patch, client);
    await syncTenantBillingState(client, clinic, next);
    return next;
  });

  return { ok: true, subscription: updated };
}

function deriveWebhookDedupeKey(payload, requestId) {
  const topic = normalizeString(payload.type || payload.topic || payload.action || 'unknown').toLowerCase();
  const resourceId =
    normalizeString(payload.data && payload.data.id) ||
    normalizeString(payload.id) ||
    normalizeString(payload.resource) ||
    'unknown';
  const action = normalizeString(payload.action || 'unknown').toLowerCase();
  return `${topic}:${action}:${resourceId}:${normalizeString(requestId) || 'no-request-id'}`;
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

async function processMercadoPagoWebhook(payload, meta = {}) {
  const requestId = normalizeString(meta.requestId);
  const dedupeKey = deriveWebhookDedupeKey(payload, requestId);

  const insertedEvent = await insertSubscriptionEvent({
    subscriptionId: null,
    provider: 'mercado_pago',
    topic: normalizeString(payload.type || payload.topic) || null,
    action: normalizeString(payload.action) || null,
    resourceId:
      normalizeString(payload.data && payload.data.id) ||
      normalizeString(payload.id) ||
      normalizeString(payload.resource) ||
      null,
    notificationId: normalizeString(payload.id) || null,
    requestId: requestId || null,
    dedupeKey,
    signatureValid: meta.signatureValid,
    raw: payload,
    processingStatus: 'received',
    processingError: null
  });

  if (!insertedEvent) {
    return { ok: true, duplicate: true };
  }

  try {
    const topic = normalizeString(payload.type || payload.topic).toLowerCase();
    const action = normalizeString(payload.action).toLowerCase();
    const resourceId =
      normalizeString(payload.data && payload.data.id) ||
      normalizeString(payload.id) ||
      normalizeString(payload.resource);

    let subscription = null;

    if (topic === 'subscription_authorized_payment' || topic === 'payment') {
      const payment = await getPayment(resourceId);
      const preapprovalId = resolveSubscriptionIdFromPayment(payment);
      const externalReference = resolveExternalReferenceFromPayment(payment);

      if (preapprovalId) {
        subscription = await findSaasSubscriptionByPreapprovalId(preapprovalId);
      }
      if (!subscription && externalReference) {
        subscription = await findSaasSubscriptionByExternalReference(externalReference);
      }

      if (!subscription) {
        throw new Error('subscription_not_mapped_from_payment');
      }

      const clinic = await findClinicByExternalTenantId(subscription.externalTenantId);
      const remotePreapproval = subscription.mercadoPagoPreapprovalId
        ? await getPreapproval(subscription.mercadoPagoPreapprovalId)
        : null;

      const updated = await withTransaction(async (client) => {
        const preapprovalPatch = remotePreapproval ? mapPreapprovalToSubscriptionPatch(remotePreapproval) : {};
        const next = await updateSaasSubscriptionById(
          subscription.id,
          {
            ...preapprovalPatch,
            lastPaymentId: normalizeString(payment.id) || subscription.lastPaymentId,
            lastPaymentStatus: normalizeString(payment.status).toLowerCase() || subscription.lastPaymentStatus,
            localStatus:
              mapMercadoPagoPaymentStatus(payment.status) === 'active'
                ? (preapprovalPatch.localStatus || 'active')
                : mapMercadoPagoPaymentStatus(payment.status),
            metadata: {
              mercadoPagoPayment: payment || {}
            }
          },
          client
        );
        if (clinic) {
          await syncTenantBillingState(client, clinic, next);
        }
        return next;
      });

      await updateSubscriptionEventStatus(insertedEvent.id, {
        subscriptionId: updated.id,
        processingStatus: 'processed',
        processingError: null
      });

      return { ok: true, duplicate: false, subscription: updated };
    }

    if (topic === 'subscription_preapproval' || topic === 'subscription' || action.includes('preapproval')) {
      subscription = await findSaasSubscriptionByPreapprovalId(resourceId);
      if (!subscription) {
        throw new Error('subscription_not_found_for_preapproval');
      }

      const clinic = await findClinicByExternalTenantId(subscription.externalTenantId);
      const remote = await getPreapproval(resourceId);
      const patch = mapPreapprovalToSubscriptionPatch(remote);
      const updated = await withTransaction(async (client) => {
        const next = await updateSaasSubscriptionById(subscription.id, patch, client);
        if (clinic) {
          await syncTenantBillingState(client, clinic, next);
        }
        return next;
      });

      await updateSubscriptionEventStatus(insertedEvent.id, {
        subscriptionId: updated.id,
        processingStatus: 'processed',
        processingError: null
      });

      return { ok: true, duplicate: false, subscription: updated };
    }

    await updateSubscriptionEventStatus(insertedEvent.id, {
      processingStatus: 'ignored',
      processingError: null
    });

    return { ok: true, duplicate: false, ignored: true };
  } catch (error) {
    await updateSubscriptionEventStatus(insertedEvent.id, {
      processingStatus: 'failed',
      processingError: error.message
    });
    throw error;
  }
}

module.exports = {
  ALLOWED_LOCAL_STATUSES,
  createSaasSubscriptionForTenant,
  getSaasSubscriptionDetails,
  listSaasSubscriptionsForAdmin,
  executeSubscriptionAction,
  refreshSubscriptionFromMercadoPagoByPreapprovalId,
  processMercadoPagoWebhook,
  findLatestSaasSubscriptionByTenantId
};
