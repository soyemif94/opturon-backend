const express = require('express');
const {
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
} = require('../controllers/admin.controller');
const { requirePortalInternalAuth } = require('../middlewares/portal-internal-auth.middleware');

const router = express.Router();

router.post('/set-active-tenant', requirePortalInternalAuth, postSetActiveTenant);
router.get('/tenants', requirePortalInternalAuth, getTenants);
router.get('/tenants/:tenantId/policy', requirePortalInternalAuth, getTenantPolicy);
router.patch('/tenants/:tenantId/policy', requirePortalInternalAuth, patchTenantPolicy);
router.post('/tenants/:tenantId/transfer-payments/validation', requirePortalInternalAuth, postTransferPaymentValidation);
router.get('/billing/subscriptions', requirePortalInternalAuth, getAdminBillingSubscriptions);
router.post('/billing/subscriptions', requirePortalInternalAuth, postAdminBillingSubscription);
router.get('/billing/subscriptions/:id', requirePortalInternalAuth, getAdminBillingSubscription);
router.post('/billing/subscriptions/:id/:action(cancel|pause|reactivate)', requirePortalInternalAuth, postAdminBillingSubscriptionAction);
router.post('/tenants/:tenantId/billing/subscription/send-link', requirePortalInternalAuth, postAdminBillingSubscriptionSendLink);
router.get('/diagnostics/ai-assist', requirePortalInternalAuth, getAdminAiAssistDiagnostics);
router.get('/meta/embedded-signup/readiness', requirePortalInternalAuth, getAdminMetaEmbeddedSignupReadiness);

module.exports = router;
