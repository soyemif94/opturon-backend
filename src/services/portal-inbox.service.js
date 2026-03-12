const crypto = require('crypto');
const { findContactByIdAndClinicId, upsertContact } = require('../repositories/contact.repository');
const { listEvents } = require('../repositories/conversation-events.repository');
const { findChannelByIdAndClinicId, findPreferredWhatsAppChannelByClinicId } = require('../repositories/tenant.repository');
const conversationRepo = require('../conversations/conversation.repo');
const { sendTextMessage } = require('../whatsapp/whatsapp.service');
const { resolvePortalTenantContext } = require('./portal-context.service');

function parseContext(context) {
  return context && typeof context === 'object' && !Array.isArray(context) ? context : {};
}

function defaultQuickReplies() {
  return [
    { intent: 'Seguimiento', text: 'Perfecto. Quedo atento y te respondo por este medio.' },
    { intent: 'Presupuesto', text: 'Te paso la propuesta y, si queres, vemos la mejor opcion para vos.' },
    { intent: 'Coordinacion', text: 'Si te sirve, coordinamos el siguiente paso desde esta conversacion.' }
  ];
}

function boolFromContext(context, key, fallback) {
  if (Object.prototype.hasOwnProperty.call(context, key)) {
    return Boolean(context[key]);
  }
  return fallback;
}

function normalizePortalStatus(status, conversation) {
  const safeStatus = String(status || '').trim().toLowerCase();
  if (safeStatus === 'closed') return 'closed';
  if (safeStatus === 'new') return 'new';
  if (!conversation.lastOutboundAt && conversation.lastInboundAt) return 'new';
  return 'open';
}

function computeSlaMinutes(conversation) {
  const inbound = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : NaN;
  if (Number.isNaN(inbound)) return 0;
  const outbound = conversation.lastOutboundAt ? new Date(conversation.lastOutboundAt).getTime() : NaN;
  if (!Number.isNaN(outbound) && outbound >= inbound) return 0;
  return Math.max(1, Math.floor((Date.now() - inbound) / (1000 * 60)));
}

function mapDeal(context, contactId) {
  const stage = String(context.portalDealStage || '').trim();
  if (!stage) return undefined;
  return {
    id: `deal-${contactId}`,
    stage,
    value: 0,
    probability: 0
  };
}

function mapConversationRow(row) {
  const context = parseContext(row.context);
  return {
    id: row.id,
    status: normalizePortalStatus(row.status, row),
    assignedTo: context.portalAssignedTo || undefined,
    lastMessageAt: row.lastMessageAt || row.updatedAt,
    lastMessagePreview: row.lastMessagePreview || undefined,
    priority: String(context.portalPriority || 'normal') === 'hot' ? 'hot' : 'normal',
    botEnabled: boolFromContext(context, 'portalBotEnabled', true),
    unreadCount: Number(row.unreadCount || 0),
    slaMinutes: computeSlaMinutes(row),
    contact: {
      id: row.contactId,
      name: row.contactName || row.waFrom || 'Contacto',
      phone: row.contactPhone || row.waFrom || undefined,
      tags: []
    },
    deal: mapDeal(context, row.contactId)
  };
}

function toPortalChannel(channel) {
  if (!channel) return null;
  return {
    id: channel.id,
    clinicId: channel.clinicId,
    provider: channel.provider || null,
    phoneNumberId: channel.phoneNumberId || null,
    wabaId: channel.wabaId || null,
    status: channel.status || null
  };
}

async function resolveRuntimeContext(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok) return context;
  const channel = await findPreferredWhatsAppChannelByClinicId(context.clinic.id);
  return {
    ...context,
    channel: channel
      ? {
          id: channel.id,
          clinicId: channel.clinicId,
          provider: channel.provider || null,
          phoneNumberId: channel.phoneNumberId || null,
          wabaId: channel.wabaId || null,
          status: channel.status || null,
          accessToken: channel.accessToken || null
        }
      : null,
    reason: channel ? 'resolved' : 'mapped_clinic_without_whatsapp_channel'
  };
}

