const { findConversationById } = require('../repositories/conversation.repository');
const { findLeadByConversation } = require('../repositories/lead.repository');
const { getOpenHandoff } = require('../repositories/handoff.repository');
const { findBookedAppointmentByConversation } = require('../repositories/calendar.repository');
const { listEvents } = require('../repositories/conversation-events.repository');

async function getConversationSnapshot(req, res) {
  const { clinicId, conversationId } = req.params;

  try {
    const conversation = await findConversationById(conversationId);
    if (!conversation || conversation.clinicId !== clinicId) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada.' });
    }

    const [lead, handoff, appointment, events] = await Promise.all([
      findLeadByConversation(clinicId, conversationId),
      getOpenHandoff(clinicId, conversationId),
      findBookedAppointmentByConversation(clinicId, conversationId),
      listEvents(clinicId, conversationId, 50)
    ]);

    return res.status(200).json({
      success: true,
      data: {
        conversation,
        lead,
        handoff,
        appointment,
        events
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo obtener conversación.',
      details: error.message
    });
  }
}

module.exports = {
  getConversationSnapshot
};

