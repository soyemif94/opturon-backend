const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function createPortalUserAuditEvent(entry, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO portal_user_audit_log (
      "tenantId",
      "clinicId",
      "actorUserId",
      "targetUserId",
      action,
      payload
    )
    VALUES ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb))
    RETURNING id,
              "tenantId",
              "clinicId",
              "actorUserId",
              "targetUserId",
              action,
              payload,
              "createdAt"`,
    [
      entry.tenantId,
      entry.clinicId,
      entry.actorUserId || null,
      entry.targetUserId || null,
      entry.action,
      JSON.stringify(entry.payload || {})
    ]
  );

  return result.rows[0] || null;
}

async function listPortalUserAuditEventsByClinicId(clinicId, limit = 10, client = null) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
  const result = await dbQuery(
    client,
    `SELECT log.id,
            log."tenantId",
            log."clinicId",
            log."actorUserId",
            actor.name AS "actorName",
            actor.email AS "actorEmail",
            log."targetUserId",
            target.name AS "targetName",
            target.email AS "targetEmail",
            log.action,
            log.payload,
            log."createdAt"
     FROM portal_user_audit_log log
     LEFT JOIN staff_users actor ON actor.id = log."actorUserId"
     LEFT JOIN staff_users target ON target.id = log."targetUserId"
     WHERE log."clinicId" = $1
     ORDER BY log."createdAt" DESC
     LIMIT $2`,
    [clinicId, safeLimit]
  );

  return result.rows;
}

module.exports = {
  createPortalUserAuditEvent,
  listPortalUserAuditEventsByClinicId
};
