const { resolvePortalTenantContext } = require('../services/portal-context.service');
const { logError } = require('../utils/logger');
const {
  listPortalConversations,
  getPortalConversationDetail,
  patchPortalConversation,
  sendPortalMessage
} = require('../services/portal-inbox.service');
const {
  listPortalOrders,
  getPortalOrderDetail,
  createPortalOrder,
  patchPortalOrderStatus
} = require('../services/portal-orders.service');
const {
  listPortalProducts,
  getPortalProductDetail,
  createPortalProduct,
  createPortalProductsBulk,
  patchPortalProduct,
  patchPortalProductStatus
} = require('../services/portal-products.service');
const {
  listPortalUsers,
  invitePortalUser,
  updatePortalUser,
  deletePortalUser,
  authenticatePortalUser,
  getPortalAuthUserByEmail
} = require('../services/portal-users.service');
const {
  listPortalContacts,
  getPortalContactDetail,
  updatePortalContact
} = require('../services/portal-contacts.service');
const {
  listPortalAutomations,
  createPortalAutomation
} = require('../services/portal-automations.service');
const {
  getPortalBusinessSettings,
  updatePortalBusinessSettings
} = require('../services/portal-business.service');
const {
  createPortalWhatsAppSignupSession,
  getPortalWhatsAppSignupStatus,
  finalizePortalWhatsAppSignup
} = require('../services/portal-whatsapp-embedded-signup.service');
const { connectPortalWhatsAppManual } = require('../services/portal-whatsapp-manual-onboarding.service');
const { discoverTenantWhatsAppAssets } = require('../services/portal-whatsapp-discovery.service');
const {
  listPortalWhatsAppTemplateBlueprints,
  listPortalWhatsAppTemplates,
  createPortalWhatsAppTemplateFromBlueprint,
  syncPortalWhatsAppTemplates
} = require('../services/portal-whatsapp-templates.service');

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

async function getPortalOrders(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalOrders(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        orders: result.orders
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_orders_failed',
      details: error.message
    });
  }
}

async function getPortalOrder(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const orderId = String(req.params.orderId || '').trim();

  try {
    const result = await getPortalOrderDetail(tenantId, orderId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' || result.reason === 'missing_order_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result.order
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_order_failed',
      details: error.message
    });
  }
}

async function postPortalOrder(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalOrder(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_customer_name' ||
        result.reason === 'missing_customer_phone' ||
        result.reason === 'missing_order_items' ||
        result.reason === 'invalid_order_item_product' ||
        result.reason === 'invalid_order_item_name' ||
        result.reason === 'invalid_order_item_price' ||
        result.reason === 'invalid_order_item_quantity'
          ? 400
          : result.reason === 'order_item_product_inactive' || result.reason === 'order_item_insufficient_stock'
            ? 409
            : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId,
        details: result.details || null
      });
    }

    return res.status(201).json({
      success: true,
      data: result.order
    });
  } catch (error) {
    logError('portal_order_create_controller_failed', {
      tenantId,
      error: error.message,
      code: error.code || null,
      detail: error.detail || null,
      where: error.where || null,
      constraint: error.constraint || null,
      stack: error.stack || null
    });

    return res.status(500).json({
      success: false,
      error: 'portal_order_create_failed',
      details: error.message,
      debug: {
        message: error.message,
        code: error.code || null,
        detail: error.detail || null,
        where: error.where || null,
        constraint: error.constraint || null
      }
    });
  }
}

async function updatePortalOrderStatus(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const orderId = String(req.params.orderId || '').trim();

  try {
    const result = await patchPortalOrderStatus(tenantId, orderId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_order_id' ||
        result.reason === 'invalid_order_status'
          ? 400
          : result.reason === 'order_item_product_inactive' || result.reason === 'order_item_insufficient_stock'
            ? 409
            : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId,
        details: result.details || null
      });
    }

    return res.status(200).json({
      success: true,
      data: result.order
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_order_status_update_failed',
      details: error.message
    });
  }
}

