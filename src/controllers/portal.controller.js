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
  getPortalUsers,
  postPortalUser,
  patchPortalUser,
  destroyPortalUser,
  postPortalAuthLogin,
  getPortalAuthUser
};
