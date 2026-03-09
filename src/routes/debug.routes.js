const express = require('express');
const env = require('../config/env');
const {
  getDebugConfig,
  getWhatsAppAssets,
  getWhatsAppFailures,
  sendDebugMessage,
  getWhatsAppAutofix,
  getWhatsAppWaba,
  getWhatsAppChannel,
  getWebhookEvents,
  getDebugConversations,
  getDebugConversationMessages,
  getAppointmentRequests,
  getInboxAppointments,
  getAppointmentRequestDetail,
  confirmAppointmentRequest,
  rejectAppointmentRequest,
  rescheduleAppointmentRequest,
  getAiReply,
  getAiAudit,
  getAppointmentsCalendar,
  getDebugInbox,
  clearDebugInbox,
  getDebugInboxHealth,
  getRecentWebhookEvents,
  getRecentWhatsAppJobs
} = require('../controllers/debug.controller');
const { getClinicLeads } = require('../controllers/leads.controller');
const { getConversationSnapshot } = require('../controllers/conversation.controller');
const {
  generateClinicSlots,
  getClinicAvailableSlots,
  getClinicAppointments
} = require('../controllers/calendar.controller');
const { assignConversationHandoff } = require('../controllers/handoff.controller');
const { requireDebugAccess } = require('../middlewares/debug-auth.middleware');
const { getInboxUi } = require('../controllers/debug.ui.controller');

const router = express.Router();

router.use((req, res, next) => {
  if (!env.whatsappDebug || !env.debugApiEnabled) {
    return res.status(404).json({ success: false, error: 'Endpoint not found' });
  }
  return next();
});

router.get('/ui/inbox', (req, res) => {
  if (!env.debugUiEnabled) {
    return res.status(404).json({ success: false, error: 'Endpoint not found' });
  }
  return getInboxUi(req, res);
});

router.use(requireDebugAccess);
router.get('/whatsapp/config', getDebugConfig);
router.get('/whatsapp/assets', getWhatsAppAssets);
router.get('/whatsapp/waba', getWhatsAppWaba);
router.get('/whatsapp/channel', getWhatsAppChannel);
router.get('/whatsapp/autofix', getWhatsAppAutofix);
router.get('/whatsapp/failures', getWhatsAppFailures);
router.get('/whatsapp/jobs/last', getRecentWhatsAppJobs);
router.get('/webhook/events', getWebhookEvents);
router.get('/webhook/recent', getRecentWebhookEvents);
router.get('/inbox', getDebugInbox);
router.post('/inbox/clear', clearDebugInbox);
router.get('/inbox/health', getDebugInboxHealth);
router.get('/conversations', getDebugConversations);
router.get('/conversations/:id/messages', getDebugConversationMessages);
router.get('/inbox/appointments', getInboxAppointments);
router.get('/appointments/requests', getAppointmentRequests);
router.get('/appointments/:conversationId', getAppointmentRequestDetail);
router.post('/appointments/:conversationId/confirm', confirmAppointmentRequest);
router.post('/appointments/:conversationId/reject', rejectAppointmentRequest);
router.post('/appointments/:conversationId/reschedule', rescheduleAppointmentRequest);
router.post('/ai/reply', getAiReply);
router.get('/ai/audit', getAiAudit);
router.get('/appointments/calendar', getAppointmentsCalendar);
router.post('/whatsapp/send-test', sendDebugMessage);
router.post('/send', sendDebugMessage);
router.get('/clinics/:clinicId/leads', getClinicLeads);
router.get('/clinics/:clinicId/conversations/:conversationId', getConversationSnapshot);
router.get('/clinics/:clinicId/appointments', getClinicAppointments);
router.post('/clinics/:clinicId/handoff/:conversationId/assign', assignConversationHandoff);
router.post('/clinics/:clinicId/calendar/generate', generateClinicSlots);
router.get('/clinics/:clinicId/calendar/available', getClinicAvailableSlots);

module.exports = router;
