const { registerPortalOwnerAccount } = require('../services/portal-users.service');
const {
  createPortalSaasCheckout,
  getPortalSaasCheckoutStatus
} = require('../services/saas-billing.service');

function respond(res, result, successStatus = 200) {
  res.set('Cache-Control', 'private, no-store');
  if (!result || result.ok !== true) {
    const error = String(result && result.reason || 'billing_request_failed');
    const status = Number.isInteger(result && result.status) ? result.status :
      error === 'email_already_registered' ? 409 :
        error.startsWith('invalid_') ? 400 : 500;
    const allowed = new Set([
      'invalid_request', 'invalid_name', 'invalid_business_name', 'invalid_email',
      'invalid_password', 'email_already_registered', 'registration_unavailable',
      'billing_actor_forbidden', 'invalid_plan_key', 'enterprise_contact_required',
      'subscription_already_exists', 'subscription_multiple_non_terminal',
      'subscription_provisioning_requires_reconciliation', 'subscription_contract_required',
      'plan_price_decision_required', 'legacy_plan_requires_selection',
      'tenant_not_found', 'checkout_contract_unavailable', 'checkout_authorization_unavailable'
    ]);
    return res.status(status).json({
      success: false,
      error: allowed.has(error) ? error : 'billing_request_failed',
      ...(result && result.contactPath === '/contacto' ? { contactPath: '/contacto' } : {})
    });
  }
  return res.status(successStatus).json({ success: true, data: result.data || result.user || result.checkout || result.status });
}

function hasOnlyKeys(body, keys) {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(key => keys.includes(key)));
}

async function postPortalAuthRegister(req, res) {
  if (!hasOnlyKeys(req.body, ['name', 'businessName', 'email', 'password'])) {
    return respond(res, { ok: false, reason: 'invalid_request', status: 400 });
  }
  try {
    const result = await registerPortalOwnerAccount(req.body);
    if (!result.ok) return respond(res, result);
    return respond(res, { ...result, data: result.user }, 201);
  } catch (error) {
    return respond(res, { ok: false, reason: 'registration_unavailable', status: 500 });
  }
}

async function postPortalBillingCheckout(req, res) {
  if (!hasOnlyKeys(req.body, ['planKey']) || typeof req.body.planKey !== 'string') {
    return respond(res, { ok: false, reason: 'invalid_request', status: 400 });
  }
  const tenantId = String(req.params.tenantId || '').trim();
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim();
  try {
    const result = await createPortalSaasCheckout({ tenantId, actorUserId, planKey: req.body.planKey });
    return respond(res, result, result.ok && result.checkout.reused ? 200 : 201);
  } catch (error) {
    return respond(res, { ok: false, reason: 'billing_request_failed', status: 502 });
  }
}

async function getPortalBillingCheckoutStatus(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim();
  try {
    return respond(res, await getPortalSaasCheckoutStatus({ tenantId, actorUserId }));
  } catch (error) {
    return respond(res, { ok: false, reason: 'billing_request_failed', status: 502 });
  }
}

module.exports = {
  postPortalAuthRegister,
  postPortalBillingCheckout,
  getPortalBillingCheckoutStatus
};
