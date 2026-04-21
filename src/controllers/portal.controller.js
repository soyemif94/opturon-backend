const { resolvePortalTenantContext } = require('../services/portal-context.service');
const { logError } = require('../utils/logger');
const {
  listPortalConversations,
  getPortalConversationDetail,
  patchPortalConversation,
  patchPortalConversationLeadStatus,
  patchPortalConversationNextAction,
  assignPortalConversationSeller,
  sendPortalMessage,
  archivePortalConversations,
  restorePortalConversations
} = require('../services/portal-inbox.service');
const {
  listPortalOrders,
  getPortalOrderPaymentMetrics,
  getPortalSellerMetrics,
  getPortalOrderDetail,
  createPortalOrder,
  patchPortalOrder,
  patchPortalOrderStatus,
  validatePortalOrderTransferPayment
} = require('../services/portal-orders.service');
const {
  listPortalInvoices,
  getPortalInvoiceDetail,
  listPortalInvoiceAllocations,
  createPortalInvoice,
  updatePortalInvoice,
  updatePortalInvoiceAccounting,
  updatePortalInvoicesBulkStatus,
  issuePortalInvoice,
  voidPortalInvoice,
  exportPortalInvoicesCsv,
  downloadPortalInvoicesBundle,
  renderPortalInvoiceDocument,
  downloadPortalInvoice
} = require('../services/portal-invoices.service');
const {
  listPortalProducts,
  listPortalProductCategories,
  getPortalProductDetail,
  createPortalProduct,
  createPortalProductsBulk,
  createPortalProductCategoryRecord,
  patchPortalProductCategoryRecord,
  deletePortalProductCategoryRecord,
  patchPortalProduct,
  patchPortalProductStatus,
  deletePortalProduct
} = require('../services/portal-products.service');
const {
  listPortalUsers,
  invitePortalUser,
  assignPrimaryPortalUser,
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
  listPortalPaymentDestinations,
  createPortalPaymentDestination,
  patchPortalPaymentDestination
} = require('../services/portal-payment-destinations.service');
const {
  listPortalCashOverview,
  openPortalCashSession,
  closePortalCashSession
} = require('../services/portal-cash.service');
const {
  listPortalAgendaItems,
  getPortalAgendaAvailability,
  createPortalAgendaItem,
  createPortalAgendaReservation,
  updatePortalAgendaItem,
  deletePortalAgendaItem
} = require('../services/portal-agenda.service');
const {
  getSalesSummary,
  getSalesMetrics,
  listSalesOpportunities
} = require('../services/portal-sales.service');
const {
  listPortalContacts,
  getPortalContactDetail,
  createPortalContact,
  updatePortalContact,
  archivePortalContacts,
  restorePortalContacts,
  deletePortalArchivedContacts
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
  createPortalAutomation,
  updatePortalAutomation,
  updatePortalAutomationTemplate,
  deletePortalAutomation
} = require('../services/portal-automations.service');
const { getPortalAutomationActionMetrics } = require('../services/portal-automation-events.service');
const {
  getPortalBusinessSettings,
  updatePortalBusinessSettings
} = require('../services/portal-business.service');
const {
  getPortalBotSettings,
  updatePortalBotSettings,
  getPortalBotTransferConfig,
  updatePortalBotTransferConfig
} = require('../services/portal-bot-settings.service');
const { provisionPortalTenant } = require('../services/portal-provisioning.service');
const {
  createPortalWhatsAppSignupSession,
  getPortalWhatsAppSignupStatus,
  finalizePortalWhatsAppSignup
} = require('../services/portal-whatsapp-embedded-signup.service');
const {
  getPortalInstagramConnectionStatus,
  connectPortalInstagramChannel
} = require('../services/portal-instagram.service');
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

async function postPortalTenantProvision(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await provisionPortalTenant(tenantId, req.body || {});
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 500;
      return res.status(status).json({ success: false, error: result.reason, details: result.detail || null });
    }

    return res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_tenant_provision_failed',
      details: error.message
    });
  }
}

