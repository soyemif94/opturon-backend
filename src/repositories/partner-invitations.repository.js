const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function createPartnerInvitation(payload, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO partner_invitations (
       "partnerId",
       email,
       "tokenHash",
       "expiresAt",
       "sourceType",
       "sourceId",
       "sponsorPartnerId",
       "createdByStaffUserId"
     )
     VALUES ($1, $2, $3, $4, $5, $6::uuid, $7::uuid, $8::uuid)
     RETURNING id,
               "partnerId",
               email,
               "tokenHash",
               "expiresAt",
               "sourceType",
               "sourceId",
               "sponsorPartnerId",
               "acceptedAt",
               "revokedAt",
               "createdByStaffUserId",
               "createdAt",
               "updatedAt"`,
    [
      payload.partnerId,
      payload.email,
      payload.tokenHash,
      payload.expiresAt,
      payload.sourceType || null,
      payload.sourceId || null,
      payload.sponsorPartnerId || null,
      payload.createdByStaffUserId || null
    ]
  );

  return result.rows[0] || null;
}

async function revokePendingPartnerInvitationsByPartnerId(partnerId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_invitations
     SET "revokedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE "partnerId" = $1
       AND "acceptedAt" IS NULL
       AND "revokedAt" IS NULL
     RETURNING id`,
    [partnerId]
  );

  return result.rows;
}

async function revokePendingPartnerInvitationsByEmail(email, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_invitations
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

async function listLatestPartnerInvitationsByPartnerIds(partnerIds, client = null) {
  const safeIds = Array.isArray(partnerIds) ? partnerIds.filter(Boolean) : [];
  if (safeIds.length === 0) return [];

  const result = await dbQuery(
    client,
    `SELECT DISTINCT ON (inv."partnerId")
            inv.id,
            inv."partnerId",
            inv.email,
            inv."expiresAt",
            inv."acceptedAt",
            inv."revokedAt",
            inv."createdByStaffUserId",
            inv."createdAt",
            inv."updatedAt"
     FROM partner_invitations inv
     WHERE inv."partnerId" = ANY($1::uuid[])
     ORDER BY inv."partnerId", inv."createdAt" DESC`,
    [safeIds]
  );

  return result.rows;
}

async function findPartnerInvitationByTokenHash(tokenHash, client = null) {
  const result = await dbQuery(
    client,
    `SELECT inv.id,
            inv."partnerId",
            inv.email,
            inv."tokenHash",
            inv."expiresAt",
            inv."sourceType",
            inv."sourceId",
            inv."sponsorPartnerId",
            inv."acceptedAt",
            inv."revokedAt",
            inv."createdByStaffUserId",
            inv."createdAt",
            inv."updatedAt",
            pa.status AS "partnerStatus",
            pa."lastLoginAt",
            pp.code,
            pp."displayName",
            pp.phone,
            COALESCE(inv."sponsorPartnerId", rel."sponsorPartnerId") AS "resolvedSponsorPartnerId",
            sponsor_profile."displayName" AS "sponsorDisplayName"
     FROM partner_invitations inv
     INNER JOIN partner_accounts pa ON pa.id = inv."partnerId"
     INNER JOIN partner_profiles pp ON pp."partnerId" = pa.id
     LEFT JOIN partner_relationships rel
       ON rel."partnerId" = pa.id
      AND rel.status = 'active'
     LEFT JOIN partner_profiles sponsor_profile
       ON sponsor_profile."partnerId" = COALESCE(inv."sponsorPartnerId", rel."sponsorPartnerId")
     WHERE inv."tokenHash" = $1
     LIMIT 1`,
    [tokenHash]
  );

  return result.rows[0] || null;
}

async function markPartnerInvitationAccepted(invitationId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE partner_invitations
     SET "acceptedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id,
               "partnerId",
               email,
               "expiresAt",
               "sourceType",
               "sourceId",
               "sponsorPartnerId",
               "acceptedAt",
               "revokedAt",
               "createdByStaffUserId",
               "createdAt",
               "updatedAt"`,
    [invitationId]
  );

  return result.rows[0] || null;
}

module.exports = {
  createPartnerInvitation,
  revokePendingPartnerInvitationsByPartnerId,
  revokePendingPartnerInvitationsByEmail,
  listLatestPartnerInvitationsByPartnerIds,
  findPartnerInvitationByTokenHash,
  markPartnerInvitationAccepted
};
