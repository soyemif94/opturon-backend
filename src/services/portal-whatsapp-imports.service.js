const crypto = require('crypto');
const { query, withTransaction } = require('../db/client');
const { parseWhatsAppChatExport } = require('../imports/whatsapp-chat-export.parser');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findPortalContactById } = require('../repositories/contact.repository');
const { findPreferredWhatsAppChannelByClinicId } = require('../repositories/tenant.repository');
const { logInfo } = require('../utils/logger');

const MAX_FILE_SIZE_BYTES = Number(process.env.WHATSAPP_CHAT_IMPORT_MAX_FILE_SIZE_BYTES || 5 * 1024 * 1024);
const MAX_PREVIEW_MESSAGES = Number(process.env.WHATSAPP_CHAT_IMPORT_MAX_PREVIEW_MESSAGES || 5000);

function normalizeString(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function buildError(tenantId, reason, detail = null) {
  return { ok: false, tenantId, reason, detail };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeFileName(value) {
  return normalizeString(value).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 160) || `whatsapp-chat-${Date.now()}.txt`;
}

function validateTextFile(file) {
  const originalName = normalizeString(file && file.originalname);
  if (!file || !file.buffer) return 'missing_file';
  if (!originalName.toLowerCase().endsWith('.txt')) return 'invalid_file_type';
  if (Number(file.size || file.buffer.length || 0) > MAX_FILE_SIZE_BYTES) return 'file_too_large';
  return null;
}

function normalizeMessageText(value) {
  return normalizeString(value).replace(/\s+/g, ' ');
}

function buildMessageHash(tenantId, message, index) {
  return sha256([
    tenantId,
    message.originalTimestamp || '',
    message.participant || '',
    normalizeMessageText(message.text),
    index
  ].join('|'));
}

function inferSelfParticipant(parsed) {
  const counts = new Map();
  for (const message of parsed.messages || []) {
    if (!message.participant) continue;
    counts.set(message.participant, (counts.get(message.participant) || 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((left, right) => right[1] - left[1]);
  return sorted.length > 1 ? sorted[sorted.length - 1][0] : null;
}

function buildNormalizedMessages(tenantId, parsed) {
  const selfParticipant = inferSelfParticipant(parsed);
  return (parsed.messages || []).map((message, index) => {
    const hash = buildMessageHash(tenantId, message, index);
    const direction = selfParticipant && message.participant === selfParticipant ? 'outbound' : 'inbound';
    return {
      index,
      hash,
      waMessageId: `imported:whatsapp_export:${hash}`,
      direction: message.participant ? direction : 'inbound',
      participant: message.participant || null,
      originalTimestamp: message.originalTimestamp,
      text: normalizeString(message.text),
      type: message.type === 'media_omitted' ? 'text' : 'text',
      systemType: message.systemType || null,
      rawLineHash: sha256(message.rawLine || `${message.originalTimestamp}:${message.text}`)
    };
  });
}

async function resolveContext(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  return context;
}

async function countDuplicates(waMessageIds, clinicId, client = null) {
  if (!waMessageIds.length) return 0;
  const db = client || { query };
  const result = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM conversation_messages m
     INNER JOIN conversations c ON c.id = m."conversationId"
     WHERE c."clinicId" = $1
       AND m."waMessageId" = ANY($2::text[])`,
    [clinicId, waMessageIds]
  );
  return Number(result.rows[0]?.count || 0);
}

async function createPreviewRecord(context, actor, file, parsed, normalizedMessages, duplicateEstimated) {
  const fileHash = sha256(file.buffer);
  const importId = `waimp_${crypto.randomUUID()}`;
  const summary = {
    source: 'whatsapp_export',
    totalMessages: normalizedMessages.length,
    newEstimated: Math.max(0, normalizedMessages.length - duplicateEstimated),
    duplicateEstimated,
    ignoredLines: parsed.ignoredLines,
    participants: parsed.participants,
    dateRange: parsed.dateRange,
    detectedFormat: parsed.detectedFormat,
    messages: normalizedMessages
  };

  const result = await query(
    `INSERT INTO conversation_imports (
       id, "tenantId", "clinicId", "actorId", "actorName", status,
       "originalFileName", "fileSizeBytes", "fileHash", format, summary, warnings, "updatedAt"
     )
     VALUES ($1, $2, $3, $4, $5, 'previewed', $6, $7, $8, $9, $10::jsonb, $11::jsonb, NOW())
     ON CONFLICT ("clinicId", "fileHash") WHERE status IN ('previewed', 'confirmed')
     DO UPDATE SET
       "actorId" = EXCLUDED."actorId",
       "actorName" = EXCLUDED."actorName",
       "updatedAt" = NOW()
     RETURNING id, status, summary, warnings, "conversationId", "confirmedAt"`,
    [
      importId,
      context.tenantId,
      context.clinic.id,
      actor?.actorId || actor?.id || null,
      actor?.actorName || actor?.name || null,
      safeFileName(file.originalname),
      Number(file.size || file.buffer.length || 0),
      fileHash,
      parsed.detectedFormat,
      JSON.stringify(summary),
      JSON.stringify(parsed.warnings || [])
    ]
  );

  return result.rows[0];
}

function buildPreviewPayload(record) {
  const summary = record.summary || {};
  return {
    importId: record.id,
    status: record.status,
    totalMessages: Number(summary.totalMessages || 0),
    newEstimated: Number(summary.newEstimated || 0),
    duplicateEstimated: Number(summary.duplicateEstimated || 0),
    ignoredLines: Number(summary.ignoredLines || 0),
    participants: Array.isArray(summary.participants) ? summary.participants : [],
    dateRange: summary.dateRange || { from: null, to: null },
    detectedFormat: summary.detectedFormat || 'unknown',
    warnings: Array.isArray(record.warnings) ? record.warnings : [],
    conversationId: record.conversationId || null,
    confirmedAt: record.confirmedAt || null
  };
}

async function previewImport({ tenantId, actor, file }) {
  const context = await resolveContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const fileError = validateTextFile(file);
  if (fileError) return buildError(context.tenantId, fileError);

  const text = file.buffer.toString('utf8');
  const parsed = parseWhatsAppChatExport(text);
  if (!parsed.messages.length || parsed.detectedFormat === 'unknown') {
    return buildError(context.tenantId, 'whatsapp_import_unrecognized_format');
  }
  if (parsed.messages.length > MAX_PREVIEW_MESSAGES) {
    return buildError(context.tenantId, 'whatsapp_import_too_many_messages', { maxMessages: MAX_PREVIEW_MESSAGES });
  }

  const normalizedMessages = buildNormalizedMessages(context.tenantId, parsed);
  const duplicateEstimated = await countDuplicates(
    normalizedMessages.map((message) => message.waMessageId),
    context.clinic.id
  );
  const record = await createPreviewRecord(context, actor, file, parsed, normalizedMessages, duplicateEstimated);

  logInfo('whatsapp_chat_import_previewed', {
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    importId: record.id,
    totalMessages: normalizedMessages.length,
    duplicateEstimated
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    import: buildPreviewPayload(record)
  };
}

async function findPreviewImport(importId, clinicId, client) {
  const result = await client.query(
    `SELECT id, "tenantId", "clinicId", "actorId", "actorName", status, "fileHash", summary, warnings,
            "selectedContactId", "conversationId", "confirmedAt"
     FROM conversation_imports
     WHERE id = $1
       AND "clinicId" = $2
     FOR UPDATE`,
    [importId, clinicId]
  );
  return result.rows[0] || null;
}

async function createImportedContact(context, participantName, client) {
  const contactId = crypto.randomUUID();
  const safeName = normalizeString(participantName) || 'Contacto importado';
  await client.query(
    `INSERT INTO contacts (id, "clinicId", "waId", phone, name, notes, status, "updatedAt")
     VALUES ($1::uuid, $2::uuid, $3, NULL, $4, $5, 'active', NOW())`,
    [
      contactId,
      context.clinic.id,
      `imported:${contactId}`,
      safeName,
      'Importado desde historial de WhatsApp. Revisar telefono antes de usar en operaciones.'
    ]
  );
  return { id: contactId, name: safeName, waId: `imported:${contactId}` };
}

async function resolveTargetContact(context, selectedContactId, summary, client) {
  if (selectedContactId) {
    const contact = await findPortalContactById(context.clinic.id, selectedContactId, client);
    if (!contact) return null;
    return contact;
  }
  const participants = Array.isArray(summary.participants) ? summary.participants : [];
  const detectedName = participants[0] || 'Contacto importado';
  return createImportedContact(context, detectedName, client);
}

async function findOrCreateConversation(context, channel, contact, client) {
  const existing = await client.query(
    `SELECT id
     FROM conversations
     WHERE "clinicId" = $1::uuid
       AND "channelId" = $2::uuid
       AND "contactId" = $3::uuid
     LIMIT 1`,
    [context.clinic.id, channel.id, contact.id]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const conversationId = crypto.randomUUID();
  await client.query(
    `INSERT INTO conversations (
       id, "clinicId", "channelId", "contactId", "waFrom", "waTo",
       status, stage, state, "leadStatus", context, "updatedAt"
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'closed', 'new', 'NEW', 'CLOSED', $7::jsonb, NOW())`,
    [
      conversationId,
      context.clinic.id,
      channel.id,
      contact.id,
      contact.waId || `imported:${contact.id}`,
      channel.phoneNumberId || 'whatsapp_import',
      JSON.stringify({
        importedHistory: true,
        importSource: 'whatsapp_export',
        portalBotEnabled: false,
        needsPhoneReview: !contact.phone
      })
    ]
  );
  return conversationId;
}

async function insertImportedMessages(context, conversationId, channel, contact, messages, importId, client) {
  let inserted = 0;
  let duplicates = 0;
  for (const message of messages) {
    const raw = {
      import: {
        source: 'whatsapp_export',
        importId,
        originalTimestamp: message.originalTimestamp,
        participant: message.participant,
        rawLineHash: message.rawLineHash,
        imported: true,
        systemType: message.systemType || null
      }
    };
    const result = await client.query(
      `INSERT INTO conversation_messages (
         "conversationId", direction, "waMessageId", "from", "to", type, text, raw, "createdAt"
       )
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
       ON CONFLICT ("waMessageId") DO NOTHING
       RETURNING id`,
      [
        conversationId,
        message.direction,
        message.waMessageId,
        message.direction === 'outbound' ? channel.phoneNumberId || 'whatsapp_import' : contact.waId || `imported:${contact.id}`,
        message.direction === 'outbound' ? contact.waId || `imported:${contact.id}` : channel.phoneNumberId || 'whatsapp_import',
        message.type || 'text',
        message.text || '',
        JSON.stringify(raw),
        message.originalTimestamp
      ]
    );
    if (result.rowCount > 0) inserted += 1;
    else duplicates += 1;
  }
  return { inserted, duplicates };
}

async function confirmImport({ tenantId, actor, importId, selectedContactId }) {
  const context = await resolveContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const safeImportId = normalizeString(importId);
  if (!safeImportId) return buildError(context.tenantId, 'missing_import_id');

  return withTransaction(async (client) => {
    const importRecord = await findPreviewImport(safeImportId, context.clinic.id, client);
    if (!importRecord) return buildError(context.tenantId, 'whatsapp_import_not_found');
    if (importRecord.status === 'confirmed') {
      return {
        ok: true,
        tenantId: context.tenantId,
        clinic: context.clinic,
        import: buildPreviewPayload(importRecord),
        idempotent: true
      };
    }
    if (importRecord.status !== 'previewed') return buildError(context.tenantId, 'whatsapp_import_not_ready');

    const summary = importRecord.summary || {};
    const messages = Array.isArray(summary.messages) ? summary.messages : [];
    if (!messages.length) return buildError(context.tenantId, 'whatsapp_import_empty_preview');

    const channel = await findPreferredWhatsAppChannelByClinicId(context.clinic.id, client);
    if (!channel) return buildError(context.tenantId, 'whatsapp_import_channel_not_found');

    const contact = await resolveTargetContact(context, selectedContactId, summary, client);
    if (!contact) return buildError(context.tenantId, 'whatsapp_import_contact_not_found');

    const conversationId = await findOrCreateConversation(context, channel, contact, client);
    const result = await insertImportedMessages(context, conversationId, channel, contact, messages, safeImportId, client);
    const { messages: _discardedMessages, ...summaryWithoutSensitiveMessages } = summary;
    const nextSummary = {
      ...summaryWithoutSensitiveMessages,
      insertedMessages: result.inserted,
      duplicateMessages: result.duplicates,
      confirmedAt: new Date().toISOString()
    };

    const updated = await client.query(
      `UPDATE conversation_imports
       SET status = 'confirmed',
           "selectedContactId" = $3,
           "conversationId" = $4,
           "confirmedAt" = NOW(),
           summary = $5::jsonb,
           "updatedAt" = NOW()
       WHERE id = $1
         AND "clinicId" = $2
       RETURNING id, status, summary, warnings, "conversationId", "confirmedAt"`,
      [safeImportId, context.clinic.id, contact.id, conversationId, JSON.stringify(nextSummary)]
    );

    logInfo('whatsapp_chat_import_confirmed', {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      importId: safeImportId,
      conversationId,
      insertedMessages: result.inserted,
      duplicateMessages: result.duplicates,
      actorId: actor?.actorId || actor?.id || null
    });

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      import: {
        ...buildPreviewPayload(updated.rows[0]),
        insertedMessages: result.inserted,
        duplicateMessages: result.duplicates,
        conversationId
      },
      idempotent: false
    };
  });
}

module.exports = {
  MAX_FILE_SIZE_BYTES,
  previewImport,
  confirmImport,
  buildMessageHash
};
