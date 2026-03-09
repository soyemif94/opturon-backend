const env = require('../config/env');
const { logInfo } = require('../utils/logger');

const maxItems = Number.isInteger(env.debugInboxMaxItems) && env.debugInboxMaxItems > 0
  ? env.debugInboxMaxItems
  : 200;

const ring = new Array(maxItems);
let writeIndex = 0;
let size = 0;

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const clone = {};
  const allowedKeys = ['field', 'metadata', 'message', 'status', 'messageType'];
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      clone[key] = payload[key];
    }
  }
  return clone;
}

function normalizeItem(item) {
  const ts = item && item.ts ? String(item.ts) : new Date().toISOString();
  return {
    ts,
    type: item && item.type ? String(item.type) : 'unknown',
    from: item && item.from ? String(item.from) : null,
    messageId: item && item.messageId ? String(item.messageId) : null,
    text: item && item.text ? String(item.text) : null,
    payload: sanitizePayload(item && item.payload ? item.payload : {})
  };
}

function pushInboxItem(item) {
  const normalized = normalizeItem(item);
  ring[writeIndex] = normalized;
  writeIndex = (writeIndex + 1) % maxItems;
  if (size < maxItems) {
    size += 1;
  }

  logInfo('debug_inbox_item_added', {
    type: normalized.type,
    from: normalized.from,
    messageId: normalized.messageId
  });

  return normalized;
}

function getInboxItems(options = {}) {
  const requested = Number.parseInt(String(options.limit || 50), 10);
  const limit = Number.isInteger(requested) ? Math.max(1, Math.min(requested, maxItems)) : 50;
  const items = [];
  const count = Math.min(limit, size);

  for (let i = 0; i < count; i += 1) {
    const index = (writeIndex - 1 - i + maxItems) % maxItems;
    items.push(ring[index]);
  }

  return items;
}

function clearInbox() {
  for (let i = 0; i < ring.length; i += 1) {
    ring[i] = undefined;
  }
  writeIndex = 0;
  size = 0;
}

function getInboxHealth() {
  return {
    size,
    max: maxItems
  };
}

module.exports = {
  pushInboxItem,
  getInboxItems,
  clearInbox,
  getInboxHealth
};

