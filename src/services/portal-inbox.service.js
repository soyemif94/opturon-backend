const crypto = require('crypto');
const { query } = require('../db/client');
const { findContactByIdAndClinicId, upsertContact } = require('../repositories/contact.repository');
const { listEvents } = require('../repositories/conversation-events.repository');
const {
  findPortalUserByIdAndClinicId,
  findPortalUserByNameAndClinicId,
  listPortalUsersByClinicId
} = require('../repositories/portal-users.repository');
const { findLatestOrderByConversationId, findOrderById } = require('../repositories/orders.repository');
const { findChannelByIdAndClinicId } = require('../repositories/tenant.repository');
const conversationRepo = require('../conversations/conversation.repo');
const { sendChannelScopedMessage } = require('../whatsapp/whatsapp.service');
const { resolvePortalTenantContext } = require('./portal-context.service');
const env = require('../config/env');
const { logInfo, logWarn } = require('../utils/logger');

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

function getTransferPaymentContext(context) {
  const safeContext = parseContext(context);
  const transferPayment = safeContext.transferPayment;
  return transferPayment && typeof transferPayment === 'object' && !Array.isArray(transferPayment)
    ? transferPayment
    : null;
}

function buildAssignedSeller(row, context) {
  const safeContext = parseContext(context);
  const sellerId = row && row.assignedSellerUserId ? String(row.assignedSellerUserId).trim() : '';
  const sellerName =
    (row && row.assignedSellerName ? String(row.assignedSellerName).trim() : '') ||
    String(safeContext.portalAssignedTo || '').trim();
  const sellerRole = row && row.assignedSellerRole ? String(row.assignedSellerRole).trim() : null;

  if (!sellerId && !sellerName) {
    return null;
  }

  return {
    id: sellerId || String(safeContext.portalAssignedToUserId || '').trim() || null,
    name: sellerName || null,
    role: sellerRole || null
  };
}

const LEAD_STATUS_VALUES = new Set(['NEW', 'IN_CONVERSATION', 'FOLLOW_UP', 'CLOSED']);

function normalizeLeadStatus(value) {
  const safeValue = String(value || '').trim().toUpperCase();
  return LEAD_STATUS_VALUES.has(safeValue) ? safeValue : 'NEW';
}

function leadStatusLabel(value) {
  if (value === 'IN_CONVERSATION') return 'En conversacion';
  if (value === 'FOLLOW_UP') return 'Seguimiento';
  if (value === 'CLOSED') return 'Cerrado';
  return 'Nuevo';
}

function normalizeNextActionNote(value) {
  if (value === null || value === undefined) return null;
  const safeValue = String(value).trim();
  return safeValue ? safeValue : null;
}

function buildRelatedOrderSummary(order) {
  if (!order || !order.id) return null;
  return {
    id: order.id,
    orderStatus: order.orderStatus || null,
    paymentStatus: order.paymentStatus || null,
    total: order.total || 0,
    currency: order.currency || 'ARS',
    customerName: order.customerName || null,
    createdAt: order.createdAt || null
  };
}

function normalizeBotDomainOverride(value) {
  const safeValue = String(value || '').trim().toLowerCase();
  if (safeValue === 'agenda' || safeValue === 'commerce') return safeValue;
  return 'automatic';
}

function normalizeBotFlowLock(value) {
  const safeValue = String(value || '').trim().toLowerCase();
  if (safeValue === 'agenda' || safeValue === 'commerce') return safeValue;
  return 'automatic';
}

