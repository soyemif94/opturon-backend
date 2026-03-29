const graphClient = require('../whatsapp/whatsapp-graph.client');

function normalizeString(value) {
  return String(value || '').trim();
}

function buildReason(reason, detail = null, extra = null) {
  return {
    ok: false,
    reason,
    detail,
    ...(extra || {})
  };
}

function extractGraphErrorMeta(result) {
  const error = result && result.data && result.data.error ? result.data.error : null;
  return {
    status: result && Number.isFinite(Number(result.status)) ? Number(result.status) : null,
    code: error && Number.isFinite(Number(error.code)) ? Number(error.code) : null,
    subcode:
      error && Number.isFinite(Number(error.error_subcode)) ? Number(error.error_subcode) : null,
    message: error && error.message ? String(error.message).trim() : null,
    fbtraceId: error && error.fbtrace_id ? String(error.fbtrace_id).trim() : null
  };
}

function inferMetaDomainReason(meta, context = 'discovery') {
  const message = String((meta && meta.message) || '').toLowerCase();
  const status = meta && Number.isFinite(Number(meta.status)) ? Number(meta.status) : null;
  const code = meta && Number.isFinite(Number(meta.code)) ? Number(meta.code) : null;

  if (code === 190 || status === 401) {
    return 'meta_invalid_access_token';
  }

  if (
    status === 403 ||
    message.includes('permission') ||
    message.includes('permissions') ||
    message.includes('not authorized') ||
    message.includes('does not have permission') ||
    message.includes('requires pages') ||
    message.includes('requires whatsapp_business_management')
  ) {
    return 'meta_insufficient_permissions';
  }

  if (context === 'subscription') {
    return 'meta_app_subscription_failed';
  }

  if (status === 400 || status === 404) {
    return 'meta_waba_not_accessible';
  }

  if (context === 'manual_connect') {
    return 'meta_manual_connect_validation_failed';
  }

  if (context === 'discovery') {
    return 'meta_business_assets_not_found';
  }

  return 'meta_graph_request_failed';
}

function buildMetaGraphDetail(reason, meta, context = 'discovery') {
  const graphMessage = meta && meta.message ? meta.message : null;

  if (reason === 'meta_invalid_access_token') {
    return 'El Access Token de Meta no es valido o ya expiro. Genera uno nuevo con acceso a WhatsApp Business.';
  }

  if (reason === 'meta_insufficient_permissions') {
    return context === 'discovery'
      ? 'El token no tiene permisos suficientes para listar tus activos de WhatsApp Business en Meta.'
      : context === 'subscription'
        ? 'La app no tiene permisos suficientes para suscribirse a la WABA en Meta.'
        : 'El token no tiene permisos suficientes para validar la WABA y el numero seleccionados.';
  }

  if (reason === 'meta_waba_not_accessible') {
    return context === 'manual_connect'
      ? 'No pudimos acceder a la WABA indicada con ese token. Revisa que el WABA ID y el token correspondan a la misma cuenta.'
      : 'No pudimos acceder a una de las WABAs asociadas al token recibido.';
  }

  if (reason === 'meta_app_subscription_failed') {
    return 'No pudimos suscribir la app actual a la WABA en Meta. Revisa la configuracion de la app y sus permisos.';
  }

  if (reason === 'meta_business_assets_not_found') {
    return graphMessage || 'Meta no devolvio WABAs o numeros de WhatsApp accesibles para ese token.';
  }

  if (reason === 'meta_manual_connect_validation_failed') {
    return graphMessage || 'Meta rechazo la validacion manual del canal de WhatsApp.';
  }

  return graphMessage || 'Meta no devolvio una respuesta valida al consultar los activos de WhatsApp.';
}

function buildLabel(verifiedName, displayPhoneNumber, phoneNumberId) {
  return [verifiedName || null, displayPhoneNumber || null].filter(Boolean).join(' · ') || phoneNumberId;
}

function normalizeWhatsAppAssetItem(wabaId, rawPhone, overrides = null) {
  const phoneNumberId = normalizeString(rawPhone && rawPhone.id);
  if (!phoneNumberId) return null;

  const displayPhoneNumber = normalizeString(rawPhone && rawPhone.display_phone_number) || null;
  const verifiedName = normalizeString(rawPhone && rawPhone.verified_name) || null;
  const qualityRating = rawPhone && rawPhone.quality_rating ? String(rawPhone.quality_rating) : null;
  const status =
    normalizeString(rawPhone && (rawPhone.name_status || rawPhone.code_verification_status || rawPhone.status)) || null;

  return {
    wabaId,
    wabaName: normalizeString(overrides && overrides.wabaName) || null,
    phoneNumberId,
    displayPhoneNumber,
    verifiedName,
    qualityRating,
    status,
    label: buildLabel(verifiedName, displayPhoneNumber, phoneNumberId)
  };
}

function mapPhoneNumbersGraphFailure(result, context = 'discovery') {
  const meta = extractGraphErrorMeta(result);
  const reason = inferMetaDomainReason(meta, context);
  return buildReason(reason, buildMetaGraphDetail(reason, meta, context), {
    graphStatus: meta.status,
    graphCode: meta.code,
    graphSubcode: meta.subcode,
    fbtraceId: meta.fbtraceId
  });
}

async function listWhatsAppAssetsForWaba(accessToken, wabaId, requestId, options = {}) {
  const safeWabaId = normalizeString(wabaId);
  const result = await graphClient.request('GET', `/${safeWabaId}/phone_numbers`, {
    requestId,
    accessToken,
    query: {
      fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status',
      limit: 200
    }
  });

  if (!result.ok) {
    return mapPhoneNumbersGraphFailure(result, options.context || 'discovery');
  }

  const items = Array.isArray(result.data && result.data.data) ? result.data.data : [];

  return {
    ok: true,
    items: items
      .map((item) => normalizeWhatsAppAssetItem(safeWabaId, item, options))
      .filter(Boolean)
  };
}

module.exports = {
  normalizeString,
  buildReason,
  extractGraphErrorMeta,
  inferMetaDomainReason,
  buildMetaGraphDetail,
  normalizeWhatsAppAssetItem,
  listWhatsAppAssetsForWaba
};
