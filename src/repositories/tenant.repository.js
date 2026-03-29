const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function findChannelByPhoneNumberId(phoneNumberId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE "phoneNumberId" = $1
       AND provider = 'whatsapp_cloud'
       AND LOWER(COALESCE(status, '')) = 'active'
     LIMIT 1`,
    [phoneNumberId]
  );

  return result.rows[0] || null;
}

async function findChannelById(channelId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE id = $1
     LIMIT 1`,
    [channelId]
  );

  return result.rows[0] || null;
}

async function findChannelByIdAndClinicId(channelId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE id = $1
       AND "clinicId" = $2
     LIMIT 1`,
    [channelId, clinicId]
  );

  return result.rows[0] || null;
}

async function findClinicByExternalTenantId(externalTenantId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, name, timezone, "externalTenantId", settings
     FROM clinics
     WHERE "externalTenantId" = $1
     LIMIT 1`,
    [externalTenantId]
  );

  return result.rows[0] || null;
}

async function findPreferredWhatsAppChannelByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE "clinicId" = $1
       AND provider = 'whatsapp_cloud'
     ORDER BY
       CASE WHEN LOWER(COALESCE(status, '')) = 'active' THEN 0 ELSE 1 END,
       "updatedAt" DESC,
       "createdAt" DESC
     LIMIT 1`,
    [clinicId]
  );

  return result.rows[0] || null;
}

async function listWhatsAppChannelsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status, "updatedAt", "createdAt"
     FROM channels
     WHERE "clinicId" = $1
       AND provider = 'whatsapp_cloud'
     ORDER BY
       CASE WHEN LOWER(COALESCE(status, '')) = 'active' THEN 0 ELSE 1 END,
       "updatedAt" DESC,
       "createdAt" DESC`,
    [clinicId]
  );

  return result.rows;
}

async function findInstagramChannelByExternalId(externalId, client = null) {
  const safeExternalId = String(externalId || '').trim();
  if (!safeExternalId) return null;

  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE type = 'instagram'
       AND provider = 'instagram_graph'
       AND (
         "externalId" = $1
         OR "instagramUserId" = $1
       )
       AND LOWER(COALESCE(status, '')) = 'active'
     ORDER BY "updatedAt" DESC, "createdAt" DESC
     LIMIT 1`,
    [safeExternalId]
  );

  return result.rows[0] || null;
}

async function findInstagramChannelByPageId(pageId, client = null) {
  const safePageId = String(pageId || '').trim();
  if (!safePageId) return null;

  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE type = 'instagram'
       AND provider = 'instagram_graph'
       AND "externalPageId" = $1
       AND LOWER(COALESCE(status, '')) = 'active'
     ORDER BY "updatedAt" DESC, "createdAt" DESC
     LIMIT 1`,
    [safePageId]
  );

  return result.rows[0] || null;
}