async function getPortalConversations(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const visibility = String(req.query.visibility || 'active').trim().toLowerCase() === 'archived' ? 'archived' : 'active';

  try {
    const result = await listPortalConversations(tenantId, { visibility });
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
        result.reason === 'missing_contact_id' ||
        result.reason === 'missing_seller_user_id' ||
        result.reason === 'missing_order_items' ||
        result.reason === 'payment_destination_not_found' ||
        result.reason === 'payment_destination_inactive' ||
        result.reason === 'invalid_order_item_product' ||
        result.reason === 'invalid_order_item_name' ||
        result.reason === 'invalid_order_item_price' ||
        result.reason === 'invalid_order_item_quantity' ||
        result.reason === 'invalid_order_item_amount' ||
        result.reason === 'contact_not_found' ||
        result.reason === 'seller_user_not_found' ||
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
        result.reason === 'invalid_order_status' ||
        result.reason === 'payment_destination_not_found' ||
        result.reason === 'payment_destination_inactive' ||
        result.reason === 'missing_payment_destination_for_paid_order' ||
        result.reason === 'invalid_order_payment_amount'
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

async function getPortalProductCategories(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const includeInactive = String(req.query.includeInactive || '').trim().toLowerCase() === 'true';

  try {
    const result = await listPortalProductCategories(tenantId, { includeInactive });
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        categories: result.categories
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_product_categories_failed',
      details: error.message
    });
  }
}

async function patchPortalConversationsArchive(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const actorId = req.user && req.user.id ? String(req.user.id) : null;
  const actorName = req.user && req.user.name ? String(req.user.name) : null;

  try {
    const result = await archivePortalConversations(tenantId, req.body || {}, { actorId, actorName });
    if (!result.ok) {
      const status = result.reason === 'missing_conversation_ids' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_conversations_archive_failed',
      details: error.message
    });
  }
}

async function patchPortalConversationsRestore(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await restorePortalConversations(tenantId, req.body || {});
    if (!result.ok) {
      const status = result.reason === 'missing_conversation_ids' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_conversations_restore_failed',
      details: error.message
    });
  }
}

async function getPortalOrdersPaymentMetrics(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const range = String(req.query.range || '').trim();

  try {
    const result = await getPortalOrderPaymentMetrics(tenantId, range);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result.metrics
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_order_payment_metrics_failed',
      details: error.message
    });
  }
}

async function patchPortalConversationAssignSeller(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const conversationId = String(req.params.conversationId || '').trim();

  try {
    const result = await assignPortalConversationSeller(tenantId, conversationId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_seller_user_id' ? 400
          : result.reason === 'seller_user_not_found' ? 422
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
      error: 'portal_conversation_assign_seller_failed',
      details: error.message
    });
  }
}

async function patchPortalConversationLeadStatusController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const conversationId = String(req.params.conversationId || '').trim();

  try {
    const result = await patchPortalConversationLeadStatus(tenantId, conversationId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'invalid_lead_status' ? 400
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
      error: 'portal_conversation_lead_status_failed',
      details: error.message
    });
  }
}

async function patchPortalConversationNextActionController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const conversationId = String(req.params.conversationId || '').trim();

  try {
    const result = await patchPortalConversationNextAction(tenantId, conversationId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_next_action_patch' ||
        result.reason === 'invalid_next_action_at'
          ? 400
          : result.reason === 'mapped_clinic_without_whatsapp_channel'
            ? 409
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
      error: 'portal_conversation_next_action_failed',
      details: error.message
    });
  }
}

async function getPortalSellerMetricsController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getPortalSellerMetrics(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result.metrics
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_seller_metrics_failed',
      details: error.message
    });
  }
}

async function postPortalOrderPaymentValidation(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const orderId = String(req.params.orderId || '').trim();
  const actorId = String(req.get('x-portal-actor-id') || '').trim() || null;
  const actorName = String(req.get('x-portal-actor-name') || '').trim() || null;

  try {
    const result = await validatePortalOrderTransferPayment(tenantId, orderId, req.body || {}, { actorId, actorName });
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_order_id' ||
        result.reason === 'invalid_payment_validation_action'
          ? 400
          : result.reason === 'transfer_payment_already_confirmed' || result.reason === 'transfer_payment_already_rejected'
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
        order: result.order,
        notification: result.notification
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_order_payment_validation_failed',
      details: error.message
    });
  }
}

