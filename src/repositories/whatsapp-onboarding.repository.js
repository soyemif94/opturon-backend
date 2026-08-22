const { query, withTransaction } = require('../db/client');
const { maybeDecryptSecret, maybeEncryptSecret } = require('../utils/secret-crypto');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function mapOnboardingSessionRecord(record) {
  if (!record || typeof record !== 'object') return record;

  return {
    ...record,
    metaCode: maybeDecryptSecret(record.metaCode),
    metaAccessToken: maybeDecryptSecret(record.metaAccessToken)
  };
}

function mapChannelRecord(record) {
  if (!record || typeof record !== 'object') return record;

  return {
    ...record,
    accessToken: maybeDecryptSecret(record.accessToken)
  };
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

  return mapOnboardingSessionRecord(result.rows[0] || null);
}

async function expirePreviousPendingSessions(clinicId, client = null) {
  await dbQuery(
    client,
    `UPDATE channel_onboarding_sessions
     SET status = 'expired',
         "errorCode" = CASE
           WHEN COALESCE("errorCode", '') = '' THEN 'embedded_signup_session_expired'
           ELSE "errorCode"
         END,
         "errorMessage" = CASE
           WHEN COALESCE("errorMessage", '') = '' THEN 'La sesion de conexion con Meta expiro antes de completarse.'
           ELSE "errorMessage"
         END,
         "updatedAt" = NOW()
     WHERE "clinicId" = $1
       AND status IN ('created', 'launching', 'awaiting_callback')
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

  return mapOnboardingSessionRecord(result.rows[0] || null);
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

  return mapOnboardingSessionRecord(result.rows[0] || null);
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

  return mapOnboardingSessionRecord(result.rows[0] || null);
}

async function updateOnboardingSessionStatus(sessionId, data, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE channel_onboarding_sessions
     SET status = COALESCE($2, status),
         "errorCode" = CASE
           WHEN $3::text = '__CLEAR__' THEN NULL
           ELSE COALESCE($3, "errorCode")
         END,
         "errorMessage" = CASE
           WHEN $4::text = '__CLEAR__' THEN NULL
           ELSE COALESCE($4, "errorMessage")
         END,
         metadata = COALESCE($5, metadata),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      sessionId,
      data.status || null,
      Object.prototype.hasOwnProperty.call(data, 'errorCode') ? data.errorCode : null,
      Object.prototype.hasOwnProperty.call(data, 'errorMessage') ? data.errorMessage : null,
      data.metadata || null
    ]
  );

  return mapOnboardingSessionRecord(result.rows[0] || null);
}

async function markOnboardingSessionCancelled(sessionId, data, client = null) {
  return updateOnboardingSessionStatus(
    sessionId,
    {
      status: 'cancelled',
      errorCode: data && Object.prototype.hasOwnProperty.call(data, 'errorCode') ? data.errorCode : null,
      errorMessage: data && Object.prototype.hasOwnProperty.call(data, 'errorMessage') ? data.errorMessage : null,
      metadata: data && data.metadata ? data.metadata : null
    },
    client
  );
}

async function markOnboardingSessionExpired(sessionId, data, client = null) {
  return updateOnboardingSessionStatus(
    sessionId,
    {
      status: 'expired',
      errorCode: data && Object.prototype.hasOwnProperty.call(data, 'errorCode') ? data.errorCode : null,
      errorMessage: data && Object.prototype.hasOwnProperty.call(data, 'errorMessage') ? data.errorMessage : null,
      metadata: data && data.metadata ? data.metadata : null
    },
    client
  );
}

async function markOnboardingSessionProcessing(sessionId, data, client = null) {
  return updateOnboardingSessionStatus(
    sessionId,
    {
      status: data.status,
      errorCode: Object.prototype.hasOwnProperty.call(data, 'errorCode') ? data.errorCode : '__CLEAR__',
      errorMessage: Object.prototype.hasOwnProperty.call(data, 'errorMessage') ? data.errorMessage : '__CLEAR__',
      metadata: data.metadata || null
    },
    client
  );
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
      maybeEncryptSecret(data.metaCode),
      maybeEncryptSecret(data.metaAccessToken),
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

  return mapOnboardingSessionRecord(result.rows[0] || null);
}

async function markOnboardingSessionCompleted(sessionId, data, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE channel_onboarding_sessions
     SET status = 'completed',
         "metaCode" = NULL,
         "metaAccessToken" = NULL,
         "metaTokenType" = NULL,
         "metaTokenExpiresAt" = NULL,
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
      null,
      null,
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

  return mapOnboardingSessionRecord(result.rows[0] || null);
}

async function findWhatsAppChannelByPhoneNumberId(phoneNumberId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT ch.id,
            ch."clinicId",
            ch.provider,
            ch."phoneNumberId",
            ch."wabaId",
            ch."accessToken",
            ch."displayPhoneNumber",
            ch."verifiedName",
            ch.status,
            ch."connectionSource",
            ch."connectionMetadata",
            ch."updatedAt",
            ch."createdAt",
            c."externalTenantId",
            c.name AS "clinicName"
     FROM channels ch
     LEFT JOIN clinics c ON c.id = ch."clinicId"
     WHERE ch."phoneNumberId" = $1
       AND ch.provider = 'whatsapp_cloud'
     LIMIT 1`,
    [phoneNumberId]
  );

  return mapChannelRecord(result.rows[0] || null);
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
      maybeEncryptSecret(input.accessToken),
      input.displayPhoneNumber || null,
      input.verifiedName || null,
      input.status || 'active',
      input.connectionSource || 'embedded_signup',
      input.connectionMetadata || null
    ]
  );

  return mapChannelRecord(result.rows[0] || null);
}

