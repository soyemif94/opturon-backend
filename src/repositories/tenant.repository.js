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
    `SELECT id, "clinicId", provider, "phoneNumberId", "wabaId", "accessToken", status
     FROM channels
     WHERE "phoneNumberId" = $1
     LIMIT 1`,
    [phoneNumberId]
  );

  return result.rows[0] || null;
}

async function findChannelById(channelId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", provider, "phoneNumberId", "wabaId", "accessToken", status
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
    `SELECT id, "clinicId", provider, "phoneNumberId", "wabaId", "accessToken", status
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
    `SELECT id, name, timezone, "externalTenantId"
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
    `SELECT id, "clinicId", provider, "phoneNumberId", "wabaId", "accessToken", status
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
    `SELECT id, "clinicId", provider, "phoneNumberId", "wabaId", "accessToken", status, "updatedAt", "createdAt"
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

module.exports = {
  findChannelByPhoneNumberId,
  findChannelById,
  findChannelByIdAndClinicId,
  findClinicByExternalTenantId,
  findPreferredWhatsAppChannelByClinicId,
  listWhatsAppChannelsByClinicId
};