async function patchPortalOrderController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const orderId = String(req.params.orderId || '').trim();

  try {
    const result = await patchPortalOrder(tenantId, orderId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_order_id' ||
        result.reason === 'missing_seller_user_id' ||
        result.reason === 'seller_user_not_found' ||
        result.reason === 'payment_destination_not_found' ||
        result.reason === 'payment_destination_inactive'
          ? 400
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
      error: 'portal_order_update_failed',
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

async function postPortalProductCategory(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalProductCategoryRecord(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_product_category_name'
          ? 400
          : result.reason === 'duplicate_product_category_name'
            ? 409
            : 404;

      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(201).json({
      success: true,
      data: result.category
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_product_category_create_failed',
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

async function updatePortalProductCategory(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const categoryId = String(req.params.categoryId || '').trim();

  try {
    const result = await patchPortalProductCategoryRecord(tenantId, categoryId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_product_category_id' ||
        result.reason === 'missing_product_category_name'
          ? 400
          : result.reason === 'duplicate_product_category_name'
            ? 409
            : 404;

      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result.category
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_product_category_update_failed',
      details: error.message
    });
  }
}

async function destroyPortalProductCategory(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const categoryId = String(req.params.categoryId || '').trim();

  try {
    const result = await deletePortalProductCategoryRecord(tenantId, categoryId);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_product_category_id'
          ? 400
          : result.reason === 'product_category_delete_blocked'
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
        categoryId: result.deletedCategoryId
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_product_category_delete_failed',
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
        users: result.users,
        activity: result.activity || [],
        meta: result.meta || null
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
  const visibility = String(req.query.visibility || 'active').trim().toLowerCase() === 'archived' ? 'archived' : 'active';

  try {
    const result = await listPortalContacts(tenantId, { visibility });
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

async function patchPortalInvoicesBulkStatus(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await updatePortalInvoicesBulkStatus(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_invoice_ids' ||
        result.reason === 'invalid_fiscal_status'
          ? 400
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
        fiscalStatus: result.fiscalStatus,
        invoices: result.updatedInvoices
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_bulk_status_failed',
      details: error.message
    });
  }
}

async function postPortalInvoicesBulkDownload(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await downloadPortalInvoicesBundle(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_invoice_ids'
          ? 400
          : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId,
        details: result.details || null
      });
    }

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.status(200).send(result.body);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_bulk_download_failed',
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

async function getPortalInvoiceDownloadController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const invoiceId = String(req.params.invoiceId || '').trim();
  const format = String(req.query.format || '').trim();

  try {
    const result = await downloadPortalInvoice(tenantId, invoiceId, format);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' || result.reason === 'missing_invoice_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.status(200).send(result.body);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_invoice_download_failed',
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

async function patchPortalContactsArchive(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await archivePortalContacts(tenantId, req.body || {});
    if (!result.ok) {
      const status = result.reason === 'missing_contact_ids' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_contacts_archive_failed',
      details: error.message
    });
  }
}

async function patchPortalContactsRestore(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await restorePortalContacts(tenantId, req.body || {});
    if (!result.ok) {
      const status = result.reason === 'missing_contact_ids' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_contacts_restore_failed',
      details: error.message
    });
  }
}

async function getPortalPaymentDestinations(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const includeInactive = String(req.query.includeInactive || '').trim() === '1';

  try {
    const result = await listPortalPaymentDestinations(tenantId, { includeInactive });
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        paymentDestinations: result.paymentDestinations
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_payment_destinations_failed',
      details: error.message
    });
  }
}

async function postPortalPaymentDestination(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalPaymentDestination(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_payment_destination_name' ||
        result.reason === 'invalid_payment_destination_type'
          ? 400
          : result.reason === 'payment_destination_name_conflict'
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
      data: result.paymentDestination
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_payment_destination_create_failed',
      details: error.message
    });
  }
}

async function patchPortalPaymentDestinationController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const destinationId = String(req.params.destinationId || '').trim();

  try {
    const result = await patchPortalPaymentDestination(tenantId, destinationId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_payment_destination_id' ||
        result.reason === 'missing_payment_destination_name' ||
        result.reason === 'invalid_payment_destination_type'
          ? 400
          : result.reason === 'payment_destination_name_conflict'
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
      data: result.paymentDestination
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_payment_destination_update_failed',
      details: error.message
    });
  }
}

async function getPortalCashOverview(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalCashOverview(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        cashBoxes: result.cashBoxes,
        recentClosedSessions: result.recentClosedSessions
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_cash_overview_failed',
      details: error.message
    });
  }
}

