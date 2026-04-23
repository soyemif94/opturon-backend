const { withTransaction } = require('../db/client');
const {
  findClinicByExternalTenantId,
  findChannelByIdAndClinicId,
  findPreferredWhatsAppChannelByClinicId
} = require('../repositories/tenant.repository');
const { findContactByIdAndClinicId } = require('../repositories/contact.repository');
const {
  findAgendaItemById,
  updateAgendaItemById
} = require('../repositories/agenda-items.repository');
const { addEvent } = require('../repositories/conversation-events.repository');
const { openHandoff } = require('../repositories/handoff.repository');
const conversationRepo = require('../conversations/conversation.repo');
const { sendChannelScopedMessage } = require('../whatsapp/whatsapp.service');

function normalizeString(value) {
  return String(value || '').trim();
}

function parseAction(value) {
  const safeValue = normalizeString(value).toLowerCase();
  if (['approved', 'approve', 'validated', 'validate'].includes(safeValue)) return 'approved';
  if (['rejected', 'reject', 'not_found', 'not-found', 'missing'].includes(safeValue)) return 'rejected';
  return null;
}

function parseContext(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function formatMoney(amount, currency = 'ARS') {
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: String(currency || 'ARS').trim() || 'ARS',
      maximumFractionDigits: 0
    }).format(value);
  } catch (error) {
    return `${currency || 'ARS'} ${value}`;
  }
}

function normalizePlan(plan) {
  return plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : null;
}

function buildOnboardingSummary({ transferPayment, context }) {
  const plan = normalizePlan(transferPayment && transferPayment.selectedPlan);
  const onboarding = parseContext(context && context.onboarding);
  const pieces = [
    'Pago validado por transferencia. Continuar onboarding/instalacion.',
    plan && plan.name ? `Plan: ${plan.name}${plan.price ? ` (${formatMoney(plan.price, plan.currency)})` : ''}.` : null,
    onboarding.businessType ? `Tipo de negocio: ${onboarding.businessType}.` : null,
    onboarding.mainOffer ? `Oferta principal: ${onboarding.mainOffer}.` : null,
    onboarding.goal ? `Objetivo: ${onboarding.goal}.` : null,
    onboarding.channel ? `Canal: ${onboarding.channel}.` : 'Canal: whatsapp.'
  ];
  return pieces.filter(Boolean).join(' ');
}

function buildOnboardingContext({ context, transferPayment, now, actorId }) {
  const existingOnboarding = parseContext(context && context.onboarding);
  const plan = normalizePlan(transferPayment && transferPayment.selectedPlan);
  const summary = buildOnboardingSummary({ transferPayment, context });

  return {
    ...existingOnboarding,
    status: 'pending',
    source: 'transfer_payment_validated',
    channel: existingOnboarding.channel || 'whatsapp',
    selectedPlan: plan,
    summary,
    handoffReason: 'transfer_payment_validated',
    pendingSince: existingOnboarding.pendingSince || now,
    validatedAt: now,
    validatedBy: actorId || null
  };
}

function prependContextItem(items, nextItem, maxItems = 50) {
  const list = Array.isArray(items) ? items : [];
  return [nextItem, ...list].slice(0, maxItems);
}

function buildTransferPaymentPatch({ transferPayment, action, actorId, reason, now }) {
  const base = transferPayment && typeof transferPayment === 'object' && !Array.isArray(transferPayment)
    ? transferPayment
    : {};

  if (action === 'approved') {
    return {
      ...base,
      status: 'payment_validated',
      awaitingHumanValidation: false,
      validatedAt: now,
      validatedBy: actorId || null,
      validationReason: reason || null
    };
  }

  return {
    ...base,
    status: 'payment_rejected',
    awaitingHumanValidation: false,
    rejectedAt: now,
    rejectedBy: actorId || null,
    rejectionReason: reason || null
  };
}

async function updateConversationPaymentValidation({ conversation, context, transferPayment, action, actorId, reason, now }, client) {
  const nextOnboarding = action === 'approved'
    ? buildOnboardingContext({ context, transferPayment, now, actorId })
    : null;
  const onboardingTask = action === 'approved'
    ? {
        id: `payment-onboarding-${now}`,
        title: 'Iniciar onboarding / instalacion',
        status: 'todo',
        dueDate: now.slice(0, 10),
        source: 'transfer_payment_validated'
      }
    : null;
  const onboardingNote = action === 'approved'
    ? {
        id: `payment-validation-${now}`,
        text: nextOnboarding.summary,
        createdAt: now,
        source: 'transfer_payment_validated'
      }
    : null;
  const nextContext = {
    ...context,
    transferPayment: buildTransferPaymentPatch({
      transferPayment,
      action,
      actorId,
      reason,
      now
    }),
    ...(nextOnboarding ? { onboarding: nextOnboarding } : {}),
    ...(onboardingNote ? { portalNotes: prependContextItem(context.portalNotes, onboardingNote) } : {}),
    ...(onboardingTask ? { portalTasks: prependContextItem(context.portalTasks, onboardingTask) } : {})
  };

  const nextStage = action === 'approved' ? 'installation_pending' : 'payment_rejected';
  const nextStatus = action === 'approved' ? 'needs_human' : 'open';
  const nextLeadStatus = 'FOLLOW_UP';

  const result = await client.query(
    `UPDATE conversations
     SET context = $3::jsonb,
         stage = $4,
         status = $5,
         "leadStatus" = $6,
         "nextActionAt" = NOW(),
         "nextActionNote" = $7,
         "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id, "clinicId", "contactId", status, stage, state, "leadStatus", "nextActionAt", "nextActionNote", context`,
    [
      conversation.id,
      conversation.clinicId,
      JSON.stringify(nextContext),
      nextStage,
      nextStatus,
      nextLeadStatus,
      action === 'approved'
        ? nextOnboarding.summary
        : 'Pago rechazado/no encontrado: recontactar para revisar comprobante.'
    ]
  );

  return result.rows[0] || null;
}

