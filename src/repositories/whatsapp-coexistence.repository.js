const { query, withTransaction } = require('../db/client');
const { extractCoexistenceChanges } = require('../webhooks/whatsapp-coexistence');

function scopedQuery(client, sql, params) {
  return client.query(sql, params);
}

async function resolveChannelsForEvent(event) {
  if (event.field === 'account_update') {
    const result = await query(
      `SELECT id, "clinicId", "phoneNumberId", "wabaId", "displayPhoneNumber", "connectionMode", status
       FROM channels
       WHERE provider = 'whatsapp_cloud' AND "wabaId" = $1
       ORDER BY "clinicId", id`,
      [event.wabaId]
    );
    const clinicIds = new Set(result.rows.map((row) => row.clinicId));
    if (clinicIds.size !== 1) return [];
    return result.rows.filter((row) => row.connectionMode === 'COEXISTENCE');
  }

  if (!event.phoneNumberId) return [];
  const result = await query(
    `SELECT * FROM (
       SELECT ch.id, ch."clinicId", ch."phoneNumberId", ch."wabaId", ch."displayPhoneNumber", ch."connectionMode", ch.status
       FROM channels ch
       WHERE ch.provider = 'whatsapp_cloud' AND ch."phoneNumberId" = $1
       UNION ALL
       SELECT ch.id, ch."clinicId", ch."phoneNumberId", ch."wabaId", ch."displayPhoneNumber", ch."connectionMode", ch.status
       FROM whatsapp_channel_phone_aliases a
       JOIN whatsapp_channel_transitions t ON t.id = a."transitionId" AND t."clinicId" = a."clinicId" AND t."channelId" = a."channelId"
       JOIN channels ch ON ch.id = a."channelId" AND ch."clinicId" = a."clinicId"
       WHERE a."phoneNumberId" = $1 AND a."wabaId" = $2 AND a."expiresAt" > NOW()
         AND t.status = 'completed' AND ch.provider = 'whatsapp_cloud'
         AND NOT EXISTS (SELECT 1 FROM channels direct WHERE direct."phoneNumberId" = $1)
     ) resolved LIMIT 2`,
    [event.phoneNumberId, event.wabaId]
  );
  if (result.rows.length !== 1) return [];
  const channel = result.rows[0];
  return channel.wabaId === event.wabaId && channel.connectionMode === 'COEXISTENCE' ? [channel] : [];
}

async function upsertChannelState(client, channel, field) {
  await scopedQuery(client,
    `INSERT INTO whatsapp_coexistence_channel_state ("clinicId", "channelId", "lastWebhookAt", "updatedAt")
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT ("channelId") DO UPDATE SET
       "lastWebhookAt" = NOW(), "updatedAt" = NOW(),
       "historySyncStatus" = CASE WHEN $3 = 'history' AND whatsapp_coexistence_channel_state."historySyncStatus"
         NOT IN ('completed', 'declined') THEN 'requested' ELSE whatsapp_coexistence_channel_state."historySyncStatus" END,
       "contactsSyncStatus" = CASE WHEN $3 = 'smb_app_state_sync' AND whatsapp_coexistence_channel_state."contactsSyncStatus"
         NOT IN ('completed', 'declined') THEN 'requested' ELSE whatsapp_coexistence_channel_state."contactsSyncStatus" END`,
    [channel.clinicId, channel.id, field]
  );
}

async function persistCoexistenceWebhookEvents(payload) {
  const events = extractCoexistenceChanges(payload);
  const totals = { received: events.length, queued: 0, duplicates: 0, ignored: 0 };

  for (const event of events) {
    const channels = await resolveChannelsForEvent(event);
    if (!channels.length) {
      totals.ignored += 1;
      continue;
    }
    for (const channel of channels) {
      const inserted = await withTransaction(async (client) => {
        await upsertChannelState(client, channel, event.field);
        const result = await scopedQuery(client,
          `INSERT INTO whatsapp_coexistence_events
             ("clinicId", "channelId", "wabaId", "phoneNumberId", field, "eventHash", payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT ("channelId", field, "eventHash") DO NOTHING
           RETURNING id`,
          [channel.clinicId, channel.id, event.wabaId, event.phoneNumberId, event.field,
            event.eventHash, JSON.stringify(event.value)]
        );
        if (!result.rows[0]) return false;
        await scopedQuery(client,
          `INSERT INTO jobs ("clinicId", "channelId", type, payload, status, attempts, "maxAttempts", "runAt", "updatedAt")
           VALUES ($1, $2, 'WHATSAPP_COEXISTENCE_EVENT', $3::jsonb, 'queued', 0, 10, NOW(), NOW())`,
          [channel.clinicId, channel.id, JSON.stringify({ eventId: result.rows[0].id })]
        );
        return true;
      });
      if (inserted) totals.queued += 1;
      else totals.duplicates += 1;
    }
  }
  return totals;
}