async function postPortalCashSession(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim();
  const payload = {
    ...(req.body || {}),
    openedByUserId: actorUserId || String(req.body?.openedByUserId || '').trim() || undefined
  };

  try {
    const result = await openPortalCashSession(tenantId, payload);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_cash_box_destination_id' ||
        result.reason === 'missing_opened_by_user_id' ||
        result.reason === 'invalid_cash_opening_amount' ||
        result.reason === 'cash_open_user_not_found'
          ? 400
          : result.reason === 'cash_session_already_open' || result.reason === 'cash_box_destination_inactive'
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
      data: result.session
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_cash_session_open_failed',
      details: error.message
    });
  }
}

async function postPortalCashSessionClose(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const sessionId = String(req.params.sessionId || '').trim();
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim();
  const payload = {
    ...(req.body || {}),
    closedByUserId: actorUserId || String(req.body?.closedByUserId || '').trim() || undefined
  };

  try {
    const result = await closePortalCashSession(tenantId, sessionId, payload);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_cash_session_id' ||
        result.reason === 'missing_closed_by_user_id' ||
        result.reason === 'invalid_cash_counted_amount' ||
        result.reason === 'cash_close_user_not_found'
          ? 400
          : result.reason === 'cash_session_not_open'
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
      data: result.session
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_cash_session_close_failed',
      details: error.message
    });
  }
}

async function getPortalAgenda(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await listPortalAgendaItems(tenantId, req.query || {});
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        range: result.range,
        items: result.items
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_agenda_list_failed',
      details: error.message
    });
  }
}

async function postPortalAgenda(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalAgendaItem(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'invalid_agenda_date' ||
        result.reason === 'invalid_agenda_type' ||
        result.reason === 'missing_agenda_title' ||
        result.reason === 'invalid_agenda_status' ||
        result.reason === 'invalid_agenda_time' ||
        result.reason === 'invalid_agenda_time_range' ||
        result.reason === 'missing_agenda_time_range' ||
        result.reason === 'agenda_time_conflict' ||
        result.reason === 'reservation_outside_availability' ||
        result.reason === 'contact_not_found'
          ? (result.reason === 'agenda_time_conflict' || result.reason === 'reservation_outside_availability' ? 409 : 400)
          : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId,
        details: result.detail || null
      });
    }

    return res.status(201).json({
      success: true,
      data: result.item
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_agenda_create_failed',
      details: error.message
    });
  }
}

async function getPortalAgendaAvailabilityController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getPortalAgendaAvailability(tenantId, req.query || {});
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        range: result.range,
        days: result.days
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_agenda_availability_failed',
      details: error.message
    });
  }
}

async function postPortalAgendaReservation(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await createPortalAgendaReservation(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'invalid_agenda_date' ||
        result.reason === 'invalid_agenda_type' ||
        result.reason === 'missing_agenda_title' ||
        result.reason === 'invalid_agenda_status' ||
        result.reason === 'invalid_agenda_time' ||
        result.reason === 'invalid_agenda_time_range' ||
        result.reason === 'missing_agenda_time_range' ||
        result.reason === 'contact_not_found'
          ? 400
          : result.reason === 'agenda_time_conflict' || result.reason === 'reservation_outside_availability'
            ? 409
            : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId,
        details: result.detail || null
      });
    }

    return res.status(201).json({
      success: true,
      data: result.reservation
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_agenda_reservation_create_failed',
      details: error.message
    });
  }
}

async function patchPortalAgenda(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const itemId = String(req.params.itemId || '').trim();

  try {
    const result = await updatePortalAgendaItem(tenantId, itemId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_agenda_item_id' ||
        result.reason === 'invalid_agenda_date' ||
        result.reason === 'invalid_agenda_type' ||
        result.reason === 'missing_agenda_title' ||
        result.reason === 'invalid_agenda_status' ||
        result.reason === 'invalid_agenda_time' ||
        result.reason === 'invalid_agenda_time_range' ||
        result.reason === 'missing_agenda_time_range' ||
        result.reason === 'agenda_time_conflict' ||
        result.reason === 'contact_not_found'
          ? 400
          : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId,
        details: result.detail || null
      });
    }

    return res.status(200).json({
      success: true,
      data: result.item
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_agenda_update_failed',
      details: error.message
    });
  }
}

