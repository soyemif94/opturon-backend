const contactRepository = require('../repositories/contact.repository');
const conversationRepository = require('./conversation.repo');

function normalizeWhatsAppIdentity(value) {
  return String(value || '').replace(/\D/g, '');
}

function createWhatsAppConversationResolver(overrides = {}) {
  const dependencies = {
    upsertContact: contactRepository.upsertContact,
    upsertConversation: conversationRepository.upsertConversation,
    upsertOutboundConversation: conversationRepository.upsertOutboundConversation,
    ...overrides
  };

  return async function resolveWhatsAppConversation(input, client = null) {
    const clinicId = String(input && input.clinicId || '').trim();
    const channelId = String(input && input.channelId || '').trim();
    const identity = normalizeWhatsAppIdentity(input && (input.providerIdentity || input.phone));
    const direction = String(input && input.direction || '').trim().toLowerCase();
    if (!clinicId || !channelId || !identity || !['inbound', 'outbound'].includes(direction)) {
      throw new Error('whatsapp_conversation_identity_context_invalid');
    }

    const contact = await dependencies.upsertContact({
      clinicId,
      waId: identity,
      phone: input.phone || identity,
      name: input.contactName || null
    }, client, {
      preserveExistingName: input.preserveExistingName === true
    });
    if (!contact || !contact.id) throw new Error('whatsapp_contact_resolution_failed');

    const conversationInput = {
      waFrom: identity,
      waTo: normalizeWhatsAppIdentity(input.waTo),
      clinicId,
      channelId,
      contactId: contact.id
    };
    const conversation = direction === 'inbound'
      ? await dependencies.upsertConversation(conversationInput, client)
      : await dependencies.upsertOutboundConversation(conversationInput, client);
    if (!conversation || !conversation.id) throw new Error('whatsapp_conversation_resolution_failed');

    return { identity, contact, conversation };
  };
}

const resolveWhatsAppConversation = createWhatsAppConversationResolver();

module.exports = {
  normalizeWhatsAppIdentity,
  createWhatsAppConversationResolver,
  resolveWhatsAppConversation
};
