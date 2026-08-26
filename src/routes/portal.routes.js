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
  destroyPortalConversation,
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
  getPortalProductImages,
  getPortalPurchaseReceiptsController,
  getPortalPurchaseReceiptController,
  getPortalSuppliers,
  getPortalSupplier,
  getPortalProductCategories,
  getPortalProduct,
  postPortalProduct,
  postPortalPurchaseReceiptController,
  postPortalSupplier,
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
  getPortalInventoryLotHistoryController,
  getPortalInventoryMovementsController,
  getPortalInventoryProductHistoryController,
  getPortalInventoryExpirationSummary,
  getPortalInventoryExpirationSettings,
  putPortalInventoryExpirationSettings,
  postPortalInventoryExpiredBulkWriteoff,
  postPortalInventoryLot,
  postPortalInventoryLotAdjustment,
  postPortalInventoryLotBlock,
  postPortalInventoryLotUnblock,
  patchPortalInventoryLotExpiration,
  getPortalInventoryLocationsController,
  postPortalInventoryLocationController,
  patchPortalInventoryLocationController,
  postPortalInventoryMovementController,
  postPortalInventoryBulkAdjustmentController,
  postPortalProductInventoryMode,
  updatePortalProduct,
  patchPortalSupplier,
  patchPortalSupplierStatus,
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
const {
  getOperationalAlertEventTypes,
  getOperationalAlertSettings,
  patchOperationalAlertSettings,
  getOperationalAlertRecipients,
  getOperationalAlertRecipient,
  postOperationalAlertRecipient,
  patchOperationalAlertRecipient,
  postOperationalAlertRecipientDisable,
  postOperationalAlertRecipientConsent,
  getOperationalAlertRules,
  getOperationalAlertRule,
  postOperationalAlertRule,
  patchOperationalAlertRule,
  putOperationalAlertRuleRecipients,
  getOperationalAlertRuleReadiness,
  getOperationalAlertRuleCandidatePreview,
  getOperationalAlertObservability,
  getOperationalAlertRuleCanaryPreflight,
  postOperationalAlertRuleEnable,
  postOperationalAlertRuleDisable,
  postOperationalAlertRulePreview,
  getOperationalAlertHistory,
  getOperationalAlertHistoryDetail
} = require('../controllers/portal-operational-alerts.controller');
const { requirePortalInternalAuth } = require('../middlewares/portal-internal-auth.middleware');
const { requireOperationalTenant } = require('../middlewares/portal-tenant-lifecycle.middleware');
const { applyPortalActiveTenant } = require('../middlewares/portal-active-tenant.middleware');
const { requirePortalModule, requirePortalCapability } = require('../middlewares/portal-module-gate.middleware');
const { requireInventoryReadRole, requireSensitiveInventoryRole, requireInventoryReceiptRole, requireCatalogWriteRole } = require('../middlewares/portal-inventory-authorization.middleware');
const { requireConversationDeleteRole } = require('../middlewares/portal-inbox-authorization.middleware');
const {
  requireOperationalAlertsReadPermission,
  requireOperationalAlertsWritePermission,
  requireOperationalAlertsAdminPermission
} = require('../middlewares/portal-operational-alerts-authorization.middleware');
const {
  requireWhatsAppTemplateSyncAdmin
} = require('../middlewares/portal-whatsapp-template-sync-authorization.middleware');
const {
  requireWhatsAppCanaryRead,
  requireWhatsAppCanaryWrite
} = require('../middlewares/portal-whatsapp-canary-authorization.middleware');
const {
  getCanary: getPortalWhatsAppTemplateCanary,
  postCanaryRefresh: postPortalWhatsAppTemplateCanaryRefresh,
  postCanary: postPortalWhatsAppTemplateCanary,
  postCanaryConversationRepair: postPortalWhatsAppTemplateCanaryConversationRepair
} = require('../controllers/portal-whatsapp-template-canary.controller');
const {
  requireAdminQaInventoryPermission
} = require('../middlewares/portal-admin-qa-inventory-authorization.middleware');
const {
  postAdminQaInventoryProduct,
  postAdminQaInventoryLocation,
  postAdminQaInventoryLot,
  postAdminQaInventoryLotRollback
} = require('../controllers/portal-admin-qa-inventory.controller');

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
const inventoryReadRole = requireInventoryReadRole();
const sensitiveInventoryRole = requireSensitiveInventoryRole();
const inventoryReceiptRole = requireInventoryReceiptRole();
const catalogWriteRole = requireCatalogWriteRole();
const conversationDeleteRole = requireConversationDeleteRole();
const operationalAlertsReadPermission = requireOperationalAlertsReadPermission();
const operationalAlertsWritePermission = requireOperationalAlertsWritePermission();
const operationalAlertsAdminPermission = requireOperationalAlertsAdminPermission();
function operationalAlertsNoStore(_req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}
function whatsappTemplateSyncNoStore(_req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}
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