function buildPaymentValidatedClientReply() {
  return [
    'Perfecto, ya validamos tu pago.',
    '',
    'En breve un asesor se va a poner en contacto para iniciar la configuracion de tu sistema.',
    'No activamos nada automaticamente: vamos a acompañarte con la instalacion paso a paso.'
  ].join('\n');
}

async function sendPaymentValidatedClientReply({ clinic, conversation }) {
  const contact = await findContactByIdAndClinicId(conversation.contactId, clinic.id);
  if (!contact || !contact.waId) {
    return { sent: false, reason: 'contact_without_waid' };
  }

  const channel =
    (conversation.channelId ? await findChannelByIdAndClinicId(conversation.channelId, clinic.id) : null) ||
    await findPreferredWhatsAppChannelByClinicId(clinic.id);

  if (!channel) {
    return { sent: false, reason: 'whatsapp_channel_not_found' };
  }
  if (String(channel.status || '').trim().toLowerCase() !== 'active') {
    return { sent: false, reason: 'whatsapp_channel_inactive' };
  }

  const text = buildPaymentValidatedClientReply();
  const sendResult = await sendChannelScopedMessage(
    { to: contact.waId, text },
    {
      requestId: `transfer-payment-validation:${conversation.id}`,
      credentials: {
        tenantId: clinic.externalTenantId || null,
        clinicId: clinic.id,
        conversationId: conversation.id,
        channelId: channel.id,
        accessToken: channel.accessToken || undefined,
        phoneNumberId: channel.phoneNumberId,
        provider: channel.provider || null,
        status: channel.status || null,
        wabaId: channel.wabaId || null
      }
    }
  );

  const outbound = await conversationRepo.insertOutboundMessage({
    conversationId: conversation.id,
    waMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null,
    from: channel.phoneNumberId || null,
    to: contact.waId,
    type: 'text',
    text,
    raw: sendResult && sendResult.raw ? sendResult.raw : {}
  });

  return {
    sent: true,
    messageId: sendResult && sendResult.messageId ? sendResult.messageId : null,
    outboundMessageId: outbound && outbound.row ? outbound.row.id : null
  };
}

async function resolveValidationTarget({ clinic, conversationId, agendaItemId }, client) {
  let agendaItem = null;
  const safeAgendaItemId = normalizeString(agendaItemId);
  const safeConversationId = normalizeString(conversationId);

  if (safeAgendaItemId) {
    agendaItem = await findAgendaItemById(clinic.id, safeAgendaItemId, client);
    if (!agendaItem) {
      return { ok: false, status: 404, reason: 'agenda_item_not_found' };
    }
    if (agendaItem.origin !== 'transfer_payment') {
      return { ok: false, status: 400, reason: 'agenda_item_not_transfer_payment' };
    }
  }

  const targetConversationId = safeConversationId || (agendaItem && agendaItem.conversationId) || '';
  if (!targetConversationId) {
    return { ok: false, status: 400, reason: 'conversation_required' };
  }

  const conversation = await conversationRepo.getConversationByIdAndClinicId(targetConversationId, clinic.id, client);
  if (!conversation) {
    return { ok: false, status: 404, reason: 'conversation_not_found' };
  }

  return { ok: true, conversation, agendaItem };
}

