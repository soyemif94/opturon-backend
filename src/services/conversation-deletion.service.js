const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { createPortalUserAuditEvent } = require('../repositories/portal-user-audit.repository');

const PERMANENT_CONTEXT_KEYS = [
  'portalAssignedTo',
  'portalAssignedToUserId',
  'portalPriority',
  'portalDealStage',
  'portalNotes',
  'portalTasks'
];

function permanentContext(context) {
  const source = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  return Object.fromEntries(PERMANENT_CONTEXT_KEYS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

async function deletePortalConversation(tenantId, conversationId, actor = {}) {
  const requestedAt = new Date();
  const safeConversationId = String(conversationId || '').trim();
  if (!safeConversationId) return { ok: false, reason: 'missing_conversation_id' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(safeConversationId)) {
    return { ok: false, reason: 'invalid_conversation_id' };
  }

  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok) return context;

  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      'inbox_conversation_worker', safeConversationId
    ]);
    // Same lock namespace is used by inbound resolution. It serializes generations
    // for one tenant/channel/contact without locking unrelated conversations.
    const ownerResult = await client.query(
      `SELECT id, "clinicId", "channelId", "contactId", context, "deletedAt", "lastInboundAt"
       FROM conversations
       WHERE id = $1::uuid AND "clinicId" = $2::uuid`,
      [safeConversationId, context.clinic.id]
    );
    const owner = ownerResult.rows[0] || null;
    if (!owner) return { ok: false, reason: 'conversation_not_found', tenantId: context.tenantId };
    if (owner.deletedAt) {
      return { ok: true, reason: 'already_deleted', conversationId: owner.id, deleted: false, tenantId: context.tenantId };
    }

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [`inbox_conversation:${owner.clinicId}`, `${owner.channelId}:${owner.contactId}`]
    );
    const rowResult = await client.query(
      `SELECT id, "clinicId", "channelId", "contactId", context, "deletedAt", "lastInboundAt"
       FROM conversations
       WHERE id = $1::uuid AND "clinicId" = $2::uuid
       FOR UPDATE`,
      [safeConversationId, context.clinic.id]
    );
    const conversation = rowResult.rows[0] || null;
    if (!conversation) return { ok: false, reason: 'conversation_not_found', tenantId: context.tenantId };
    if (conversation.deletedAt) {
      return { ok: true, reason: 'already_deleted', conversationId: conversation.id, deleted: false, tenantId: context.tenantId };
    }
    if (conversation.lastInboundAt && new Date(conversation.lastInboundAt).getTime() > requestedAt.getTime()) {
      return { ok: false, reason: 'conversation_changed', tenantId: context.tenantId };
    }

    const savedContext = permanentContext(conversation.context);
    const deleted = await client.query(
      `UPDATE conversations
       SET status = 'closed', stage = 'deleted', state = 'DELETED',
           context = $3::jsonb, "deletedAt" = NOW(), "deletedByUserId" = $4::uuid,
           "deleteReason" = 'portal_conversation_deleted', "updatedAt" = NOW()
       WHERE id = $1::uuid AND "clinicId" = $2::uuid AND "deletedAt" IS NULL
       RETURNING id, "contactId", "deletedAt"`,
      [conversation.id, context.clinic.id, JSON.stringify(savedContext), actor.id || actor.userId || null]
    );
    if (!deleted.rows[0]) {
      return { ok: true, reason: 'already_deleted', conversationId: conversation.id, deleted: false, tenantId: context.tenantId };
    }

    const jobs = await client.query(
      `UPDATE jobs SET status = 'failed', "lastError" = 'conversation_deleted',
              "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = NOW()
       WHERE payload->>'conversationId' = $1 AND status IN ('queued', 'processing')
       RETURNING id`,
      [conversation.id]
    );
    await client.query(
      `UPDATE handoff_requests SET status = 'resolved', "updatedAt" = NOW()
       WHERE "clinicId" = $1::uuid AND "conversationId" = $2::uuid
         AND status IN ('open', 'assigned')`,
      [context.clinic.id, conversation.id]
    );
    await createPortalUserAuditEvent({
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      actorUserId: actor.id || actor.userId || null,
      action: 'inbox_conversation_deleted',
      payload: { conversationId: conversation.id, contactId: conversation.contactId }
    }, client);

    return {
      ok: true,
      tenantId: context.tenantId,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      deleted: true,
      invalidatedJobs: jobs.rowCount || 0,
      reason: 'conversation_deleted'
    };
  });
}

module.exports = { PERMANENT_CONTEXT_KEYS, permanentContext, deletePortalConversation };
