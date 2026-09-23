const conversationRepo = require('./conversation.repo');
const { upsertLeadForConversation } = require('../repositories/lead.repository');
const { processTakeoverOrder } = require('../services/takeover-order-processing.service');
const { invalidatePendingForMessage } = require('../repositories/order-closure.repository');
const { invalidateForMessage: invalidateAmendmentForMessage } = require('../repositories/order-amendment.repository');

function createTakeoverOperationalProcessor(overrides = {}) {
  const deps = {
    updateConversation: conversationRepo.updateConversationStateForClinic || conversationRepo.updateConversationState,
    upsertLead: upsertLeadForConversation,
    processOrder: processTakeoverOrder,
    invalidateCandidate: async (...args) => {
      await invalidatePendingForMessage(...args);
      await invalidateAmendmentForMessage(...args);
    },
    ...overrides
  };
  return async function processTakeoverInbound({ clinicId, channelId, conversationId, contactId, inboundMessageId }) {
    if (!clinicId || !channelId || !conversationId || !contactId || !inboundMessageId) {
      throw new Error('takeover_operational_scope_missing');
    }
    await deps.upsertLead({ clinicId, channelId, conversationId, contactId, primaryIntent: null });
    await deps.invalidateCandidate(clinicId, conversationId, inboundMessageId);
    const orderProcessing = await deps.processOrder({ clinicId, channelId, conversationId, contactId, inboundMessageId });
    const updated = await deps.updateConversation({
      clinicId,
      conversationId,
      state: null,
      contextPatch: {
        portalLastProcessedInboundMessageId: inboundMessageId,
        portalLastProcessedInboundAt: new Date().toISOString(),
        portalLastOperationalOrderResult: orderProcessing && {
          mutated: orderProcessing.mutated === true,
          duplicate: orderProcessing.duplicate === true,
          operation: orderProcessing.operation || null,
          reason: orderProcessing.reason || null,
          orderId: orderProcessing.orderId || null,
          processedAt: new Date().toISOString()
        }
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