function mapConversationRow(row) {
  const context = parseContext(row.context);
  const transferPayment = getTransferPaymentContext(context);
  const assignedSeller = buildAssignedSeller(row, context);
  const leadStatus = normalizeLeadStatus(row.leadStatus);
  return {
    id: row.id,
    channelId: row.channelId || null,
    status: normalizePortalStatus(row.status, row),
    leadStatus,
    leadStatusLabel: leadStatusLabel(leadStatus),
    assignedTo: assignedSeller && assignedSeller.name ? assignedSeller.name : undefined,
    assignedSellerUserId: assignedSeller && assignedSeller.id ? assignedSeller.id : null,
    assignedSellerName: assignedSeller && assignedSeller.name ? assignedSeller.name : null,
    assignedSellerRole: assignedSeller && assignedSeller.role ? assignedSeller.role : null,
    lastMessageAt: row.lastMessageAt || row.updatedAt,
    lastMessagePreview: row.lastMessagePreview || undefined,
    priority: String(context.portalPriority || 'normal') === 'hot' ? 'hot' : 'normal',
    botEnabled: boolFromContext(context, 'portalBotEnabled', true),
    botFlowLock: normalizeBotFlowLock(context.botFlowLock),
    botDomainOverride: normalizeBotDomainOverride(context.botDomainOverride),
    unreadCount: Number(row.unreadCount || 0),
    slaMinutes: computeSlaMinutes(row),
    nextActionAt: row.nextActionAt || null,
    nextActionNote: normalizeNextActionNote(row.nextActionNote),
    contact: {
      id: row.contactId,
      name: row.contactName || row.waFrom || 'Contacto',
      phone: row.contactPhone || row.waFrom || undefined,
      profileImageUrl: row.contactProfileImageUrl || undefined,
      tags: []
    },
    deal: mapDeal(context, row.contactId),
    transferPaymentStatus: transferPayment && String(transferPayment.status || '').trim()
      ? String(transferPayment.status || '').trim()
      : null,
    transferPaymentOrderId: transferPayment && String(transferPayment.orderId || '').trim()
      ? String(transferPayment.orderId || '').trim()
      : null
  };
}

function toPortalChannel(channel) {
  if (!channel) return null;
  return {
    id: channel.id,
    clinicId: channel.clinicId,
    provider: channel.provider || null,
    phoneNumberId: channel.phoneNumberId || null,
    displayPhoneNumber: channel.displayPhoneNumber || null,
    verifiedName: channel.verifiedName || null,
    wabaId: channel.wabaId || null,
    status: channel.status || null
  };
}

function buildConversationChannelBinding({ context, conversationChannel }) {
  const workspaceDefaultChannel = toPortalChannel(context && context.channel ? context.channel : null);
  const boundConversationChannel = toPortalChannel(conversationChannel);
  const boundStatus = String(
    (boundConversationChannel && boundConversationChannel.status) || ''
  )
    .trim()
    .toLowerCase();

  let resolutionStatus = 'workspace_default_unresolved';
  let matchesWorkspaceDefault = null;

  if (!boundConversationChannel) {
    resolutionStatus = 'conversation_channel_missing';
    matchesWorkspaceDefault = false;
  } else if (boundStatus !== 'active') {
    resolutionStatus = 'conversation_channel_inactive';
    matchesWorkspaceDefault =
      Boolean(workspaceDefaultChannel && workspaceDefaultChannel.id) &&
      workspaceDefaultChannel.id === boundConversationChannel.id;
  } else if (!workspaceDefaultChannel || !workspaceDefaultChannel.id) {
    resolutionStatus = 'workspace_default_unresolved';
    matchesWorkspaceDefault = null;
  } else if (workspaceDefaultChannel.id === boundConversationChannel.id) {
    resolutionStatus = 'matches_workspace_default';
    matchesWorkspaceDefault = true;
  } else {
    resolutionStatus = 'different_from_workspace_default';
    matchesWorkspaceDefault = false;
  }

  return {
    conversationChannelId: boundConversationChannel ? boundConversationChannel.id : null,
    conversationChannel: boundConversationChannel,
    workspaceDefaultChannel,
    activeWorkspaceChannels: Array.isArray(context && context.channels)
      ? context.channels
          .filter((channel) => String(channel && channel.status ? channel.status : '').trim().toLowerCase() === 'active')
          .map((channel) => toPortalChannel(channel))
      : [],
    matchesWorkspaceDefault,
    resolutionStatus
  };
}

