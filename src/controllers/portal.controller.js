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
  listPortalInvoices,
  getPortalInvoiceDetail,
  listPortalInvoiceAllocations,
  createPortalInvoice,
  updatePortalInvoice,
  updatePortalInvoiceAccounting,
  issuePortalInvoice,
  voidPortalInvoice,
  exportPortalInvoicesCsv,
  renderPortalInvoiceDocument
} = require('../services/portal-invoices.service');
const {
  listPortalProducts,
  getPortalProductDetail,
  createPortalProduct,
  createPortalProductsBulk,
  patchPortalProduct,
  patchPortalProductStatus,
  deletePortalProduct
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
  listPortalPayments,
  getPortalPaymentDetail,
  createPortalPayment,
  createPortalPaymentAllocation,
  listPortalPaymentAllocations,
  voidPortalPayment
} = require('../services/portal-payments.service');
const {
  getSalesSummary,
  getSalesMetrics,
  listSalesOpportunities
} = require('../services/portal-sales.service');
const {
  listPortalContacts,
  getPortalContactDetail,
  createPortalContact,
  updatePortalContact
} = require('../services/portal-contacts.service');
const {
  getPortalLoyaltyProgram,
  updatePortalLoyaltyProgram,
  listPortalLoyaltyRewards,
  createPortalLoyaltyReward,
  updatePortalLoyaltyReward,
  getPortalLoyaltyContactDetail,
  getPortalLoyaltyOverview,
  redeemPortalLoyaltyReward
} = require('../services/portal-loyalty.service');
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
  getPortalWhatsAppChannelSettings,
  updatePortalWhatsAppDefaultChannel
} = require('../services/portal-whatsapp-channel-settings.service');
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
          : result.reason === 'repair_channel_target_unresolved' ? 409
            : result.reason === 'repair_channel_invalid_provider' || result.reason === 'repair_channel_inactive' ? 409
              : result.reason === 'repair_channel_not_persisted' ? 500
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
            : result.reason === 'conversation_channel_inactive' ? 409
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
        result.reason === 'invalid_order_item_quantity' ||
        result.reason === 'invalid_order_item_amount' ||
        result.reason === 'contact_not_found' ||
        result.reason === 'conversation_not_found' ||
        result.reason === 'conversation_contact_scope_mismatch'
          ? 400
          : result.reason === 'order_item_product_inactive' ||
              result.reason === 'order_item_product_archived' ||
              result.reason === 'order_item_insufficient_stock'
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
        result.reason === 'invalid_product_tax_rate' ||
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
        result.reason === 'invalid_product_tax_rate' ||
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

async function destroyPortalProduct(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const productId = String(req.params.productId || '').trim();

  try {
    const result = await deletePortalProduct(tenantId, productId);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_product_id'
          ? 400
          : result.reason === 'product_delete_blocked'
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
      data: {
        tenantId: result.tenantId,
        productId: result.deletedProductId
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_product_delete_failed',
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
      const status = result.reason === 'missing_tenant_id' || result.reason === 'missing_contact_id' ? 400 : 404;
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

async function postPortalContact(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalContact(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_contact_name' ||
        result.reason === 'invalid_contact_email'
          ? 400
          : result.reason === 'duplicate_contact_identity'
            ? 409
            : 404;

      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(201).json({
      success: true,
      data: result.contact
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_contact_create_failed',
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
          : result.reason === 'duplicate_contact_identity'
            ? 409
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
      error: 'portal_contact_update_failed',
      details: error.message
    });
  }
}

async function getPortalInvoices(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalInvoices(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        invoices: result.invoices
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoices_failed',
      details: error.message
    });
  }
}

async function getPortalInvoice(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const invoiceId = String(req.params.invoiceId || '').trim();

  try {
    const result = await getPortalInvoiceDetail(tenantId, invoiceId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' || result.reason === 'missing_invoice_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result.invoice
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_failed',
      details: error.message
    });
  }
}

