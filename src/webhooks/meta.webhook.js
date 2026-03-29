const { sanitizeString } = require('../utils/validators');

function normalizeDigits(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function hasInstagramMessagingEntries(payload) {
  const entry = Array.isArray(payload && payload.entry) ? payload.entry : [];
  return entry.some((entryItem) => Array.isArray(entryItem && entryItem.messaging) && entryItem.messaging.length > 0);
}

function hasWhatsAppChangeEntries(payload) {
  const entry = Array.isArray(payload && payload.entry) ? payload.entry : [];
  return entry.some((entryItem) => {
    const changes = Array.isArray(entryItem && entryItem.changes) ? entryItem.changes : [];
    return changes.some((change) => {
      const value = change && change.value ? change.value : {};
      return Boolean(
        (change && String(change.field || '').trim().toLowerCase() === 'messages') ||
        (value && value.metadata && (value.metadata.phone_number_id || value.metadata.phoneNumberId)) ||
        (Array.isArray(value.messages) && value.messages.length > 0) ||
        (Array.isArray(value.statuses) && value.statuses.length > 0)
      );
    });
  });
}

function deriveMetaWebhookProvider(payload) {
  const object = String(payload && payload.object ? payload.object : '')
    .trim()
    .toLowerCase();

  if (object === 'instagram') {
    return 'meta_instagram';
  }

  if (object === 'whatsapp_business_account' || hasWhatsAppChangeEntries(payload)) {
    return 'meta_whatsapp';
  }

  if (object === 'page' && hasInstagramMessagingEntries(payload)) {
    return 'meta_instagram';
  }

  return 'meta_unknown';
}

function deriveMetaEventType(payload) {
  const entry = Array.isArray(payload && payload.entry) ? payload.entry : [];

  for (const entryItem of entry) {
    if (Array.isArray(entryItem && entryItem.messaging) && entryItem.messaging.length > 0) {
      return 'messages';
    }

    const changes = Array.isArray(entryItem && entryItem.changes) ? entryItem.changes : [];
    for (const change of changes) {
      const value = change && change.value ? change.value : {};
      if (Array.isArray(value.statuses) && value.statuses.length > 0) {
        return 'statuses';
      }
      if (Array.isArray(value.messages) && value.messages.length > 0) {
        return 'messages';
      }
      if (change && change.field) {
        return String(change.field);
      }
    }
  }

  return null;
}

function extractMetaWebhookIdentifiers(payload) {
  if (deriveMetaWebhookProvider(payload) === 'meta_instagram') {
    const entry = Array.isArray(payload && payload.entry) ? payload.entry : [];
    for (const entryItem of entry) {
      const messaging = Array.isArray(entryItem && entryItem.messaging) ? entryItem.messaging : [];
      for (const event of messaging) {
        const senderId = sanitizeString(event && event.sender && event.sender.id);
        const recipientId = sanitizeString(event && event.recipient && event.recipient.id);
        const mid =
          sanitizeString(event && event.message && event.message.mid) ||
          sanitizeString(event && event.message && event.message.id);

        if (senderId || recipientId || mid) {
          return {
            waMessageId: mid || null,
            waFrom: senderId || null,
            waTo: recipientId || null
          };
        }
      }
    }

    return {
      waMessageId: null,
      waFrom: null,
      waTo: null
    };
  }

  const entry = Array.isArray(payload && payload.entry) ? payload.entry : [];
  let waMessageId = null;
  let waFrom = null;
  let waTo = null;

  for (const entryItem of entry) {
    const changes = Array.isArray(entryItem && entryItem.changes) ? entryItem.changes : [];
    for (const change of changes) {
      const value = change && change.value ? change.value : {};
      const metadata = value && value.metadata ? value.metadata : {};

      if (!waTo) {
        waTo = metadata.display_phone_number || metadata.phone_number_id || null;
      }

      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      if (!waMessageId && statuses[0] && statuses[0].id) {
        waMessageId = statuses[0].id;
      }

      const messages = Array.isArray(value.messages) ? value.messages : [];
      if (!waMessageId && messages[0] && messages[0].id) {
        waMessageId = messages[0].id;
      }

      if (!waFrom && messages[0] && messages[0].from) {
        waFrom = messages[0].from;
      }
    }
  }

  return {
    waMessageId: waMessageId || null,
    waFrom: waFrom || null,
    waTo: waTo || null
  };
}

function extractWhatsAppInboundEvents(payload) {
  const events = [];
  const entry = Array.isArray(payload && payload.entry) ? payload.entry : [];

  for (const entryItem of entry) {
    const changes = Array.isArray(entryItem && entryItem.changes) ? entryItem.changes : [];
    for (const change of changes) {
      const value = change && change.value ? change.value : {};
      const metadata = value && value.metadata ? value.metadata : {};
      const phoneNumberId = sanitizeString(metadata.phone_number_id || metadata.phoneNumberId);
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const messages = Array.isArray(value.messages) ? value.messages : [];

      const names = new Map();
      contacts.forEach((contact) => {
        const waId = normalizeDigits(contact && (contact.wa_id || contact.waId));
        const name = sanitizeString(contact && contact.profile && contact.profile.name);
        if (waId) {
          names.set(waId, name || null);
        }
      });

      for (const message of messages) {
        const from = normalizeDigits(message && (message.from || message.wa_id));
        const id = sanitizeString(message && message.id);
        const type = sanitizeString(message && message.type) || 'text';
        const text = sanitizeString(message && message.text && message.text.body);

        if (!from) continue;

        events.push({
          channelType: 'whatsapp',
          channelProvider: 'whatsapp_cloud',
          phoneNumberId,
          externalChannelId: null,
          pageId: null,
          fromId: from,
          toId: normalizeDigits(metadata.display_phone_number || metadata.phone_number_id || ''),
          providerMessageId: id,
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

function extractInstagramInboundEvents(payload) {
  const events = [];
  const entry = Array.isArray(payload && payload.entry) ? payload.entry : [];

  for (const entryItem of entry) {
    const pageId = sanitizeString(entryItem && entryItem.id);
    const messaging = Array.isArray(entryItem && entryItem.messaging) ? entryItem.messaging : [];

    for (const event of messaging) {
      const senderId = sanitizeString(event && event.sender && event.sender.id);
      const recipientId = sanitizeString(event && event.recipient && event.recipient.id);
      const message = event && event.message ? event.message : null;
      const isEcho = Boolean(message && (message.is_echo === true || message.echo === true));
      const mid = sanitizeString(message && (message.mid || message.id));
      const text = sanitizeString(message && message.text);
      const type = text ? 'text' : Array.isArray(message && message.attachments) ? 'attachments' : 'unknown';

      if (!senderId || !recipientId || !message || isEcho) {
        continue;
      }

      events.push({
        channelType: 'instagram',
        channelProvider: 'instagram_graph',
        phoneNumberId: null,
        externalChannelId: recipientId,
        pageId,
        fromId: senderId,
        toId: recipientId,
        providerMessageId: mid,
        type,
        text: text || '',
        name: null,
        raw: {
          entry: entryItem,
          event
        }
      });
    }
  }

  return events;
}

function extractMetaInboundMessages(payload) {
  if (deriveMetaWebhookProvider(payload) === 'meta_instagram') {
    return extractInstagramInboundEvents(payload);
  }

  return extractWhatsAppInboundEvents(payload);
}

module.exports = {
  deriveMetaWebhookProvider,
  deriveMetaEventType,
  extractMetaWebhookIdentifiers,
  extractMetaInboundMessages,
  hasInstagramMessagingEntries,
  hasWhatsAppChangeEntries
};
