const crypto = require('crypto');
const { logInfo, logWarn } = require('../utils/logger');
const graphClient = require('../whatsapp/whatsapp-graph.client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  findWhatsAppChannelByPhoneNumberId,
  upsertWhatsAppChannel,
  updateWhatsAppChannelAssetCredentials,
  reassignWhatsAppChannelToClinic,
  deactivateOtherClinicWhatsAppChannels,
  withOnboardingTransaction
} = require('../repositories/whatsapp-onboarding.repository');
const {
  normalizeString,
  buildReason,
  extractGraphErrorMeta,
  inferMetaDomainReason,
  buildMetaGraphDetail,
  listWhatsAppAssetsForWaba
} = require('./portal-whatsapp-assets.service');

function tokenDiagnostic(value) {
  const safe = normalizeString(value);
  return {
    present: Boolean(safe),
    length: safe.length,
    fingerprint: safe ? crypto.createHash('sha256').update(safe).digest('hex').slice(0, 12) : null
  };
}

function buildSafeChannelPayload(channel) {
  if (!channel) return null;
  return {
    id: channel.id || null,
    clinicId: channel.clinicId || null,
    provider: channel.provider || 'whatsapp_cloud',
    phoneNumberId: channel.phoneNumberId || null,
    wabaId: channel.wabaId || null,
    displayPhoneNumber: channel.displayPhoneNumber || null,
    verifiedName: channel.verifiedName || null,
    status: channel.status || null,
    connectionSource: channel.connectionSource || null,
    connectionMetadata: channel.connectionMetadata || null,
    updatedAt: channel.updatedAt || null,
    createdAt: channel.createdAt || null
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
    body: result.data || null,
    meta: extractGraphErrorMeta(result)
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
    token: tokenDiagnostic(accessToken)
  });

  const numbers = await listWhatsAppAssetsForWaba(accessToken, wabaId, requestId, {
    context: 'manual_connect'
  });

  if (!numbers.ok) {
    logWarn('portal_whatsapp_manual_connect_validation_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      reason: numbers.reason,
      detail: numbers.detail
    });
    return buildReason(numbers.reason, numbers.detail, { tenantId: safeTenantId });
  }

  const matchedPhone = numbers.items.find((item) => normalizeString(item.phoneNumberId) === phoneNumberId);
  if (!matchedPhone) {
    logWarn('portal_whatsapp_manual_connect_phone_validation_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      wabaId,
      phoneNumberId,
      availablePhones: numbers.items.length
    });
    return buildReason(
      'meta_phone_number_waba_mismatch',
      'El Phone Number ID seleccionado no pertenece a la WABA validada con ese token.',
      { tenantId: safeTenantId }
    );
  }

  let channelAction = 'created';
  const currentChannel = context.channel && context.channel.id ? context.channel : null;
  const existingChannel = await findWhatsAppChannelByPhoneNumberId(phoneNumberId);
  if (existingChannel) {
    if (currentChannel && existingChannel.clinicId === context.clinic.id && existingChannel.id !== currentChannel.id) {
      return buildReason(
        'whatsapp_channel_duplicate_asset_conflict',
        'El Phone Number ID ya pertenece a otro channel del mismo workspace. El cutover requiere revisión manual.',
        { tenantId: safeTenantId }
      );
    }
    if (existingChannel.clinicId === context.clinic.id) {
      channelAction = String(existingChannel.status || '').trim().toLowerCase() === 'active' ? 'reconnected' : 'repaired';
    } else if (
      existingChannel.externalTenantId &&
      normalizeString(existingChannel.externalTenantId) !== safeTenantId
    ) {
      logWarn('portal_whatsapp_manual_connect_cross_tenant_conflict', {
        tenantId: safeTenantId,
        clinicId: context.clinic.id,
        requestId,
        phoneNumberId,
        conflictingClinicId: existingChannel.clinicId,
        conflictingTenantId: existingChannel.externalTenantId
      });
      return buildReason(
        'WHATSAPP_CHANNEL_ALREADY_CONNECTED',
        'Ese numero ya esta asociado a otro workspace y no se puede vincular manualmente.'
      );
    } else {
      channelAction = 'repaired';
      logInfo('portal_whatsapp_manual_connect_repairing_channel', {
        tenantId: safeTenantId,
        clinicId: context.clinic.id,
        requestId,
        phoneNumberId,
        previousClinicId: existingChannel.clinicId,
        previousTenantId: existingChannel.externalTenantId || null
      });
    }
  }

  if (!existingChannel && currentChannel) {
    channelAction = 'cutover';
  }

  const subscription = await subscribeCurrentAppToWaba(accessToken, wabaId, requestId);
  if (!subscription.ok) {
    const meta = subscription.meta || null;
    const reason = inferMetaDomainReason(meta, 'subscription');
    const detail = buildMetaGraphDetail(reason, meta, 'subscription');

    logWarn('portal_whatsapp_manual_connect_subscription_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      wabaId,
      phoneNumberId,
      reason,
      detail,
      graphStatus: meta && meta.status ? meta.status : null,
      graphCode: meta && meta.code ? meta.code : null,
      graphSubcode: meta && meta.subcode ? meta.subcode : null,
      fbtraceId: meta && meta.fbtraceId ? meta.fbtraceId : null
    });

    return buildReason(reason, detail, {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      graphStatus: meta && meta.status ? meta.status : null,
      graphCode: meta && meta.code ? meta.code : null,
      graphSubcode: meta && meta.subcode ? meta.subcode : null,
      fbtraceId: meta && meta.fbtraceId ? meta.fbtraceId : null
    });
  }

  const persisted = await withOnboardingTransaction(async (client) => {
    const nextChannelData = {
      clinicId: context.clinic.id,
      phoneNumberId,
      wabaId,
      accessToken,
      displayPhoneNumber: matchedPhone.displayPhoneNumber || null,
      verifiedName: matchedPhone.verifiedName || channelName || null,
      status: 'active',
      connectionSource: 'manual_assisted',
      connectionMetadata: {
        onboardingProvider: 'manual_assisted',
        requestId,
        channelName,
        wabaName: matchedPhone.wabaName || null,
        subscriptionOk: true,
        subscriptionAlreadyExisted: subscription.alreadySubscribed || false,
        subscriptionError: null,
        channelAction
      }
    };

    const channel = channelAction === 'cutover'
      ? await updateWhatsAppChannelAssetCredentials(currentChannel.id, context.clinic.id, nextChannelData, client)
      : existingChannel && existingChannel.clinicId !== context.clinic.id && channelAction === 'repaired'
        ? await reassignWhatsAppChannelToClinic(existingChannel.id, nextChannelData, client)
        : await upsertWhatsAppChannel(nextChannelData, client);

    if (!channel) {
      throw new Error('whatsapp_channel_cutover_target_not_found');
    }

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
    subscriptionState: 'ok',
    channelAction
  });

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    status: 'connected',
    channelAction,
    channel: buildSafeChannelPayload(persisted),
    validation: {
      wabaName: matchedPhone.wabaName || null,
      displayPhoneNumber: matchedPhone.displayPhoneNumber || null,
      verifiedName: matchedPhone.verifiedName || null,
      subscriptionOk: true
    }
  };
}

module.exports = {
  connectPortalWhatsAppManual
};
