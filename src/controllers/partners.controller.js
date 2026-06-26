const {
  resolvePartnerInvitation,
  acceptPartnerInvitation,
  getPartnerMe,
  getPartnerSummary,
  getPartnerClients,
  getPartnerRankProgress,
  getPartnerNetwork,
  getPartnerCommissionLedger
} = require('../services/partners.service');
const {
  createRequestForPartner,
  listRequestsForPartner,
  getRequestForPartner,
  updateRequestForPartner,
  submitRequestForPartner,
  cancelRequestForPartner,
  getReceiptForPartner
} = require('../services/partner-client-requests.service');
const {
  createApplicationForPartner,
  listApplicationsForPartner,
  getApplicationForPartner,
  updateApplicationForPartner,
  submitApplicationForPartner,
  cancelApplicationForPartner
} = require('../services/partner-recruitment-applications.service');

function getPartnerActorId(req) {
  return String((req.partnerAuth && req.partnerAuth.partnerId) || '').trim();
}

function getPartnerIdentityTraceId(req) {
  return String((req.partnerAuth && req.partnerAuth.traceId) || req.get('x-partner-identity-trace-id') || '').trim();
}

async function getPartnersMe(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await getPartnerMe(partnerId);
    if (!result.ok) {
      return res.status(result.reason === 'partner_not_found' ? 404 : 400).json({ success: false, error: result.reason });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_me_failed', details: error.message });
  }
}

async function getPartnerInvitationValidation(req, res) {
  try {
    const result = await resolvePartnerInvitation(req.query && req.query.token);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.reason });
    }
    return res.status(200).json({ success: true, data: result.invitation });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_invitation_lookup_failed', details: error.message });
  }
}

async function postPartnerInvitationAcceptance(req, res) {
  try {
    const result = await acceptPartnerInvitation(req.body && req.body.token, req.body && req.body.password);
    if (!result.ok) {
      return res.status(result.reason === 'partner_not_found' ? 404 : 400).json({ success: false, error: result.reason });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_invitation_accept_failed', details: error.message });
  }
}

async function getPartnersMeSummary(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await getPartnerSummary(partnerId);
    if (!result.ok) {
      return res.status(result.reason === 'partner_not_found' ? 404 : 400).json({ success: false, error: result.reason });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_summary_failed', details: error.message });
  }
}

async function getPartnersMeClients(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await getPartnerClients(partnerId);
    if (!result.ok) {
      return res.status(result.reason === 'partner_not_found' ? 404 : 400).json({ success: false, error: result.reason });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_clients_failed', details: error.message });
  }
}

async function getPartnersMeRankProgress(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await getPartnerRankProgress(partnerId);
    if (!result.ok) {
      return res.status(result.reason === 'partner_not_found' ? 404 : 400).json({ success: false, error: result.reason });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_rank_progress_failed', details: error.message });
  }
}

async function getPartnersMeNetwork(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await getPartnerNetwork(partnerId);
    if (!result.ok) {
      return res.status(result.reason === 'partner_not_found' ? 404 : 400).json({ success: false, error: result.reason });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_network_failed', details: error.message });
  }
}

async function getPartnersMeCommissions(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await getPartnerCommissionLedger(partnerId, req.query || {});
    if (!result.ok) {
      return res.status(result.reason === 'partner_not_found' ? 404 : 400).json({ success: false, error: result.reason });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_commissions_failed', details: error.message });
  }
}

function sendClientRequestResult(res, result) {
  if (!result.ok) {
    const status = result.reason === 'client_request_not_found'
      ? 404
      : result.reason === 'partner_identity_invalid' || result.reason === 'partner_inactive'
        ? 403
      : result.reason === 'partner_unauthorized'
        ? 401
      : result.reason === 'client_request_not_editable' || result.reason === 'invalid_client_request_transition'
        ? 409
        : 400;
    return res.status(status).json({ success: false, error: result.reason });
  }
  return res.status(200).json({ success: true, data: result });
}

async function postPartnerClientRequest(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await createRequestForPartner(partnerId, req.body || {}, req.file || null, {
      traceId: getPartnerIdentityTraceId(req),
      requestPath: req.originalUrl || req.path
    });
    return sendClientRequestResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_client_request_create_failed', details: error.message });
  }
}

