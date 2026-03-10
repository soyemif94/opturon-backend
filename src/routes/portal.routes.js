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
  updatePortalProductStatus
} = require('../controllers/portal.controller');

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

module.exports = router;