async function findCoexistenceEventForProcessing(eventId, client) {
  const result = await scopedQuery(client,
    `SELECT e.id, e."clinicId", e."channelId", e."wabaId", e."phoneNumberId", e.field, e.payload, e.status,
            c."displayPhoneNumber", c."connectionMode", c."wabaId" AS "channelWabaId", c."phoneNumberId" AS "channelPhoneNumberId",
            EXISTS (
              SELECT 1 FROM whatsapp_channel_phone_aliases a
              JOIN whatsapp_channel_transitions t ON t.id = a."transitionId" AND t."clinicId" = a."clinicId" AND t."channelId" = a."channelId"
              WHERE a."phoneNumberId" = e."phoneNumberId" AND a."wabaId" = e."wabaId"
                AND a."clinicId" = e."clinicId" AND a."channelId" = e."channelId"
                AND a."expiresAt" > NOW() AND t.status = 'completed'
            ) AS "phoneNumberIdAliasValid"
     FROM whatsapp_coexistence_events e
     JOIN channels c ON c.id = e."channelId" AND c."clinicId" = e."clinicId"
     WHERE e.id = $1::uuid
     FOR UPDATE OF e`,
    [eventId]
  );
  return result.rows[0] || null;
}

async function upsertHistoryContact(client, { clinicId, phone, name }) {
  const identityCandidates = new Set([phone]);
  if (phone.startsWith('549') && phone.length === 13) identityCandidates.add(`54${phone.slice(3)}`);
  if (phone.startsWith('54') && !phone.startsWith('549') && phone.length === 12) identityCandidates.add(`549${phone.slice(2)}`);
  const candidates = [...identityCandidates];
  const found = await scopedQuery(client,
    `SELECT id, "waId", phone, name, metadata
     FROM contacts
     WHERE "clinicId" = $1
       AND (regexp_replace(COALESCE("waId", ''), '[^0-9]', '', 'g') = ANY($2::text[])
         OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ANY($2::text[]))
       AND "deletedAt" IS NULL
     ORDER BY "updatedAt" DESC NULLS LAST, "createdAt" ASC
     LIMIT 1
     FOR UPDATE`,
    [clinicId, candidates]
  );
  if (found.rows[0]) {
    const existing = found.rows[0];
    const result = await scopedQuery(client,
      `UPDATE contacts SET
         phone = COALESCE(phone, $2),
         name = CASE WHEN NULLIF(BTRIM(name), '') IS NULL THEN $3 ELSE name END,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('whatsappCoexistenceSource', 'smb_app_state_sync'),
         "updatedAt" = NOW()
       WHERE id = $1 AND "clinicId" = $4
       RETURNING id, "waId"`,
      [existing.id, phone, name, clinicId]
    );
    return result.rows[0] || null;
  }

  const result = await scopedQuery(client,
    `INSERT INTO contacts ("clinicId", "waId", phone, name, metadata, "updatedAt")
     VALUES ($1, $2, $2, $3, jsonb_build_object('whatsappCoexistenceSource', 'smb_app_state_sync'), NOW())
     ON CONFLICT ("clinicId", "waId") DO UPDATE SET
       phone = COALESCE(contacts.phone, EXCLUDED.phone),
       name = CASE WHEN NULLIF(BTRIM(contacts.name), '') IS NULL THEN EXCLUDED.name ELSE contacts.name END,
       "updatedAt" = NOW()
     RETURNING id, "waId"`,
    [clinicId, phone, name]
  );
  return result.rows[0] || null;
}

