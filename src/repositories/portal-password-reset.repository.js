const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function findResettablePortalUserByEmail(email, client = null) {
  const result = await dbQuery(
    client,
    `SELECT su.id,
            su."clinicId",
            su.name,
            su.email,
            su.role,
            su.active,
            su."passwordHash",
            c."externalTenantId" AS "tenantId",
            COALESCE(
              c.settings #>> '{portal,accountScope}',
              c.settings #>> '{accountScope}',
              'client'
            ) AS "accountScope"
     FROM staff_users su
     INNER JOIN clinics c ON c.id = su."clinicId"
     WHERE LOWER(su.email) = LOWER($1)
       AND su."accountType" = 'client_portal'
       AND su.email IS NOT NULL
       AND su.role IN ('owner', 'manager', 'seller', 'viewer', 'editor')
     LIMIT 1`,
    [email]
  );

  return result.rows[0] || null;
}

async function createPortalPasswordResetToken(payload, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO portal_password_reset_tokens (
       "userId",
       "tokenHash",
       "expiresAt",
       metadata
     )
     VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb))
     RETURNING id,
               "userId",
               "tokenHash",
               "expiresAt",
               "consumedAt",
               metadata,
               "createdAt"`,
    [
      payload.userId,
      payload.tokenHash,
      payload.expiresAt,
      JSON.stringify(payload.metadata || {})
    ]
  );

  return result.rows[0] || null;
}

async function revokePendingPortalPasswordResetTokensByUserId(userId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE portal_password_reset_tokens
     SET "consumedAt" = NOW()
     WHERE "userId" = $1
       AND "consumedAt" IS NULL
       AND "expiresAt" > NOW()
     RETURNING id`,
    [userId]
  );

  return result.rows;
}

async function findPortalPasswordResetTokenByHash(tokenHash, client = null) {
  const result = await dbQuery(
    client,
    `SELECT prt.id,
            prt."userId",
            prt."tokenHash",
            prt."expiresAt",
            prt."consumedAt",
            prt.metadata,
            prt."createdAt",
            su."clinicId",
            su.email,
            su.name,
            su.role,
            su.active,
            c."externalTenantId" AS "tenantId",
            COALESCE(
              c.settings #>> '{portal,accountScope}',
              c.settings #>> '{accountScope}',
              'client'
            ) AS "accountScope"
     FROM portal_password_reset_tokens prt
     INNER JOIN staff_users su ON su.id = prt."userId"
     INNER JOIN clinics c ON c.id = su."clinicId"
     WHERE prt."tokenHash" = $1
     LIMIT 1`,
    [tokenHash]
  );

  return result.rows[0] || null;
}

async function consumePortalPasswordResetTokenById(tokenId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE portal_password_reset_tokens
     SET "consumedAt" = NOW()
     WHERE id = $1
       AND "consumedAt" IS NULL
     RETURNING id,
               "userId",
               "tokenHash",
               "expiresAt",
               "consumedAt",
               metadata,
               "createdAt"`,
    [tokenId]
  );

  return result.rows[0] || null;
}

async function revokePortalPasswordResetTokenByHash(tokenHash, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE portal_password_reset_tokens
     SET "consumedAt" = NOW()
     WHERE "tokenHash" = $1
       AND "consumedAt" IS NULL
     RETURNING id,
               "userId",
               "tokenHash",
               "expiresAt",
               "consumedAt",
               metadata,
               "createdAt"`,
    [tokenHash]
  );

  return result.rows[0] || null;
}

module.exports = {
  findResettablePortalUserByEmail,
  createPortalPasswordResetToken,
  revokePendingPortalPasswordResetTokensByUserId,
  findPortalPasswordResetTokenByHash,
  consumePortalPasswordResetTokenById,
  revokePortalPasswordResetTokenByHash
};
