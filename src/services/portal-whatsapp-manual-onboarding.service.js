const crypto = require('crypto');
const { logInfo, logWarn } = require('../utils/logger');
const graphClient = require('../whatsapp/whatsapp-graph.client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  findWhatsAppChannelByPhoneNumberId,
  upsertWhatsAppChannel,
  deactivateOtherClinicWhatsAppChannels,
  withOnboardingTransaction
} = require('../repositories/whatsapp-onboarding.repository');

function normalizeString(value) {
  return String(value || '').trim();
}

function maskToken(value) {
  const safe = normalizeString(value);
  if (!safe) return null;
  if (safe.length <= 8) return `${safe.slice(0, 2)}***`;
  return `${safe.slice(0, 4)}***${safe.slice(-4)}`;
}

function buildReason(reason, detail = null, extra = null) {
  return {
    ok: false,
    reason,
    detail,
    ...(extra || {})
  };
}

async function fetchPhoneNumber(accessToken, phoneNumberId, requestId) {
  const result = await graphClient.request('GET', `/${phoneNumberId}`, {
    requestId,
    accessToken,
    query: {
      fields: 'id,display_phone_number,verified_name'
    }
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: 'meta_phone_number_not_accessible',
      detail:
        result.data && result.data.error && result.data.error.message
          ? String(result.data.error.message)
          : `No pudimos acceder al Phone Number ID (${result.status || 'unknown'}).`
    };
  }

  return {
    ok: true,
    data: result.data || null
  };
}

async function fetchWabaPhoneNumbers(accessToken, wabaId, requestId) {
  const result = await graphClient.request('GET', `/${wabaId}/phone_numbers`, {
    requestId,
    accessToken,
    query: {
      fields: 'id,display_phone_number,verified_name',
      limit: 200
    }
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: 'meta_waba_phone_numbers_not_accessible',
      detail:
        result.data && result.data.error && result.data.error.message
          ? String(result.data.error.message)
          : `No pudimos listar numeros de la WABA (${result.status || 'unknown'}).`
    };
  }

  return {
    ok: true,
    items: Array.isArray(result.data && result.data.data) ? result.data.data : []
  };
}

async function subscribeCurrentAppToWaba(accessToken, wabaId, requestId) {
  const result = await graphClient.request('POST', `/${wabaId}/subscribed_apps`, {
    requestId,
    accessToken
  });

  if (result.ok) {
    return { ok: true, alreadySubscribed: false, body: result.data || null };
  }

  const errorMessage = String((result.data && result.data.error && result.data.error.message) || '').toLowerCase();
  if (
    result.status === 400 &&
    (errorMessage.includes('already subscribed') || errorMessage.includes('already exists'))
  ) {
    return { ok: true, alreadySubscribed: true, body: result.data || null };
  }

  return {
    ok: false,
    status: result.status || null,
    body: result.data || null
  };
}

async function connectPortalWhatsAppManual(tenantId, payload) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para conectar el canal manualmente.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const wabaId = normalizeString(payload && payload.wabaId);
  const phoneNumberId = normalizeString(payload && payload.phoneNumberId);
  const accessToken = normalizeString(payload && payload.accessToken);
  const channelName = normalizeString(payload && payload.channelName) || null;

  if (!wabaId) {
    return buildReason('missing_waba_id', 'Necesitamos el WABA ID para validar tu cuenta de WhatsApp Business.', {
      tenantId: safeTenantId
    });
  }
  if (!phoneNumberId) {
    return buildReason('missing_phone_number_id', 'Necesitamos el Phone Number ID para validar el numero del canal.', {
      tenantId: safeTenantId
    });
  }
  if (!accessToken) {
    return buildReason('missing_access_token', 'Necesitamos un Access Token valido para revisar tu canal en Meta.', {
      tenantId: safeTenantId
    });
  }

  const requestId = `wa_manual_${crypto.randomUUID()}`;
  logInfo('portal_whatsapp_manual_connect_started', {
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    requestId,
    wabaId,
    phoneNumberId,
    accessToken: maskToken(accessToken)
  });

  const [phone, phoneNumbers] = await Promise.all([
    fetchPhoneNumber(accessToken, phoneNumberId, requestId),
    fetchWabaPhoneNumbers(accessToken, wabaId, requestId)
  ]);

  if (!phone.ok) {
    logWarn('portal_whatsapp_manual_connect_validation_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      reason: phone.reason,
      detail: phone.detail
    });
    return buildReason(phone.reason, phone.detail, { tenantId: safeTenantId });
  }
  if (!phoneNumbers.ok) {
    logWarn('portal_whatsapp_manual_connect_validation_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      reason: phoneNumbers.reason,
      detail: phoneNumbers.detail
    });
    return buildReason(phoneNumbers.reason, phoneNumbers.detail, { tenantId: safeTenantId });
  }

  const matchedPhone = phoneNumbers.items.find((item) => normalizeString(item.id) === phoneNumberId);
  if (!matchedPhone) {
    return buildReason(
      'phone_number_not_in_waba',
      'El Phone Number ID indicado no aparece dentro de la WABA validada con ese token.',
      { tenantId: safeTenantId }
    );
  }

  const existingChannel = await findWhatsAppChannelByPhoneNumberId(phoneNumberId);
  if (existingChannel && existingChannel.clinicId !== context.clinic.id) {
    logWarn('portal_whatsapp_manual_connect_cross_tenant_conflict', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      phoneNumberId,
      conflictingClinicId: existingChannel.clinicId
    });
    return buildReason(
      'channel_belongs_to_another_workspace',
      'Ese numero ya esta asociado a otro workspace y no se puede vincular manualmente.'
    );
  }

  const subscription = await subscribeCurrentAppToWaba(accessToken, wabaId, requestId);
  const persisted = await withOnboardingTransaction(async (client) => {
    const channel = await upsertWhatsAppChannel(
      {
        clinicId: context.clinic.id,
        phoneNumberId,
        wabaId,
        accessToken,
        displayPhoneNumber: normalizeString(matchedPhone.display_phone_number) || normalizeString(phone.data && phone.data.display_phone_number) || null,
        verifiedName: normalizeString(matchedPhone.verified_name) || normalizeString(phone.data && phone.data.verified_name) || channelName || null,
        status: subscription.ok ? 'active' : 'pending',
        connectionSource: 'manual_assisted',
        connectionMetadata: {
          onboardingProvider: 'manual_assisted',
          requestId,
          channelName,
          wabaName: null,
          subscriptionOk: subscription.ok,
          subscriptionAlreadyExisted: subscription.alreadySubscribed || false,
          subscriptionError: subscription.ok ? null : subscription.body || null
        }
      },
      client
    );

    await deactivateOtherClinicWhatsAppChannels(context.clinic.id, channel.id, client);
    return channel;
  });

  logInfo('portal_whatsapp_manual_connect_completed', {
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    requestId,
    channelId: persisted.id,
    phoneNumberId: persisted.phoneNumberId,
    wabaId: persisted.wabaId,
    status: persisted.status,
    subscriptionState: subscription.ok ? 'ok' : 'pending'
  });

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    status: subscription.ok ? 'connected' : 'pending_meta',
    channel: persisted,
      validation: {
        wabaName: null,
        displayPhoneNumber: normalizeString(matchedPhone.display_phone_number) || null,
        verifiedName: normalizeString(matchedPhone.verified_name) || null,
        subscriptionOk: subscription.ok
    }
  };
}

module.exports = {
  connectPortalWhatsAppManual
};