async function deletePortalAgenda(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const itemId = String(req.params.itemId || '').trim();

  try {
    const result = await deletePortalAgendaItem(tenantId, itemId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' || result.reason === 'missing_agenda_item_id' ? 400 : 404;
      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId,
        details: result.detail || null
      });
    }

    return res.status(200).json({
      success: true,
      data: result.item
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_agenda_delete_failed',
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
        automations: result.automations,
        businessProfile: result.businessProfile,
        catalog: result.catalog
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

async function patchPortalAutomationTemplate(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const templateKey = String(req.params.templateKey || '').trim();

  try {
    const result = await updatePortalAutomationTemplate(tenantId, templateKey, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_automation_template_key' ||
        result.reason === 'invalid_automation_template_enabled'
          ? 400
          : result.reason === 'automation_template_incompatible'
            ? 409
            : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId || tenantId,
        meta: {
          missingCapabilities: result.missingCapabilities || [],
          businessType: result.businessType || null
        }
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        template: result.template
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_automation_template_update_failed',
      details: error.message
    });
  }
}

async function getPortalAutomationTemplateMetrics(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const templateKey = String(req.params.templateKey || '').trim();
  const limit = Number(req.query.limit || 20);

  try {
    const result = await getPortalAutomationActionMetrics(tenantId, templateKey, { limit });
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_automation_template_key'
          ? 400
          : 404;

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
        template: result.template,
        summary: result.summary,
        events: result.events
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_automation_template_metrics_failed',
      details: error.message
    });
  }
}

async function postPortalUser(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim() || null;

  try {
    const result = await invitePortalUser(tenantId, req.body || {}, { actorUserId });
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'invalid_name' ||
        result.reason === 'invalid_email' ||
        result.reason === 'invalid_role' ||
        result.reason === 'invalid_password'
          ? 400
          : result.reason === 'tenant_subaccount_limit_reached'
            ? 409
          : result.reason === 'duplicate_user_email'
              ? 409
              : 404;
        return res.status(status).json({
          success: false,
          error: result.reason,
          tenantId: result.tenantId,
          meta: result.meta || null
        });
      }

      return res.status(201).json({
        success: true,
        data: {
          tenantId: result.tenantId,
          user: result.user,
          meta: result.meta || null
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

async function patchPortalPrimaryUser(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const userId = String((req.body && req.body.userId) || '').trim();
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim() || null;

  try {
    const result = await assignPrimaryPortalUser(tenantId, userId, { actorUserId });
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'missing_user_id'
          ? 400
          : result.reason === 'user_not_found'
            ? 404
            : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId,
        meta: result.meta || null
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        tenantId: result.tenantId,
        user: result.user,
        meta: result.meta || null
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_primary_user_update_failed',
      details: error.message
    });
  }
}

async function deletePortalArchivedContactsController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await deletePortalArchivedContacts(tenantId, req.body || {});
    if (!result.ok) {
      const status = result.reason === 'missing_contact_ids' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_contacts_delete_failed',
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

async function patchPortalAutomation(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const automationId = String(req.params.automationId || '').trim();

  try {
    const result = await updatePortalAutomation(tenantId, automationId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_automation_id' ||
        result.reason === 'invalid_automation_enabled'
          ? 400
          : 404;

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
        automation: result.automation
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_automation_update_failed',
      details: error.message
    });
  }
}

async function destroyPortalAutomation(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const automationId = String(req.params.automationId || '').trim();

  try {
    const result = await deletePortalAutomation(tenantId, automationId);
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_automation_id'
          ? 400
          : 404;

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
        automation: result.automation
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_automation_delete_failed',
      details: error.message
    });
  }
}