async function getPortalProducts(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalProducts(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        products: result.products
      }
    });
  } catch (error) {
    logError('portal_products_failed', {
      tenantId,
      error: error.message,
      code: error.code || null,
      detail: error.detail || null,
      where: error.where || null,
      constraint: error.constraint || null,
      stack: error.stack || null
    });

    return res.status(500).json({
      success: false,
      error: 'portal_products_failed',
      details: error.message,
      debug: {
        message: error.message,
        code: error.code || null,
        detail: error.detail || null,
        where: error.where || null,
        constraint: error.constraint || null
      }
    });
  }
}

async function getPortalProduct(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const productId = String(req.params.productId || '').trim();

  try {
    const result = await getPortalProductDetail(tenantId, productId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' || result.reason === 'missing_product_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result.product
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_product_failed',
      details: error.message
    });
  }
}

async function postPortalProduct(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalProduct(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_product_name' ||
        result.reason === 'invalid_product_price' ||
        result.reason === 'invalid_product_stock' ||
        result.reason === 'invalid_product_status'
          ? 400
          : 404;

      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(201).json({
      success: true,
      data: result.product
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_product_create_failed',
      details: error.message
    });
  }
}

async function postPortalProductsBulk(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalProductsBulk(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_bulk_items'
          ? 400
          : 404;

      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        created: result.created,
        failed: result.failed,
        results: result.results
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_product_bulk_create_failed',
      details: error.message
    });
  }
}

async function updatePortalProduct(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const productId = String(req.params.productId || '').trim();

  try {
    const result = await patchPortalProduct(tenantId, productId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_product_id' ||
        result.reason === 'missing_product_name' ||
        result.reason === 'invalid_product_price' ||
        result.reason === 'invalid_product_stock' ||
        result.reason === 'invalid_product_status'
          ? 400
          : 404;

      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result.product
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_product_update_failed',
      details: error.message
    });
  }
}

async function updatePortalProductStatus(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const productId = String(req.params.productId || '').trim();

  try {
    const result = await patchPortalProductStatus(tenantId, productId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_product_id' ||
        result.reason === 'invalid_product_status'
          ? 400
          : 404;

      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result.product
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_product_status_update_failed',
      details: error.message
    });
  }
}

async function getPortalUsers(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalUsers(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        users: result.users
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_users_failed',
      details: error.message
    });
  }
}

async function getPortalContacts(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalContacts(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        contacts: result.contacts
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_contacts_failed',
      details: error.message
    });
  }
}

async function getPortalContact(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const contactId = String(req.params.contactId || '').trim();

  try {
    const result = await getPortalContactDetail(tenantId, contactId);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_contact_id'
          ? 400
          : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result.contact
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_contact_failed',
      details: error.message
    });
  }
}

async function patchPortalContact(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const contactId = String(req.params.contactId || '').trim();

  try {
    const result = await updatePortalContact(tenantId, contactId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_contact_id' ||
        result.reason === 'missing_contact_name' ||
        result.reason === 'invalid_contact_email'
          ? 400
          : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId
      });
    }

    return res.status(200).json({
      success: true,
      data: result.contact
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_contact_update_failed',
      details: error.message
    });
  }
}

async function getPortalBusiness(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getPortalBusinessSettings(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, detail: result.detail || null, tenantId: result.tenantId || tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_business_failed',
      details: error.message
    });
  }
}

async function getPortalAutomations(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalAutomations(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId || tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        automations: result.automations
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_automations_failed',
      details: error.message
    });
  }
}

async function postPortalUser(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await invitePortalUser(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'invalid_name' ||
        result.reason === 'invalid_email' ||
        result.reason === 'invalid_role' ||
        result.reason === 'invalid_password'
          ? 400
          : result.reason === 'duplicate_user_email'
            ? 409
            : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(201).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        user: result.user
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_user_create_failed',
      details: error.message
    });
  }
}

