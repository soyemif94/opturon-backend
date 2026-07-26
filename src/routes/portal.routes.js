const express = require('express');
const multer = require('multer');
const {
  getPortalTenantContext,
  getPortalTenantPolicy,
  postPortalTenantProvision,
  getPortalConversations,
  getPortalConversation,
  getPortalConversationMessageMedia,
  updatePortalConversation,
  patchPortalConversationAssignSeller,
  patchPortalConversationLeadStatusController,
  patchPortalConversationNextActionController,
  patchPortalConversationsArchive,
  patchPortalConversationsRestore,
  postPortalMessage,
  postPortalWhatsAppImportPreview,
  postPortalWhatsAppImportConfirm,
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
  postPortalProductImageUpload,
  postPortalProductCategory,
  postPortalProductsBulk,
  postPortalProductsBulkDeletePreview,
  postPortalProductsBulkDeleteExecute,
  postPortalCatalogImportAnalyze,
  getPortalCatalogImports,
  getPortalCatalogImport,
  postPortalCatalogImportConfirm,
  postPortalCatalogImportCancel,
  postPortalCatalogImportRollbackPreview,
  postPortalCatalogImportRollbackExecute,
  getPortalCatalogImportErrors,
  getPortalCatalogImportTemplate,
  getPortalInventoryProductsController,
  getPortalInventoryLots,
  getPortalInventoryLot,
  getPortalInventoryProductHistoryController,
  getPortalInventoryExpirationSummary,
  getPortalInventoryExpirationSettings,
  putPortalInventoryExpirationSettings,
  postPortalInventoryExpiredBulkWriteoff,
  postPortalInventoryLot,
  postPortalInventoryLotAdjustment,
  postPortalInventoryMovementController,
  postPortalProductInventoryMode,
  updatePortalProduct,
  updatePortalProductCategory,
  destroyPortalProductCategory,
  updatePortalProductStatus,
  destroyPortalProduct,
  getPortalProductImagePublic,
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
  postPortalCashSessionMovement,
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
  postPortalLoyaltyRewardImageUpload,
  getPortalLoyaltyRewardImagePublic,
  getPortalLoyaltyContactController,
  getPortalLoyaltyOverviewController,
  postPortalLoyaltyRedeemController,
  getPortalAutomations,
  getPortalAutomationTemplateMetrics,
  getPortalBusiness,
  getPortalUsers,
  postPortalUser,
  patchPortalPrimaryUser,
  getPortalInvitation,
  postPortalInvitationAccept,
  postPortalAutomation,
  patchPortalAutomationTemplate,
  patchPortalAutomation,
  destroyPortalAutomation,
  patchPortalBusiness,
  patchPortalUser,
  destroyPortalUser,
  postPortalAuthLogin,
  postPortalAuthForgotPassword,
  postPortalAuthForgotPasswordInvalidate,
  getPortalAuthResetPasswordValidation,
  postPortalAuthResetPassword,
  getPortalAuthUser,
  getPortalAuthAdminActor,
  postPortalWhatsAppEmbeddedSignupBootstrap,
  getPortalWhatsAppEmbeddedSignupStatus,
  postPortalWhatsAppEmbeddedSignupRefresh,
  postPortalWhatsAppEmbeddedSignupCancel,
  postPortalWhatsAppEmbeddedSignupFinalize,
  postPortalWhatsAppManualConnect,
  postPortalWhatsAppDiscoverAssets,
  getPortalWhatsAppStatusController,
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
  deletePortalAgenda,
  patchPortalTenantPolicy
} = require('../controllers/portal.controller');
const { requirePortalInternalAuth } = require('../middlewares/portal-internal-auth.middleware');
const { applyPortalActiveTenant } = require('../middlewares/portal-active-tenant.middleware');
const { requirePortalModule, requirePortalCapability } = require('../middlewares/portal-module-gate.middleware');

const router = express.Router();

const inboxModule = requirePortalModule('inbox');
const agendaModule = requirePortalModule('agenda');
const catalogModule = requirePortalModule('catalog');
const automationsModule = requirePortalModule('automations');
const salesModule = requirePortalModule('sales');
const loyaltyModule = requirePortalModule('loyalty');
const paymentsModule = requirePortalModule('payments');
const contactsCapability = requirePortalCapability('contacts');
const ordersCapability = requirePortalCapability('orders');
const receiptsCapability = requirePortalCapability('receipts');
const cashCapability = requirePortalCapability('cash_management');
const inventoryCapability = requirePortalCapability('inventory');
const catalogImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024,
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    const mimeType = String(file && file.mimetype ? file.mimetype : '').toLowerCase();
    if (mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp') {
      callback(null, true);
      return;
    }
    callback(new Error('invalid_product_image_type'));
  }
});

