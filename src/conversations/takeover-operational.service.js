const conversationRepo = require('./conversation.repo');
const { upsertLeadForConversation } = require('../repositories/lead.repository');

function createTakeoverOperationalProcessor(overrides = {}) {
  const deps = {
    updateConversation: conversationRepo.updateConversationStateForClinic || conversationRepo.updateConversationState,
    upsertLead: upsertLeadForConversation,
    ...overrides
  };
  return async function processTakeoverInbound({ clinicId, channelId, conversationId, contactId, inboundMessageId }) {
    if (!clinicId || !channelId || !conversationId || !contactId || !inboundMessageId) {
      throw new Error('takeover_operational_scope_missing');
    }
    await deps.upsertLead({ clinicId, channelId, conversationId, contactId, primaryIntent: null });
    const updated = await deps.updateConversation({
      clinicId,
      conversationId,
      state: null,
      contextPatch: {
        portalLastProcessedInboundMessageId: inboundMessageId,
        portalLastProcessedInboundAt: new Date().toISOString()
      }
    });
    if (!updated) throw new Error('takeover_operational_conversation_missing');
    return updated;
  };
}

module.exports = {
  createTakeoverOperationalProcessor,
  processTakeoverInbound: createTakeoverOperationalProcessor()
};
