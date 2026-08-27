const { logInfo, logWarn, logError } = require('../utils/logger');
const { sanitizeString } = require('../utils/validators');
const {
  findChannelByPhoneNumberId,
  findInstagramChannelByRecipientId
} = require('../repositories/tenant.repository');
const repo = require('./conversation.repo');
const { resolveWhatsAppConversation } = require('./whatsapp-conversation-resolver');
const { extractMetaInboundMessages } = require('../webhooks/meta.webhook');
const { withTransaction } = require('../db/client');

function normalizeWaNumber(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function extractInboundMessages(body) {
  return extractMetaInboundMessages(body || {});
}

async function findInboundChannel(event) {
  if (!event) return null;

  if (event.channelType === 'instagram') {
    return findInstagramChannelByRecipientId(event.externalChannelId || event.pageId || '');
  }

  return findChannelByPhoneNumberId(event.phoneNumberId || '');
}

async function processInboundMessages({ body, headers, requestId }) {
  const events = extractInboundMessages(body);
  let received = 0;
  let enqueued = 0;
  let duplicates = 0;
  let unrouted = 0;
  let ignoredMissingWaMessageId = 0;

  for (const event of events) {
    received += 1;
    try {
      logInfo('conversation_inbound_received', {
        requestId,
        provider: event.channelProvider || null,
        phoneNumberId: event.phoneNumberId || null,
        from: event.fromId || null,
        to: event.toId || null,
        providerMessageId: event.providerMessageId || null,
        type: event.type || null,
        text: event.text || null
      });

      const channel = await findInboundChannel(event);
      if (!channel) {
        unrouted += 1;
        logWarn('conversation_unrouted_channel', {
          requestId,
          providerMessageId: event.providerMessageId || null,
          phoneNumberId: event.phoneNumberId || null,
          externalChannelId: event.externalChannelId || null,
          pageId: event.pageId || null
        });
        continue;
      }

      const persisted = await withTransaction(async (client) => {
        // Dedup precedes generation creation: a provider retry belonging to a
        // tombstoned thread must not manufacture an empty replacement thread.
        const existingMessage = await repo.findInboundMessageByProviderId(event.providerMessageId, client);
        if (existingMessage) return { duplicate: true, conversation: null, inboundWrite: { inserted: false } };

        const resolved = await resolveWhatsAppConversation({
          direction: 'inbound',
          providerIdentity: event.fromId,
          phone: event.fromId,
          contactName: event.name || null,
          waTo: event.toId || channel.externalId || channel.phoneNumberId,
          clinicId: channel.clinicId,
          channelId: channel.id
        }, client);
        const { contact, conversation } = resolved;
        const inboundWrite = await repo.insertInboundMessage({
          conversationId: conversation.id,
          waMessageId: event.providerMessageId,
          from: event.fromId,
          to: event.toId || channel.externalId || channel.phoneNumberId,
          type: event.type || 'text',
          text: event.text || '',
          raw: event.raw || {}
        }, client);
        if (inboundWrite.inserted && String(channel.provider || '').trim().toLowerCase() === 'whatsapp_cloud') {
          await repo.enqueueJob('conversation_reply', {
            clinicId: channel.clinicId, channelId: channel.id, conversationId: conversation.id,
            contactId: contact.id, inboundMessageId: inboundWrite.row.id, waMessageId: event.providerMessageId
          }, client);
        }
        return { duplicate: !inboundWrite.inserted, contact, conversation, inboundWrite };
      });
      const { conversation, inboundWrite } = persisted;

      if (persisted.duplicate || !inboundWrite.inserted) {
        if (inboundWrite.reason === 'missing_waMessageId') {
          ignoredMissingWaMessageId += 1;
          logWarn('inbound_missing_waMessageId_ignored', {
            requestId,
            from: event.fromId || null,
            type: event.type || null
          });
          continue;
        }

        duplicates += 1;
        logInfo('conversation_inbound_deduped', {
          requestId,
          provider: event.channelProvider || null,
          conversationId: conversation ? conversation.id : null,
          waMessageId: event.providerMessageId
        });
        continue;
      }

      logInfo('conversation_enqueue_attempt', {
        requestId,
        clinicId: channel.clinicId,
        channelId: channel.id,
        contactId: persisted.contact.id,
        conversationId: conversation.id,
        waMessageId: event.providerMessageId || null,
        inboundMessageId: inboundWrite && inboundWrite.row ? inboundWrite.row.id : null,
        jobType: 'conversation_reply'
      });

      if (String(channel.provider || '').trim().toLowerCase() !== 'whatsapp_cloud') {
        logInfo('conversation_reply_enqueue_skipped_non_whatsapp_channel', {
          requestId,
          clinicId: channel.clinicId,
          channelId: channel.id,
          provider: channel.provider || null,
          conversationId: conversation.id,
          inboundMessageId: inboundWrite && inboundWrite.row ? inboundWrite.row.id : null
        });
        continue;
      }

      enqueued += 1;
      logInfo('conversation_reply_enqueued', {
        requestId,
        jobId: null,
        clinicId: channel.clinicId,
        channelId: channel.id,
        conversationId: conversation.id,
        contactId: persisted.contact.id,
        inboundMessageId: inboundWrite && inboundWrite.row ? inboundWrite.row.id : null,
        waMessageId: event.providerMessageId
      });
    } catch (error) {
      logError('conversation_inbound_process_failed', {
        requestId,
        waMessageId: event.providerMessageId || null,
        error: error.message,
        code: error.code || null,
        details: error.details || null
      });
    }
  }

  return { received, enqueued, duplicates, unrouted, ignoredMissingWaMessageId };
}

module.exports = {
  normalizeWaNumber,
  extractInboundMessages,
  processInboundMessages
};