async function listInstagramChannelsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status, "updatedAt", "createdAt"
     FROM channels
     WHERE "clinicId" = $1
       AND type = 'instagram'
       AND provider = 'instagram_graph'
     ORDER BY
       CASE WHEN LOWER(COALESCE(status, '')) = 'active' THEN 0 ELSE 1 END,
       "updatedAt" DESC,
       "createdAt" DESC`,
    [clinicId]
  );

  return result.rows;
}

async function upsertInstagramChannel(input, client = null) {
  const safeExternalId = String(input.externalId || input.instagramUserId || '').trim() || null;
  const safePageId = String(input.externalPageId || '').trim() || null;

  const existingResult =
    safeExternalId || safePageId
      ? await dbQuery(
          client,
          `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status, "updatedAt", "createdAt"
           FROM channels
           WHERE type = 'instagram'
             AND provider = 'instagram_graph'
             AND (
               ($1::text IS NOT NULL AND ("externalId" = $1 OR "instagramUserId" = $1))
               OR ($2::text IS NOT NULL AND "externalPageId" = $2)
             )
           ORDER BY
             CASE WHEN LOWER(COALESCE(status, '')) = 'active' THEN 0 ELSE 1 END,
             "updatedAt" DESC,
             "createdAt" DESC
           LIMIT 1`,
          [safeExternalId, safePageId]
        )
      : null;
  const existing = existingResult && existingResult.rows ? existingResult.rows[0] || null : null;

  if (existing) {
    if (existing.clinicId && input.clinicId && existing.clinicId !== input.clinicId) {
      const error = new Error('instagram_channel_already_bound_to_other_clinic');
      error.code = 'INSTAGRAM_CHANNEL_CROSS_CLINIC_CONFLICT';
      error.details = {
        existingChannelId: existing.id,
        existingClinicId: existing.clinicId,
        targetClinicId: input.clinicId,
        externalId: safeExternalId,
        externalPageId: safePageId
      };
      throw error;
    }

    const result = await dbQuery(
      client,
      `UPDATE channels
       SET type = 'instagram',
           provider = 'instagram_graph',
           "externalId" = COALESCE($2, "externalId"),
           "externalPageId" = COALESCE($3, "externalPageId"),
           "externalPageName" = COALESCE($4, "externalPageName"),
           "instagramUserId" = COALESCE($5, "instagramUserId"),
           "instagramUsername" = COALESCE($6, "instagramUsername"),
           "accessToken" = COALESCE($7, "accessToken"),
           status = $8,
           "connectionSource" = COALESCE($9, "connectionSource"),
           "connectionMetadata" = COALESCE($10, "connectionMetadata"),
           "updatedAt" = NOW()
       WHERE id = $1
       RETURNING id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status, "updatedAt", "createdAt"`,
      [
        existing.id,
        safeExternalId,
        safePageId,
        input.externalPageName || null,
        String(input.instagramUserId || '').trim() || null,
        String(input.instagramUsername || '').trim() || null,
        input.accessToken || null,
        input.status || 'active',
        input.connectionSource || 'instagram_oauth',
        input.connectionMetadata || null
      ]
    );

    return result.rows[0] || null;
  }

  const result = await dbQuery(
    client,
    `INSERT INTO channels (
      "clinicId",
      type,
      provider,
      "phoneNumberId",
      "externalId",
      "externalPageId",
      "externalPageName",
      "instagramUserId",
      "instagramUsername",
      "accessToken",
      status,
      "connectionSource",
      "connectionMetadata",
      "updatedAt"
    )
    VALUES ($1, 'instagram', 'instagram_graph', NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
    RETURNING id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status, "updatedAt", "createdAt"`,
    [
      input.clinicId,
      safeExternalId,
      safePageId,
      input.externalPageName || null,
      String(input.instagramUserId || '').trim() || null,
      String(input.instagramUsername || '').trim() || null,
      input.accessToken || null,
      input.status || 'active',
      input.connectionSource || 'instagram_oauth',
      input.connectionMetadata || null
    ]
  );

  return result.rows[0] || null;
}

async function getClinicBusinessProfileById(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            name,
            timezone,
            "externalTenantId",
            settings,
            settings -> 'businessProfile' AS "businessProfile"
     FROM clinics
     WHERE id = $1
     LIMIT 1`,
    [clinicId]
  );

  return result.rows[0] || null;
}

async function getClinicWhatsAppSettingsById(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            name,
            timezone,
            "externalTenantId",
            settings,
            settings -> 'whatsapp' AS "whatsappSettings",
            settings -> 'whatsapp' ->> 'defaultChannelId' AS "defaultWhatsAppChannelId"
     FROM clinics
     WHERE id = $1
     LIMIT 1`,
    [clinicId]
  );

  return result.rows[0] || null;
}

async function updateClinicWhatsAppDefaultChannelId(clinicId, defaultChannelId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE clinics
     SET settings = jsonb_set(
       jsonb_set(
         (
           (
             COALESCE(settings, '{}'::jsonb)
             #- '{portal,defaultWhatsAppChannelId}'
           )
           #- '{portal,selectedWhatsAppChannelId}'
         )
         #- '{whatsapp,primaryChannelId}',
         '{whatsapp}',
         COALESCE(
           CASE
             WHEN jsonb_typeof(settings -> 'whatsapp') = 'object' THEN settings -> 'whatsapp'
             ELSE '{}'::jsonb
           END,
           '{}'::jsonb
         ),
         true
       ),
       '{whatsapp,defaultChannelId}',
       to_jsonb($2::text),
       true
     ),
     "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id,
               name,
               timezone,
               "externalTenantId",
               settings,
               settings -> 'whatsapp' AS "whatsappSettings",
               settings -> 'whatsapp' ->> 'defaultChannelId' AS "defaultWhatsAppChannelId"`,
    [clinicId, defaultChannelId]
  );

  return result.rows[0] || null;
}

async function updateClinicBusinessProfileById(clinicId, businessProfile, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE clinics
     SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb),
       '{businessProfile}',
       $2::jsonb,
       true
     ),
     "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id,
               name,
               timezone,
               "externalTenantId",
               settings,
               settings -> 'businessProfile' AS "businessProfile"`,
    [clinicId, JSON.stringify(businessProfile || {})]
  );

  return result.rows[0] || null;
}

module.exports = {
  findChannelByPhoneNumberId,
  findChannelById,
  findChannelByIdAndClinicId,
  findClinicByExternalTenantId,
  findPreferredWhatsAppChannelByClinicId,
  listWhatsAppChannelsByClinicId,
  findInstagramChannelByExternalId,
  findInstagramChannelByPageId,
  listInstagramChannelsByClinicId,
  upsertInstagramChannel,
  getClinicWhatsAppSettingsById,
  updateClinicWhatsAppDefaultChannelId,
  getClinicBusinessProfileById,
  updateClinicBusinessProfileById
};

