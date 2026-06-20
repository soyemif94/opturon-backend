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

function getPartnerActorId(req) {
  return String((req.partnerAuth && req.partnerAuth.partnerId) || '').trim();
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

module.exports = {
  getPartnerInvitationValidation,
  postPartnerInvitationAcceptance,
  getPartnersMe,
  getPartnersMeSummary,
  getPartnersMeClients,
  getPartnersMeRankProgress,
  getPartnersMeNetwork,
  getPartnersMeCommissions
};