async function resolveRuntimeContext(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok) return context;
  const channel =
    context.channel && context.channel.id
      ? await findChannelByIdAndClinicId(context.channel.id, context.clinic.id)
      : null;
  return {
    ...context,
    channel: channel
      ? {
          id: channel.id,
          clinicId: channel.clinicId,
          provider: channel.provider || null,
          phoneNumberId: channel.phoneNumberId || null,
          displayPhoneNumber: channel.displayPhoneNumber || null,
          verifiedName: channel.verifiedName || null,
          wabaId: channel.wabaId || null,
          status: channel.status || null,
          accessToken: channel.accessToken || null
        }
      : null,
    reason: channel ? context.reason || 'resolved' : context.reason || 'mapped_clinic_without_whatsapp_channel'
  };
}

function buildOwnershipSnapshot({ context, conversation, runtimeChannel }) {
  return {
    tenantId: context && context.tenantId ? context.tenantId : null,
    clinicId: context && context.clinic && context.clinic.id ? context.clinic.id : null,
    conversationId: conversation && conversation.id ? conversation.id : null,
    conversationChannelId: conversation && conversation.channelId ? conversation.channelId : null,
    selectedPortalChannelId: context && context.channel && context.channel.id ? context.channel.id : null,
    runtimeChannelId: runtimeChannel && runtimeChannel.id ? runtimeChannel.id : null,
    runtimeChannelClinicId: runtimeChannel && runtimeChannel.clinicId ? runtimeChannel.clinicId : null,
    channelSelectionReason: context && context.channelSelection ? context.channelSelection.reason || null : null,
    channelSelectionStrategy: context && context.channelSelection ? context.channelSelection.strategy || null : null
  };
}

async function resolvePortalAssignee(clinicId, value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return {
      label: null,
      userId: null
    };
  }

  const byId = await findPortalUserByIdAndClinicId(rawValue, clinicId);
  if (byId) {
    return {
      label: byId.name || rawValue,
      userId: byId.id
    };
  }

  const byName = await findPortalUserByNameAndClinicId(rawValue, clinicId);
  if (byName) {
    return {
      label: byName.name || rawValue,
      userId: byName.id
    };
  }

  const normalizeAssigneeName = (input) =>
    String(input || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();

  const normalizedRawValue = normalizeAssigneeName(rawValue);
  if (normalizedRawValue) {
    const users = await listPortalUsersByClinicId(clinicId);
    const byNormalizedName = users.find((user) => normalizeAssigneeName(user && user.name) === normalizedRawValue);
    if (byNormalizedName) {
      return {
        label: byNormalizedName.name || rawValue,
        userId: byNormalizedName.id
      };
    }
  }

  return {
    label: rawValue,
    userId: null
  };
}

