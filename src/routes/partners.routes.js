const express = require('express');
const multer = require('multer');
const {
  getPartnerInvitationValidation,
  postPartnerInvitationAcceptance,
  getPartnersMe,
  getPartnersMeSummary,
  getPartnersMeClients,
  getPartnersMeRankProgress,
  getPartnersMeNetwork,
  getPartnersMeCommissions,
  postPartnerClientRequest,
  getPartnerClientRequests,
  getPartnerClientRequest,
  patchPartnerClientRequest,
  postPartnerClientRequestSubmit,
  postPartnerClientRequestCancel,
  getPartnerClientRequestReceipt,
  postPartnerRecruitmentApplication,
  getPartnerRecruitmentApplications,
  getPartnerRecruitmentApplication,
  patchPartnerRecruitmentApplication,
  postPartnerRecruitmentApplicationSubmit,
  postPartnerRecruitmentApplicationCancel
} = require('../controllers/partners.controller');
const { MAX_RECEIPT_BYTES } = require('../services/partner-client-request-receipts.service');
const { authenticatePartnerUser, getPartnerAuthUserByEmail } = require('../services/partners.service');
const { requirePartnerInternalAuth } = require('../middlewares/partner-auth.middleware');
const { requirePortalInternalAuth } = require('../middlewares/portal-internal-auth.middleware');

const router = express.Router();
const clientRequestReceiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_BYTES }
});

function handleClientRequestReceiptUpload(req, res, next) {
  clientRequestReceiptUpload.single('receipt')(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'client_request_receipt_too_large' });
    }
    if (error) {
      return res.status(400).json({ success: false, error: 'invalid_client_request_receipt_upload' });
    }
    return next();
  });
}

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
router.post('/me/client-requests', requirePartnerInternalAuth, handleClientRequestReceiptUpload, postPartnerClientRequest);
router.get('/me/client-requests', requirePartnerInternalAuth, getPartnerClientRequests);
router.get('/me/client-requests/:requestId', requirePartnerInternalAuth, getPartnerClientRequest);
router.patch('/me/client-requests/:requestId', requirePartnerInternalAuth, handleClientRequestReceiptUpload, patchPartnerClientRequest);
router.post('/me/client-requests/:requestId/submit', requirePartnerInternalAuth, postPartnerClientRequestSubmit);
router.post('/me/client-requests/:requestId/cancel', requirePartnerInternalAuth, postPartnerClientRequestCancel);
router.get('/me/client-requests/:requestId/receipt', requirePartnerInternalAuth, getPartnerClientRequestReceipt);
router.post('/me/recruitment-applications', requirePartnerInternalAuth, postPartnerRecruitmentApplication);
router.get('/me/recruitment-applications', requirePartnerInternalAuth, getPartnerRecruitmentApplications);
router.get('/me/recruitment-applications/:applicationId', requirePartnerInternalAuth, getPartnerRecruitmentApplication);
router.patch('/me/recruitment-applications/:applicationId', requirePartnerInternalAuth, patchPartnerRecruitmentApplication);
router.post('/me/recruitment-applications/:applicationId/submit', requirePartnerInternalAuth, postPartnerRecruitmentApplicationSubmit);
router.post('/me/recruitment-applications/:applicationId/cancel', requirePartnerInternalAuth, postPartnerRecruitmentApplicationCancel);

module.exports = router;
