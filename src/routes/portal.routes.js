const express = require('express');
const {
  getPortalTenantContext,
  getPortalConversations,
  getPortalConversation,
  updatePortalConversation,
  postPortalMessage
} = require('../controllers/portal.controller');

const router = express.Router();

router.get('/tenants/:tenantId/context', getPortalTenantContext);
router.get('/tenants/:tenantId/conversations', getPortalConversations);
router.get('/tenants/:tenantId/conversations/:conversationId', getPortalConversation);
router.patch('/tenants/:tenantId/conversations/:conversationId', updatePortalConversation);
router.post('/tenants/:tenantId/messages', postPortalMessage);

module.exports = router;