async function listPortalConversations(tenantId, options = {}) {
  const context = await resolveRuntimeContext(tenantId);
  if (!context.ok) return context;
  const visibility = String(options && options.visibility ? options.visibility : 'active').trim().toLowerCase() === 'archived'
    ? 'archived'
    : 'active';
  const visibilityClause =
    visibility === 'archived'
      ? `AND NULLIF(c.context->>'portalHiddenAt', '') IS NOT NULL`
      : `AND NULLIF(c.context->>'portalHiddenAt', '') IS NULL`;

  const result = await query(
    `SELECT
       c.id,
       c."channelId" AS "channelId",
       c.status,
       c."leadStatus" AS "leadStatus",
       c."nextActionAt" AS "nextActionAt",
       c."nextActionNote" AS "nextActionNote",
       c.context,
       c."lastInboundAt",
       c."lastOutboundAt",
       c."updatedAt",
       c."contactId" AS "contactId",
       c."assignedSellerUserId" AS "assignedSellerUserId",
       ct.name AS "contactName",
       ct.phone AS "contactPhone",
       ct."waId" AS "waFrom",
       ct."profileImageUrl" AS "contactProfileImageUrl",
       su.name AS "assignedSellerName",
       CASE WHEN su.role = 'editor' THEN 'seller' ELSE su.role END AS "assignedSellerRole",
       latest.text AS "lastMessagePreview",
       latest."createdAt" AS "lastMessageAt",
       COALESCE(unread.total, 0)::int AS "unreadCount"
     FROM conversations c
     INNER JOIN contacts ct ON ct.id = c."contactId"
     LEFT JOIN staff_users su ON su.id = c."assignedSellerUserId"
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
       AND COALESCE(ct.status, 'active') <> 'deleted'
       ${visibilityClause}
      ORDER BY COALESCE(latest."createdAt", c."updatedAt") DESC, c."updatedAt" DESC`,
    [context.clinic.id]
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: toPortalChannel(context.channel),
    conversations: result.rows.map(mapConversationRow),
    visibility,
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

  const [contact, messages, events, conversationChannel] = await Promise.all([
    findContactByIdAndClinicId(conversation.contactId, context.clinic.id),
    conversationRepo.listConversationMessagesByClinicId(conversation.id, context.clinic.id, null),
    listEvents(context.clinic.id, conversation.id, 20),
    conversation.channelId ? findChannelByIdAndClinicId(conversation.channelId, context.clinic.id) : null
  ]);

  const contextData = parseContext(conversation.context);
  const assignedSeller = buildAssignedSeller(conversation, contextData);
  const transferPayment = getTransferPaymentContext(contextData);
  const transferOrderId = transferPayment && String(transferPayment.orderId || '').trim()
    ? String(transferPayment.orderId || '').trim()
    : null;
  const relatedOrder =
    (transferOrderId ? await findOrderById(transferOrderId, context.clinic.id) : null) ||
    await findLatestOrderByConversationId(conversation.id, context.clinic.id);
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

  const channelBinding = buildConversationChannelBinding({
    context,
    conversationChannel
  });

  if (channelBinding.resolutionStatus === 'conversation_channel_inactive' || channelBinding.resolutionStatus === 'conversation_channel_missing') {
    logWarn('portal_conversation_channel_binding_warning', {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      conversationId: conversation.id,
      conversationChannelId: channelBinding.conversationChannelId,
      workspaceDefaultChannelId: channelBinding.workspaceDefaultChannel ? channelBinding.workspaceDefaultChannel.id : null,
      resolutionStatus: channelBinding.resolutionStatus
    });
  }

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
          profileImageUrl: contact.profileImageUrl || undefined,
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
      assignee: assignedSeller && assignedSeller.name
        ? {
            id: assignedSeller.id || assignedSeller.name,
            name: assignedSeller.name
          }
        : undefined,
      assignedSeller: assignedSeller || undefined,
      quickReplies: defaultQuickReplies(),
      aiEvents: events.slice(0, 10).map((event) => ({
        id: event.id,
        text: event.type,
        createdAt: event.createdAt
      })),
      channelBinding,
      relatedOrder: buildRelatedOrderSummary(relatedOrder)
    }
  };
}

async function archivePortalConversations(tenantId, payload = {}, actor = {}) {
  const context = await resolveRuntimeContext(tenantId);
  if (!context.ok) return context;

  const conversationIds = Array.isArray(payload.conversationIds)
    ? payload.conversationIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];

  if (!conversationIds.length) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'missing_conversation_ids'
    };
  }

  const hiddenAt = new Date().toISOString();
  const hiddenByUserId = String(actor.actorId || actor.userId || '').trim() || null;
  const hiddenByName = String(actor.actorName || '').trim() || null;

  const result = await query(
    `UPDATE conversations
     SET
       context = COALESCE(context, '{}'::jsonb) || jsonb_strip_nulls(
         jsonb_build_object(
           'portalHiddenAt', $3::text,
           'portalHiddenByUserId', $4::text,
           'portalHiddenByName', $5::text
         )
       ),
       "updatedAt" = NOW()
     WHERE "clinicId" = $1::uuid
       AND id = ANY($2::uuid[])
       AND NULLIF(context->>'portalHiddenAt', '') IS NULL
     RETURNING id`,
    [context.clinic.id, conversationIds, hiddenAt, hiddenByUserId, hiddenByName]
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: toPortalChannel(context.channel),
    archivedConversationIds: result.rows.map((row) => row.id),
    archivedCount: result.rowCount || 0,
    reason: 'archived'
  };
}

