const env = require('../config/env');
const { query } = require('../db/client');
const { findChannelByPhoneNumberId } = require('../repositories/tenant.repository');

function summarizeChannel(channel) {
  if (!channel) return null;
  return {
    id: channel.id,
    clinicId: channel.clinicId,
    provider: channel.provider || null,
    phoneNumberId: channel.phoneNumberId || null,
    wabaId: channel.wabaId || null,
    status: channel.status || null
  };
}

async function listChannels() {
  const result = await query(
    `SELECT id, "clinicId", provider, "phoneNumberId", "wabaId", status, "updatedAt", "createdAt"
     FROM channels
     ORDER BY "updatedAt" DESC, "createdAt" DESC`,
    []
  );
  return result.rows;
}

async function listClinics() {
  const result = await query(
    `SELECT id, name, "createdAt"
     FROM clinics
     ORDER BY "createdAt" ASC`,
    []
  );
  return result.rows;
}

async function resolveClinicIdForConfiguredChannel(existingChannels) {
  const clinics = await listClinics();

  if (clinics.length === 1) {
    return { ok: true, clinicId: clinics[0].id, reason: 'single_clinic_found', clinics };
  }

  const distinctClinicIds = Array.from(new Set(existingChannels.map((channel) => channel.clinicId).filter(Boolean)));
  if (distinctClinicIds.length === 1) {
    return { ok: true, clinicId: distinctClinicIds[0], reason: 'single_clinic_in_channels', clinics };
  }

  if (clinics.length === 0) {
    return { ok: false, clinicId: null, reason: 'no_clinics_found', clinics };
  }

  return { ok: false, clinicId: null, reason: 'multiple_clinics_require_manual_mapping', clinics };
}

async function upsertConfiguredChannel(clinicId) {
  const result = await query(
    `INSERT INTO channels ("clinicId", provider, "phoneNumberId", "wabaId", "accessToken", status, "updatedAt")
     VALUES ($1, 'whatsapp_cloud', $2, $3, $4, 'active', NOW())
     ON CONFLICT ("phoneNumberId")
     DO UPDATE SET
       "clinicId" = EXCLUDED."clinicId",
       "wabaId" = COALESCE(EXCLUDED."wabaId", channels."wabaId"),
       "accessToken" = COALESCE(EXCLUDED."accessToken", channels."accessToken"),
       status = 'active',
       "updatedAt" = NOW()
     RETURNING id, "clinicId", provider, "phoneNumberId", "wabaId", status`,
    [clinicId, env.whatsappPhoneNumberId, env.whatsappWabaId || null, env.whatsappAccessToken || null]
  );

  return result.rows[0] || null;
}

async function updateExistingChannelMetadata(channel) {
  const configuredWabaId = String(env.whatsappWabaId || '').trim() || null;
  const configuredAccessToken = String(env.whatsappAccessToken || '').trim() || null;
  const currentWabaId = channel && channel.wabaId ? String(channel.wabaId).trim() : null;
  const needsWabaUpdate = configuredWabaId && configuredWabaId !== currentWabaId;
  const needsStatusUpdate = String(channel && channel.status ? channel.status : '').trim().toLowerCase() !== 'active';
  const needsAccessTokenUpdate = !!configuredAccessToken;

  if (!needsWabaUpdate && !needsStatusUpdate && !needsAccessTokenUpdate) {
    return {
      updated: false,
      channel
    };
  }

  const result = await query(
    `UPDATE channels
     SET "wabaId" = COALESCE($2, "wabaId"),
         "accessToken" = COALESCE($3, "accessToken"),
         status = 'active',
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, "clinicId", provider, "phoneNumberId", "wabaId", status`,
    [channel.id, configuredWabaId, configuredAccessToken]
  );

  return {
    updated: true,
    channel: result.rows[0] || channel
  };
}

async function getConfiguredChannelStatus(options = {}) {
  const requestId = options.requestId || null;
  const autoCreate = options.autoCreate === true;
  const configuredPhoneNumberId = String(env.whatsappPhoneNumberId || '').trim();

  if (!configuredPhoneNumberId) {
    return {
      ok: false,
      requestId,
      configuredPhoneNumberId: null,
      channel: null,
      reason: 'missing_env_phone_number_id',
      existingChannels: [],
      clinics: []
    };
  }

  const existingChannels = await listChannels();
  const matchedChannel = await findChannelByPhoneNumberId(configuredPhoneNumberId);

  if (matchedChannel) {
    const metadataSync = await updateExistingChannelMetadata(matchedChannel);
    return {
      ok: true,
      requestId,
      configuredPhoneNumberId,
      channel: summarizeChannel(metadataSync.channel),
      reason: metadataSync.updated ? 'matched_existing_channel_updated_metadata' : 'matched_existing_channel',
      autofixed: metadataSync.updated,
      existingChannels: existingChannels.map(summarizeChannel),
      clinics: []
    };
  }

  if (!autoCreate) {
    return {
      ok: false,
      requestId,
      configuredPhoneNumberId,
      channel: null,
      reason: 'no_channel_for_configured_phone_number_id',
      existingChannels: existingChannels.map(summarizeChannel),
      clinics: []
    };
  }

  const clinicResolution = await resolveClinicIdForConfiguredChannel(existingChannels);
  if (!clinicResolution.ok) {
    return {
      ok: false,
      requestId,
      configuredPhoneNumberId,
      channel: null,
      reason: clinicResolution.reason,
      existingChannels: existingChannels.map(summarizeChannel),
      clinics: clinicResolution.clinics || []
    };
  }

  const syncedChannel = await upsertConfiguredChannel(clinicResolution.clinicId);
  return {
    ok: true,
    requestId,
    configuredPhoneNumberId,
    channel: summarizeChannel(syncedChannel),
    reason: 'configured_channel_upserted',
    autofixed: true,
    existingChannels: existingChannels.map(summarizeChannel),
    clinics: clinicResolution.clinics || []
  };
}

module.exports = {
  getConfiguredChannelStatus
};
