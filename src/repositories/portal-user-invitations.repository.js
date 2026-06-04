const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function createPortalUserInvitation(payload, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO portal_user_invitations (
       "clinicId",
       "tenantId",
       "userId",
       email,
       role,
       "tokenHash",
       "expiresAt",
       "createdByUserId"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id,
               "clinicId",
               "tenantId",
               "userId",
               email,
               role,
               "tokenHash",
               "expiresAt",
               "acceptedAt",
               "revokedAt",
               "createdByUserId",
               "createdAt",
               "updatedAt"`,
    [
      payload.clinicId,
      payload.tenantId,
      payload.userId,
      payload.email,
      payload.role,
      payload.tokenHash,
      payload.expiresAt,
      payload.createdByUserId || null
    ]
  );

  return result.rows[0] || null;
}

async function revokePendingPortalUserInvitationsByUserId(userId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE portal_user_invitations
     SET "revokedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE "userId" = $1
       AND "acceptedAt" IS NULL
       AND "revokedAt" IS NULL
     RETURNING id`,
    [userId]
  );

  return result.rows;
}

async function revokePendingPortalUserInvitationsByEmail(email, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE portal_user_invitations
     SET "revokedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE LOWER(email) = LOWER($1)
       AND "acceptedAt" IS NULL
       AND "revokedAt" IS NULL
     RETURNING id`,
    [email]
  );

  return result.rows;
}

async function listLatestPortalUserInvitationsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT DISTINCT ON (inv."userId")
            inv.id,
            inv."clinicId",
            inv."tenantId",
            inv."userId",
            inv.email,
            inv.role,
            inv."expiresAt",
            inv."acceptedAt",
            inv."revokedAt",
            inv."createdByUserId",
            inv."createdAt",
            inv."updatedAt"
     FROM portal_user_invitations inv
     WHERE inv."clinicId" = $1
     ORDER BY inv."userId", inv."createdAt" DESC`,
    [clinicId]
  );

  return result.rows;
}

async function findPortalInvitationByTokenHash(tokenHash, client = null) {
  const result = await dbQuery(
    client,
    `SELECT inv.id,
            inv."clinicId",
            inv."tenantId",
            inv."userId",
            inv.email,
            inv.role,
            inv."tokenHash",
            inv."expiresAt",
            inv."acceptedAt",
            inv."revokedAt",
            inv."createdByUserId",
            inv."createdAt",
            inv."updatedAt",
            su.name AS "userName",
            su.active AS "userActive",
            c.name AS "clinicName"
     FROM portal_user_invitations inv
     INNER JOIN staff_users su ON su.id = inv."userId"
     INNER JOIN clinics c ON c.id = inv."clinicId"
     WHERE inv."tokenHash" = $1
     LIMIT 1`,
    [tokenHash]
  );

  return result.rows[0] || null;
}

async function markPortalInvitationAccepted(invitationId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE portal_user_invitations
     SET "acceptedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id,
               "clinicId",
               "tenantId",
               "userId",
               email,
               role,
               "expiresAt",
               "acceptedAt",
               "revokedAt",
               "createdByUserId",
               "createdAt",
               "updatedAt"`,
    [invitationId]
  );

  return result.rows[0] || null;
}

module.exports = {
  createPortalUserInvitation,
  revokePendingPortalUserInvitationsByUserId,
  revokePendingPortalUserInvitationsByEmail,
  listLatestPortalUserInvitationsByClinicId,
  findPortalInvitationByTokenHash,
  markPortalInvitationAccepted
};
