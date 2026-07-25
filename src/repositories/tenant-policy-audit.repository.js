const { query } = require('../db/client');

async function createTenantPolicyAuditEvent(entry, client = null) {
  const db = client && typeof client.query === 'function' ? client : { query };
  const result = await db.query(
    `INSERT INTO tenant_policy_audit_log (
       "clinicId",
       "tenantId",
       "actorUserId",
       "actorRole",
       "actorScope",
       action,
       "beforeSnapshot",
       "afterSnapshot",
       metadata
     )
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
     RETURNING id, "tenantId", "clinicId", action, "createdAt"`,
    [
      entry.clinicId,
      entry.tenantId,
      entry.actorUserId || null,
      entry.actorRole || null,
      entry.actorScope || null,
      entry.action || 'tenant_policy_updated',
      JSON.stringify(entry.beforeSnapshot || {}),
      JSON.stringify(entry.afterSnapshot || {}),
      JSON.stringify(entry.metadata || {})
    ]
  );

  return result.rows[0] || null;
}

module.exports = {
  createTenantPolicyAuditEvent
};
