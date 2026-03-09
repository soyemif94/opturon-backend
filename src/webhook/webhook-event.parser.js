function deriveEventType(payload) {
  const entry = Array.isArray(payload && payload.entry) ? payload.entry : [];
  for (const entryItem of entry) {
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

function extractWhatsAppMeta(payload) {
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

module.exports = {
  deriveEventType,
  extractWhatsAppMeta
};