async function validateTransferPaymentByExternalTenantId({ tenantId, conversationId, agendaItemId, action, reason, actorId }) {
  const safeTenantId = normalizeString(tenantId);
  const normalizedAction = parseAction(action);
  const safeReason = normalizeString(reason) || null;
  const safeActorId = normalizeString(actorId) || null;

  if (!safeTenantId) {
    return { ok: false, status: 400, reason: 'tenant_required' };
  }
  if (!normalizedAction) {
    return { ok: false, status: 400, reason: 'invalid_payment_validation_action' };
  }

  const clinic = await findClinicByExternalTenantId(safeTenantId);
  if (!clinic) {
    return { ok: false, status: 404, reason: 'tenant_not_found' };
  }

  const result = await withTransaction(async (client) => {
    const target = await resolveValidationTarget({ clinic, conversationId, agendaItemId }, client);
    if (!target.ok) return target;

    const context = parseContext(target.conversation.context);
    const transferPayment = context.transferPayment && typeof context.transferPayment === 'object' && !Array.isArray(context.transferPayment)
      ? context.transferPayment
      : null;

    if (!transferPayment || !['payment_reported', 'payment_pending_validation'].includes(normalizeString(transferPayment.status).toLowerCase())) {
      return {
        ok: false,
        status: 409,
        reason: 'transfer_payment_not_pending_validation',
        currentStatus: transferPayment && transferPayment.status ? transferPayment.status : null
      };
    }

    const now = new Date().toISOString();
    const updatedConversation = await updateConversationPaymentValidation({
      conversation: target.conversation,
      context,
      transferPayment,
      action: normalizedAction,
      actorId: safeActorId,
      reason: safeReason,
      now
    }, client);

    let agendaItem = target.agendaItem;
    if (!agendaItem && transferPayment.agendaFollowUp && transferPayment.agendaFollowUp.id) {
      agendaItem = await findAgendaItemById(clinic.id, transferPayment.agendaFollowUp.id, client);
    }

    await addEvent({
      clinicId: clinic.id,
      conversationId: target.conversation.id,
      type: normalizedAction === 'approved' ? 'TRANSFER_PAYMENT_VALIDATED' : 'TRANSFER_PAYMENT_REJECTED',
      data: {
        status: normalizedAction === 'approved' ? 'payment_validated' : 'payment_rejected',
        action: normalizedAction,
        reason: safeReason,
        actorId: safeActorId,
        validatedAt: normalizedAction === 'approved' ? now : null,
        rejectedAt: normalizedAction === 'rejected' ? now : null,
        selectedPlan: transferPayment.selectedPlan || null,
        agendaItemId: agendaItem ? agendaItem.id : null,
        awaitingHumanValidation: false
      }
    }, client);

    let updatedAgendaItem = null;
    if (agendaItem) {
      updatedAgendaItem = await updateAgendaItemById(clinic.id, agendaItem.id, {
        status: 'done',
        commercialOutcome: normalizedAction === 'approved' ? 'won' : 'not_interested',
        resultNote: normalizedAction === 'approved'
          ? `Pago validado${safeActorId ? ` por ${safeActorId}` : ''}. Continuar onboarding/instalacion.`
          : `Pago rechazado/no encontrado${safeReason ? `: ${safeReason}` : ''}.`,
        nextStepNote: normalizedAction === 'approved'
          ? 'Continuar onboarding/instalacion con asesor.'
          : 'Recontactar si el cliente envia nuevo comprobante.',
        nextActionAt: null
      }, client);
    }

    let handoff = null;
    if (normalizedAction === 'approved') {
      handoff = await openHandoff({
        clinicId: clinic.id,
        conversationId: target.conversation.id,
        contactId: target.conversation.contactId,
        leadId: null,
        reason: 'transfer_payment_validated'
      }, client);

      await addEvent({
        clinicId: clinic.id,
        conversationId: target.conversation.id,
        type: 'TRANSFER_PAYMENT_ONBOARDING_HANDOFF_CREATED',
        data: {
          status: 'onboarding_pending',
          handoffId: handoff ? handoff.id : null,
          handoffReason: 'transfer_payment_validated',
          channel: 'whatsapp',
          selectedPlan: transferPayment.selectedPlan || null,
          summary: updatedConversation && updatedConversation.context && updatedConversation.context.onboarding
            ? updatedConversation.context.onboarding.summary || null
            : null
        }
      }, client);
    }

    return {
      ok: true,
      tenantId: clinic.externalTenantId || safeTenantId,
      clinicId: clinic.id,
      action: normalizedAction,
      conversation: updatedConversation,
      agendaItem: updatedAgendaItem,
      handoff
    };
  });

  if (result && result.ok && normalizedAction === 'approved') {
    try {
      const notification = await sendPaymentValidatedClientReply({
        clinic,
        conversation: result.conversation
      });
      result.clientNotification = notification;
      await addEvent({
        clinicId: clinic.id,
        conversationId: result.conversation.id,
        type: notification.sent ? 'TRANSFER_PAYMENT_VALIDATION_CLIENT_NOTIFIED' : 'TRANSFER_PAYMENT_VALIDATION_CLIENT_NOTIFICATION_SKIPPED',
        data: notification
      });
    } catch (error) {
      result.clientNotification = { sent: false, reason: 'send_failed', detail: error.message };
      await addEvent({
        clinicId: clinic.id,
        conversationId: result.conversation.id,
        type: 'TRANSFER_PAYMENT_VALIDATION_CLIENT_NOTIFICATION_FAILED',
        data: result.clientNotification
      });
    }
  }

  return result;
}

module.exports = {
  validateTransferPaymentByExternalTenantId
};