async function restorePortalConversations(tenantId, payload = {}) {
  const context = await resolveRuntimeContext(tenantId);
  if (!context.ok) return context;

  const conversationIds = Array.isArray(payload.conversationIds)
    ? payload.conversationIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];

  if (!conversationIds.length) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'missing_conversation_ids'
    };
  }

  const result = await query(
    `UPDATE conversations
     SET
       context = (COALESCE(context, '{}'::jsonb) - 'portalHiddenAt' - 'portalHiddenByUserId' - 'portalHiddenByName'),
       "updatedAt" = NOW()
     WHERE "clinicId" = $1::uuid
       AND id = ANY($2::uuid[])
       AND NULLIF(context->>'portalHiddenAt', '') IS NOT NULL
     RETURNING id`,
    [context.clinic.id, conversationIds]
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: toPortalChannel(context.channel),
    restoredConversationIds: result.rows.map((row) => row.id),
    restoredCount: result.rowCount || 0,
    reason: 'restored'
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
    const resolvedAssignee = await resolvePortalAssignee(context.clinic.id, safePayload.assignedTo);
    nextContext.portalAssignedTo = resolvedAssignee.label;
    nextContext.portalAssignedToUserId = resolvedAssignee.userId;
    await conversationRepo.assignConversationSellerForClinic({
      conversationId: conversation.id,
      clinicId: context.clinic.id,
      sellerUserId: resolvedAssignee.userId || null,
      leadStatus:
        resolvedAssignee.userId && normalizeLeadStatus(conversation.leadStatus) === 'NEW'
          ? 'IN_CONVERSATION'
          : null,
      contextPatch: {
        portalAssignedTo: resolvedAssignee.label,
        portalAssignedToUserId: resolvedAssignee.userId
      }
    });
    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'updated'
    };
  } else if (action === 'set_bot_flow_lock') {
    const nextLock = normalizeBotFlowLock(safePayload.botFlowLock);
    if (nextLock === 'automatic') {
      delete nextContext.botFlowLock;
    } else {
      nextContext.botFlowLock = nextLock;
    }
  } else if (action === 'set_bot_domain_override') {
    const nextOverride = normalizeBotDomainOverride(safePayload.botDomainOverride);
    if (nextOverride === 'automatic') {
      delete nextContext.botDomainOverride;
    } else {
      nextContext.botDomainOverride = nextOverride;
    }
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
  } else if (action === 'repair_channel') {
    const requestedChannelId = String(safePayload.channelId || '').trim();
    const source = requestedChannelId ? 'explicit_channel' : 'workspace_default_channel';
    const targetChannelId = requestedChannelId || String(context.channel && context.channel.id ? context.channel.id : '').trim();

    if (!targetChannelId) {
      return {
        ok: false,
        tenantId: context.tenantId,
        clinic: context.clinic,
        channel: toPortalChannel(context.channel),
        reason: 'repair_channel_target_unresolved'
      };
    }

    const targetChannel = await findChannelByIdAndClinicId(targetChannelId, context.clinic.id);
    if (!targetChannel) {
      return {
        ok: false,
        tenantId: context.tenantId,
        clinic: context.clinic,
        channel: toPortalChannel(context.channel),
        reason: 'repair_channel_not_found'
      };
    }

    if (String(targetChannel.provider || '').trim().toLowerCase() !== 'whatsapp_cloud') {
      return {
        ok: false,
        tenantId: context.tenantId,
        clinic: context.clinic,
        channel: toPortalChannel(context.channel),
        reason: 'repair_channel_invalid_provider'
      };
    }

    if (String(targetChannel.status || '').trim().toLowerCase() !== 'active') {
      return {
        ok: false,
        tenantId: context.tenantId,
        clinic: context.clinic,
        channel: toPortalChannel(context.channel),
        reason: 'repair_channel_inactive'
      };
    }

    const previousChannelId = conversation.channelId || null;
    const repairedConversation = await conversationRepo.reassignConversationChannelForClinic({
      conversationId: conversation.id,
      clinicId: context.clinic.id,
      channelId: targetChannel.id,
      waTo: targetChannel.phoneNumberId || conversation.waTo || null
    });

    if (!repairedConversation) {
      return {
        ok: false,
        tenantId: context.tenantId,
        clinic: context.clinic,
        channel: toPortalChannel(context.channel),
        reason: 'repair_channel_not_persisted'
      };
    }

    logInfo('portal_conversation_channel_repaired', {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      conversationId: conversation.id,
      previousChannelId,
      nextChannelId: targetChannel.id,
      source
    });

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'channel_repaired'
    };
  }

  if (action === 'close' || action === 'reopen') {
    await conversationRepo.updateConversationStatusForClinic({
      conversationId: conversation.id,
      clinicId: context.clinic.id,
      status: action === 'close' ? 'closed' : 'open'
    });
  }

  await conversationRepo.replaceConversationStateForClinic({
    conversationId: conversation.id,
    clinicId: context.clinic.id,
    state: null,
    context: nextContext
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: toPortalChannel(context.channel),
    reason: 'updated'
  };
}

