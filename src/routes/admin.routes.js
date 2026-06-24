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
  getAdminMetaEmbeddedSignupReadiness,
  getAdminPartners,
  postAdminPartner,
  postAdminPartnerInvite,
  getAdminPartner,
  patchAdminPartnerStatus,
  postAdminPartnerSponsor,
  postAdminPartnerAttribution,
  postAdminPartnerResendInvite,
  postAdminPartnerCancelInvitation,
  postAdminPartnerDeactivate,
  postAdminPartnerRankEvaluation,
  getAdminPartnerCommissionPlans,
  postAdminPartnerCommissionPlan,
  postAdminPartnerCommissionPlanVersion,
  postAdminPartnerCommissionSimulation,
  postAdminPartnerCommissionGeneration,
  postAdminPartnerCommissionReverse,
  getAdminPartnerClientRequests,
  getAdminPartnerClientRequest,
  postAdminPartnerClientRequestReview,
  postAdminPartnerClientRequestProcess,
  getAdminPartnerClientRequestReceipt
} = require('../controllers/admin.controller');
const { requirePortalInternalAuth } = require('../middlewares/portal-internal-auth.middleware');
const { requireAdminInternalActor } = require('../middlewares/partner-auth.middleware');

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
router.get('/partners', requireAdminInternalActor, getAdminPartners);
router.post('/partners', requireAdminInternalActor, postAdminPartner);
router.post('/partners/invite', requireAdminInternalActor, postAdminPartnerInvite);
router.get('/partners/commission-plans', requireAdminInternalActor, getAdminPartnerCommissionPlans);
router.post('/partners/commission-plans', requireAdminInternalActor, postAdminPartnerCommissionPlan);
router.post('/partners/commission-plans/:planCode/versions', requireAdminInternalActor, postAdminPartnerCommissionPlanVersion);
router.post('/partners/commissions/simulate', requireAdminInternalActor, postAdminPartnerCommissionSimulation);
router.post('/partners/commissions/generate-controlled', requireAdminInternalActor, postAdminPartnerCommissionGeneration);
router.post('/partners/commissions/reverse-controlled', requireAdminInternalActor, postAdminPartnerCommissionReverse);
router.get('/partners/client-requests', requireAdminInternalActor, getAdminPartnerClientRequests);
router.get('/partners/client-requests/:requestId', requireAdminInternalActor, getAdminPartnerClientRequest);
router.get('/partners/client-requests/:requestId/receipt', requireAdminInternalActor, getAdminPartnerClientRequestReceipt);
router.post('/partners/client-requests/:requestId/process', requireAdminInternalActor, postAdminPartnerClientRequestProcess);
router.post('/partners/client-requests/:requestId/:action(approve|reject|request_changes)', requireAdminInternalActor, postAdminPartnerClientRequestReview);
router.get('/partners/:partnerId', requireAdminInternalActor, getAdminPartner);
router.patch('/partners/:partnerId/status', requireAdminInternalActor, patchAdminPartnerStatus);
router.post('/partners/:partnerId/resend-invite', requireAdminInternalActor, postAdminPartnerResendInvite);
router.post('/partners/:partnerId/cancel-invitation', requireAdminInternalActor, postAdminPartnerCancelInvitation);
router.post('/partners/:partnerId/deactivate', requireAdminInternalActor, postAdminPartnerDeactivate);
router.post('/partners/:partnerId/sponsor', requireAdminInternalActor, postAdminPartnerSponsor);
router.post('/partners/:partnerId/attributions', requireAdminInternalActor, postAdminPartnerAttribution);
router.post('/partners/:partnerId/rank/evaluate', requireAdminInternalActor, postAdminPartnerRankEvaluation);

module.exports = router;
