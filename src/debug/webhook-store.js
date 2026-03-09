const { logInfo } = require('../utils/logger');

const MAX_ITEMS = 50;
const ring = new Array(MAX_ITEMS);
let writeIndex = 0;
let size = 0;

function truncateText(value, maxChars) {
  const text = String(value || '');
  if (!text) {
    return null;
  }

  return text.length > maxChars ? `${text.slice(0, maxChars)}...[truncated]` : text;
}

function normalizeRecord(record) {
  return {
    timestamp: record && record.timestamp ? String(record.timestamp) : new Date().toISOString(),
    requestId: record && record.requestId ? String(record.requestId) : null,
    object: record && record.object ? String(record.object) : null,
    field: record && record.field ? String(record.field) : null,
    from: record && record.from ? String(record.from) : null,
    messageId: record && record.messageId ? String(record.messageId) : null,
    textPreview: truncateText(record && record.textPreview, 160),
    rawBody: truncateText(record && record.rawBody, 2000)
  };
}

function pushWebhookEvent(record) {
  const normalized = normalizeRecord(record);
  ring[writeIndex] = normalized;
  writeIndex = (writeIndex + 1) % MAX_ITEMS;

  if (size < MAX_ITEMS) {
    size += 1;
  }

  logInfo('debug_webhook_item_added', {
    requestId: normalized.requestId,
    object: normalized.object,
    field: normalized.field,
    from: normalized.from,
    messageId: normalized.messageId
  });

  return normalized;
}

function getWebhookEvents(options = {}) {
  const requested = Number.parseInt(String(options.limit || 20), 10);
  const limit = Number.isInteger(requested) ? Math.max(1, Math.min(requested, MAX_ITEMS)) : 20;
  const items = [];
  const count = Math.min(limit, size);

  for (let i = 0; i < count; i += 1) {
    const index = (writeIndex - 1 - i + MAX_ITEMS) % MAX_ITEMS;
    items.push(ring[index]);
  }

  return items;
}

module.exports = {
  pushWebhookEvent,
  getWebhookEvents
};