async function postPortalInvoice(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalInvoice(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_invoice_items' ||
        result.reason === 'invalid_invoice_item' ||
        result.reason === 'invalid_credit_note_item' ||
        result.reason === 'invalid_invoice_document_mode' ||
        result.reason === 'invalid_invoice_amount_sign' ||
        result.reason === 'invoice_void_requires_dedicated_action' ||
        result.reason === 'credit_note_requires_parent_invoice' ||
        result.reason === 'credit_note_parent_invalid' ||
        result.reason === 'credit_note_amount_sign_invalid' ||
        result.reason === 'invoice_cannot_have_parent_invoice' ||
        result.reason === 'contact_not_found' ||
        result.reason === 'order_not_found' ||
        result.reason === 'parent_invoice_not_found' ||
        result.reason === 'invoice_order_contact_scope_mismatch'
          ? 400
          : result.reason === 'invoice_item_product_not_found'
            ? 404
          : result.reason === 'invoice_order_amount_mismatch' ||
              result.reason === 'duplicate_invoice_number'
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
      data: result.invoice
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_create_failed',
      details: error.message
    });
  }
}

async function patchPortalInvoice(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const invoiceId = String(req.params.invoiceId || '').trim();

  try {
    const result = await updatePortalInvoice(tenantId, invoiceId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'invalid_invoice_item' ||
        result.reason === 'invalid_credit_note_item' ||
        result.reason === 'invalid_invoice_document_mode' ||
        result.reason === 'invalid_invoice_amount_sign' ||
        result.reason === 'invoice_issue_requires_dedicated_action' ||
        result.reason === 'credit_note_requires_parent_invoice' ||
        result.reason === 'credit_note_parent_invalid' ||
        result.reason === 'credit_note_amount_sign_invalid' ||
        result.reason === 'invoice_cannot_have_parent_invoice' ||
        result.reason === 'contact_not_found' ||
        result.reason === 'order_not_found' ||
        result.reason === 'parent_invoice_not_found' ||
        result.reason === 'invoice_order_contact_scope_mismatch'
          ? 400
          : result.reason === 'invoice_not_editable_in_current_status' ||
              result.reason === 'invoice_order_amount_mismatch' ||
              result.reason === 'duplicate_invoice_number'
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
      data: result.invoice
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_update_failed',
      details: error.message
    });
  }
}

async function patchPortalInvoiceAccountingController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const invoiceId = String(req.params.invoiceId || '').trim();

  try {
    const result = await updatePortalInvoiceAccounting(tenantId, invoiceId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id'
          ? 400
          : result.reason === 'duplicate_internal_document_number'
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
      data: result.invoice
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_accounting_update_failed',
      details: error.message
    });
  }
}

async function getPortalInvoicesCsvExport(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await exportPortalInvoicesCsv(tenantId, req.query || {});
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.status(200).send(result.csv);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_export_failed',
      details: error.message
    });
  }
}

async function getPortalInvoiceDocumentController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const invoiceId = String(req.params.invoiceId || '').trim();

  try {
    const result = await renderPortalInvoiceDocument(tenantId, invoiceId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' || result.reason === 'missing_invoice_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.status(200).send(result.html);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_document_failed',
      details: error.message
    });
  }
}

async function postPortalInvoiceIssue(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const invoiceId = String(req.params.invoiceId || '').trim();

  try {
    const result = await issuePortalInvoice(tenantId, invoiceId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_invoice_items' ||
        result.reason === 'invalid_invoice_amount_sign' ||
        result.reason === 'credit_note_requires_parent_invoice' ||
        result.reason === 'credit_note_parent_invalid' ||
        result.reason === 'credit_note_amount_sign_invalid' ||
        result.reason === 'invoice_cannot_have_parent_invoice' ||
        result.reason === 'contact_not_found' ||
        result.reason === 'order_not_found' ||
        result.reason === 'parent_invoice_not_found' ||
        result.reason === 'invoice_order_contact_scope_mismatch'
          ? 400
          : result.reason === 'invoice_already_issued' ||
              result.reason === 'void_invoice_cannot_be_issued' ||
              result.reason === 'invoice_not_issuable_in_current_status' ||
              result.reason === 'invoice_order_amount_mismatch'
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
      data: result.invoice
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_issue_failed',
      details: error.message
    });
  }
}

async function postPortalInvoiceVoid(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const invoiceId = String(req.params.invoiceId || '').trim();

  try {
    const result = await voidPortalInvoice(tenantId, invoiceId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id'
          ? 400
          : result.reason === 'invoice_already_void'
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
      data: result.invoice
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_void_failed',
      details: error.message
    });
  }
}

