const express = require('express');
const { postSetActiveTenant, getTenantPolicy, patchTenantPolicy } = require('../controllers/admin.controller');
const { requirePortalInternalAuth } = require('../middlewares/portal-internal-auth.middleware');

const router = express.Router();

router.post('/set-active-tenant', requirePortalInternalAuth, postSetActiveTenant);
router.get('/tenants/:tenantId/policy', requirePortalInternalAuth, getTenantPolicy);
router.patch('/tenants/:tenantId/policy', requirePortalInternalAuth, patchTenantPolicy);

module.exports = router;
