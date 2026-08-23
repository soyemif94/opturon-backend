const contactRepository = require('../repositories/contact.repository');
const conversationRepository = require('./conversation.repo');

function normalizeWhatsAppIdentity(value) {
  return String(value || '').replace(/\D/g, '');
}

function whatsappIdentityCandidates(value) {
  const identity = normalizeWhatsAppIdentity(value);
  if (!identity) return [];
  if (identity.startsWith('549') && identity.length === 13) {
    return [identity, `54${identity.slice(3)}`];
  }
  if (identity.startsWith('54') && !identity.startsWith('549') && identity.length === 12) {
    return [`549${identity.slice(2)}`, identity];
  }
  return [identity];
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
    const identityCandidates = whatsappIdentityCandidates(input && (input.providerIdentity || input.phone));
    const identity = identityCandidates[0] || '';
    const direction = String(input && input.direction || '').trim().toLowerCase();
    if (!clinicId || !channelId || !identity || !['inbound', 'outbound'].includes(direction)) {
      throw new Error('whatsapp_conversation_identity_context_invalid');
    }

    if (client && typeof client.query === 'function') {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
        `whatsapp_contact_identity:${clinicId}`,
        identity
      ]);
    }
    const contact = await dependencies.upsertContact({
      clinicId,
      waId: identity,
      phone: input.phone || identity,
      name: input.contactName || null
    }, client, {
      preserveExistingName: input.preserveExistingName === true,
      preserveExistingIdentity: input.preserveExistingIdentity === true,
      identityCandidates
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

    return { identity, identityCandidates, contact, conversation };
  };
}

const resolveWhatsAppConversation = createWhatsAppConversationResolver();

module.exports = {
  normalizeWhatsAppIdentity,
  whatsappIdentityCandidates,
  createWhatsAppConversationResolver,
  resolveWhatsAppConversation
};
