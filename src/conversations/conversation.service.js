const { logInfo, logWarn, logError } = require('../utils/logger');
const { sanitizeString } = require('../utils/validators');
const {
  findChannelByPhoneNumberId,
  findInstagramChannelByExternalId,
  findInstagramChannelByPageId
} = require('../repositories/tenant.repository');
const { upsertContact } = require('../repositories/contact.repository');
const repo = require('./conversation.repo');
const { extractMetaInboundMessages } = require('../webhooks/meta.webhook');

function normalizeWaNumber(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function extractInboundMessages(body) {
  return extractMetaInboundMessages(body || {});
}

async function findInboundChannel(event) {
  if (!event) return null;

  if (event.channelType === 'instagram') {
    return (
      (event.externalChannelId ? await findInstagramChannelByExternalId(event.externalChannelId) : null) ||
      (event.pageId ? await findInstagramChannelByPageId(event.pageId) : null) ||
      null
    );
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

      const contact = await upsertContact({
        clinicId: channel.clinicId,
        waId: event.fromId,
        phone: event.fromId,
        name: event.name || null
      });

      const conversation = await repo.upsertConversation({
        waFrom: event.fromId,
        waTo: event.toId || channel.externalId || channel.phoneNumberId,
        clinicId: channel.clinicId,
        channelId: channel.id,
        contactId: contact.id
      });

      const inboundWrite = await repo.insertInboundMessage({
        conversationId: conversation.id,
        waMessageId: event.providerMessageId,
        from: event.fromId,
        to: event.toId || channel.externalId || channel.phoneNumberId,
        type: event.type || 'text',
        text: event.text || '',
        raw: event.raw || {}
      });

      if (!inboundWrite.inserted) {
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
          conversationId: conversation.id,
          waMessageId: event.providerMessageId
        });
        continue;
      }

      logInfo('conversation_enqueue_attempt', {
        requestId,
        clinicId: channel.clinicId,
        channelId: channel.id,
        contactId: contact.id,
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

      const job = await repo.enqueueJob('conversation_reply', {
        clinicId: channel.clinicId,
        channelId: channel.id,
        conversationId: conversation.id,
        contactId: contact.id,
        inboundMessageId: inboundWrite.row.id,
        waMessageId: event.providerMessageId
      });

      enqueued += 1;
      logInfo('conversation_reply_enqueued', {
        requestId,
        jobId: job ? job.id : null,
        clinicId: channel.clinicId,
        channelId: channel.id,
        conversationId: conversation.id,
        contactId: contact.id,
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