function handleCatalogImageUpload(req, res, next) {
  catalogImageUpload.single('file')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ success: false, error: 'product_image_too_large' });
      return;
    }

    if (error && error.message === 'invalid_product_image_type') {
      res.status(400).json({ success: false, error: 'invalid_product_image_type' });
      return;
    }

    next(error);
  });
}

const catalogImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.CATALOG_IMPORT_MAX_FILE_SIZE_BYTES || 10 * 1024 * 1024),
    files: 1
  }
});

function handleCatalogImportUpload(req, res, next) {
  catalogImportUpload.single('file')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ success: false, error: 'catalog_import_file_too_large' });
      return;
    }

    next(error);
  });
}

const whatsappChatImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.WHATSAPP_CHAT_IMPORT_MAX_FILE_SIZE_BYTES || 5 * 1024 * 1024),
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    const name = String(file && file.originalname ? file.originalname : '').toLowerCase();
    const mimeType = String(file && file.mimetype ? file.mimetype : '').toLowerCase();
    if (name.endsWith('.txt') || mimeType === 'text/plain') {
      callback(null, true);
      return;
    }
    callback(new Error('invalid_whatsapp_import_file_type'));
  }
});

function handleWhatsAppChatImportUpload(req, res, next) {
  whatsappChatImportUpload.single('file')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ success: false, error: 'file_too_large' });
      return;
    }

    if (error && error.message === 'invalid_whatsapp_import_file_type') {
      res.status(400).json({ success: false, error: 'invalid_file_type' });
      return;
    }

    next(error);
  });
}

const loyaltyRewardImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024,
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    const mimeType = String(file && file.mimetype ? file.mimetype : '').toLowerCase();
    if (mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp') {
      callback(null, true);
      return;
    }
    callback(new Error('invalid_loyalty_reward_image_type'));
  }
});

function handleLoyaltyRewardImageUpload(req, res, next) {
  loyaltyRewardImageUpload.single('file')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ success: false, error: 'loyalty_reward_image_too_large' });
      return;
    }

    if (error && error.message === 'invalid_loyalty_reward_image_type') {
      res.status(400).json({ success: false, error: 'invalid_loyalty_reward_image_type' });
      return;
    }

    next(error);
  });
}

router.use('/tenants/:tenantId', applyPortalActiveTenant);

