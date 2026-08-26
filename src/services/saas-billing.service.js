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
const { sendBillingSubscriptionAuthorizationEmail } = require('./saas-billing-email.service');
const { logError, logInfo } = require('../utils/logger');

const ALLOWED_PLAN_CODES = new Set(['inicial', 'crecimiento', 'empresa']);
const ALLOWED_LOCAL_STATUSES = new Set(['pending', 'active', 'paused', 'canceled', 'payment_failed', 'suspended']);
const TERMINAL_REMOTE_STATUSES = new Set(['canceled', 'cancelled', 'expired', 'ended', 'finished']);
const REMOTE_ACTIONS = Object.freeze({
  pending: ['cancel'],
  authorized: ['pause', 'cancel'],
  active: ['pause', 'cancel'],
  paused: ['reactivate', 'cancel']
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
  if (
    normalizeString(clinic && clinic.externalTenantId) &&
    normalizeString(subscription && subscription.externalTenantId) &&
    normalizeString(clinic.externalTenantId) !== normalizeString(subscription.externalTenantId)
  ) {
    throw new Error('billing_tenant_mismatch');
  }

  const settings = parseSettings(clinic.settings);
  const portal = settings.portal && typeof settings.portal === 'object' ? { ...settings.portal } : {};
  const billing = portal.billing && typeof portal.billing === 'object' ? { ...portal.billing } : {};

  billing.status = subscription.localStatus;
  billing.subscription = buildTenantBillingSnapshot(subscription);

  const nextSettings = {
    ...settings,
    portal: {
      ...portal,
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

function resolveBillingAuditEventType(action, localStatusAfter) {
  if (normalizeString(action).toLowerCase() === 'cancel' && normalizeString(localStatusAfter).toLowerCase() === 'canceled') {
    return 'BILLING_SUBSCRIPTION_CANCELED';
  }
  return 'BILLING_RECONCILED';
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

function normalizeRemoteStatus(value) {
  return normalizeString(value).toLowerCase() || 'unknown';
}

function availableSubscriptionActions(remoteStatus, localStatus) {
  const normalizedLocal = normalizeString(localStatus).toLowerCase();
  if (normalizedLocal === 'canceled' || normalizedLocal === 'suspended') return [];
  return [...(REMOTE_ACTIONS[normalizeRemoteStatus(remoteStatus)] || [])];
}

function providerAvailableActions(remoteStatus) {
  return [...(REMOTE_ACTIONS[normalizeRemoteStatus(remoteStatus)] || [])];
}

function subscriptionStatusMessage(remoteStatus, localStatus, metadata = {}) {
  const reconciliation = metadata.billingReconciliation && typeof metadata.billingReconciliation === 'object'
    ? metadata.billingReconciliation
    : {};
  if (reconciliation.disposition === 'pending_authorization_closed_locally') {
    return 'Esta solicitud nunca fue activada y quedo cerrada en Opturon.';
  }
  const normalizedRemote = normalizeRemoteStatus(remoteStatus);
  if (normalizedRemote === 'unavailable' || normalizeString(localStatus).toLowerCase() === 'suspended') {
    return 'Esta suscripcion ya no esta disponible en Mercado Pago.';
  }
  if (TERMINAL_REMOTE_STATUSES.has(normalizedRemote)) {
    return 'Esta suscripcion ya no esta activa en Mercado Pago.';
  }
  return null;
}

function decorateSubscription(subscription) {
  if (!subscription) return subscription;
  return {
    ...subscription,
    availableActions: availableSubscriptionActions(subscription.mercadoPagoStatus, subscription.localStatus),
    statusMessage: subscriptionStatusMessage(
      subscription.mercadoPagoStatus,
      subscription.localStatus,
      subscription.metadata || {}
    )
  };
}

function buildReconciliationMetadata(subscription, input) {
  const metadata = subscription.metadata && typeof subscription.metadata === 'object' ? subscription.metadata : {};
  return {
    ...metadata,
    billingReconciliation: {
      disposition: input.disposition,
      remoteStatus: input.remoteStatus || null,
      action: input.action || null,
      providerActionApplied: Boolean(input.providerActionApplied),
      upstreamStatus: input.upstreamStatus || null,
      reconciledAt: new Date().toISOString()
    }
  };
}

function mergeProviderAndReconciliationMetadata(subscription, providerMetadata, input) {
  const reconciled = buildReconciliationMetadata(subscription, input);
  return {
    ...reconciled,
    ...(providerMetadata && typeof providerMetadata === 'object' ? providerMetadata : {}),
    billingReconciliation: reconciled.billingReconciliation
  };
}

function remoteResourceMatches(subscription, remote) {
  const remoteId = normalizeString(remote && remote.id);
  const localId = normalizeString(subscription && subscription.mercadoPagoPreapprovalId);
  if (!remoteId || !localId || remoteId !== localId) return false;
  const remoteReference = normalizeString(remote && remote.external_reference);
  const localReference = normalizeString(subscription && subscription.externalReference);
  return !remoteReference || !localReference || remoteReference === localReference;
}

function isRemoteUnavailableError(error) {
  const status = Number(error && error.status);
  if (status === 404) return true;
  if (status !== 400) return false;
  const detail = `${normalizeString(error && error.message)} ${JSON.stringify(error && error.body || {})}`.toLowerCase();
  return detail.includes('not found') || detail.includes('invalid preapproval') || detail.includes('invalid id');
}

function isKnownProviderActionRejection(error) {
  return [400, 409, 422].includes(Number(error && error.status));
}

async function persistSubscriptionReconciliation(subscription, clinic, patch, audit, dependencies = {}) {
  const runTransaction = dependencies.withTransaction || withTransaction;
  const updateSubscription = dependencies.updateSaasSubscriptionById || updateSaasSubscriptionById;
  const syncBilling = dependencies.syncTenantBillingState || syncTenantBillingState;
  const insertAudit = dependencies.insertSubscriptionEvent || insertSubscriptionEvent;
  return runTransaction(async (client) => {
    const next = await updateSubscription(subscription.id, patch, client);
    await syncBilling(client, clinic, next);
    await insertAudit({
      subscriptionId: subscription.id,
      provider: 'mercado_pago',
      topic: 'admin_subscription_action',
      action: audit.action || 'reconcile',
      resourceId: subscription.mercadoPagoPreapprovalId,
      notificationId: null,
      requestId: null,
      dedupeKey: `admin-billing:${subscription.id}:${audit.action || 'reconcile'}:${randomUUID()}`,
      signatureValid: null,
      raw: {
        eventType: resolveBillingAuditEventType(audit.action, next.localStatus),
        localStatusBefore: subscription.localStatus,
        localStatusAfter: next.localStatus,
        remoteStatus: audit.remoteStatus || null,
        disposition: audit.disposition,
        providerActionApplied: Boolean(audit.providerActionApplied),
        upstreamStatus: audit.upstreamStatus || null
      },
      processingStatus: 'processed',
      processingError: null
    }, client);
    return next;
  });
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

  const existingSubscription = await findLatestSaasSubscriptionByTenantId(tenantId);
  if (existingSubscription && ['pending', 'active', 'paused'].includes(existingSubscription.localStatus)) {
    return {
      ok: false,
      reason: 'billing_subscription_already_exists',
      status: 409,
      subscription: decorateSubscription(existingSubscription)
    };
  }

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
  return { ok: true, subscription: decorateSubscription(subscription) };
}

async function listSaasSubscriptionsForAdmin(filters = {}) {
  const tenantId = normalizeString(filters.tenantId);
  const items = await listSaasSubscriptions({ externalTenantId: tenantId || null });
  return { ok: true, subscriptions: items.map(decorateSubscription) };
}

async function sendSaasSubscriptionAuthorizationLinkEmail(input) {
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
    const updated = await updateSaasSubscriptionById(subscription.id, {
      metadata: {
        billingLinkEmail: {
          lastSentAt: sentAt,
          lastSentTo: destinationEmail,
          provider: delivery.provider,
          providerMessageId: delivery.id || null,
          status: 'sent'
        }
      }
    });

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

async function executeSubscriptionAction(subscriptionId, action, dependencies = {}) {
  const findSubscription = dependencies.findSaasSubscriptionById || findSaasSubscriptionById;
  const findClinic = dependencies.findClinicByExternalTenantId || findClinicByExternalTenantId;
  const readRemote = dependencies.getPreapproval || getPreapproval;
  const cancelRemote = dependencies.cancelPreapproval || cancelPreapproval;
  const pauseRemote = dependencies.pausePreapproval || pausePreapproval;
  const reactivateRemote = dependencies.reactivatePreapproval || reactivatePreapproval;
  const subscription = await findSubscription(subscriptionId);
  if (!subscription) return { ok: false, reason: 'subscription_not_found', status: 404 };

  const clinic = await findClinic(subscription.externalTenantId);
  if (!clinic) return { ok: false, reason: 'tenant_not_found', status: 404 };
  if (!subscription.mercadoPagoPreapprovalId) {
    return { ok: false, reason: 'missing_preapproval_id', status: 409 };
  }

  const persist = (patch, audit) => persistSubscriptionReconciliation(
    subscription,
    clinic,
    patch,
    audit,
    dependencies
  );

  let currentRemote = null;
  try {
    currentRemote = await readRemote(subscription.mercadoPagoPreapprovalId);
  } catch (error) {
    if (!isRemoteUnavailableError(error)) {
      logError('billing_subscription_reconciliation_read_failed', {
        subscriptionId: subscription.id,
        action,
        upstreamStatus: Number(error && error.status) || null,
        cause: normalizeString(error && error.code) || 'provider_read_failed'
      });
      return {
        ok: false,
        reason: 'billing_provider_unavailable',
        status: 502,
        message: 'No se pudo confirmar el estado de la suscripcion en Mercado Pago.'
      };
    }
    const metadata = buildReconciliationMetadata(subscription, {
      disposition: 'remote_unavailable',
      remoteStatus: 'unavailable',
      action,
      providerActionApplied: false,
      upstreamStatus: Number(error && error.status) || null
    });
    const updated = await persist(
      { localStatus: 'suspended', mercadoPagoStatus: 'unavailable', metadata },
      { action, remoteStatus: 'unavailable', disposition: 'remote_unavailable', upstreamStatus: error.status }
    );
    return {
      ok: true,
      reconciled: true,
      providerActionApplied: false,
      message: 'Esta suscripcion ya no esta disponible en Mercado Pago.',
      subscription: decorateSubscription(updated)
    };
  }

  if (!remoteResourceMatches(subscription, currentRemote)) {
    return {
      ok: false,
      reason: 'billing_subscription_remote_mismatch',
      status: 409,
      message: 'La suscripcion no coincide con el registro de Mercado Pago.'
    };
  }

  const remoteStatus = normalizeRemoteStatus(currentRemote.status);
  if (TERMINAL_REMOTE_STATUSES.has(remoteStatus)) {
    const patch = mapPreapprovalToSubscriptionPatch(currentRemote);
    patch.localStatus = 'canceled';
    patch.metadata = mergeProviderAndReconciliationMetadata(subscription, patch.metadata, {
      disposition: 'remote_terminal', remoteStatus, action, providerActionApplied: false
    });
    const updated = await persist(patch, {
      action, remoteStatus, disposition: 'remote_terminal', providerActionApplied: false
    });
    return {
      ok: true,
      reconciled: true,
      providerActionApplied: false,
      message: 'Esta suscripcion ya no esta activa en Mercado Pago.',
      subscription: decorateSubscription(updated)
    };
  }

  if (!providerAvailableActions(remoteStatus).includes(action)) {
    const patch = mapPreapprovalToSubscriptionPatch(currentRemote);
    if (remoteStatus === 'unknown') patch.localStatus = 'suspended';
    patch.metadata = mergeProviderAndReconciliationMetadata(subscription, patch.metadata, {
      disposition: 'action_not_available', remoteStatus, action, providerActionApplied: false
    });
    const updated = await persist(patch, {
      action, remoteStatus, disposition: 'action_not_available', providerActionApplied: false
    });
    return {
      ok: false,
      reason: 'billing_subscription_action_not_available',
      status: 409,
      message: 'La accion no esta disponible para el estado actual de la suscripcion.',
      subscription: decorateSubscription(updated)
    };
  }

  let remote = null;
  try {
    if (action === 'cancel') remote = await cancelRemote(subscription.mercadoPagoPreapprovalId);
    else if (action === 'pause') remote = await pauseRemote(subscription.mercadoPagoPreapprovalId);
    else if (action === 'reactivate') remote = await reactivateRemote(subscription.mercadoPagoPreapprovalId);
    else return { ok: false, reason: 'unsupported_action', status: 400 };
  } catch (error) {
    if (action === 'cancel' && remoteStatus === 'pending' && isKnownProviderActionRejection(error)) {
      const metadata = buildReconciliationMetadata(subscription, {
        disposition: 'pending_authorization_closed_locally',
        remoteStatus,
        action,
        providerActionApplied: false,
        upstreamStatus: Number(error && error.status) || null
      });
      const updated = await persist(
        { localStatus: 'canceled', mercadoPagoStatus: remoteStatus, metadata },
        {
          action,
          remoteStatus,
          disposition: 'pending_authorization_closed_locally',
          providerActionApplied: false,
          upstreamStatus: error.status
        }
      );
      logInfo('billing_pending_authorization_closed_locally', {
        subscriptionId: subscription.id,
        externalTenantId: subscription.externalTenantId,
        upstreamStatus: Number(error && error.status) || null
      });
      return {
        ok: true,
        reconciled: true,
        providerActionApplied: false,
        message: 'Esta solicitud nunca fue activada y quedo cerrada en Opturon.',
        subscription: decorateSubscription(updated)
      };
    }
    logError('billing_subscription_provider_action_failed', {
      subscriptionId: subscription.id,
      action,
      remoteStatus,
      upstreamStatus: Number(error && error.status) || null,
      cause: normalizeString(error && error.code) || 'provider_action_failed'
    });
    return {
      ok: false,
      reason: 'billing_subscription_action_not_available',
      status: isKnownProviderActionRejection(error) ? 409 : 502,
      message: isKnownProviderActionRejection(error)
        ? 'Mercado Pago no permite esta accion para el estado actual de la suscripcion.'
        : 'No se pudo confirmar la accion en Mercado Pago.'
    };
  }

  const patch = mapPreapprovalToSubscriptionPatch(remote);
  patch.metadata = mergeProviderAndReconciliationMetadata(subscription, patch.metadata, {
    disposition: 'provider_action_applied',
    remoteStatus: normalizeRemoteStatus(remote && remote.status),
    action,
    providerActionApplied: true
  });
  const updated = await persist(patch, {
    action,
    remoteStatus: normalizeRemoteStatus(remote && remote.status),
    disposition: 'provider_action_applied',
    providerActionApplied: true
  });
  return {
    ok: true,
    reconciled: true,
    providerActionApplied: true,
    message: 'Suscripcion actualizada y reconciliada con Mercado Pago.',
    subscription: decorateSubscription(updated)
  };
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
  return normalizeString(payload && payload.id) || null;
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

async function processMercadoPagoWebhook(payload, meta = {}) {
  const requestId = normalizeString(meta.requestId);
  const snapshot = buildWebhookEventSnapshot(payload, meta);
  const dedupeKey = deriveWebhookDedupeKey(snapshot);

  const insertedEvent = await insertSubscriptionEvent({
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
  });

  if (!insertedEvent) {
    return { ok: true, duplicate: true };
  }

  try {
    const topic = snapshot.topic || '';
    const action = snapshot.action || '';
    const resourceId = snapshot.resourceId;

    let subscription = null;

    if (topic === 'subscription_authorized_payment' || topic === 'authorized_payment' || topic === 'payment') {
      if (!resourceId) {
        throw new Error('payment_resource_id_missing');
      }
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
              ...buildPaymentWebhookMetadata(payment, payload, meta)
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

    if (
      topic === 'subscription_preapproval' ||
      topic === 'preapproval' ||
      topic === 'subscription' ||
      action.includes('preapproval')
    ) {
      if (!resourceId) {
        throw new Error('preapproval_resource_id_missing');
      }

      subscription = await findSaasSubscriptionByPreapprovalId(resourceId);
      const remote = await getPreapproval(resourceId);
      if (!subscription) {
        const remoteExternalReference = normalizeString(remote && remote.external_reference);
        if (remoteExternalReference) {
          subscription = await findSaasSubscriptionByExternalReference(remoteExternalReference);
        }
      }
      if (!subscription) {
        throw new Error('subscription_not_found_for_preapproval');
      }

      const clinic = await findClinicByExternalTenantId(subscription.externalTenantId);
      const patch = {
        ...mapPreapprovalToSubscriptionPatch(remote),
        metadata: buildPreapprovalWebhookMetadata(remote, payload, meta)
      };
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
  sendSaasSubscriptionAuthorizationLinkEmail,
  executeSubscriptionAction,
  refreshSubscriptionFromMercadoPagoByPreapprovalId,
  processMercadoPagoWebhook,
  findLatestSaasSubscriptionByTenantId,
  __internal: {
    extractMercadoPagoResourceId,
    extractMercadoPagoWebhookTopic,
    extractMercadoPagoWebhookAction,
    extractMercadoPagoWebhookNotificationId,
    extractMercadoPagoWebhookResourceId,
    buildWebhookEventSnapshot,
    deriveWebhookDedupeKey,
    buildPreapprovalWebhookMetadata,
    buildPaymentWebhookMetadata,
    resolveSubscriptionIdFromPayment,
    resolveExternalReferenceFromPayment,
    normalizeRemoteStatus,
    availableSubscriptionActions,
    providerAvailableActions,
    subscriptionStatusMessage,
    decorateSubscription,
    remoteResourceMatches,
    isRemoteUnavailableError,
    isKnownProviderActionRejection,
    syncTenantBillingState,
    resolveBillingAuditEventType
  }
};
