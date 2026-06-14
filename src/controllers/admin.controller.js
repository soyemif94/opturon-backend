const { setActiveTenantForAdmin } = require('../services/portal-active-tenant.service');
const {
  listTenantPolicies,
  resolveTenantPolicyByExternalTenantId,
  updateTenantPolicyByExternalTenantId
} = require('../services/tenant-policy.service');
const { validateTransferPaymentByExternalTenantId } = require('../services/transfer-payment-validation.service');
const {
  createSaasSubscriptionForTenant,
  listSaasSubscriptionsForAdmin,
  getSaasSubscriptionDetails,
  executeSubscriptionAction,
  sendSaasSubscriptionAuthorizationLinkEmail
} = require('../services/saas-billing.service');
const { getAiAssistRuntimeDiagnostics } = require('../services/ai-assist.service');
const { getMetaEmbeddedSignupReadiness } = require('../services/meta-embedded-readiness.service');
const { logError } = require('../utils/logger');

function sanitizeBillingPayload(payload) {
  const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return {
    tenantId: String(safePayload.tenantId || '').trim() || null,
    planCode: String(safePayload.planCode || '').trim() || null,
    amount: safePayload.amount === undefined || safePayload.amount === null ? null : Number(safePayload.amount),
    currency: String(safePayload.currency || '').trim() || null,
    payerEmail: String(safePayload.payerEmail || '').trim().toLowerCase() || null
  };
}

function sanitizeBackendErrorBody(body) {
  if (!body || typeof body !== 'object') return body || null;
  const safe = {};
  for (const [key, value] of Object.entries(body)) {
    if (String(key).toLowerCase().includes('token')) continue;
    safe[key] = value;
  }
  return safe;
}

function normalizeErrorCode(value) {
  return String(value || '').trim().toLowerCase();
}

function mapBillingSubscriptionCreateError(error) {
  const upstreamStatus = Number.isInteger(Number(error && error.status)) ? Number(error.status) : null;
  const upstreamBody = sanitizeBackendErrorBody(error && error.body);
  const code = normalizeErrorCode(error && (error.code || error.message));
  const detail = error && error.message ? error.message : 'billing_subscription_create_failed';

  if (code === 'billing_subscription_env_missing' || code === 'mercado_pago_not_configured') {
    return {
      status: 500,
      error: 'billing_subscription_env_missing',
      detail: 'billing_subscription_env_missing: MERCADO_PAGO_ACCESS_TOKEN no esta configurado en backend.',
      upstreamStatus,
      upstreamBody
    };
  }

  if (code === 'mercadopago_credentials_invalid') {
    return {
      status: 502,
      error: 'mercadopago_credentials_invalid',
      detail: `mercadopago_credentials_invalid: ${detail}`,
      upstreamStatus,
      upstreamBody
    };
  }

  if (code === 'mercadopago_invalid_payload') {
    return {
      status: 502,
      error: 'mercadopago_invalid_payload',
      detail: `mercadopago_invalid_payload: ${detail}`,
      upstreamStatus,
      upstreamBody
    };
  }

  if (code === 'mercadopago_preapproval_failed') {
    return {
      status: 502,
      error: 'mercadopago_preapproval_failed',
      detail: `mercadopago_preapproval_failed: ${detail}`,
      upstreamStatus,
      upstreamBody
    };
  }

  return {
    status: 500,
    error: 'billing_subscription_create_failed',
    detail,
    upstreamStatus,
    upstreamBody
  };
}

async function postSetActiveTenant(req, res) {
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim();
  const tenantId = String((req.body && req.body.tenantId) || '').trim();

  try {
    const result = await setActiveTenantForAdmin(actorUserId, tenantId);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.reason
      });
    }

    res.set('x-active-tenant-id', result.activeTenantId);
    return res.status(200).json({
      success: true,
      data: {
        activeTenantId: result.activeTenantId,
        tenant: result.tenant,
        header: 'x-active-tenant-id'
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'set_active_tenant_failed',
      details: error.message
    });
  }
}

async function getTenantPolicy(req, res) {
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim();
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const access = await setActiveTenantForAdmin(actorUserId, tenantId);
    if (!access.ok) {
      return res.status(access.status || 400).json({ success: false, error: access.reason });
    }

    const result = await resolveTenantPolicyByExternalTenantId(tenantId);
    if (!result.ok) {
      return res.status(result.reason === 'tenant_not_found' ? 404 : 400).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'tenant_policy_read_failed',
      details: error.message
    });
  }
}