router.get('/product-images/:tenantId/:fileName', getPortalProductImagePublic);
router.get('/loyalty-reward-images/:tenantId/:fileName', getPortalLoyaltyRewardImagePublic);
router.get('/tenants/:tenantId/context', getPortalTenantContext);
router.get('/tenants/:tenantId/policy', requirePortalInternalAuth, getPortalTenantPolicy);
router.post('/tenants/:tenantId/provision', requirePortalInternalAuth, postPortalTenantProvision);
router.patch('/tenants/:tenantId/policy', requirePortalInternalAuth, patchPortalTenantPolicy);
router.get('/tenants/:tenantId/conversations', inboxModule, getPortalConversations);
router.patch('/tenants/:tenantId/conversations/archive', inboxModule, patchPortalConversationsArchive);
router.patch('/tenants/:tenantId/conversations/restore', inboxModule, patchPortalConversationsRestore);
router.get('/tenants/:tenantId/conversations/:conversationId', inboxModule, getPortalConversation);
router.get('/tenants/:tenantId/conversations/:conversationId/messages/:messageId/media', inboxModule, getPortalConversationMessageMedia);
router.patch('/tenants/:tenantId/conversations/:conversationId/assign-seller', inboxModule, patchPortalConversationAssignSeller);
router.patch('/tenants/:tenantId/conversations/:conversationId/lead-status', inboxModule, patchPortalConversationLeadStatusController);
router.patch('/tenants/:tenantId/conversations/:conversationId/next-action', inboxModule, patchPortalConversationNextActionController);
router.patch('/tenants/:tenantId/conversations/:conversationId', inboxModule, updatePortalConversation);
router.post('/tenants/:tenantId/messages', inboxModule, postPortalMessage);
router.post('/tenants/:tenantId/whatsapp-imports/preview', requirePortalInternalAuth, inboxModule, handleWhatsAppChatImportUpload, postPortalWhatsAppImportPreview);
router.post('/tenants/:tenantId/whatsapp-imports/:importId/confirm', requirePortalInternalAuth, inboxModule, postPortalWhatsAppImportConfirm);
router.get('/tenants/:tenantId/orders', ordersCapability, getPortalOrders);
router.get('/tenants/:tenantId/orders/payment-metrics', ordersCapability, getPortalOrdersPaymentMetrics);
router.get('/tenants/:tenantId/seller-metrics', getPortalSellerMetricsController);
router.post('/tenants/:tenantId/orders', ordersCapability, postPortalOrder);
router.get('/tenants/:tenantId/orders/:orderId', ordersCapability, getPortalOrder);
router.patch('/tenants/:tenantId/orders/:orderId', ordersCapability, patchPortalOrderController);
router.patch('/tenants/:tenantId/orders/:orderId/status', ordersCapability, updatePortalOrderStatus);
router.post('/tenants/:tenantId/orders/:orderId/payment-validation', ordersCapability, postPortalOrderPaymentValidation);
router.get('/tenants/:tenantId/products', catalogModule, getPortalProducts);
router.get('/tenants/:tenantId/product-categories', catalogModule, getPortalProductCategories);
router.post('/tenants/:tenantId/products', catalogModule, postPortalProduct);
router.post('/tenants/:tenantId/products/image-upload', requirePortalInternalAuth, catalogModule, handleCatalogImageUpload, postPortalProductImageUpload);
router.post('/tenants/:tenantId/product-categories', catalogModule, postPortalProductCategory);
router.post('/tenants/:tenantId/products/bulk', catalogModule, postPortalProductsBulk);
router.post('/tenants/:tenantId/products/bulk-delete/preview', requirePortalInternalAuth, catalogModule, postPortalProductsBulkDeletePreview);
router.post('/tenants/:tenantId/products/bulk-delete/execute', requirePortalInternalAuth, catalogModule, postPortalProductsBulkDeleteExecute);
router.get('/tenants/:tenantId/catalog-imports', requirePortalInternalAuth, catalogModule, getPortalCatalogImports);
router.get('/tenants/:tenantId/catalog-imports/template', requirePortalInternalAuth, catalogModule, getPortalCatalogImportTemplate);
router.post('/tenants/:tenantId/catalog-imports/analyze', requirePortalInternalAuth, catalogModule, handleCatalogImportUpload, postPortalCatalogImportAnalyze);
router.get('/tenants/:tenantId/catalog-imports/:importId', requirePortalInternalAuth, catalogModule, getPortalCatalogImport);
router.post('/tenants/:tenantId/catalog-imports/:importId/confirm', requirePortalInternalAuth, catalogModule, postPortalCatalogImportConfirm);
router.post('/tenants/:tenantId/catalog-imports/:importId/cancel', requirePortalInternalAuth, catalogModule, postPortalCatalogImportCancel);
router.post('/tenants/:tenantId/catalog-imports/:importId/rollback/preview', requirePortalInternalAuth, catalogModule, postPortalCatalogImportRollbackPreview);
router.post('/tenants/:tenantId/catalog-imports/:importId/rollback', requirePortalInternalAuth, catalogModule, postPortalCatalogImportRollbackExecute);
router.get('/tenants/:tenantId/catalog-imports/:importId/errors', requirePortalInternalAuth, catalogModule, getPortalCatalogImportErrors);
router.get('/tenants/:tenantId/inventory/products', inventoryCapability, getPortalInventoryProductsController);
router.get('/tenants/:tenantId/inventory/products/:productId/movements', inventoryCapability, getPortalInventoryProductHistoryController);
router.post('/tenants/:tenantId/inventory/products/:productId/movements', requirePortalInternalAuth, inventoryCapability, postPortalInventoryMovementController);
router.get('/tenants/:tenantId/inventory/lots', inventoryCapability, getPortalInventoryLots);
router.post('/tenants/:tenantId/inventory/lots', inventoryCapability, postPortalInventoryLot);
router.get('/tenants/:tenantId/inventory/expiration-summary', inventoryCapability, getPortalInventoryExpirationSummary);
router.get('/tenants/:tenantId/inventory/expiration-settings', inventoryCapability, getPortalInventoryExpirationSettings);
router.put('/tenants/:tenantId/inventory/expiration-settings', inventoryCapability, putPortalInventoryExpirationSettings);
router.post('/tenants/:tenantId/inventory/lots/bulk-writeoff-expired', inventoryCapability, postPortalInventoryExpiredBulkWriteoff);
router.get('/tenants/:tenantId/inventory/lots/:lotId', inventoryCapability, getPortalInventoryLot);
router.post('/tenants/:tenantId/inventory/lots/:lotId/adjust', inventoryCapability, postPortalInventoryLotAdjustment);
router.get('/tenants/:tenantId/products/:productId', catalogModule, getPortalProduct);
router.post('/tenants/:tenantId/products/:productId/inventory-mode', catalogModule, postPortalProductInventoryMode);
router.patch('/tenants/:tenantId/products/:productId', catalogModule, updatePortalProduct);
router.patch('/tenants/:tenantId/product-categories/:categoryId', catalogModule, updatePortalProductCategory);
router.delete('/tenants/:tenantId/product-categories/:categoryId', catalogModule, destroyPortalProductCategory);
router.patch('/tenants/:tenantId/products/:productId/status', catalogModule, updatePortalProductStatus);
router.delete('/tenants/:tenantId/products/:productId', requirePortalInternalAuth, catalogModule, destroyPortalProduct);
router.get('/tenants/:tenantId/contacts', contactsCapability, getPortalContacts);
router.patch('/tenants/:tenantId/contacts/archive', contactsCapability, patchPortalContactsArchive);
router.patch('/tenants/:tenantId/contacts/restore', contactsCapability, patchPortalContactsRestore);
router.delete('/tenants/:tenantId/contacts/archived', contactsCapability, deletePortalArchivedContactsController);
router.post('/tenants/:tenantId/contacts', contactsCapability, postPortalContact);
router.get('/tenants/:tenantId/contacts/:contactId', contactsCapability, getPortalContact);
router.patch('/tenants/:tenantId/contacts/:contactId', contactsCapability, patchPortalContact);
router.get('/tenants/:tenantId/invoices', receiptsCapability, getPortalInvoices);
router.post('/tenants/:tenantId/invoices', receiptsCapability, postPortalInvoice);
router.get('/tenants/:tenantId/invoices/export.csv', receiptsCapability, getPortalInvoicesCsvExport);
router.patch('/tenants/:tenantId/invoices/bulk-status', receiptsCapability, patchPortalInvoicesBulkStatus);
router.post('/tenants/:tenantId/invoices/bulk-download', receiptsCapability, postPortalInvoicesBulkDownload);
router.get('/tenants/:tenantId/invoices/:invoiceId', receiptsCapability, getPortalInvoice);
router.get('/tenants/:tenantId/invoices/:invoiceId/document', receiptsCapability, getPortalInvoiceDocumentController);
router.get('/tenants/:tenantId/invoices/:invoiceId/download', receiptsCapability, getPortalInvoiceDownloadController);
router.get('/tenants/:tenantId/invoices/:invoiceId/allocations', receiptsCapability, getPortalInvoiceAllocations);
router.patch('/tenants/:tenantId/invoices/:invoiceId', receiptsCapability, patchPortalInvoice);
router.patch('/tenants/:tenantId/invoices/:invoiceId/accounting', receiptsCapability, patchPortalInvoiceAccountingController);
router.post('/tenants/:tenantId/invoices/:invoiceId/issue', receiptsCapability, postPortalInvoiceIssue);
router.post('/tenants/:tenantId/invoices/:invoiceId/void', receiptsCapability, postPortalInvoiceVoid);
router.get('/tenants/:tenantId/payments', paymentsModule, getPortalPayments);
router.post('/tenants/:tenantId/payments', paymentsModule, postPortalPayment);
router.get('/tenants/:tenantId/payment-destinations', paymentsModule, getPortalPaymentDestinations);
router.post('/tenants/:tenantId/payment-destinations', paymentsModule, postPortalPaymentDestination);
router.patch('/tenants/:tenantId/payment-destinations/:destinationId', paymentsModule, patchPortalPaymentDestinationController);
router.get('/tenants/:tenantId/cash-sessions', cashCapability, getPortalCashOverview);
router.post('/tenants/:tenantId/cash-sessions', cashCapability, postPortalCashSession);
router.post('/tenants/:tenantId/cash-sessions/:sessionId/close', cashCapability, postPortalCashSessionClose);
router.post('/tenants/:tenantId/cash-sessions/:sessionId/movements', cashCapability, postPortalCashSessionMovement);
router.get('/tenants/:tenantId/agenda', requirePortalInternalAuth, agendaModule, getPortalAgenda);
router.get('/tenants/:tenantId/agenda/availability', requirePortalInternalAuth, agendaModule, getPortalAgendaAvailabilityController);
router.post('/tenants/:tenantId/agenda', requirePortalInternalAuth, agendaModule, postPortalAgenda);
router.post('/tenants/:tenantId/agenda/reservations', requirePortalInternalAuth, agendaModule, postPortalAgendaReservation);
router.patch('/tenants/:tenantId/agenda/:itemId', requirePortalInternalAuth, agendaModule, patchPortalAgenda);
router.delete('/tenants/:tenantId/agenda/:itemId', requirePortalInternalAuth, agendaModule, deletePortalAgenda);
router.get('/tenants/:tenantId/payments/:paymentId', paymentsModule, getPortalPayment);
router.get('/tenants/:tenantId/payments/:paymentId/allocations', paymentsModule, getPortalPaymentAllocations);
router.post('/tenants/:tenantId/payments/:paymentId/allocations', paymentsModule, postPortalPaymentAllocation);
router.post('/tenants/:tenantId/payments/:paymentId/void', paymentsModule, postPortalPaymentVoid);
router.get('/tenants/:tenantId/sales/summary', salesModule, getPortalSalesSummary);
router.get('/tenants/:tenantId/sales/metrics', salesModule, getPortalSalesMetrics);
router.get('/tenants/:tenantId/sales/opportunities', salesModule, getPortalSalesOpportunities);
router.get('/tenants/:tenantId/loyalty/program', requirePortalInternalAuth, loyaltyModule, getPortalLoyaltyProgramController);
router.patch('/tenants/:tenantId/loyalty/program', requirePortalInternalAuth, loyaltyModule, patchPortalLoyaltyProgramController);
router.get('/tenants/:tenantId/loyalty/rewards', requirePortalInternalAuth, loyaltyModule, getPortalLoyaltyRewardsController);
router.post('/tenants/:tenantId/loyalty/rewards', requirePortalInternalAuth, loyaltyModule, postPortalLoyaltyRewardController);
router.patch('/tenants/:tenantId/loyalty/rewards/:rewardId', requirePortalInternalAuth, loyaltyModule, patchPortalLoyaltyRewardController);
router.post(
  '/tenants/:tenantId/loyalty/rewards/image-upload',
  requirePortalInternalAuth,
  loyaltyModule,
  handleLoyaltyRewardImageUpload,
  postPortalLoyaltyRewardImageUpload
);
router.get('/tenants/:tenantId/loyalty/contacts/:contactId', requirePortalInternalAuth, loyaltyModule, getPortalLoyaltyContactController);
router.get('/tenants/:tenantId/loyalty/overview', requirePortalInternalAuth, loyaltyModule, getPortalLoyaltyOverviewController);
router.post('/tenants/:tenantId/loyalty/redemptions', requirePortalInternalAuth, loyaltyModule, postPortalLoyaltyRedeemController);
router.get('/tenants/:tenantId/automations', requirePortalInternalAuth, automationsModule, getPortalAutomations);
router.get('/tenants/:tenantId/automations/catalog/:templateKey/metrics', requirePortalInternalAuth, automationsModule, getPortalAutomationTemplateMetrics);
router.post('/tenants/:tenantId/automations', requirePortalInternalAuth, automationsModule, postPortalAutomation);
router.patch('/tenants/:tenantId/automations/catalog/:templateKey', requirePortalInternalAuth, automationsModule, patchPortalAutomationTemplate);
router.patch('/tenants/:tenantId/automations/:automationId', requirePortalInternalAuth, automationsModule, patchPortalAutomation);
router.delete('/tenants/:tenantId/automations/:automationId', requirePortalInternalAuth, automationsModule, destroyPortalAutomation);
router.get('/tenants/:tenantId/business', requirePortalInternalAuth, getPortalBusiness);
router.patch('/tenants/:tenantId/business', requirePortalInternalAuth, patchPortalBusiness);
router.get('/tenants/:tenantId/bot-settings', requirePortalInternalAuth, getPortalBotSettingsController);
router.patch('/tenants/:tenantId/bot-settings', requirePortalInternalAuth, patchPortalBotSettingsController);
router.get('/tenants/:tenantId/bot/transfer-config', requirePortalInternalAuth, getPortalBotTransferConfigController);
router.post('/tenants/:tenantId/bot/transfer-config', requirePortalInternalAuth, postPortalBotTransferConfigController);
router.get('/tenants/:tenantId/whatsapp/embedded-signup/status', requirePortalInternalAuth, getPortalWhatsAppEmbeddedSignupStatus);
router.post('/tenants/:tenantId/whatsapp/embedded-signup/refresh', requirePortalInternalAuth, postPortalWhatsAppEmbeddedSignupRefresh);
router.post('/tenants/:tenantId/whatsapp/embedded-signup/cancel', requirePortalInternalAuth, postPortalWhatsAppEmbeddedSignupCancel);
router.post('/tenants/:tenantId/whatsapp/embedded-signup/bootstrap', requirePortalInternalAuth, postPortalWhatsAppEmbeddedSignupBootstrap);
router.post('/tenants/:tenantId/whatsapp/embedded-signup/finalize', requirePortalInternalAuth, postPortalWhatsAppEmbeddedSignupFinalize);
router.post('/tenants/:tenantId/whatsapp/manual-connect', requirePortalInternalAuth, postPortalWhatsAppManualConnect);
router.post('/tenants/:tenantId/whatsapp/discover-assets', requirePortalInternalAuth, postPortalWhatsAppDiscoverAssets);
router.get('/tenants/:tenantId/whatsapp/status', requirePortalInternalAuth, getPortalWhatsAppStatusController);
router.get('/tenants/:tenantId/instagram/status', requirePortalInternalAuth, getPortalInstagramStatus);
router.post('/tenants/:tenantId/instagram/connect', requirePortalInternalAuth, postPortalInstagramConnect);
router.get('/tenants/:tenantId/whatsapp/default-channel', requirePortalInternalAuth, getPortalWhatsAppDefaultChannel);
router.patch('/tenants/:tenantId/whatsapp/default-channel', requirePortalInternalAuth, patchPortalWhatsAppDefaultChannel);
router.get('/tenants/:tenantId/whatsapp/templates/blueprints', requirePortalInternalAuth, getPortalWhatsAppTemplateBlueprints);
router.get('/tenants/:tenantId/whatsapp/templates', requirePortalInternalAuth, getPortalWhatsAppTemplates);
router.post('/tenants/:tenantId/whatsapp/templates/create-from-blueprint', requirePortalInternalAuth, postPortalWhatsAppTemplateFromBlueprint);
router.post('/tenants/:tenantId/whatsapp/templates/sync', requirePortalInternalAuth, postPortalWhatsAppTemplatesSync);
router.get('/tenants/:tenantId/users', requirePortalInternalAuth, getPortalUsers);
router.post('/tenants/:tenantId/users', requirePortalInternalAuth, postPortalUser);
router.patch('/tenants/:tenantId/users/primary', requirePortalInternalAuth, patchPortalPrimaryUser);
router.patch('/tenants/:tenantId/users/:userId', requirePortalInternalAuth, patchPortalUser);
router.delete('/tenants/:tenantId/users/:userId', requirePortalInternalAuth, destroyPortalUser);
router.get('/auth/invitations', getPortalInvitation);
router.post('/auth/invitations/accept', postPortalInvitationAccept);
router.post('/auth/login', postPortalAuthLogin);
router.post('/auth/forgot-password', postPortalAuthForgotPassword);
router.post('/auth/forgot-password/invalidate', postPortalAuthForgotPasswordInvalidate);
router.get('/auth/reset-password/validate', getPortalAuthResetPasswordValidation);
router.post('/auth/reset-password', postPortalAuthResetPassword);
router.get('/auth/users/by-email', requirePortalInternalAuth, getPortalAuthUser);
router.get('/auth/admin-actor', requirePortalInternalAuth, getPortalAuthAdminActor);

module.exports = router;
