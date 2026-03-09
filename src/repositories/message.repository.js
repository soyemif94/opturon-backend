const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function insertInboundMessage(record, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO messages (
      "clinicId", "channelId", "conversationId", direction,
      "providerMessageId", "from", "to", type, body, raw, "receivedAt"
    ) VALUES ($1,$2,$3,'inbound',$4,$5,$6,$7,$8,$9::jsonb,NOW())
    ON CONFLICT ("clinicId", "providerMessageId")
    DO NOTHING
    RETURNING id, "providerMessageId", "clinicId", "channelId", "conversationId"`,
    [
      record.clinicId,
      record.channelId,
      record.conversationId,
      record.providerMessageId || null,
      record.from,
      record.to,
      record.type,
      record.body || null,
      JSON.stringify(record.raw || {})
    ]
  );

  if (result.rows[0]) {
    return { message: result.rows[0], inserted: true };
  }

  if (!record.providerMessageId) {
    return { message: null, inserted: false };
  }

  const existing = await dbQuery(
    client,
    `SELECT id, "providerMessageId", "clinicId", "channelId", "conversationId"
     FROM messages
     WHERE "clinicId"=$1 AND "providerMessageId"=$2
     LIMIT 1`,
    [record.clinicId, record.providerMessageId]
  );

  return { message: existing.rows[0] || null, inserted: false };
}

async function insertOutboundMessage(record, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO messages (
      "clinicId", "channelId", "conversationId", direction,
      "providerMessageId", "from", "to", type, body, raw, "receivedAt"
    ) VALUES ($1,$2,$3,'outbound',$4,$5,$6,$7,$8,$9::jsonb,NOW())
    RETURNING id`,
    [
      record.clinicId,
      record.channelId,
      record.conversationId,
      record.providerMessageId || null,
      record.from,
      record.to,
      record.type,
      record.body || null,
      JSON.stringify(record.raw || {})
    ]
  );

  return result.rows[0] || null;
}

async function getMessageById(messageId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "channelId", "conversationId", direction, "providerMessageId", "from", "to", type, body, raw, "receivedAt"
     FROM messages
     WHERE id = $1
     LIMIT 1`,
    [messageId]
  );

  return result.rows[0] || null;
}

module.exports = {
  insertInboundMessage,
  insertOutboundMessage,
  getMessageById
};

