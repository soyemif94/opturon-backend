const { withTransaction } = require('../db/client');
const { findClinicByExternalTenantId } = require('../repositories/tenant.repository');
const {
  findAgendaItemById,
  updateAgendaItemById
} = require('../repositories/agenda-items.repository');
const { addEvent } = require('../repositories/conversation-events.repository');
const { openHandoff } = require('../repositories/handoff.repository');
const conversationRepo = require('../conversations/conversation.repo');

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
  const nextContext = {
    ...context,
    transferPayment: buildTransferPaymentPatch({
      transferPayment,
      action,
      actorId,
      reason,
      now
    })
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
        ? 'Pago validado: continuar onboarding/instalacion.'
        : 'Pago rechazado/no encontrado: recontactar para revisar comprobante.'
    ]
  );

  return result.rows[0] || null;
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

  return withTransaction(async (client) => {
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
}

module.exports = {
  validateTransferPaymentByExternalTenantId
};