async function listPortalConversations(tenantId) {
  const context = await resolveRuntimeContext(tenantId);
  if (!context.ok) return context;

  const result = await query(
    `SELECT
       c.id,
       c."channelId" AS "channelId",
       c.status,
       c.context,
       c."lastInboundAt",
       c."lastOutboundAt",
       c."updatedAt",
       c."contactId" AS "contactId",
       ct.name AS "contactName",
       ct.phone AS "contactPhone",
       ct."waId" AS "waFrom",
       latest.text AS "lastMessagePreview",
       latest."createdAt" AS "lastMessageAt",
       COALESCE(unread.total, 0)::int AS "unreadCount"
     FROM conversations c
     INNER JOIN contacts ct ON ct.id = c."contactId"
     LEFT JOIN LATERAL (
       SELECT m.text, m."createdAt"
       FROM conversation_messages m
       WHERE m."conversationId" = c.id
       ORDER BY m."createdAt" DESC
       LIMIT 1
     ) latest ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS total
       FROM conversation_messages m
       WHERE m."conversationId" = c.id
         AND m.direction = 'inbound'
         AND m."createdAt" > COALESCE(
           CASE
             WHEN c.context ? 'portalLastReadAt'
               AND NULLIF(c.context->>'portalLastReadAt', '') IS NOT NULL
             THEN (c.context->>'portalLastReadAt')::timestamptz
             ELSE NULL
           END,
           c."lastOutboundAt",
           to_timestamp(0)
         )
     ) unread ON TRUE
     WHERE c."clinicId" = $1::uuid
     ORDER BY COALESCE(latest."createdAt", c."updatedAt") DESC, c."updatedAt" DESC`,
    [context.clinic.id]
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: toPortalChannel(context.channel),
    conversations: result.rows.map(mapConversationRow),
    reason: 'resolved'
  };
}

async function getPortalConversationDetail(tenantId, conversationId) {
  const context = await resolveRuntimeContext(tenantId);
  if (!context.ok) return context;

  const conversation = await conversationRepo.getConversationByIdAndClinicId(conversationId, context.clinic.id);
  if (!conversation) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'conversation_not_found'
    };
  }

  const [contact, messages, events] = await Promise.all([
    findContactByIdAndClinicId(conversation.contactId, context.clinic.id),
    conversationRepo.listConversationMessagesByClinicId(conversation.id, context.clinic.id, 200),
    listEvents(context.clinic.id, conversation.id, 20)
  ]);

  const contextData = parseContext(conversation.context);
  const detailRow = mapConversationRow({
    ...conversation,
    contactId: contact ? contact.id : conversation.contactId,
    contactName: contact ? contact.name : null,
    contactPhone: contact ? contact.phone : null,
    waFrom: contact ? contact.waId : null,
    lastMessageAt:
      messages.length > 0 ? messages[messages.length - 1].createdAt : conversation.updatedAt,
    lastMessagePreview: messages.length > 0 ? messages[messages.length - 1].text : null,
    unreadCount: 0
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: toPortalChannel(context.channel),
    detail: {
      readOnly: false,
      conversation: detailRow,
      contact: contact
        ? {
            id: contact.id,
            name: contact.name || contact.waId,
            phone: contact.phone || contact.waId || undefined,
            email: undefined,
            industry: undefined,
            tags: []
          }
        : undefined,
      deal: mapDeal(contextData, conversation.contactId),
      messages: messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        text: message.text || '',
        timestamp: message.createdAt,
        status: message.direction === 'inbound' ? 'read' : 'sent'
      })),
      notes: Array.isArray(contextData.portalNotes) ? contextData.portalNotes : [],
      tasks: Array.isArray(contextData.portalTasks) ? contextData.portalTasks : [],
      assignee: contextData.portalAssignedTo
        ? { id: contextData.portalAssignedTo, name: contextData.portalAssignedTo }
        : undefined,
      quickReplies: defaultQuickReplies(),
      aiEvents: events.slice(0, 10).map((event) => ({
        id: event.id,
        text: event.type,
        createdAt: event.createdAt
      }))
    }
  };
}

