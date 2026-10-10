const crypto = require('crypto');

const COEXISTENCE_FIELDS = new Set(['history', 'smb_app_state_sync', 'account_update']);

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function boundedText(value, max = 32000) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function extractCoexistenceChanges(payload) {
  if (!payload || payload.object !== 'whatsapp_business_account') return [];
  const events = [];
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    const wabaId = boundedText(entry && entry.id, 256);
    if (!wabaId) continue;
    for (const change of Array.isArray(entry && entry.changes) ? entry.changes : []) {
      const field = boundedText(change && change.field, 64);
      if (!COEXISTENCE_FIELDS.has(field)) continue;
      const value = change && change.value && typeof change.value === 'object' && !Array.isArray(change.value)
        ? change.value
        : {};
      const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
      const phoneNumberId = boundedText(metadata.phone_number_id || metadata.phoneNumberId, 256);
      const eventHash = crypto.createHash('sha256')
        .update(JSON.stringify({ field, wabaId, phoneNumberId, value }))
        .digest('hex');
      events.push({ field, wabaId, phoneNumberId, value, eventHash });
    }
  }
  return events;
}

function* iterateHistoryMessages(value, channel) {
  const chunks = Array.isArray(value && value.history)
    ? value.history
    : value && value.history && typeof value.history === 'object' ? [value.history] : [];
  const businessNumber = digits(channel && channel.displayPhoneNumber);
  if (!businessNumber) return;

  for (const chunk of chunks) {
    const threads = Array.isArray(chunk && chunk.threads) ? chunk.threads : [];
    for (const thread of threads) {
      const threadIdentity = digits(thread && thread.id);
      if (!/^\d{8,15}$/.test(threadIdentity)) continue;
      for (const message of Array.isArray(thread && thread.messages) ? thread.messages : []) {
        const id = boundedText(message && message.id, 512);
        const from = digits(message && message.from);
        const to = digits(message && message.to);
        const type = boundedText(message && message.type, 40) || 'unknown';
        const timestampRaw = String(message && message.timestamp || '').trim();
        if (!id || !from || !/^\d{10,13}$/.test(timestampRaw)) continue;

        let direction;
        let customerIdentity;
        if (from === businessNumber && to && to !== businessNumber) {
          direction = 'outbound';
          customerIdentity = to;
        } else if (from !== businessNumber && (!to || to === businessNumber)) {
          direction = 'inbound';
          customerIdentity = from;
        } else {
          continue;
        }
        if (customerIdentity !== threadIdentity) continue;

        const content = message[type] && typeof message[type] === 'object' ? message[type] : {};
        const text = boundedText(type === 'text' ? content.body : content.caption);
        const timestampNumber = Number(timestampRaw);
        const timestampMs = timestampRaw.length >= 13 ? timestampNumber : timestampNumber * 1000;
        const createdAt = new Date(timestampMs);
        if (!Number.isFinite(createdAt.getTime())) continue;

        yield {
          id,
          direction,
          customerIdentity,
          from,
          to: to || businessNumber,
          type,
          text,
          createdAt: createdAt.toISOString(),
          historyStatus: boundedText(message.history_context && message.history_context.status, 80),
          mediaUnavailable: !['text', 'unknown', 'system'].includes(type)
        };
      }
    }
  }
}

function extractHistoryMessages(value, channel) {
  return [...iterateHistoryMessages(value, channel)];
}

function* iterateStateSyncContacts(value) {
  for (const item of Array.isArray(value && value.state_sync) ? value.state_sync : []) {
    if (item && item.type && item.type !== 'contact') continue;
    const contact = item && item.contact && typeof item.contact === 'object' ? item.contact : {};
    const phone = digits(contact.phone_number || contact.phone || contact.wa_id);
    const action = (boundedText(item && item.action, 20) || '').toLowerCase();
    const name = boundedText(contact.full_name || contact.first_name, 160);
    if (!/^\d{8,15}$/.test(phone) || !['add', 'remove'].includes(action)) continue;
    yield { phone, action, name };
  }
}

function extractStateSyncContacts(value) {
  return [...iterateStateSyncContacts(value)];
}

function classifyAccountUpdate(value) {
  const candidates = [value && value.event, value && value.event_type, value && value.status,
    value && value.account_update && value.account_update.event]
    .map((item) => (boundedText(item, 80) || '').toUpperCase().replace(/[\s-]+/g, '_'))
    .filter(Boolean);
  const event = candidates[0] || null;
  if (event && /(PARTNER_REMOVED|OFFBOARD|DISCONNECT)/.test(event)) {
    return { event, coexistenceStatus: 'reconnection_required' };
  }
  return { event, coexistenceStatus: null };
}

function normalizeSyncProgress(value) {
  const chunks = Array.isArray(value && value.history) ? value.history
    : value && value.history && typeof value.history === 'object' ? [value.history] : [];
  const metadata = chunks.find((chunk) => chunk && chunk.metadata)?.metadata || value && value.metadata || {};
  const rawProgress = metadata && metadata.progress;
  const progress = Number(rawProgress);
  return {
    phase: boundedText(metadata && metadata.phase, 80),
    chunkOrder: metadata && metadata.chunk_order !== undefined && metadata.chunk_order !== null &&
      Number.isInteger(Number(metadata.chunk_order)) ? Number(metadata.chunk_order) : null,
    progress: Number.isFinite(progress) && progress >= 0 && progress <= 100 ? progress : null,
    complete: rawProgress === 100 || String(rawProgress || '').trim() === '100' ||
      String(metadata && metadata.phase || '').toLowerCase() === 'complete'
  };
}

module.exports = {
  COEXISTENCE_FIELDS,
  classifyAccountUpdate,
  digits,
  extractCoexistenceChanges,
  extractHistoryMessages,
  extractStateSyncContacts,
  iterateHistoryMessages,
  iterateStateSyncContacts,
  normalizeSyncProgress
};
