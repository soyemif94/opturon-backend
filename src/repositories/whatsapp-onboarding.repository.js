const { query, withTransaction } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function createOnboardingSession(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO channel_onboarding_sessions (
      "clinicId",
      "externalTenantId",
      provider,
      status,
      "stateToken",
      nonce,
      "createdByUserId",
      "redirectUri",
      "graphVersion",
      metadata
    )
    VALUES ($1, $2, 'whatsapp_embedded_signup', $3, $4, $5, $6, $7, $8, $9)
    RETURNING *`,
    [
      input.clinicId,
      input.externalTenantId,
      input.status || 'launching',
      input.stateToken,
      input.nonce,
      input.createdByUserId || null,
      input.redirectUri,
      input.graphVersion || null,
      input.metadata || null
    ]
  );

  return result.rows[0] || null;
}

async function expirePreviousPendingSessions(clinicId, client = null) {
  await dbQuery(
    client,
    `UPDATE channel_onboarding_sessions
     SET status = 'expired',
         "updatedAt" = NOW()
     WHERE "clinicId" = $1
       AND status IN ('launching', 'pending_meta')
       AND "completedAt" IS NULL`,
    [clinicId]
  );
}

async function findOnboardingSessionByStateToken(stateToken, client = null) {
  const result = await dbQuery(
    client,
    `SELECT *
     FROM channel_onboarding_sessions
     WHERE "stateToken" = $1
     LIMIT 1`,
    [stateToken]
  );

  return result.rows[0] || null;
}

async function findLatestOnboardingSessionByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT *
     FROM channel_onboarding_sessions
     WHERE "clinicId" = $1
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [clinicId]
  );

  return result.rows[0] || null;
}

async function markOnboardingSessionFailed(sessionId, data, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE channel_onboarding_sessions
     SET status = 'failed',
         "errorCode" = COALESCE($2, "errorCode"),
         "errorMessage" = COALESCE($3, "errorMessage"),
         metadata = COALESCE($4, metadata),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [sessionId, data.errorCode || null, data.errorMessage || null, data.metadata || null]
  );

  return result.rows[0] || null;
}

async function markOnboardingSessionPending(sessionId, data, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE channel_onboarding_sessions
     SET status = 'pending_meta',
         "metaCode" = COALESCE($2, "metaCode"),
         "metaAccessToken" = COALESCE($3, "metaAccessToken"),
         "metaTokenType" = COALESCE($4, "metaTokenType"),
         "metaTokenExpiresAt" = COALESCE($5, "metaTokenExpiresAt"),
         "metaBusinessId" = COALESCE($6, "metaBusinessId"),
         "wabaId" = COALESCE($7, "wabaId"),
         "phoneNumberId" = COALESCE($8, "phoneNumberId"),
         "displayPhoneNumber" = COALESCE($9, "displayPhoneNumber"),
         "verifiedName" = COALESCE($10, "verifiedName"),
         "errorCode" = COALESCE($11, "errorCode"),
         "errorMessage" = COALESCE($12, "errorMessage"),
         metadata = COALESCE($13, metadata),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      sessionId,
      data.metaCode || null,
      data.metaAccessToken || null,
      data.metaTokenType || null,
      data.metaTokenExpiresAt || null,
      data.metaBusinessId || null,
      data.wabaId || null,
      data.phoneNumberId || null,
      data.displayPhoneNumber || null,
      data.verifiedName || null,
      data.errorCode || null,
      data.errorMessage || null,
      data.metadata || null
    ]
  );

  return result.rows[0] || null;
}

async function markOnboardingSessionCompleted(sessionId, data, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE channel_onboarding_sessions
     SET status = 'completed',
         "metaCode" = COALESCE($2, "metaCode"),
         "metaAccessToken" = COALESCE($3, "metaAccessToken"),
         "metaTokenType" = COALESCE($4, "metaTokenType"),
         "metaTokenExpiresAt" = COALESCE($5, "metaTokenExpiresAt"),
         "metaBusinessId" = COALESCE($6, "metaBusinessId"),
         "wabaId" = COALESCE($7, "wabaId"),
         "phoneNumberId" = COALESCE($8, "phoneNumberId"),
         "displayPhoneNumber" = COALESCE($9, "displayPhoneNumber"),
         "verifiedName" = COALESCE($10, "verifiedName"),
         "channelId" = COALESCE($11, "channelId"),
         "errorCode" = NULL,
         "errorMessage" = NULL,
         metadata = COALESCE($12, metadata),
         "completedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      sessionId,
      data.metaCode || null,
      data.metaAccessToken || null,
      data.metaTokenType || null,
      data.metaTokenExpiresAt || null,
      data.metaBusinessId || null,
      data.wabaId || null,
      data.phoneNumberId || null,
      data.displayPhoneNumber || null,
      data.verifiedName || null,
      data.channelId || null,
      data.metadata || null
    ]
  );

  return result.rows[0] || null;
}

async function findWhatsAppChannelByPhoneNumberId(phoneNumberId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", provider, "phoneNumberId", "wabaId", "accessToken", "displayPhoneNumber", "verifiedName", status, "connectionSource", "connectionMetadata", "updatedAt", "createdAt"
     FROM channels
     WHERE "phoneNumberId" = $1
       AND provider = 'whatsapp_cloud'
     LIMIT 1`,
    [phoneNumberId]
  );

  return result.rows[0] || null;
}