router.use('/tenants/:tenantId/operational-alerts', operationalAlertsNoStore);
router.use('/tenants/:tenantId/whatsapp/templates/sync', whatsappTemplateSyncNoStore);
// Every tenant-scoped portal route is server-to-server only. Keeping this at
// the common boundary prevents a newly added route from accidentally bypassing
// authentication.
router.use(
  '/tenants/:tenantId',
  requirePortalInternalAuth,
  applyPortalActiveTenant
);

router.get('/product-images/:tenantId/:fileName', getPortalProductImagePublic);
router.get('/loyalty-reward-images/:tenantId/:fileName', getPortalLoyaltyRewardImagePublic);
router.use('/tenants/:tenantId', requireOperationalTenant);
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
router.delete('/tenants/:tenantId/conversations/:conversationId', requirePortalInternalAuth, inboxModule, conversationDeleteRole, destroyPortalConversation);
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
router.get('/tenants/:tenantId/products', requirePortalInternalAuth, inventoryReadRole, catalogModule, getPortalProducts);
router.get('/tenants/:tenantId/products/images', requirePortalInternalAuth, inventoryReadRole, catalogModule, getPortalProductImages);
router.get('/tenants/:tenantId/products/workspace', requirePortalInternalAuth, inventoryReadRole, catalogModule, getPortalProductImages);
router.get('/tenants/:tenantId/suppliers', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalSuppliers);
router.get('/tenants/:tenantId/purchase-receipts', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalPurchaseReceiptsController);
router.get('/tenants/:tenantId/purchase-receipts/:receiptId', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalPurchaseReceiptController);
router.get('/tenants/:tenantId/suppliers/:supplierId', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalSupplier);
router.post('/tenants/:tenantId/suppliers', requirePortalInternalAuth, inventoryReceiptRole, inventoryCapability, postPortalSupplier);
router.post('/tenants/:tenantId/purchase-receipts', requirePortalInternalAuth, inventoryReceiptRole, inventoryCapability, postPortalPurchaseReceiptController);
router.patch('/tenants/:tenantId/suppliers/:supplierId', requirePortalInternalAuth, inventoryReceiptRole, inventoryCapability, patchPortalSupplier);
router.patch('/tenants/:tenantId/suppliers/:supplierId/status', requirePortalInternalAuth, inventoryReceiptRole, inventoryCapability, patchPortalSupplierStatus);
router.get('/tenants/:tenantId/product-categories', requirePortalInternalAuth, inventoryReadRole, catalogModule, getPortalProductCategories);
router.post('/tenants/:tenantId/products', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalProduct);
router.post('/tenants/:tenantId/products/image-upload', requirePortalInternalAuth, catalogWriteRole, catalogModule, handleCatalogImageUpload, postPortalProductImageUpload);
router.post('/tenants/:tenantId/product-categories', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalProductCategory);
router.post('/tenants/:tenantId/products/bulk', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalProductsBulk);
router.post('/tenants/:tenantId/products/bulk-delete/preview', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalProductsBulkDeletePreview);
router.post('/tenants/:tenantId/products/bulk-delete/execute', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalProductsBulkDeleteExecute);
router.get('/tenants/:tenantId/catalog-imports', requirePortalInternalAuth, catalogWriteRole, catalogModule, getPortalCatalogImports);
router.get('/tenants/:tenantId/catalog-imports/template', requirePortalInternalAuth, catalogWriteRole, catalogModule, getPortalCatalogImportTemplate);
router.post('/tenants/:tenantId/catalog-imports/analyze', requirePortalInternalAuth, catalogWriteRole, catalogModule, handleCatalogImportUpload, postPortalCatalogImportAnalyze);
router.get('/tenants/:tenantId/catalog-imports/:importId', requirePortalInternalAuth, catalogWriteRole, catalogModule, getPortalCatalogImport);
router.post('/tenants/:tenantId/catalog-imports/:importId/confirm', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalCatalogImportConfirm);
router.post('/tenants/:tenantId/catalog-imports/:importId/cancel', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalCatalogImportCancel);
router.post('/tenants/:tenantId/catalog-imports/:importId/rollback/preview', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalCatalogImportRollbackPreview);
router.post('/tenants/:tenantId/catalog-imports/:importId/rollback', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalCatalogImportRollbackExecute);
router.get('/tenants/:tenantId/catalog-imports/:importId/errors', requirePortalInternalAuth, catalogWriteRole, catalogModule, getPortalCatalogImportErrors);
router.get('/tenants/:tenantId/inventory/products', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalInventoryProductsController);
router.get('/tenants/:tenantId/inventory/movements', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalInventoryMovementsController);
router.get('/tenants/:tenantId/inventory/products/:productId/movements', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalInventoryProductHistoryController);
router.post('/tenants/:tenantId/inventory/bulk-adjust', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, postPortalInventoryBulkAdjustmentController);
router.post('/tenants/:tenantId/inventory/products/:productId/movements', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, postPortalInventoryMovementController);
router.get('/tenants/:tenantId/inventory/lots', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalInventoryLots);
router.post('/tenants/:tenantId/inventory/lots', requirePortalInternalAuth, inventoryCapability, inventoryReceiptRole, postPortalInventoryLot);
router.get('/tenants/:tenantId/inventory/locations', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalInventoryLocationsController);
router.post('/tenants/:tenantId/inventory/locations', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, postPortalInventoryLocationController);
router.patch('/tenants/:tenantId/inventory/locations/:locationId', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, patchPortalInventoryLocationController);
router.get('/tenants/:tenantId/inventory/expiration-summary', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalInventoryExpirationSummary);
router.get('/tenants/:tenantId/inventory/expiration-settings', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalInventoryExpirationSettings);
router.put('/tenants/:tenantId/inventory/expiration-settings', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, putPortalInventoryExpirationSettings);
router.post('/tenants/:tenantId/inventory/lots/bulk-writeoff-expired', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, postPortalInventoryExpiredBulkWriteoff);
router.get('/tenants/:tenantId/inventory/lots/:lotId', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalInventoryLot);
router.get('/tenants/:tenantId/inventory/lots/:lotId/history', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalInventoryLotHistoryController);
router.post('/tenants/:tenantId/inventory/lots/:lotId/adjust', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, postPortalInventoryLotAdjustment);
router.post('/tenants/:tenantId/inventory/lots/:lotId/block', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, postPortalInventoryLotBlock);
router.post('/tenants/:tenantId/inventory/lots/:lotId/unblock', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, postPortalInventoryLotUnblock);
router.patch('/tenants/:tenantId/inventory/lots/:lotId/expiration', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, patchPortalInventoryLotExpiration);
// Deliberately separate from generic inventory routes: only a server-resolved
// Opturon Admin selecting an active client tenant can create this one canonical
// QA inventory fixture and its audit-preserving rollback.
router.post('/tenants/:tenantId/admin-qa-inventory/products', requirePortalInternalAuth, requireAdminQaInventoryPermission, catalogModule, inventoryCapability, postAdminQaInventoryProduct);
router.post('/tenants/:tenantId/admin-qa-inventory/locations', requirePortalInternalAuth, requireAdminQaInventoryPermission, inventoryCapability, postAdminQaInventoryLocation);
router.post('/tenants/:tenantId/admin-qa-inventory/lots', requirePortalInternalAuth, requireAdminQaInventoryPermission, inventoryCapability, postAdminQaInventoryLot);
router.post('/tenants/:tenantId/admin-qa-inventory/lots/:lotId/rollback', requirePortalInternalAuth, requireAdminQaInventoryPermission, inventoryCapability, postAdminQaInventoryLotRollback);
router.get('/tenants/:tenantId/products/:productId', requirePortalInternalAuth, inventoryReadRole, catalogModule, getPortalProduct);
router.post('/tenants/:tenantId/products/:productId/inventory-mode', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, catalogModule, postPortalProductInventoryMode);
router.patch('/tenants/:tenantId/products/:productId', requirePortalInternalAuth, catalogWriteRole, catalogModule, updatePortalProduct);
router.patch('/tenants/:tenantId/product-categories/:categoryId', requirePortalInternalAuth, catalogWriteRole, catalogModule, updatePortalProductCategory);
router.delete('/tenants/:tenantId/product-categories/:categoryId', requirePortalInternalAuth, catalogWriteRole, catalogModule, destroyPortalProductCategory);
router.patch('/tenants/:tenantId/products/:productId/status', requirePortalInternalAuth, catalogWriteRole, catalogModule, updatePortalProductStatus);
router.delete('/tenants/:tenantId/products/:productId', requirePortalInternalAuth, catalogWriteRole, catalogModule, destroyPortalProduct);
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
router.get('/tenants/:tenantId/agenda', agendaModule, getPortalAgenda);
router.get('/tenants/:tenantId/agenda/availability', agendaModule, getPortalAgendaAvailabilityController);
router.post('/tenants/:tenantId/agenda', agendaModule, postPortalAgenda);
router.post('/tenants/:tenantId/agenda/reservations', agendaModule, postPortalAgendaReservation);
router.patch('/tenants/:tenantId/agenda/:itemId', agendaModule, patchPortalAgenda);
router.delete('/tenants/:tenantId/agenda/:itemId', agendaModule, deletePortalAgenda);
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
router.get('/tenants/:tenantId/operational-alerts/event-types', requirePortalInternalAuth, operationalAlertsReadPermission, getOperationalAlertEventTypes);
router.get('/tenants/:tenantId/operational-alerts/settings', requirePortalInternalAuth, operationalAlertsReadPermission, getOperationalAlertSettings);
router.patch('/tenants/:tenantId/operational-alerts/settings', requirePortalInternalAuth, operationalAlertsAdminPermission, patchOperationalAlertSettings);
router.get('/tenants/:tenantId/operational-alerts/observability', requirePortalInternalAuth, operationalAlertsAdminPermission, getOperationalAlertObservability);
router.get('/tenants/:tenantId/operational-alerts/recipients', requirePortalInternalAuth, operationalAlertsReadPermission, getOperationalAlertRecipients);
router.post('/tenants/:tenantId/operational-alerts/recipients', requirePortalInternalAuth, operationalAlertsWritePermission, postOperationalAlertRecipient);
router.get('/tenants/:tenantId/operational-alerts/recipients/:recipientId', requirePortalInternalAuth, operationalAlertsReadPermission, getOperationalAlertRecipient);
router.patch('/tenants/:tenantId/operational-alerts/recipients/:recipientId', requirePortalInternalAuth, operationalAlertsWritePermission, patchOperationalAlertRecipient);
router.post('/tenants/:tenantId/operational-alerts/recipients/:recipientId/disable', requirePortalInternalAuth, operationalAlertsWritePermission, postOperationalAlertRecipientDisable);
router.post('/tenants/:tenantId/operational-alerts/recipients/:recipientId/consent', requirePortalInternalAuth, operationalAlertsWritePermission, postOperationalAlertRecipientConsent);
router.get('/tenants/:tenantId/operational-alerts/rules', requirePortalInternalAuth, operationalAlertsReadPermission, getOperationalAlertRules);
router.post('/tenants/:tenantId/operational-alerts/rules', requirePortalInternalAuth, operationalAlertsWritePermission, postOperationalAlertRule);
router.get('/tenants/:tenantId/operational-alerts/rules/:ruleId', requirePortalInternalAuth, operationalAlertsReadPermission, getOperationalAlertRule);
router.patch('/tenants/:tenantId/operational-alerts/rules/:ruleId', requirePortalInternalAuth, operationalAlertsWritePermission, patchOperationalAlertRule);
router.put('/tenants/:tenantId/operational-alerts/rules/:ruleId/recipients', requirePortalInternalAuth, operationalAlertsWritePermission, putOperationalAlertRuleRecipients);
router.get('/tenants/:tenantId/operational-alerts/rules/:ruleId/readiness', requirePortalInternalAuth, operationalAlertsReadPermission, getOperationalAlertRuleReadiness);
router.get('/tenants/:tenantId/operational-alerts/rules/:ruleId/candidate-preview', requirePortalInternalAuth, operationalAlertsAdminPermission, getOperationalAlertRuleCandidatePreview);
router.get('/tenants/:tenantId/operational-alerts/rules/:ruleId/canary-preflight', requirePortalInternalAuth, operationalAlertsAdminPermission, getOperationalAlertRuleCanaryPreflight);
router.post('/tenants/:tenantId/operational-alerts/rules/:ruleId/enable', requirePortalInternalAuth, operationalAlertsWritePermission, postOperationalAlertRuleEnable);
router.post('/tenants/:tenantId/operational-alerts/rules/:ruleId/disable', requirePortalInternalAuth, operationalAlertsWritePermission, postOperationalAlertRuleDisable);
router.post('/tenants/:tenantId/operational-alerts/rules/:ruleId/preview', requirePortalInternalAuth, operationalAlertsReadPermission, postOperationalAlertRulePreview);
router.get('/tenants/:tenantId/operational-alerts/history', requirePortalInternalAuth, operationalAlertsReadPermission, getOperationalAlertHistory);
router.get('/tenants/:tenantId/operational-alerts/history/:instanceId', requirePortalInternalAuth, operationalAlertsReadPermission, getOperationalAlertHistoryDetail);
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
router.get('/tenants/:tenantId/whatsapp/templates/canary', requirePortalInternalAuth, requireWhatsAppCanaryRead, getPortalWhatsAppTemplateCanary);
router.post('/tenants/:tenantId/whatsapp/templates/canary/refresh', requirePortalInternalAuth, requireWhatsAppCanaryWrite, postPortalWhatsAppTemplateCanaryRefresh);
router.post('/tenants/:tenantId/whatsapp/templates/canary', requirePortalInternalAuth, requireWhatsAppCanaryWrite, postPortalWhatsAppTemplateCanary);
router.post('/tenants/:tenantId/whatsapp/templates/canary/attempts/:attemptId/repair-conversation', requirePortalInternalAuth, requireWhatsAppCanaryWrite, postPortalWhatsAppTemplateCanaryConversationRepair);
router.post('/tenants/:tenantId/whatsapp/templates/create-from-blueprint', requirePortalInternalAuth, postPortalWhatsAppTemplateFromBlueprint);
router.post(
  '/tenants/:tenantId/whatsapp/templates/sync',
  requirePortalInternalAuth,
  requireWhatsAppTemplateSyncAdmin,
  postPortalWhatsAppTemplatesSync
);
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
