const { sanitizeString } = require('../utils/validators');

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function hasSmbMessageEchoEntries(payload) {
  const entries = Array.isArray(payload && payload.entry) ? payload.entry : [];
  return entries.some((entry) =>
    (Array.isArray(entry && entry.changes) ? entry.changes : [])
      .some((change) => String(change && change.field || '').trim() === 'smb_message_echoes')
  );
}

function extractSmbMessageEchoes(payload) {
  const events = [];
  if (!payload || payload.object !== 'whatsapp_business_account') return events;
  const entries = Array.isArray(payload && payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    for (const change of Array.isArray(entry && entry.changes) ? entry.changes : []) {
      if (String(change && change.field || '').trim() !== 'smb_message_echoes') continue;
      const value = change && change.value && typeof change.value === 'object' ? change.value : {};
      const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
      for (const message of Array.isArray(value.message_echoes) ? value.message_echoes : []) {
        const type = sanitizeString(message && message.type).toLowerCase();
        const content = message && message[type] && typeof message[type] === 'object' ? message[type] : {};
        const from = digits(message && message.from);
        const to = digits(message && message.to);
        const id = sanitizeString(message && message.id);
        const phoneNumberId = sanitizeString(metadata.phone_number_id);
        const wabaId = sanitizeString(entry && entry.id);
        const displayPhoneNumber = digits(metadata.display_phone_number);
        const timestamp = sanitizeString(message && message.timestamp);
        const invalidReason = sanitizeString(value.messaging_product).toLowerCase() !== 'whatsapp' ? 'invalid_messaging_product'
          : !id || id.length > 512 ? 'invalid_message_id'
          : !phoneNumberId || !wabaId ? 'missing_channel_identity'
            : !from || !to || from === to ? 'invalid_phone_identity'
              : !displayPhoneNumber || displayPhoneNumber !== from ? 'sender_metadata_mismatch'
                : !/^[a-z_]{1,30}$/.test(type) || !/^\d{10,11}$/.test(timestamp) ? 'invalid_type_or_timestamp'
                  : null;
        events.push({
          id, type, from, to, phoneNumberId, wabaId, displayPhoneNumber, timestamp,
          text: type === 'text' ? sanitizeString(content.body) : sanitizeString(content.caption),
          content,
          invalidReason
        });
      }
    }
  }
  return events;
}

module.exports = { extractSmbMessageEchoes, hasSmbMessageEchoEntries, digits };