async function getPortalPayments(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalPayments(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        payments: result.payments
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_payments_failed',
      details: error.message
    });
  }
}

async function getPortalPayment(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const paymentId = String(req.params.paymentId || '').trim();

  try {
    const result = await getPortalPaymentDetail(tenantId, paymentId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' || result.reason === 'missing_payment_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result.payment
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_payment_failed',
      details: error.message
    });
  }
}

async function getPortalPaymentAllocations(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const paymentId = String(req.params.paymentId || '').trim();

  try {
    const result = await listPortalPaymentAllocations(tenantId, paymentId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' || result.reason === 'missing_payment_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        payment: result.payment,
        allocations: result.allocations
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_payment_allocations_failed',
      details: error.message
    });
  }
}

async function postPortalPayment(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalPayment(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'invalid_payment_amount' ||
        result.reason === 'contact_not_found' ||
        result.reason === 'invoice_not_found' ||
        result.reason === 'payment_invoice_contact_scope_mismatch' ||
        result.reason === 'payment_currency_mismatch'
          ? 400
          : result.reason === 'payment_cannot_target_void_invoice' ||
              result.reason === 'payment_cannot_target_non_issued_invoice' ||
              result.reason === 'payment_cannot_target_credit_note' ||
              result.reason === 'invoice_has_no_outstanding_amount' ||
              result.reason === 'payment_exceeds_outstanding_amount'
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
      data: result.payment
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_payment_create_failed',
      details: error.message
    });
  }
}

async function postPortalPaymentAllocation(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const paymentId = String(req.params.paymentId || '').trim();

  try {
    const result = await createPortalPaymentAllocation(tenantId, paymentId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_payment_id' ||
        result.reason === 'missing_invoice_id' ||
        result.reason === 'invalid_payment_allocation_amount' ||
        result.reason === 'payment_allocation_currency_mismatch' ||
        result.reason === 'payment_allocation_contact_scope_mismatch'
          ? 400
          : result.reason === 'payment_not_allocatable_in_current_status' ||
              result.reason === 'payment_allocation_cannot_target_void_invoice' ||
              result.reason === 'payment_allocation_cannot_target_non_issued_invoice' ||
              result.reason === 'payment_allocation_cannot_target_credit_note' ||
              result.reason === 'payment_has_no_unallocated_amount' ||
              result.reason === 'payment_allocation_exceeds_unallocated_amount' ||
              result.reason === 'invoice_has_no_outstanding_amount' ||
              result.reason === 'payment_allocation_exceeds_invoice_outstanding_amount'
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
      data: {
        allocation: result.allocation,
        payment: result.payment
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_payment_allocation_create_failed',
      details: error.message
    });
  }
}

async function postPortalPaymentVoid(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const paymentId = String(req.params.paymentId || '').trim();

  try {
    const result = await voidPortalPayment(tenantId, paymentId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_payment_id'
          ? 400
          : result.reason === 'payment_already_void' || result.reason === 'payment_not_voidable_in_current_status'
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
      data: result.payment
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_payment_void_failed',
      details: error.message
    });
  }
}

async function getPortalSalesSummary(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getSalesSummary(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        summary: result.summary
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_sales_summary_failed',
      details: error.message
    });
  }
}

async function getPortalSalesMetrics(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getSalesMetrics(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        metrics: result.metrics
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_sales_metrics_failed',
      details: error.message
    });
  }
}

async function getPortalSalesOpportunities(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listSalesOpportunities(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        opportunities: result.opportunities
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_sales_opportunities_failed',
      details: error.message
    });
  }
}

async function getPortalLoyaltyProgramController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getPortalLoyaltyProgram(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        program: result.program
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_loyalty_program_failed',
      details: error.message
    });
  }
}

async function patchPortalLoyaltyProgramController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await updatePortalLoyaltyProgram(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'invalid_loyalty_spend_amount' ||
        result.reason === 'invalid_loyalty_points_amount'
          ? 400
          : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        program: result.program
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_loyalty_program_update_failed',
      details: error.message
    });
  }
}

async function getPortalLoyaltyRewardsController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalLoyaltyRewards(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        rewards: result.rewards
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_loyalty_rewards_failed',
      details: error.message
    });
  }
}