async function patchPortalBusiness(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await updatePortalBusinessSettings(tenantId, req.body || {});
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, detail: result.detail || null, tenantId: result.tenantId || tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_business_update_failed',
      details: error.message
    });
  }
}

async function postPortalAutomation(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalAutomation(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_automation_name' ||
        result.reason === 'invalid_automation_trigger' ||
        result.reason === 'missing_automation_keyword' ||
        result.reason === 'missing_automation_actions' ||
        result.reason === 'invalid_automation_action' ||
        result.reason === 'missing_automation_message' ||
        result.reason === 'missing_automation_tag'
          ? 400
          : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        automation: result.automation
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_automation_create_failed',
      details: error.message
    });
  }
}

async function patchPortalUser(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const userId = String(req.params.userId || '').trim();

  try {
    const result = await updatePortalUser(tenantId, userId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'invalid_role'
          ? 400
          : result.reason === 'cannot_delete_last_owner'
            ? 409
            : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        user: result.user
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_user_update_failed',
      details: error.message
    });
  }
}

async function destroyPortalUser(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const userId = String(req.params.userId || '').trim();
  const currentUserId = String(req.get('x-portal-actor-id') || '').trim();

  try {
    const result = await deletePortalUser(tenantId, userId, currentUserId);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'cannot_delete_current_user'
          ? 400
          : result.reason === 'cannot_delete_last_owner'
            ? 409
            : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        userId: result.userId
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_user_delete_failed',
      details: error.message
    });
  }
}

async function postPortalAuthLogin(req, res) {
  const email = req.body && req.body.email;
  const password = req.body && req.body.password;

  try {
    const result = await authenticatePortalUser(email, password);
    if (!result.ok) {
      return res.status(401).json({ success: false, error: result.reason });
    }

    return res.status(200).json({
      success: true,
      data: result.user
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_auth_login_failed',
      details: error.message
    });
  }
}

async function getPortalAuthUser(req, res) {
  const email = String(req.query.email || '').trim();

  try {
    const result = await getPortalAuthUserByEmail(email);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.reason });
    }

    return res.status(200).json({
      success: true,
      data: result.user
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_auth_user_lookup_failed',
      details: error.message
    });
  }
}

async function postPortalWhatsAppEmbeddedSignupBootstrap(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const redirectUri = String((req.body && req.body.redirectUri) || '').trim();
  const actorUserId = String((req.body && req.body.actorUserId) || '').trim() || null;

  try {
    const result = await createPortalWhatsAppSignupSession({
      tenantId,
      redirectUri,
      actorUserId,
      metadata: req.body && req.body.metadata ? req.body.metadata : null
    });

    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_redirect_uri'
          ? 400
          : result.reason === 'tenant_mapping_not_found'
            ? 404
            : 409;

      return res.status(status).json({
        success: false,
        error: result.reason,
        detail: result.detail || null,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(result.ready ? 200 : 202).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_whatsapp_embedded_signup_bootstrap_failed',
      details: error.message
    });
  }
}

async function getPortalWhatsAppEmbeddedSignupStatus(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getPortalWhatsAppSignupStatus(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({
        success: false,
        error: result.reason,
        detail: result.detail || null,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_whatsapp_embedded_signup_status_failed',
      details: error.message
    });
  }
}

async function postPortalWhatsAppEmbeddedSignupFinalize(req, res) {
  try {
    const result = await finalizePortalWhatsAppSignup({
      stateToken: req.body && req.body.stateToken,
      code: req.body && req.body.code,
      redirectUri: req.body && req.body.redirectUri,
      metaPayload: req.body && req.body.metaPayload ? req.body.metaPayload : null,
      requestId: req.body && req.body.requestId ? String(req.body.requestId) : null,
      error: req.body && req.body.error ? String(req.body.error) : null,
      errorDescription: req.body && req.body.errorDescription ? String(req.body.errorDescription) : null
    });

    if (!result.ok) {
      const status =
        result.reason === 'missing_state_token' ||
        result.reason === 'missing_meta_code' ||
        result.reason === 'embedded_signup_redirect_uri_mismatch'
          ? 400
          : result.reason === 'embedded_signup_session_not_found'
            ? 404
            : result.reason === 'channel_belongs_to_another_workspace'
              ? 409
              : 422;

      return res.status(status).json({
        success: false,
        error: result.reason,
        detail: result.detail || null
      });
    }

    return res.status(result.status === 'connected' ? 200 : 202).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_whatsapp_embedded_signup_finalize_failed',
      details: error.message
    });
  }
}

