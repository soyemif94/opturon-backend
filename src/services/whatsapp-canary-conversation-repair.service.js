const { resolvePortalTenantContext } = require('./portal-context.service');
const canaryRepository = require('../repositories/whatsapp-template-canary.repository');
const { createPortalUserAuditEvent } = require('../repositories/portal-user-audit.repository');

const CONFIRMATION = 'RELINK_CANARY_TO_EXISTING_CONVERSATION';

function normalize(value) {
  return String(value || '').trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalize(value));
}

function canonicalWhatsAppIdentity(value) {
  const digits = normalize(value).replace(/\D/g, '');
  if (digits.startsWith('54') && digits.length === 12) return `549${digits.slice(2)}`;
  return digits;
}

function contactIdentities(contact) {
  return [...new Set([
    contact && contact.waId,
    contact && contact.whatsappPhone,
    contact && contact.phone,
    contact && contact.waFrom
  ].map(canonicalWhatsAppIdentity).filter(Boolean))];
}

function identitiesIntersect(left, right) {
  const rightSet = new Set(contactIdentities(right));
  return contactIdentities(left).some((identity) => rightSet.has(identity));
}

async function repairCanaryConversation(tenantId, attemptId, payload, actor) {
  const sourceConversationId = normalize(payload && payload.sourceConversationId);
  const targetConversationId = normalize(payload && payload.targetConversationId);
  if (normalize(payload && payload.confirmation) !== CONFIRMATION) {
    return { ok: false, reason: 'canary_conversation_repair_confirmation_required', status: 400 };
  }
  if (![attemptId, sourceConversationId, targetConversationId].every(isUuid) || sourceConversationId === targetConversationId) {
    return { ok: false, reason: 'canary_conversation_repair_scope_invalid', status: 400 };
  }

  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic || !context.clinic.id || !context.channel || !context.channel.id) return context;

  return canaryRepository.withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      'whatsapp_canary_conversation_repair', attemptId
    ]);

    const attemptResult = await client.query(
      `SELECT id, "clinicId", "channelId", "conversationId", "inboxMessageId", "providerMessageId", status,
              "sentAt", "deliveredAt", "readAt", "failedAt", "createdAt", "updatedAt"
       FROM whatsapp_template_canary_attempts
       WHERE id=$1::uuid AND "clinicId"=$2::uuid
       FOR UPDATE`,
      [attemptId, context.clinic.id]
    );
    const attempt = attemptResult.rows[0] || null;
    if (!attempt) return { ok: false, reason: 'canary_attempt_not_found', status: 404 };
    if (attempt.conversationId === targetConversationId) {
      return {
        ok: true,
        reason: 'already_repaired',
        repaired: false,
        attemptId: attempt.id,
        conversationId: targetConversationId,
        providerMessageId: attempt.providerMessageId,
        inboxMessageId: attempt.inboxMessageId,
        status: attempt.status
      };
    }
    if (attempt.conversationId !== sourceConversationId) {
      return { ok: false, reason: 'canary_attempt_source_mismatch', status: 409 };
    }

    const ownersResult = await client.query(
      `SELECT c.id, c."clinicId", c."channelId", c."contactId", c."waFrom", c."waTo", c.status, c.context,
              c."lastInboundAt", c."lastOutboundAt", c."deletedAt", c."createdAt", c."updatedAt",
              ct."waId", ct.phone, ct."whatsappPhone", ct.name AS "contactName", ct.status AS "contactStatus",
              ct."createdAt" AS "contactCreatedAt", ct."updatedAt" AS "contactUpdatedAt"
       FROM conversations c
       INNER JOIN contacts ct ON ct.id=c."contactId" AND ct."clinicId"=c."clinicId"
       WHERE c.id=ANY($1::uuid[]) AND c."clinicId"=$2::uuid
       ORDER BY c.id
       FOR UPDATE OF c,ct`,
      [[sourceConversationId, targetConversationId], context.clinic.id]
    );
    const source = ownersResult.rows.find((row) => row.id === sourceConversationId) || null;
    const target = ownersResult.rows.find((row) => row.id === targetConversationId) || null;
    if (!source || !target || source.deletedAt || target.deletedAt) {
      return { ok: false, reason: 'canary_conversation_repair_owner_missing', status: 409 };
    }
    if (source.clinicId !== target.clinicId || source.channelId !== target.channelId ||
        source.channelId !== context.channel.id || attempt.channelId !== context.channel.id) {
      return { ok: false, reason: 'canary_conversation_repair_cross_scope_blocked', status: 403 };
    }
    if (!identitiesIntersect(source, target)) {
      return { ok: false, reason: 'canary_conversation_repair_identity_mismatch', status: 409 };
    }

    const messagesResult = await client.query(
      `SELECT id, "conversationId", direction, "waMessageId", raw, "createdAt"
       FROM conversation_messages WHERE "conversationId"=$1::uuid ORDER BY "createdAt",id FOR UPDATE`,
      [sourceConversationId]
    );
    const sourceMessages = messagesResult.rows;
    const outbound = sourceMessages[0] || null;
    const rawAttemptId = normalize(outbound && outbound.raw && outbound.raw.whatsappTemplateCanary && outbound.raw.whatsappTemplateCanary.attemptId);
    if (sourceMessages.length !== 1 || !outbound || outbound.direction !== 'outbound' ||
        outbound.id !== attempt.inboxMessageId || rawAttemptId !== attempt.id ||
        normalize(outbound.waMessageId) !== normalize(attempt.providerMessageId)) {
      return { ok: false, reason: 'canary_conversation_repair_message_precondition_failed', status: 409 };
    }

    const references = (await client.query(
      `SELECT
        (SELECT count(*)::int FROM messages WHERE "conversationId"=$1::uuid) messages,
        (SELECT count(*)::int FROM leads WHERE "conversationId"=$1::uuid) leads,
        (SELECT count(*)::int FROM handoff_requests WHERE "conversationId"=$1::uuid) handoffs,
        (SELECT count(*)::int FROM conversation_events WHERE "conversationId"=$1::uuid) events,
        (SELECT count(*)::int FROM appointments WHERE "conversationId"=$1::uuid) appointments,
        (SELECT count(*)::int FROM orders WHERE "conversationId"=$1::uuid) orders,
        (SELECT count(*)::int FROM agenda_items WHERE "conversationId"=$1::uuid) agenda,
        (SELECT count(*)::int FROM order_customer_notifications WHERE "conversationId"=$1::uuid) notifications,
        (SELECT count(*)::int FROM whatsapp_template_canary_attempts WHERE "conversationId"=$1::uuid AND id<>$2::uuid) "otherAttempts",
        (SELECT count(*)::int FROM jobs WHERE payload->>'conversationId'=$1::text) jobs`,
      [sourceConversationId, attemptId]
    )).rows[0];
    if (Object.values(references).some((count) => Number(count) !== 0)) {
      return { ok: false, reason: 'canary_conversation_repair_foreign_activity_detected', status: 409, references };
    }

    const contactReferences = (await client.query(
      `SELECT
        (SELECT count(*)::int FROM conversations WHERE "contactId"=$1::uuid AND id<>$2::uuid) conversations,
        (SELECT count(*)::int FROM orders WHERE "contactId"=$1::uuid) orders,
        (SELECT count(*)::int FROM invoices WHERE "contactId"=$1::uuid) invoices,
        (SELECT count(*)::int FROM payments WHERE "contactId"=$1::uuid) payments,
        (SELECT count(*)::int FROM loyalty_points_ledger WHERE "contactId"=$1::uuid) loyalty,
        (SELECT count(*)::int FROM leads WHERE "contactId"=$1::uuid) leads,
        (SELECT count(*)::int FROM appointments WHERE "contactId"=$1::uuid) appointments,
        (SELECT count(*)::int FROM handoff_requests WHERE "contactId"=$1::uuid) handoffs,
        (SELECT count(*)::int FROM agenda_items WHERE "contactId"=$1::uuid) agenda`,
      [source.contactId, sourceConversationId]
    )).rows[0];
    if (Object.values(contactReferences).some((count) => Number(count) !== 0)) {
      return { ok: false, reason: 'canary_contact_repair_foreign_activity_detected', status: 409, contactReferences };
    }

    await client.query(
      `UPDATE conversation_messages SET "conversationId"=$2::uuid WHERE id=$1::uuid AND "conversationId"=$3::uuid`,
      [outbound.id, targetConversationId, sourceConversationId]
    );
    await client.query(
      `UPDATE whatsapp_template_canary_attempts SET "conversationId"=$2::uuid, "updatedAt"=NOW()
       WHERE id=$1::uuid AND "clinicId"=$3::uuid AND "conversationId"=$4::uuid`,
      [attemptId, targetConversationId, context.clinic.id, sourceConversationId]
    );
    await client.query(
      `UPDATE conversations SET
         "lastOutboundAt"=GREATEST(COALESCE("lastOutboundAt",'-infinity'::timestamptz),$2::timestamptz),
         "updatedAt"=GREATEST("updatedAt",$2::timestamptz)
       WHERE id=$1::uuid AND "clinicId"=$3::uuid AND "channelId"=$4::uuid`,
      [targetConversationId, outbound.createdAt, context.clinic.id, context.channel.id]
    );
    await client.query(
      `UPDATE conversations SET status='closed',stage='deleted',state='DELETED',
         context=jsonb_build_object('canaryDuplicateRepair',jsonb_build_object('attemptId',$2::text,'targetConversationId',$3::text,'repairedAt',NOW())),
         "deletedAt"=NOW(),"deletedByUserId"=$4::uuid,"deleteReason"='canary_duplicate_repaired',"updatedAt"=NOW()
       WHERE id=$1::uuid AND "clinicId"=$5::uuid AND "deletedAt" IS NULL`,
      [sourceConversationId, attemptId, targetConversationId, actor && actor.id || null, context.clinic.id]
    );
    await client.query(
      `UPDATE contacts SET status='deleted',"deletedAt"=NOW(),"updatedAt"=NOW()
       WHERE id=$1::uuid AND "clinicId"=$2::uuid`,
      [source.contactId, context.clinic.id]
    );
    await createPortalUserAuditEvent({
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      actorUserId: actor && actor.id || null,
      action: 'whatsapp_canary_conversation_repaired',
      payload: {
        attemptId,
        sourceConversationId,
        targetConversationId,
        inboxMessageId: outbound.id,
        duplicateContactId: source.contactId
      }
    }, client);

    return {
      ok: true,
      reason: 'repaired',
      repaired: true,
      attemptId,
      sourceConversationId,
      targetConversationId,
      conversationId: targetConversationId,
      inboxMessageId: outbound.id,
      providerMessageId: attempt.providerMessageId,
      status: attempt.status,
      sourceConversationRetired: true,
      duplicateContactId: source.contactId,
      duplicateContactRetired: true
    };
  });
}

module.exports = {
  CONFIRMATION,
  canonicalWhatsAppIdentity,
  contactIdentities,
  identitiesIntersect,
  repairCanaryConversation
};
