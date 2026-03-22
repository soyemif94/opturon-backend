const { logInfo, logWarn, logError } = require('../utils/logger');
const { sanitizeString } = require('../utils/validators');
const { findChannelByPhoneNumberId } = require('../repositories/tenant.repository');
const { upsertContact } = require('../repositories/contact.repository');
const repo = require('./conversation.repo');

function normalizeWaNumber(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function extractInboundMessages(body) {
  const payload = body || {};
  const events = [];
  const entry = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entryItem of entry) {
    const changes = Array.isArray(entryItem && entryItem.changes) ? entryItem.changes : [];
    for (const change of changes) {
      const value = change && change.value ? change.value : {};
      const metadata = value && value.metadata ? value.metadata : {};
      const phoneNumberId = sanitizeString(metadata.phone_number_id || metadata.phoneNumberId);
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const messages = Array.isArray(value.messages) ? value.messages : [];

      const names = new Map();
      contacts.forEach((c) => {
        const wa = normalizeWaNumber(c && (c.wa_id || c.waId));
        const name = sanitizeString(c && c.profile && c.profile.name);
        if (wa) names.set(wa, name || null);
      });

      for (const message of messages) {
        const from = normalizeWaNumber(message && (message.from || message.wa_id));
        const id = sanitizeString(message && message.id);
        const type = sanitizeString(message && message.type) || 'text';
        const text = sanitizeString(message && message.text && message.text.body);

        if (!from) continue;

        events.push({
          phoneNumberId,
          waFrom: from,
          waTo: normalizeWaNumber(metadata.display_phone_number || metadata.phone_number_id || ''),
          waMessageId: id,
          type,
          text: text || '',
          name: names.get(from) || null,
          raw: {
            entry: entryItem,
            change,
            value,
            message
          }
        });
      }
    }
  }

  return events;
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
        phoneNumberId: event.phoneNumberId || null,
        waFrom: event.waFrom || null,
        waTo: event.waTo || null,
        waMessageId: event.waMessageId || null,
        type: event.type || null,
        text: event.text || null
      });

      const channel = await findChannelByPhoneNumberId(event.phoneNumberId || '');
      if (!channel) {
        unrouted += 1;
        logWarn('conversation_unrouted_channel', {
          requestId,
          waMessageId: event.waMessageId,
          phoneNumberId: event.phoneNumberId || null
        });
        continue;
      }

      const contact = await upsertContact({
        clinicId: channel.clinicId,
        waId: event.waFrom,
        phone: event.waFrom,
        name: event.name || null
      });

      const conversation = await repo.upsertConversation({
        waFrom: event.waFrom,
        waTo: event.waTo || channel.phoneNumberId,
        clinicId: channel.clinicId,
        channelId: channel.id,
        contactId: contact.id
      });

      const inboundWrite = await repo.insertInboundMessage({
        conversationId: conversation.id,
        waMessageId: event.waMessageId,
        from: event.waFrom,
        to: event.waTo || channel.phoneNumberId,
        type: event.type || 'text',
        text: event.text || '',
        raw: event.raw || {}
      });

      if (!inboundWrite.inserted) {
        if (inboundWrite.reason === 'missing_waMessageId') {
          ignoredMissingWaMessageId += 1;
          logWarn('inbound_missing_waMessageId_ignored', {
            requestId,
            from: event.waFrom || null,
            type: event.type || null
          });
          continue;
        }

        duplicates += 1;
        logInfo('conversation_inbound_duplicate', {
          requestId,
          conversationId: conversation.id,
          waMessageId: event.waMessageId
        });
        continue;
      }

      logInfo('conversation_enqueue_attempt', {
        requestId,
        clinicId: channel.clinicId,
        channelId: channel.id,
        contactId: contact.id,
        conversationId: conversation.id,
        waMessageId: event.waMessageId || null,
        inboundMessageId: inboundWrite && inboundWrite.row ? inboundWrite.row.id : null,
        jobType: 'conversation_reply'
      });

      const job = await repo.enqueueJob('conversation_reply', {
        clinicId: channel.clinicId,
        channelId: channel.id,
        conversationId: conversation.id,
        contactId: contact.id,
        inboundMessageId: inboundWrite.row.id,
        waMessageId: event.waMessageId
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
        waMessageId: event.waMessageId
      });
    } catch (error) {
      logError('conversation_inbound_process_failed', {
        requestId,
        waMessageId: event.waMessageId || null,
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