async function postPortalLoyaltyRewardController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalLoyaltyReward(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_loyalty_reward_name' ||
        result.reason === 'invalid_loyalty_reward_points_cost'
          ? 400
          : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(201).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        reward: result.reward
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_loyalty_reward_create_failed',
      details: error.message
    });
  }
}

async function patchPortalLoyaltyRewardController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const rewardId = String(req.params.rewardId || '').trim();

  try {
    const result = await updatePortalLoyaltyReward(tenantId, rewardId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_loyalty_reward_id' ||
        result.reason === 'missing_loyalty_reward_name' ||
        result.reason === 'invalid_loyalty_reward_points_cost'
          ? 400
          : result.reason === 'loyalty_reward_not_found'
            ? 404
            : 409;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        reward: result.reward
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_loyalty_reward_update_failed',
      details: error.message
    });
  }
}

async function getPortalLoyaltyContactController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const contactId = String(req.params.contactId || '').trim();

  try {
    const result = await getPortalLoyaltyContactDetail(tenantId, contactId);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_contact_id'
          ? 400
          : result.reason === 'contact_not_found'
            ? 404
            : 409;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        contact: result.contact,
        loyalty: result.loyalty
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_loyalty_contact_failed',
      details: error.message
    });
  }
}

async function getPortalLoyaltyOverviewController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getPortalLoyaltyOverview(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        overview: result.overview
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_loyalty_overview_failed',
      details: error.message
    });
  }
}

async function postPortalLoyaltyRedeemController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await redeemPortalLoyaltyReward(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_contact_id' ||
        result.reason === 'missing_loyalty_reward_id'
          ? 400
          : result.reason === 'contact_not_found' || result.reason === 'loyalty_reward_not_found'
            ? 404
            : result.reason === 'loyalty_reward_inactive' || result.reason === 'insufficient_loyalty_points'
              ? 409
              : 422;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(201).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        redemption: result.redemption,
        contact: result.contact,
        loyalty: result.loyalty
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_loyalty_redeem_failed',
      details: error.message
    });
  }
}

async function getPortalInvoiceAllocations(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const invoiceId = String(req.params.invoiceId || '').trim();

  try {
    const result = await listPortalInvoiceAllocations(tenantId, invoiceId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' || result.reason === 'missing_invoice_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        invoice: result.invoice,
        allocations: result.allocations
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_allocations_failed',
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

async function getPortalWhatsAppDefaultChannel(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getPortalWhatsAppChannelSettings(tenantId);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id'
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

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_whatsapp_default_channel_failed',
      details: error.message
    });
  }
}

async function patchPortalWhatsAppDefaultChannel(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await updatePortalWhatsAppDefaultChannel(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_channel_id'
          ? 400
          : result.reason === 'default_channel_not_found'
            ? 404
            : result.reason === 'default_channel_invalid_provider' || result.reason === 'default_channel_inactive'
              ? 409
              : 409;

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
      error: 'portal_whatsapp_default_channel_update_failed',
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
  destroyPortalProduct,
  getPortalContacts,
  getPortalContact,
  postPortalContact,
  patchPortalContact,
  getPortalInvoices,
  getPortalInvoice,
  getPortalInvoiceAllocations,
  postPortalInvoice,
  patchPortalInvoice,
  patchPortalInvoiceAccountingController,
  getPortalInvoicesCsvExport,
  getPortalInvoiceDocumentController,
  postPortalInvoiceIssue,
  postPortalInvoiceVoid,
  getPortalPayments,
  getPortalPayment,
  getPortalPaymentAllocations,
  postPortalPayment,
  postPortalPaymentAllocation,
  postPortalPaymentVoid,
  getPortalSalesSummary,
  getPortalSalesMetrics,
  getPortalSalesOpportunities,
  getPortalLoyaltyProgramController,
  patchPortalLoyaltyProgramController,
  getPortalLoyaltyRewardsController,
  postPortalLoyaltyRewardController,
  patchPortalLoyaltyRewardController,
  getPortalLoyaltyContactController,
  getPortalLoyaltyOverviewController,
  postPortalLoyaltyRedeemController,
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
  getPortalWhatsAppDefaultChannel,
  patchPortalWhatsAppDefaultChannel,
  getPortalWhatsAppTemplateBlueprints,
  getPortalWhatsAppTemplates,
  postPortalWhatsAppTemplateFromBlueprint,
  postPortalWhatsAppTemplatesSync
};
