const express = require('express');
const {
  getPortalTenantContext,
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
  getPortalBusiness,
  getPortalUsers,
  postPortalUser,
  patchPortalPrimaryUser,
  postPortalAutomation,
  patchPortalAutomation,
  destroyPortalAutomation,
  patchPortalBusiness,
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
} = require('../controllers/portal.controller');
const { requirePortalInternalAuth } = require('../middlewares/portal-internal-auth.middleware');

const router = express.Router();

router.get('/tenants/:tenantId/context', getPortalTenantContext);
router.get('/tenants/:tenantId/conversations', getPortalConversations);
router.patch('/tenants/:tenantId/conversations/archive', patchPortalConversationsArchive);
router.patch('/tenants/:tenantId/conversations/restore', patchPortalConversationsRestore);
router.get('/tenants/:tenantId/conversations/:conversationId', getPortalConversation);
router.patch('/tenants/:tenantId/conversations/:conversationId/assign-seller', patchPortalConversationAssignSeller);
router.patch('/tenants/:tenantId/conversations/:conversationId/lead-status', patchPortalConversationLeadStatusController);
router.patch('/tenants/:tenantId/conversations/:conversationId/next-action', patchPortalConversationNextActionController);
router.patch('/tenants/:tenantId/conversations/:conversationId', updatePortalConversation);
router.post('/tenants/:tenantId/messages', postPortalMessage);
router.get('/tenants/:tenantId/orders', getPortalOrders);
router.get('/tenants/:tenantId/orders/payment-metrics', getPortalOrdersPaymentMetrics);
router.get('/tenants/:tenantId/seller-metrics', getPortalSellerMetricsController);
router.post('/tenants/:tenantId/orders', postPortalOrder);
router.get('/tenants/:tenantId/orders/:orderId', getPortalOrder);
router.patch('/tenants/:tenantId/orders/:orderId', patchPortalOrderController);
router.patch('/tenants/:tenantId/orders/:orderId/status', updatePortalOrderStatus);
router.post('/tenants/:tenantId/orders/:orderId/payment-validation', postPortalOrderPaymentValidation);
router.get('/tenants/:tenantId/products', getPortalProducts);
router.get('/tenants/:tenantId/product-categories', getPortalProductCategories);
router.post('/tenants/:tenantId/products', postPortalProduct);
router.post('/tenants/:tenantId/product-categories', postPortalProductCategory);
router.post('/tenants/:tenantId/products/bulk', postPortalProductsBulk);
router.get('/tenants/:tenantId/products/:productId', getPortalProduct);
router.patch('/tenants/:tenantId/products/:productId', updatePortalProduct);
router.patch('/tenants/:tenantId/product-categories/:categoryId', updatePortalProductCategory);
router.delete('/tenants/:tenantId/product-categories/:categoryId', destroyPortalProductCategory);
router.patch('/tenants/:tenantId/products/:productId/status', updatePortalProductStatus);
router.delete('/tenants/:tenantId/products/:productId', destroyPortalProduct);
router.get('/tenants/:tenantId/contacts', getPortalContacts);
router.patch('/tenants/:tenantId/contacts/archive', patchPortalContactsArchive);
router.patch('/tenants/:tenantId/contacts/restore', patchPortalContactsRestore);
router.delete('/tenants/:tenantId/contacts/archived', deletePortalArchivedContactsController);
router.post('/tenants/:tenantId/contacts', postPortalContact);
router.get('/tenants/:tenantId/contacts/:contactId', getPortalContact);
router.patch('/tenants/:tenantId/contacts/:contactId', patchPortalContact);
router.get('/tenants/:tenantId/invoices', getPortalInvoices);
router.post('/tenants/:tenantId/invoices', postPortalInvoice);
router.get('/tenants/:tenantId/invoices/export.csv', getPortalInvoicesCsvExport);
router.patch('/tenants/:tenantId/invoices/bulk-status', patchPortalInvoicesBulkStatus);
router.post('/tenants/:tenantId/invoices/bulk-download', postPortalInvoicesBulkDownload);
router.get('/tenants/:tenantId/invoices/:invoiceId', getPortalInvoice);
router.get('/tenants/:tenantId/invoices/:invoiceId/document', getPortalInvoiceDocumentController);
router.get('/tenants/:tenantId/invoices/:invoiceId/download', getPortalInvoiceDownloadController);
router.get('/tenants/:tenantId/invoices/:invoiceId/allocations', getPortalInvoiceAllocations);
router.patch('/tenants/:tenantId/invoices/:invoiceId', patchPortalInvoice);
router.patch('/tenants/:tenantId/invoices/:invoiceId/accounting', patchPortalInvoiceAccountingController);
router.post('/tenants/:tenantId/invoices/:invoiceId/issue', postPortalInvoiceIssue);
router.post('/tenants/:tenantId/invoices/:invoiceId/void', postPortalInvoiceVoid);
router.get('/tenants/:tenantId/payments', getPortalPayments);
router.post('/tenants/:tenantId/payments', postPortalPayment);
router.get('/tenants/:tenantId/payment-destinations', getPortalPaymentDestinations);
router.post('/tenants/:tenantId/payment-destinations', postPortalPaymentDestination);
router.patch('/tenants/:tenantId/payment-destinations/:destinationId', patchPortalPaymentDestinationController);
router.get('/tenants/:tenantId/cash-sessions', getPortalCashOverview);
router.post('/tenants/:tenantId/cash-sessions', postPortalCashSession);
router.post('/tenants/:tenantId/cash-sessions/:sessionId/close', postPortalCashSessionClose);
router.get('/tenants/:tenantId/agenda', requirePortalInternalAuth, getPortalAgenda);
router.get('/tenants/:tenantId/agenda/availability', requirePortalInternalAuth, getPortalAgendaAvailabilityController);
router.post('/tenants/:tenantId/agenda', requirePortalInternalAuth, postPortalAgenda);
router.post('/tenants/:tenantId/agenda/reservations', requirePortalInternalAuth, postPortalAgendaReservation);
router.patch('/tenants/:tenantId/agenda/:itemId', requirePortalInternalAuth, patchPortalAgenda);
router.delete('/tenants/:tenantId/agenda/:itemId', requirePortalInternalAuth, deletePortalAgenda);
router.get('/tenants/:tenantId/payments/:paymentId', getPortalPayment);
router.get('/tenants/:tenantId/payments/:paymentId/allocations', getPortalPaymentAllocations);
router.post('/tenants/:tenantId/payments/:paymentId/allocations', postPortalPaymentAllocation);
router.post('/tenants/:tenantId/payments/:paymentId/void', postPortalPaymentVoid);
router.get('/tenants/:tenantId/sales/summary', getPortalSalesSummary);
router.get('/tenants/:tenantId/sales/metrics', getPortalSalesMetrics);
router.get('/tenants/:tenantId/sales/opportunities', getPortalSalesOpportunities);
router.get('/tenants/:tenantId/loyalty/program', requirePortalInternalAuth, getPortalLoyaltyProgramController);
router.patch('/tenants/:tenantId/loyalty/program', requirePortalInternalAuth, patchPortalLoyaltyProgramController);
router.get('/tenants/:tenantId/loyalty/rewards', requirePortalInternalAuth, getPortalLoyaltyRewardsController);
router.post('/tenants/:tenantId/loyalty/rewards', requirePortalInternalAuth, postPortalLoyaltyRewardController);
router.patch('/tenants/:tenantId/loyalty/rewards/:rewardId', requirePortalInternalAuth, patchPortalLoyaltyRewardController);
router.get('/tenants/:tenantId/loyalty/contacts/:contactId', requirePortalInternalAuth, getPortalLoyaltyContactController);
router.get('/tenants/:tenantId/loyalty/overview', requirePortalInternalAuth, getPortalLoyaltyOverviewController);
router.post('/tenants/:tenantId/loyalty/redemptions', requirePortalInternalAuth, postPortalLoyaltyRedeemController);
router.get('/tenants/:tenantId/automations', requirePortalInternalAuth, getPortalAutomations);
router.post('/tenants/:tenantId/automations', requirePortalInternalAuth, postPortalAutomation);
router.patch('/tenants/:tenantId/automations/:automationId', requirePortalInternalAuth, patchPortalAutomation);
router.delete('/tenants/:tenantId/automations/:automationId', requirePortalInternalAuth, destroyPortalAutomation);
router.get('/tenants/:tenantId/business', requirePortalInternalAuth, getPortalBusiness);
router.patch('/tenants/:tenantId/business', requirePortalInternalAuth, patchPortalBusiness);
router.get('/tenants/:tenantId/bot-settings', requirePortalInternalAuth, getPortalBotSettingsController);
router.patch('/tenants/:tenantId/bot-settings', requirePortalInternalAuth, patchPortalBotSettingsController);
router.get('/tenants/:tenantId/bot/transfer-config', requirePortalInternalAuth, getPortalBotTransferConfigController);
router.post('/tenants/:tenantId/bot/transfer-config', requirePortalInternalAuth, postPortalBotTransferConfigController);
router.get('/tenants/:tenantId/whatsapp/embedded-signup/status', requirePortalInternalAuth, getPortalWhatsAppEmbeddedSignupStatus);
router.post('/tenants/:tenantId/whatsapp/embedded-signup/bootstrap', requirePortalInternalAuth, postPortalWhatsAppEmbeddedSignupBootstrap);
router.post('/tenants/:tenantId/whatsapp/embedded-signup/finalize', requirePortalInternalAuth, postPortalWhatsAppEmbeddedSignupFinalize);
router.post('/tenants/:tenantId/whatsapp/manual-connect', requirePortalInternalAuth, postPortalWhatsAppManualConnect);
router.post('/tenants/:tenantId/whatsapp/discover-assets', requirePortalInternalAuth, postPortalWhatsAppDiscoverAssets);
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
router.post('/auth/login', postPortalAuthLogin);
router.get('/auth/users/by-email', requirePortalInternalAuth, getPortalAuthUser);

module.exports = router;