async function updateWhatsAppChannelAssetCredentials(channelId, clinicId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE channels
     SET "phoneNumberId" = $3,
         "wabaId" = $4,
         "accessToken" = $5,
         "displayPhoneNumber" = COALESCE($6, "displayPhoneNumber"),
         "verifiedName" = COALESCE($7, "verifiedName"),
         status = $8,
         "connectionSource" = $9,
         "connectionMetadata" = COALESCE($10, "connectionMetadata"),
         "updatedAt" = NOW()
     WHERE id = $1
       AND "clinicId" = $2
       AND provider = 'whatsapp_cloud'
     RETURNING id, "clinicId", provider, "phoneNumberId", "wabaId", "accessToken", "displayPhoneNumber", "verifiedName", status, "connectionSource", "connectionMetadata", "updatedAt", "createdAt"`,
    [
      channelId,
      clinicId,
      input.phoneNumberId,
      input.wabaId,
      maybeEncryptSecret(input.accessToken),
      input.displayPhoneNumber || null,
      input.verifiedName || null,
      input.status || 'active',
      input.connectionSource || 'manual_assisted',
      input.connectionMetadata || null
    ]
  );
  return mapChannelRecord(result.rows[0] || null);
}

async function reassignWhatsAppChannelToClinic(channelId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE channels
     SET "clinicId" = $2,
         "wabaId" = COALESCE($3, "wabaId"),
         "accessToken" = COALESCE($4, "accessToken"),
         "displayPhoneNumber" = COALESCE($5, "displayPhoneNumber"),
         "verifiedName" = COALESCE($6, "verifiedName"),
         status = $7,
         "connectionSource" = $8,
         "connectionMetadata" = COALESCE($9, "connectionMetadata"),
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, "clinicId", provider, "phoneNumberId", "wabaId", "accessToken", "displayPhoneNumber", "verifiedName", status, "connectionSource", "connectionMetadata", "updatedAt", "createdAt"`,
    [
      channelId,
      input.clinicId,
      input.wabaId || null,
      maybeEncryptSecret(input.accessToken),
      input.displayPhoneNumber || null,
      input.verifiedName || null,
      input.status || 'active',
      input.connectionSource || 'embedded_signup',
      input.connectionMetadata || null
    ]
  );

  return mapChannelRecord(result.rows[0] || null);
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
  markOnboardingSessionCancelled,
  markOnboardingSessionExpired,
  markOnboardingSessionProcessing,
  markOnboardingSessionPending,
  markOnboardingSessionCompleted,
  findWhatsAppChannelByPhoneNumberId,
  upsertWhatsAppChannel,
  updateWhatsAppChannelAssetCredentials,
  reassignWhatsAppChannelToClinic,
  deactivateOtherClinicWhatsAppChannels,
  withOnboardingTransaction
};