async function assignPortalConversationSeller(tenantId, conversationId, payload = {}) {
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

  const sellerUserId = String(payload && payload.sellerUserId ? payload.sellerUserId : '').trim();
  if (!sellerUserId) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'missing_seller_user_id'
    };
  }

  const seller = await findPortalUserByIdAndClinicId(sellerUserId, context.clinic.id);
  if (!seller || seller.role === 'viewer') {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'seller_user_not_found'
    };
  }

  const updatedConversation = await conversationRepo.assignConversationSellerForClinic({
    conversationId: conversation.id,
    clinicId: context.clinic.id,
    sellerUserId: seller.id,
    leadStatus: normalizeLeadStatus(conversation.leadStatus) === 'NEW' ? 'IN_CONVERSATION' : null,
    contextPatch: {
      portalAssignedTo: seller.name || null,
      portalAssignedToUserId: seller.id
    }
  });

  if (!updatedConversation) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'conversation_not_found'
    };
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: toPortalChannel(context.channel),
    conversation: mapConversationRow({
      ...updatedConversation,
      contactName: null,
      contactPhone: null,
      contactProfileImageUrl: null,
      assignedSellerName: seller.name || null,
      assignedSellerRole: seller.role || null,
      lastMessagePreview: null,
      lastMessageAt: updatedConversation.updatedAt,
      unreadCount: 0
    }),
    reason: 'assigned'
  };
}

async function patchPortalConversationLeadStatus(tenantId, conversationId, payload = {}) {
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

  const leadStatus = String(payload && payload.leadStatus ? payload.leadStatus : '').trim().toUpperCase();
  if (!LEAD_STATUS_VALUES.has(leadStatus)) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'invalid_lead_status'
    };
  }

  const updatedConversation = await conversationRepo.updateConversationLeadStatusForClinic({
    conversationId: conversation.id,
    clinicId: context.clinic.id,
    leadStatus
  });

  if (!updatedConversation) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'conversation_not_found'
    };
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: toPortalChannel(context.channel),
    conversation: {
      id: updatedConversation.id,
      leadStatus,
      leadStatusLabel: leadStatusLabel(leadStatus),
      updatedAt: updatedConversation.updatedAt
    },
    reason: 'lead_status_updated'
  };
}