async function postPortalWhatsAppManualConnect(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await connectPortalWhatsAppManual(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_waba_id' ||
        result.reason === 'missing_phone_number_id' ||
        result.reason === 'missing_access_token'
          ? 400
          : result.reason === 'WHATSAPP_CHANNEL_ALREADY_CONNECTED' ||
              result.reason === 'PHONE_NUMBER_NOT_IN_WABA'
            ? 409
            : result.reason === 'tenant_mapping_not_found'
              ? 404
              : result.reason === 'WHATSAPP_TOKEN_INVALID' || result.reason === 'WABA_NOT_ACCESSIBLE'
                ? 422
                : 422;

      return res.status(status).json({
        success: false,
        error: result.reason,
        detail: result.detail || null,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(result.status === 'connected' ? 200 : 202).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_whatsapp_manual_connect_failed',
      details: error.message
    });
  }
}

async function postPortalWhatsAppDiscoverAssets(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await discoverTenantWhatsAppAssets(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_access_token'
          ? 400
          : result.reason === 'tenant_mapping_not_found'
            ? 404
            : result.reason === 'WHATSAPP_TOKEN_INVALID' || result.reason === 'WABA_NOT_ACCESSIBLE'
              ? 422
              : 422;

      return res.status(status).json({
        success: false,
        error: result.reason,
        detail: result.detail || null,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_whatsapp_discover_assets_failed',
      details: error.message
    });
  }
}

async function getPortalWhatsAppTemplateBlueprints(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalWhatsAppTemplateBlueprints(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        blueprints: result.blueprints
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_whatsapp_template_blueprints_failed',
      details: error.message
    });
  }
}

async function getPortalWhatsAppTemplates(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalWhatsAppTemplates(tenantId);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id'
          ? 400
          : result.reason === 'mapped_clinic_without_whatsapp_channel' || result.reason === 'whatsapp_channel_not_ready'
            ? 409
            : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        detail: result.detail || null,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        templates: result.templates
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_whatsapp_templates_failed',
      details: error.message
    });
  }
}

async function postPortalWhatsAppTemplateFromBlueprint(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalWhatsAppTemplateFromBlueprint(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_template_key' ||
        result.reason === 'invalid_template_category'
          ? 400
          : result.reason === 'mapped_clinic_without_whatsapp_channel' ||
              result.reason === 'whatsapp_channel_not_ready' ||
              result.reason === 'meta_template_create_failed'
            ? 409
            : result.reason === 'template_blueprint_not_found'
              ? 404
              : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        detail: result.detail || null,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(result.created ? 201 : 200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        template: result.template,
        created: result.created
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_whatsapp_template_create_failed',
      details: error.message
    });
  }
}

async function postPortalWhatsAppTemplatesSync(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await syncPortalWhatsAppTemplates(tenantId);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id'
          ? 400
          : result.reason === 'mapped_clinic_without_whatsapp_channel' ||
              result.reason === 'whatsapp_channel_not_ready' ||
              result.reason === 'meta_templates_sync_failed'
            ? 409
            : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        detail: result.detail || null,
        tenantId: result.tenantId || tenantId
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        templates: result.templates,
        syncedCount: result.syncedCount
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_whatsapp_templates_sync_failed',
      details: error.message
    });
  }
}

module.exports = {
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
  patchPortalBusiness,
  postPortalAutomation,
  postPortalUser,
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
};