async function patchPortalUser(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const userId = String(req.params.userId || '').trim();
  const actorUserId = String(req.get('x-portal-actor-id') || '').trim() || null;

  try {
    const result = await updatePortalUser(tenantId, userId, {
      ...(req.body || {}),
      actorUserId
    });
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
          : result.reason === 'cannot_delete_primary_account'
            ? 409
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
      const status = mapPortalWhatsAppConnectReasonToStatus(result.reason, 409);

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
    const status = mapPortalWhatsAppConnectReasonToStatus(error.reason, 500);
    return res.status(status).json({
      success: false,
      error: error.reason || 'portal_whatsapp_embedded_signup_bootstrap_failed',
      detail: error.message || null,
      details: error.message || null
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
      const status = mapPortalWhatsAppConnectReasonToStatus(result.reason, 422);

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
    const status = mapPortalWhatsAppConnectReasonToStatus(error.reason, 500);
    return res.status(status).json({
      success: false,
      error: error.reason || 'portal_whatsapp_embedded_signup_finalize_failed',
      detail: error.message || null,
      details: error.message || null
    });
  }
}

async function postPortalWhatsAppManualConnect(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await connectPortalWhatsAppManual(tenantId, req.body || {});
    if (!result.ok) {
      const status = mapPortalWhatsAppConnectReasonToStatus(result.reason, 422);

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
    const status = mapPortalWhatsAppConnectReasonToStatus(error.reason, 500);
    return res.status(status).json({
      success: false,
      error: error.reason || 'portal_whatsapp_manual_connect_failed',
      detail: error.message || null,
      details: error.message || null
    });
  }
}

async function postPortalWhatsAppDiscoverAssets(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await discoverTenantWhatsAppAssets(tenantId, req.body || {});
    if (!result.ok) {
      const status = mapPortalWhatsAppConnectReasonToStatus(result.reason, 422);

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
    const status = mapPortalWhatsAppConnectReasonToStatus(error.reason, 500);
    return res.status(status).json({
      success: false,
      error: error.reason || 'portal_whatsapp_discover_assets_failed',
      detail: error.message || null,
      details: error.message || null
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

function mapPortalWhatsAppConnectReasonToStatus(reason, fallbackStatus = 422) {
  if (
    reason === 'missing_tenant_id' ||
    reason === 'missing_redirect_uri' ||
    reason === 'missing_waba_id' ||
    reason === 'missing_phone_number_id' ||
    reason === 'missing_access_token' ||
    reason === 'missing_state_token' ||
    reason === 'missing_meta_code' ||
    reason === 'embedded_signup_redirect_uri_mismatch'
  ) {
    return 400;
  }

  if (reason === 'tenant_mapping_not_found' || reason === 'embedded_signup_session_not_found') {
    return 404;
  }

  if (
    reason === 'WHATSAPP_CHANNEL_ALREADY_CONNECTED' ||
    reason === 'channel_belongs_to_another_workspace'
  ) {
    return 409;
  }

  if (
    reason === 'meta_invalid_access_token' ||
    reason === 'meta_insufficient_permissions' ||
    reason === 'meta_waba_not_accessible' ||
    reason === 'meta_phone_number_waba_mismatch' ||
    reason === 'meta_app_subscription_failed' ||
    reason === 'meta_business_assets_not_found' ||
    reason === 'meta_embedded_signup_not_configured' ||
    reason === 'meta_debug_token_not_configured'
  ) {
    return 422;
  }

  return fallbackStatus;
}

async function getPortalInstagramStatus(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getPortalInstagramConnectionStatus(tenantId);
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
      error: 'portal_instagram_status_failed',
      details: error.message
    });
  }
}

async function postPortalInstagramConnect(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await connectPortalInstagramChannel(tenantId, {
      code: req.body && req.body.code,
      redirectUri: req.body && req.body.redirectUri,
      requestId: req.requestId || null
    });

    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' ||
        result.reason === 'missing_instagram_oauth_code' ||
        result.reason === 'missing_instagram_redirect_uri'
          ? 400
          : result.reason === 'tenant_mapping_not_found'
            ? 404
            : result.reason === 'instagram_multiple_assets_found'
              ? 409
              : 409;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId || tenantId,
        details: result.details || null
      });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    const status =
      error && (error.reason === 'instagram_channel_already_bound_to_other_clinic' || error.code === 'INSTAGRAM_CHANNEL_CROSS_CLINIC_CONFLICT')
        ? 409
        : 500;

    return res.status(status).json({
      success: false,
      error: error.reason || 'portal_instagram_connect_failed',
      details: error.details || error.message
    });
  }
}

async function getPortalBotSettingsController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getPortalBotSettings(tenantId);
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
      error: 'portal_bot_settings_failed',
      details: error.message
    });
  }
}

async function patchPortalBotSettingsController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await updatePortalBotSettings(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'invalid_bot_mode'
          ? 400
          : result.reason === 'bot_settings_not_saved'
            ? 500
            : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId || tenantId,
        detail: result.detail || null,
        details: result.detail || null,
        fieldErrors: result.fieldErrors || null
      });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_bot_settings_update_failed',
      details: error.message
    });
  }
}