async function getPartnerClientRequests(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await listRequestsForPartner(partnerId, req.query || {}, {
      traceId: getPartnerIdentityTraceId(req),
      requestPath: req.originalUrl || req.path
    });
    return sendClientRequestResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_client_requests_failed', details: error.message });
  }
}

async function getPartnerClientRequest(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await getRequestForPartner(partnerId, req.params && req.params.requestId);
    return sendClientRequestResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_client_request_failed', details: error.message });
  }
}

async function patchPartnerClientRequest(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await updateRequestForPartner(partnerId, req.params && req.params.requestId, req.body || {}, req.file || null);
    return sendClientRequestResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_client_request_update_failed', details: error.message });
  }
}

async function postPartnerClientRequestSubmit(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await submitRequestForPartner(partnerId, req.params && req.params.requestId);
    return sendClientRequestResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_client_request_submit_failed', details: error.message });
  }
}

async function postPartnerClientRequestCancel(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await cancelRequestForPartner(partnerId, req.params && req.params.requestId);
    return sendClientRequestResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_client_request_cancel_failed', details: error.message });
  }
}

async function getPartnerClientRequestReceipt(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await getReceiptForPartner(partnerId, req.params && req.params.requestId, {
      actorType: 'partner',
      actorPartnerId: partnerId
    });
    if (!result.ok) {
      return res.status(result.reason === 'client_request_not_found' ? 404 : 400).json({ success: false, error: result.reason });
    }
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.fileName)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(result.buffer);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_client_request_receipt_failed', details: error.message });
  }
}

function sendRecruitmentApplicationResult(res, result) {
  if (!result.ok) {
    const status = result.reason === 'partner_recruitment_application_not_found'
      ? 404
      : result.reason === 'partner_identity_invalid' || result.reason === 'partner_inactive'
        ? 403
      : result.reason === 'partner_unauthorized'
        ? 401
      : result.reason === 'partner_recruitment_application_not_editable' || result.reason === 'invalid_partner_recruitment_transition'
        ? 409
        : 400;
    return res.status(status).json({ success: false, error: result.reason, duplicateWarnings: result.duplicateWarnings || undefined });
  }
  return res.status(200).json({ success: true, data: result });
}

async function postPartnerRecruitmentApplication(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await createApplicationForPartner(partnerId, req.body || {}, {
      traceId: getPartnerIdentityTraceId(req),
      requestPath: req.originalUrl || req.path
    });
    return sendRecruitmentApplicationResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_recruitment_application_create_failed', details: error.message });
  }
}

async function getPartnerRecruitmentApplications(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await listApplicationsForPartner(partnerId, req.query || {}, {
      traceId: getPartnerIdentityTraceId(req),
      requestPath: req.originalUrl || req.path
    });
    return sendRecruitmentApplicationResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_recruitment_applications_failed', details: error.message });
  }
}

async function getPartnerRecruitmentApplication(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await getApplicationForPartner(partnerId, req.params && req.params.applicationId);
    return sendRecruitmentApplicationResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_recruitment_application_failed', details: error.message });
  }
}

async function patchPartnerRecruitmentApplication(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await updateApplicationForPartner(partnerId, req.params && req.params.applicationId, req.body || {});
    return sendRecruitmentApplicationResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_recruitment_application_update_failed', details: error.message });
  }
}

async function postPartnerRecruitmentApplicationSubmit(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await submitApplicationForPartner(partnerId, req.params && req.params.applicationId);
    return sendRecruitmentApplicationResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_recruitment_application_submit_failed', details: error.message });
  }
}

async function postPartnerRecruitmentApplicationCancel(req, res) {
  const partnerId = getPartnerActorId(req);
  try {
    const result = await cancelApplicationForPartner(partnerId, req.params && req.params.applicationId);
    return sendRecruitmentApplicationResult(res, result);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'partner_recruitment_application_cancel_failed', details: error.message });
  }
}

module.exports = {
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
};
