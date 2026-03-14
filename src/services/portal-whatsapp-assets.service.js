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
  const graphMessage =
    result && result.data && result.data.error && result.data.error.message
      ? String(result.data.error.message)
      : null;

  if (result && (result.status === 401 || result.status === 403)) {
    return buildReason(
      'WHATSAPP_TOKEN_INVALID',
      'El Access Token no tiene permisos válidos para leer tus activos de WhatsApp en Meta.'
    );
  }

  if (result && (result.status === 400 || result.status === 404)) {
    return buildReason(
      'WABA_NOT_ACCESSIBLE',
      context === 'manual_connect'
        ? 'No pudimos acceder a la WABA indicada con ese token. Revisa que el WABA ID y el token correspondan a la misma cuenta.'
        : 'No pudimos acceder a una de las WABAs asociadas a ese token.'
    );
  }

  return buildReason(
    context === 'manual_connect' ? 'WHATSAPP_MANUAL_CONNECT_FAILED' : 'WHATSAPP_DISCOVERY_FAILED',
    graphMessage || 'Meta no devolvió una respuesta válida al listar los números de WhatsApp.'
  );
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
  normalizeWhatsAppAssetItem,
  listWhatsAppAssetsForWaba
};