async function getPortalBotTransferConfigController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await getPortalBotTransferConfig(tenantId);
    if (!result.ok) {
      const status = result.reason === 'missing_tenant_id' ? 400 : 404;
      return res.status(status).json({ success: false, error: result.reason, tenantId: result.tenantId || tenantId });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_bot_transfer_config_failed',
      details: error.message
    });
  }
}

async function postPortalBotTransferConfigController(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();

  try {
    const result = await updatePortalBotTransferConfig(tenantId, req.body || {});
    if (!result.ok) {
      const status =
        result.reason === 'missing_tenant_id' || result.reason === 'invalid_transfer_config'
          ? 400
          : result.reason === 'transfer_config_not_saved'
            ? 500
            : 404;

      return res.status(status).json({
        success: false,
        error: result.reason,
        tenantId: result.tenantId || tenantId,
        details: result.detail || null
      });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'portal_bot_transfer_config_update_failed',
      details: error.message
    });
  }
}

module.exports = {
  getPortalTenantContext,
  postPortalTenantProvision,
  getPortalConversations,
  getPortalConversation,
  updatePortalConversation,
  patchPortalConversationAssignSeller,
  patchPortalConversationLeadStatusController,
  patchPortalConversationNextActionController,
  patchPortalConversationsArchive,
  patchPortalConversationsRestore,
  postPortalMessage,
  getPortalOrders,
  getPortalOrdersPaymentMetrics,
  getPortalSellerMetricsController,
  getPortalOrder,
  postPortalOrder,
  patchPortalOrderController,
  updatePortalOrderStatus,
  postPortalOrderPaymentValidation,
  getPortalProducts,
  getPortalProductCategories,
  getPortalProduct,
  postPortalProduct,
  postPortalProductCategory,
  postPortalProductsBulk,
  updatePortalProduct,
  updatePortalProductCategory,
  destroyPortalProductCategory,
  updatePortalProductStatus,
  destroyPortalProduct,
  getPortalContacts,
  getPortalContact,
  postPortalContact,
  patchPortalContact,
  patchPortalContactsArchive,
  patchPortalContactsRestore,
  deletePortalArchivedContactsController,
  getPortalInvoices,
  getPortalInvoice,
  getPortalInvoiceAllocations,
  postPortalInvoice,
  patchPortalInvoice,
  patchPortalInvoiceAccountingController,
  patchPortalInvoicesBulkStatus,
  postPortalInvoicesBulkDownload,
  getPortalInvoicesCsvExport,
  getPortalInvoiceDocumentController,
  getPortalInvoiceDownloadController,
  postPortalInvoiceIssue,
  postPortalInvoiceVoid,
  getPortalPayments,
  getPortalPaymentDestinations,
  getPortalCashOverview,
  getPortalAgenda,
  getPortalAgendaAvailabilityController,
  getPortalPayment,
  getPortalPaymentAllocations,
  postPortalCashSession,
  postPortalCashSessionClose,
  postPortalAgenda,
  postPortalAgendaReservation,
  postPortalPayment,
  postPortalPaymentDestination,
  patchPortalPaymentDestinationController,
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
  getPortalAutomationTemplateMetrics,
  getPortalBusiness,
  getPortalUsers,
  patchPortalBusiness,
  postPortalAutomation,
  patchPortalAutomation,
  patchPortalAutomationTemplate,
  destroyPortalAutomation,
  postPortalUser,
  patchPortalPrimaryUser,
  patchPortalUser,
  destroyPortalUser,
  postPortalAuthLogin,
  getPortalAuthUser,
  postPortalWhatsAppEmbeddedSignupBootstrap,
  getPortalWhatsAppEmbeddedSignupStatus,
  postPortalWhatsAppEmbeddedSignupFinalize,
  postPortalWhatsAppManualConnect,
  postPortalWhatsAppDiscoverAssets,
  getPortalInstagramStatus,
  postPortalInstagramConnect,
  getPortalBotSettingsController,
  patchPortalBotSettingsController,
  getPortalBotTransferConfigController,
  postPortalBotTransferConfigController,
  getPortalWhatsAppDefaultChannel,
  patchPortalWhatsAppDefaultChannel,
  getPortalWhatsAppTemplateBlueprints,
  getPortalWhatsAppTemplates,
  postPortalWhatsAppTemplateFromBlueprint,
  postPortalWhatsAppTemplatesSync,
  patchPortalAgenda,
  deletePortalAgenda
};