async function getTenants(req, res) {
  try {
    const result = await listTenantPolicies();
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'tenants_list_failed',
      details: error.message
    });
  }
}

async function patchTenantPolicy(req, res) {
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim();
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const access = await setActiveTenantForAdmin(actorUserId, tenantId);
    if (!access.ok) {
      return res.status(access.status || 400).json({ success: false, error: access.reason });
    }

    const result = await updateTenantPolicyByExternalTenantId(tenantId, req.body || {});
    if (!result.ok) {
      return res.status(result.reason === 'tenant_not_found' ? 404 : 400).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'tenant_policy_update_failed',
      details: error.message
    });
  }
}

async function postTransferPaymentValidation(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const actorId = String(req.get('x-portal-actor-id') || req.get('x-admin-actor-id') || '').trim();
  const payload = req.body || {};

  try {
    const result = await validateTransferPaymentByExternalTenantId({
      tenantId,
      conversationId: payload.conversationId,
      agendaItemId: payload.agendaItemId,
      action: payload.action,
      reason: payload.reason,
      actorId
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.reason,
        currentStatus: result.currentStatus || undefined
      });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'transfer_payment_validation_failed',
      details: error.message
    });
  }
}

async function getAdminBillingSubscriptions(req, res) {
  const tenantId = String(req.query.tenantId || '').trim();

  try {
    const result = await listSaasSubscriptionsForAdmin({ tenantId });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'billing_subscriptions_list_failed',
      details: error.message
    });
  }
}

async function getAdminMetaEmbeddedSignupReadiness(req, res) {
  try {
    const result = await getMetaEmbeddedSignupReadiness();
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'meta_embedded_signup_readiness_failed',
      details: error && error.message ? error.message : 'unknown_error'
    });
  }
}

async function postAdminBillingSubscription(req, res) {
  const payload = req.body || {};
  const safePayload = sanitizeBillingPayload(payload);

  try {
    const result = await createSaasSubscriptionForTenant(payload);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.reason
      });
    }

    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    const mappedError = mapBillingSubscriptionCreateError(error);
    logError('billing_subscription_create_failed', {
      ...safePayload,
      errorCode: mappedError.error,
      mpStatus: mappedError.upstreamStatus,
      mpBody: mappedError.upstreamBody,
      cause: mappedError.detail
    });
    return res.status(mappedError.status).json({
      success: false,
      error: mappedError.error,
      detail: mappedError.detail,
      upstreamStatus: mappedError.upstreamStatus || undefined,
      upstreamBody: mappedError.upstreamBody || undefined
    });
  }
}

async function getAdminBillingSubscription(req, res) {
  const subscriptionId = String(req.params.id || '').trim();

  try {
    const result = await getSaasSubscriptionDetails(subscriptionId);
    if (!result.ok) {
      return res.status(result.status || 404).json({
        success: false,
        error: result.reason
      });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'billing_subscription_read_failed',
      details: error.message
    });
  }
}

async function postAdminBillingSubscriptionAction(req, res) {
  const subscriptionId = String(req.params.id || '').trim();
  const action = String(req.params.action || '').trim().toLowerCase();

  try {
    const result = await executeSubscriptionAction(subscriptionId, action);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.reason
      });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'billing_subscription_action_failed',
      details: error.message
    });
  }
}

async function postAdminBillingSubscriptionSendLink(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await sendSaasSubscriptionAuthorizationLinkEmail({ tenantId });
    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        error: result.reason
      });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    logError('billing_subscription_send_link_failed', {
      tenantId,
      cause: error && error.message ? error.message : 'unknown_error'
    });
    return res.status(500).json({
      success: false,
      error: 'billing_subscription_send_link_failed',
      detail: error.message
    });
  }
}

async function getAdminAiAssistDiagnostics(req, res) {
  try {
    return res.status(200).json({
      success: true,
      data: getAiAssistRuntimeDiagnostics()
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'ai_assist_diagnostics_failed',
      details: error.message
    });
  }
}

module.exports = {
  postSetActiveTenant,
  getTenants,
  getTenantPolicy,
  patchTenantPolicy,
  postTransferPaymentValidation,
  getAdminBillingSubscriptions,
  postAdminBillingSubscription,
  getAdminBillingSubscription,
  postAdminBillingSubscriptionAction,
  postAdminBillingSubscriptionSendLink,
  getAdminAiAssistDiagnostics,
  getAdminMetaEmbeddedSignupReadiness
};