async function upsertWhatsAppChannel(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO channels (
      "clinicId",
      provider,
      "phoneNumberId",
      "wabaId",
      "accessToken",
      "displayPhoneNumber",
      "verifiedName",
      status,
      "connectionSource",
      "connectionMetadata",
      "updatedAt"
    )
    VALUES ($1, 'whatsapp_cloud', $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    ON CONFLICT ("phoneNumberId")
    DO UPDATE SET
      "wabaId" = COALESCE(EXCLUDED."wabaId", channels."wabaId"),
      "accessToken" = COALESCE(EXCLUDED."accessToken", channels."accessToken"),
      "displayPhoneNumber" = COALESCE(EXCLUDED."displayPhoneNumber", channels."displayPhoneNumber"),
      "verifiedName" = COALESCE(EXCLUDED."verifiedName", channels."verifiedName"),
      status = EXCLUDED.status,
      "connectionSource" = EXCLUDED."connectionSource",
      "connectionMetadata" = COALESCE(EXCLUDED."connectionMetadata", channels."connectionMetadata"),
      "updatedAt" = NOW()
    WHERE channels."clinicId" = EXCLUDED."clinicId"
    RETURNING id, "clinicId", provider, "phoneNumberId", "wabaId", "accessToken", "displayPhoneNumber", "verifiedName", status, "connectionSource", "connectionMetadata", "updatedAt", "createdAt"`,
    [
      input.clinicId,
      input.phoneNumberId,
      input.wabaId || null,
      input.accessToken || null,
      input.displayPhoneNumber || null,
      input.verifiedName || null,
      input.status || 'active',
      input.connectionSource || 'embedded_signup',
      input.connectionMetadata || null
    ]
  );

  return result.rows[0] || null;
}

async function deactivateOtherClinicWhatsAppChannels(clinicId, keepChannelId, client = null) {
  await dbQuery(
    client,
    `UPDATE channels
     SET status = 'inactive',
         "updatedAt" = NOW()
     WHERE "clinicId" = $1
       AND provider = 'whatsapp_cloud'
       AND id <> $2
       AND LOWER(COALESCE(status, '')) = 'active'`,
    [clinicId, keepChannelId]
  );
}

async function withOnboardingTransaction(fn) {
  return withTransaction(fn);
}

module.exports = {
  createOnboardingSession,
  expirePreviousPendingSessions,
  findOnboardingSessionByStateToken,
  findLatestOnboardingSessionByClinicId,
  markOnboardingSessionFailed,
  markOnboardingSessionPending,
  markOnboardingSessionCompleted,
  findWhatsAppChannelByPhoneNumberId,
  upsertWhatsAppChannel,
  deactivateOtherClinicWhatsAppChannels,
  withOnboardingTransaction
};
