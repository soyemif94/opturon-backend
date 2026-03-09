const { resolvePortalTenantContext } = require('../services/portal-context.service');
const {
  listPortalConversations,
  getPortalConversationDetail,
  patchPortalConversation,
  sendPortalMessage
} = require('../services/portal-inbox.service');

async function getPortalTenantContext(req, res) {
  const tenantId = String(req.params.tenantId || req.query.tenantId || '').trim();

  try {
    const result = await resolvePortalTenantContext(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId
      });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_tenant_context_failed',
      details: error.message
    });
  }
}

async function getPortalConversations(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalConversations(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_conversations_failed',
      details: error.message
    });
  }
}

async function getPortalConversation(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const conversationId = String(req.params.conversationId || '').trim();

  try {
    const result = await getPortalConversationDetail(tenantId, conversationId);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ? 400
          : result.reason === 'mapped_clinic_without_whatsapp_channel' ? 409
            : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result.detail
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_conversation_failed',
      details: error.message
    });
  }
}

async function updatePortalConversation(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const conversationId = String(req.params.conversationId || '').trim();

  try {
    const result = await patchPortalConversation(tenantId, conversationId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ? 400
          : result.reason === 'mapped_clinic_without_whatsapp_channel' ? 409
            : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_conversation_update_failed',
      details: error.message
    });
  }
}

async function postPortalMessage(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const conversationId = String((req.body && req.body.conversationId) || '').trim();
  const text = req.body && req.body.text;

  try {
    const result = await sendPortalMessage(tenantId, conversationId, text);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_text' ? 400
          : result.reason === 'mapped_clinic_without_whatsapp_channel' ? 409
            : result.reason === 'contact_without_waid' ? 422
              : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_message_send_failed',
      details: error.message
    });
  }
}

module.exports = {
  getPortalTenantContext,
  getPortalConversations,
  getPortalConversation,
  updatePortalConversation,
  postPortalMessage
};
