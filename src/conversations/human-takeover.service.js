const { withTransaction } = require('../db/client');
const conversationRepo = require('./conversation.repo');

const TAKEOVER_SOURCES = Object.freeze({
  WHATSAPP_BUSINESS_APP: 'WHATSAPP_BUSINESS_APP',
  OPTURON_INBOX: 'OPTURON_INBOX',
  MANUAL_PAUSE: 'MANUAL_PAUSE'
});

function buildTakeoverContextPatch(context, source, at = new Date().toISOString(), humanActivity = true) {
  if (!Object.values(TAKEOVER_SOURCES).includes(source)) {
    throw new Error('human_takeover_source_invalid');
  }
  const safeContext = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  return {
    portalBotEnabled: false,
    portalBotTakeoverSource: source,
    portalBotTakeoverStartedAt: safeContext.portalBotEnabled === false && safeContext.portalBotTakeoverStartedAt
      ? safeContext.portalBotTakeoverStartedAt
      : at,
    portalBotLastHumanActivityAt: humanActivity ? at : safeContext.portalBotLastHumanActivityAt || null
  };
}

function buildResumeContextPatch() {
  return {
    portalBotEnabled: true,
    portalBotTakeoverSource: null,
    portalBotTakeoverStartedAt: null,
    portalBotLastHumanActivityAt: null
  };
}

function getInboundProcessingJobType(context) {
  return context && context.portalBotEnabled === false ? 'conversation_operational' : 'conversation_reply';
}

async function activateHumanTakeover({ clinicId, conversationId, source, at = new Date().toISOString() }, client = null) {
  const run = async (tx) => {
    const result = await tx.query(
      `SELECT id, context FROM conversations
       WHERE id = $1::uuid AND "clinicId" = $2::uuid AND "deletedAt" IS NULL
       FOR UPDATE`,
      [conversationId, clinicId]
    );
    const conversation = result.rows[0] || null;
    if (!conversation) return null;
    const previousContext = conversation.context && typeof conversation.context === 'object' ? conversation.context : {};
    const patch = buildTakeoverContextPatch(previousContext, source, at);
    const updated = await conversationRepo.updateConversationStateForClinic({
      conversationId,
      clinicId,
      state: null,
      contextPatch: patch
    }, tx);
    return updated ? { conversationId, activated: previousContext.portalBotEnabled !== false, source } : null;
  };
  return client ? run(client) : withTransaction(run);
}

async function loadConversationScoped(conversationId, clinicId) {
  if (typeof conversationRepo.getConversationByIdAndClinicId === 'function') {
    return conversationRepo.getConversationByIdAndClinicId(conversationId, clinicId);
  }
  const conversation = await conversationRepo.getConversationById(conversationId);
  return conversation && conversation.clinicId === clinicId ? conversation : null;
}

async function isAutomaticReplyAllowedNow({ clinicId, conversationId, channelId }, loadConversation = loadConversationScoped) {
  const conversation = await loadConversation(conversationId, clinicId);
  return Boolean(
    conversation &&
    conversation.channelId === channelId &&
    !(conversation.context && conversation.context.portalBotEnabled === false)
  );
}

module.exports = {
  TAKEOVER_SOURCES,
  buildTakeoverContextPatch,
  buildResumeContextPatch,
  getInboundProcessingJobType,
  activateHumanTakeover,
  isAutomaticReplyAllowedNow
};