async function patchPortalConversation(tenantId, conversationId, payload = {}) {
  const context = await resolveRuntimeContext(tenantId);
  if (!context.ok) return context;

  const conversation = await conversationRepo.getConversationByIdAndClinicId(conversationId, context.clinic.id);
  if (!conversation) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'conversation_not_found'
    };
  }

  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const action = String(safePayload.action || '').trim();
  const currentContext = parseContext(conversation.context);
  const nextContext = { ...currentContext };

  if (action === 'assign') {
    nextContext.portalAssignedTo = safePayload.assignedTo ? String(safePayload.assignedTo) : null;
  } else if (action === 'toggle_bot') {
    nextContext.portalBotEnabled = Boolean(safePayload.botEnabled);
  } else if (action === 'mark_hot') {
    nextContext.portalPriority = 'hot';
  } else if (action === 'unmark_hot') {
    nextContext.portalPriority = 'normal';
  } else if (action === 'mark_read') {
    nextContext.portalLastReadAt = new Date().toISOString();
  } else if (action === 'mark_unread') {
    nextContext.portalLastReadAt = '1970-01-01T00:00:00.000Z';
  } else if (action === 'change_stage') {
    nextContext.portalDealStage = safePayload.stage ? String(safePayload.stage) : null;
  } else if (action === 'add_note') {
    const text = String(safePayload.text || '').trim();
    if (text) {
      const notes = Array.isArray(nextContext.portalNotes) ? nextContext.portalNotes.slice(0, 49) : [];
      notes.unshift({ id: crypto.randomUUID(), text, createdAt: new Date().toISOString() });
      nextContext.portalNotes = notes;
    }
  } else if (action === 'add_task') {
    const title = String(safePayload.title || '').trim();
    if (title) {
      const tasks = Array.isArray(nextContext.portalTasks) ? nextContext.portalTasks.slice(0, 49) : [];
      tasks.unshift({
        id: crypto.randomUUID(),
        title,
        status: 'todo',
        dueDate: safePayload.dueDate ? String(safePayload.dueDate) : undefined
      });
      nextContext.portalTasks = tasks;
    }
  }

  if (action === 'close' || action === 'reopen') {
    await conversationRepo.updateConversationStatusForClinic({
      conversationId: conversation.id,
      clinicId: context.clinic.id,
      status: action === 'close' ? 'closed' : 'open'
    });
  }

  await conversationRepo.updateConversationStateForClinic({
    conversationId: conversation.id,
    clinicId: context.clinic.id,
    state: null,
    contextPatch: nextContext
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: toPortalChannel(context.channel),
    reason: 'updated'
  };
}

async function sendPortalMessage(tenantId, conversationId, text) {
  const context = await resolveRuntimeContext(tenantId);
  if (!context.ok) return context;

  const conversation = await conversationRepo.getConversationByIdAndClinicId(conversationId, context.clinic.id);
  if (!conversation) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'conversation_not_found'
    };
  }

  const runtimeChannel =
    (context.channel && context.channel.id === conversation.channelId
      ? context.channel
      : await findChannelByIdAndClinicId(conversation.channelId, context.clinic.id)) || null;
  if (!runtimeChannel) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'conversation_channel_not_found'
    };
  }

  const contact = await findContactByIdAndClinicId(conversation.contactId, context.clinic.id);
  if (!contact || !contact.waId) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'contact_without_waid'
    };
  }

  const safeText = String(text || '').trim();
  if (!safeText) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'missing_text'
    };
  }

  const sendResult = await sendTextMessage(
    { to: contact.waId, text: safeText },
    {
      requestId: `portal:${conversation.id}`,
      credentials: {
        accessToken: runtimeChannel.accessToken || undefined,
        phoneNumberId: runtimeChannel.phoneNumberId
      }
    }
  );

  const outboundWrite = await conversationRepo.insertOutboundMessage({
    conversationId: conversation.id,
    waMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null,
    from: runtimeChannel.phoneNumberId || null,
    to: contact.waId || null,
    type: 'text',
    text: safeText,
    raw: sendResult && sendResult.raw ? sendResult.raw : {}
  });

  await upsertContact({
    clinicId: context.clinic.id,
    waId: contact.waId,
    phone: contact.phone,
    name: contact.name
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: toPortalChannel(runtimeChannel),
    message: {
      id: outboundWrite && outboundWrite.row ? outboundWrite.row.id : crypto.randomUUID(),
      direction: 'outbound',
      text: safeText,
      timestamp: outboundWrite && outboundWrite.row ? outboundWrite.row.createdAt : new Date().toISOString(),
      status: 'sent',
      providerMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null
    },
    reason: 'sent'
  };
}

module.exports = {
  listPortalConversations,
  getPortalConversationDetail,
  patchPortalConversation,
  sendPortalMessage
};
