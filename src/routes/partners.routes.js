const express = require('express');
const {
  getPartnerInvitationValidation,
  postPartnerInvitationAcceptance,
  getPartnersMe,
  getPartnersMeSummary,
  getPartnersMeClients,
  getPartnersMeRankProgress,
  getPartnersMeNetwork,
  getPartnersMeCommissions
} = require('../controllers/partners.controller');
const { authenticatePartnerUser, getPartnerAuthUserByEmail } = require('../services/partners.service');
const { requirePartnerInternalAuth } = require('../middlewares/partner-auth.middleware');
const { requirePortalInternalAuth } = require('../middlewares/portal-internal-auth.middleware');

const router = express.Router();

router.post('/auth/login', async (req, res) => {
  try {
    const result = await authenticatePartnerUser(req.body && req.body.email, req.body && req.body.password);
    if (!result.ok) {
      return res.status(401).json({ success: false, error: result.reason });
    }
    return res.status(200).json({ success: true, data: result.user });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_auth_login_failed', details: error.message });
  }
});

router.get('/invitations/validate', async (req, res) => getPartnerInvitationValidation(req, res));
router.post('/invitations/accept', async (req, res) => postPartnerInvitationAcceptance(req, res));

router.get('/auth/users/by-email', requirePortalInternalAuth, async (req, res) => {
  try {
    const result = await getPartnerAuthUserByEmail(req.query.email);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.reason });
    }
    return res.status(200).json({ success: true, data: result.user });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_auth_user_lookup_failed', details: error.message });
  }
});

router.get('/me', requirePartnerInternalAuth, getPartnersMe);
router.get('/me/summary', requirePartnerInternalAuth, getPartnersMeSummary);
router.get('/me/clients', requirePartnerInternalAuth, getPartnersMeClients);
router.get('/me/rank-progress', requirePartnerInternalAuth, getPartnersMeRankProgress);
router.get('/me/network', requirePartnerInternalAuth, getPartnersMeNetwork);
router.get('/me/commissions', requirePartnerInternalAuth, getPartnersMeCommissions);

module.exports = router;
