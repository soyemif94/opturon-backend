const express = require('express');
const {
  getPortalTenantContext,
  getPortalConversations,
  getPortalConversation,
  updatePortalConversation,
  postPortalMessage,
  getPortalOrders,
  getPortalOrder,
  postPortalOrder,
  updatePortalOrderStatus,
  getPortalProducts,
  getPortalProduct,
  postPortalProduct,
  postPortalProductsBulk,
  updatePortalProduct,
  updatePortalProductStatus,
  getPortalContacts,
  getPortalContact,
  patchPortalContact,
  getPortalAutomations,
  getPortalBusiness,
  getPortalUsers,
  postPortalUser,
  postPortalAutomation,
  patchPortalBusiness,
  patchPortalUser,
  destroyPortalUser,
  postPortalAuthLogin,
  getPortalAuthUser,
  postPortalWhatsAppEmbeddedSignupBootstrap,
  getPortalWhatsAppEmbeddedSignupStatus,
  postPortalWhatsAppEmbeddedSignupFinalize,
  postPortalWhatsAppManualConnect,
  postPortalWhatsAppDiscoverAssets,
  getPortalWhatsAppTemplateBlueprints,
  getPortalWhatsAppTemplates,
  postPortalWhatsAppTemplateFromBlueprint,
  postPortalWhatsAppTemplatesSync
} = require('../controllers/portal.controller');
const { requirePortalInternalAuth } = require('../middlewares/portal-internal-auth.middleware');

const router = express.Router();

router.get('/tenants/:tenantId/context', getPortalTenantContext);
router.get('/tenants/:tenantId/conversations', getPortalConversations);
router.get('/tenants/:tenantId/conversations/:conversationId', getPortalConversation);
router.patch('/tenants/:tenantId/conversations/:conversationId', updatePortalConversation);
router.post('/tenants/:tenantId/messages', postPortalMessage);
router.get('/tenants/:tenantId/orders', getPortalOrders);
router.post('/tenants/:tenantId/orders', postPortalOrder);
router.get('/tenants/:tenantId/orders/:orderId', getPortalOrder);
router.patch('/tenants/:tenantId/orders/:orderId/status', updatePortalOrderStatus);
router.get('/tenants/:tenantId/products', getPortalProducts);
router.post('/tenants/:tenantId/products', postPortalProduct);
router.post('/tenants/:tenantId/products/bulk', postPortalProductsBulk);
router.get('/tenants/:tenantId/products/:productId', getPortalProduct);
router.patch('/tenants/:tenantId/products/:productId', updatePortalProduct);
router.patch('/tenants/:tenantId/products/:productId/status', updatePortalProductStatus);
router.get('/tenants/:tenantId/contacts', getPortalContacts);
router.get('/tenants/:tenantId/contacts/:contactId', getPortalContact);
router.patch('/tenants/:tenantId/contacts/:contactId', patchPortalContact);
router.get('/tenants/:tenantId/automations', requirePortalInternalAuth, getPortalAutomations);
router.post('/tenants/:tenantId/automations', requirePortalInternalAuth, postPortalAutomation);
router.get('/tenants/:tenantId/business', requirePortalInternalAuth, getPortalBusiness);
router.patch('/tenants/:tenantId/business', requirePortalInternalAuth, patchPortalBusiness);
router.get('/tenants/:tenantId/whatsapp/embedded-signup/status', requirePortalInternalAuth, getPortalWhatsAppEmbeddedSignupStatus);
router.post('/tenants/:tenantId/whatsapp/embedded-signup/bootstrap', requirePortalInternalAuth, postPortalWhatsAppEmbeddedSignupBootstrap);
router.post('/tenants/:tenantId/whatsapp/embedded-signup/finalize', requirePortalInternalAuth, postPortalWhatsAppEmbeddedSignupFinalize);
router.post('/tenants/:tenantId/whatsapp/manual-connect', requirePortalInternalAuth, postPortalWhatsAppManualConnect);
router.post('/tenants/:tenantId/whatsapp/discover-assets', requirePortalInternalAuth, postPortalWhatsAppDiscoverAssets);
router.get('/tenants/:tenantId/whatsapp/templates/blueprints', requirePortalInternalAuth, getPortalWhatsAppTemplateBlueprints);
router.get('/tenants/:tenantId/whatsapp/templates', requirePortalInternalAuth, getPortalWhatsAppTemplates);
router.post('/tenants/:tenantId/whatsapp/templates/create-from-blueprint', requirePortalInternalAuth, postPortalWhatsAppTemplateFromBlueprint);
router.post('/tenants/:tenantId/whatsapp/templates/sync', requirePortalInternalAuth, postPortalWhatsAppTemplatesSync);
router.get('/tenants/:tenantId/users', requirePortalInternalAuth, getPortalUsers);
router.post('/tenants/:tenantId/users', requirePortalInternalAuth, postPortalUser);
router.patch('/tenants/:tenantId/users/:userId', requirePortalInternalAuth, patchPortalUser);
router.delete('/tenants/:tenantId/users/:userId', requirePortalInternalAuth, destroyPortalUser);
router.post('/auth/login', postPortalAuthLogin);
router.get('/auth/users/by-email', requirePortalInternalAuth, getPortalAuthUser);

module.exports = router;