async function patchPortalConversationNextAction(tenantId, conversationId, payload = {}) {
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

  const hasNextActionAt = Object.prototype.hasOwnProperty.call(payload || {}, 'nextActionAt');
  const hasNextActionNote = Object.prototype.hasOwnProperty.call(payload || {}, 'nextActionNote');
  if (!hasNextActionAt && !hasNextActionNote) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'missing_next_action_patch'
    };
  }

  let parsedNextActionAt = null;
  if (hasNextActionAt) {
    if (payload.nextActionAt !== null && String(payload.nextActionAt || '').trim()) {
      const date = new Date(String(payload.nextActionAt));
      if (Number.isNaN(date.getTime())) {
        return {
          ok: false,
          tenantId: context.tenantId,
          clinic: context.clinic,
          channel: toPortalChannel(context.channel),
          reason: 'invalid_next_action_at'
        };
      }
      parsedNextActionAt = date.toISOString();
    }
  }

  const updatedConversation = await conversationRepo.updateConversationFollowUpForClinic({
    conversationId: conversation.id,
    clinicId: context.clinic.id,
    patch: {
      ...(hasNextActionAt ? { nextActionAt: parsedNextActionAt } : {}),
      ...(hasNextActionNote ? { nextActionNote: normalizeNextActionNote(payload.nextActionNote) } : {})
    }
  });

  if (!updatedConversation) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'conversation_not_found'
    };
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    channel: toPortalChannel(context.channel),
    conversation: {
      id: updatedConversation.id,
      nextActionAt: updatedConversation.nextActionAt || null,
      nextActionNote: normalizeNextActionNote(updatedConversation.nextActionNote),
      updatedAt: updatedConversation.updatedAt
    },
    reason: 'next_action_updated'
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

  let runtimeChannel =
    (context.channel && context.channel.id === conversation.channelId
      ? context.channel
      : await findChannelByIdAndClinicId(conversation.channelId, context.clinic.id)) || null;
  if (!runtimeChannel) {
    logWarn('portal_conversation_channel_resolution_failed', buildOwnershipSnapshot({
      context,
      conversation,
      runtimeChannel: null
    }));
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(context.channel),
      reason: 'conversation_channel_not_found'
    };
  }

  const runtimeChannelStatus = String(runtimeChannel.status || '').trim().toLowerCase();
  const preferredChannelStatus = String(context.channel && context.channel.status ? context.channel.status : '').trim().toLowerCase();
  const canRepairConversationChannel =
    runtimeChannelStatus !== 'active' &&
    context.channel &&
    context.channel.id &&
    context.channel.id !== runtimeChannel.id &&
    preferredChannelStatus === 'active';

  if (canRepairConversationChannel) {
    const repairedConversation = await conversationRepo.reassignConversationChannelForClinic({
      conversationId: conversation.id,
      clinicId: context.clinic.id,
      channelId: context.channel.id,
      waTo: context.channel.phoneNumberId || conversation.waTo || null
    });

    if (repairedConversation) {
      conversation.channelId = repairedConversation.channelId;
      conversation.waTo = repairedConversation.waTo;
      runtimeChannel = context.channel;
      logWarn('portal_conversation_channel_repaired_to_selected_channel', buildOwnershipSnapshot({
        context,
        conversation,
        runtimeChannel
      }));
    }
  }

  logInfo('portal_conversation_channel_resolved', {
    ...buildOwnershipSnapshot({ context, conversation, runtimeChannel }),
    resolutionSource:
      context.channel && context.channel.id === runtimeChannel.id
        ? 'portal_selected_channel'
        : 'conversation_bound_channel'
  });

  if (String(runtimeChannel.status || '').trim().toLowerCase() !== 'active') {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      channel: toPortalChannel(runtimeChannel),
      reason: 'conversation_channel_inactive'
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

  console.log('WA_CHANNEL_VALIDATION', {
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    conversationId: conversation.id,
    channelId: runtimeChannel.id,
    provider: runtimeChannel.provider || null,
    status: runtimeChannel.status || null,
    phoneNumberId: runtimeChannel.phoneNumberId || null,
    wabaId: runtimeChannel.wabaId || null,
    graphVersion: env.getWhatsAppGraphVersion()
  });

  const sendResult = await sendChannelScopedMessage(
    { to: contact.waId, text: safeText },
      {
        requestId: `portal:${conversation.id}`,
        credentials: {
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          conversationId: conversation.id,
          channelId: runtimeChannel.id,
          accessToken: runtimeChannel.accessToken || undefined,
          phoneNumberId: runtimeChannel.phoneNumberId,
          provider: runtimeChannel.provider || null,
          status: runtimeChannel.status || null,
          wabaId: runtimeChannel.wabaId || null
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
  patchPortalConversationLeadStatus,
  patchPortalConversationNextAction,
  assignPortalConversationSeller,
  sendPortalMessage,
  archivePortalConversations,
  restorePortalConversations
};
