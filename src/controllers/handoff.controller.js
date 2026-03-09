const { withTransaction } = require('../db/client');
const { getOpenHandoff, assignHandoff } = require('../repositories/handoff.repository');
const { addEvent } = require('../repositories/conversation-events.repository');
const { updateConversationStatus } = require('../repositories/conversation.repository');

async function assignConversationHandoff(req, res) {
  const { clinicId, conversationId } = req.params;
  const staffUserId = req.body && req.body.staffUserId ? String(req.body.staffUserId) : '';

  if (!staffUserId) {
    return res.status(400).json({ success: false, error: 'staffUserId es obligatorio.' });
  }

  try {
    const result = await withTransaction(async (client) => {
      const handoff = await getOpenHandoff(clinicId, conversationId, client);
      if (!handoff) {
        return null;
      }

      const assigned = await assignHandoff(handoff.id, staffUserId, client);
      await updateConversationStatus(conversationId, 'needs_human', client);
      await addEvent(
        {
          clinicId,
          conversationId,
          type: 'HANDOFF_ASSIGNED',
          data: { handoffId: handoff.id, staffUserId }
        },
        client
      );

      return assigned;
    });

    if (!result) {
      return res.status(404).json({ success: false, error: 'No hay handoff abierto para esta conversación.' });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo asignar handoff.',
      details: error.message
    });
  }
}

module.exports = {
  assignConversationHandoff
};