async function markContactRemoved(client, { clinicId, phone }) {
  await scopedQuery(client,
    `UPDATE contacts SET
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('whatsappCoexistenceAppContactRemovedAt', NOW()),
       "updatedAt" = NOW()
     WHERE "clinicId" = $1
       AND (regexp_replace(COALESCE("waId", ''), '[^0-9]', '', 'g') = $2
         OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2)
       AND "deletedAt" IS NULL`,
    [clinicId, phone]
  );
}

async function findOrCreateHistoricalConversation(client, { clinicId, channelId, contactId, customerIdentity, businessNumber }) {
  const found = await scopedQuery(client,
    `SELECT id FROM conversations
     WHERE "clinicId" = $1 AND "channelId" = $2 AND "contactId" = $3 AND "deletedAt" IS NULL
     LIMIT 1 FOR UPDATE`,
    [clinicId, channelId, contactId]
  );
  if (found.rows[0]) return found.rows[0];
  const inserted = await scopedQuery(client,
    `INSERT INTO conversations ("clinicId", "channelId", "contactId", "waFrom", "waTo", status, stage, state, context, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 'open', 'new', 'NEW', '{}'::jsonb, NOW())
     ON CONFLICT ("clinicId", "channelId", "contactId") WHERE "deletedAt" IS NULL DO NOTHING
     RETURNING id`,
    [clinicId, channelId, contactId, customerIdentity, businessNumber]
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const raced = await scopedQuery(client,
    `SELECT id FROM conversations
     WHERE "clinicId" = $1 AND "channelId" = $2 AND "contactId" = $3 AND "deletedAt" IS NULL
     LIMIT 1`,
    [clinicId, channelId, contactId]
  );
  return raced.rows[0] || null;
}

async function insertHistoricalMessage(client, record) {
  const result = await scopedQuery(client,
    `INSERT INTO conversation_messages
       ("conversationId", direction, "waMessageId", "from", "to", type, text, raw, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
     ON CONFLICT ("waMessageId") DO NOTHING
     RETURNING id`,
    [record.conversationId, record.direction, record.id, record.from, record.to, record.type, record.text,
      JSON.stringify(record.raw), record.createdAt]
  );
  return result.rows[0] || null;
}

async function setCoexistenceEventStatus(eventId, status, errorCode = null) {
  await query(
    `UPDATE whatsapp_coexistence_events SET status = $2, "lastErrorCode" = $3,
       payload = CASE WHEN $2 = 'failed' THEN NULL ELSE payload END, "updatedAt" = NOW()
     WHERE id = $1::uuid AND status <> 'done'`,
    [eventId, status, errorCode]
  );
}

async function processCoexistenceEvent(eventId, handlers) {
  return withTransaction(async (client) => {
    const event = await findCoexistenceEventForProcessing(eventId, client);
    if (!event || event.status === 'done' || !event.payload) return { skipped: true };
    if (event.channelWabaId !== event.wabaId
      || event.channelPhoneNumberId !== event.phoneNumberId && event.field !== 'account_update' && event.phoneNumberIdAliasValid !== true) {
      const error = new Error('coexistence_event_channel_identity_mismatch');
      error.code = 'COEXISTENCE_CHANNEL_IDENTITY_MISMATCH';
      throw error;
    }
    if (event.field !== 'account_update' && event.connectionMode !== 'COEXISTENCE') {
      const error = new Error('coexistence_event_mode_mismatch');
      error.code = 'COEXISTENCE_MODE_MISMATCH';
      throw error;
    }
    await scopedQuery(client,
      `UPDATE whatsapp_coexistence_events SET status = 'processing', "lastErrorCode" = NULL, "updatedAt" = NOW()
       WHERE id = $1::uuid`, [eventId]);
    await handlers.process(event, client);
    await scopedQuery(client,
      `UPDATE whatsapp_coexistence_events SET status = 'done', payload = NULL, "processedAt" = NOW(),
         "lastErrorCode" = NULL, "updatedAt" = NOW()
       WHERE id = $1::uuid`, [eventId]);
    return { processed: true, field: event.field };
  });
}

module.exports = {
  resolveChannelsForEvent,
  findOrCreateHistoricalConversation,
  insertHistoricalMessage,
  markContactRemoved,
  persistCoexistenceWebhookEvents,
  processCoexistenceEvent,
  setCoexistenceEventStatus,
  upsertHistoryContact
};
