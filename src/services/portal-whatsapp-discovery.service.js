const crypto = require('crypto');
const env = require('../config/env');
const graphClient = require('../whatsapp/whatsapp-graph.client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { logInfo, logWarn } = require('../utils/logger');

function normalizeString(value) {
  return String(value || '').trim();
}

function redactToken(value) {
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

async function debugMetaAccessToken(accessToken, requestId) {
  const appId = normalizeString(env.whatsappAppId);
  const appSecret = normalizeString(env.metaAppSecret);
  if (!appId || !appSecret) {
    return null;
  }

  const url = new URL(`https://graph.facebook.com/${normalizeString(env.whatsappApiVersion || env.whatsappGraphVersion || 'v25.0')}/debug_token`);
  url.searchParams.set('input_token', accessToken);
  url.searchParams.set('access_token', `${appId}|${appSecret}`);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok || !json || !json.data) {
    logWarn('portal_whatsapp_discovery_debug_token_failed', {
      requestId,
      status: response.status,
      body: json
    });
    return null;
  }

  return json.data;
}

function extractCandidateWabaIds(debugTokenData) {
  const granularScopes = Array.isArray(debugTokenData && debugTokenData.granular_scopes)
    ? debugTokenData.granular_scopes
    : [];

  const ids = new Set();
  for (const scope of granularScopes) {
    const targetIds = Array.isArray(scope && scope.target_ids) ? scope.target_ids : [];
    for (const targetId of targetIds) {
      const safe = normalizeString(targetId);
      if (safe) ids.add(safe);
    }
  }
  return Array.from(ids);
}

async function fetchWabaPhoneNumbers(accessToken, wabaId, requestId) {
  const result = await graphClient.request('GET', `/${wabaId}/phone_numbers`, {
    requestId,
    accessToken,
    query: {
      fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status',
      limit: 200
    }
  });

  if (!result.ok) {
    return {
      ok: false,
      reason:
        result.status === 401 || result.status === 403
          ? 'meta_access_denied'
          : result.status === 400
            ? 'meta_assets_not_found'
            : 'meta_discovery_failed',
      detail:
        result.data && result.data.error && result.data.error.message
          ? String(result.data.error.message)
          : `No pudimos listar numeros para la WABA ${wabaId}.`
    };
  }

  return {
    ok: true,
    items: Array.isArray(result.data && result.data.data) ? result.data.data : []
  };
}

function normalizeDiscoveryItem(wabaId, rawPhone) {
  const phoneNumberId = normalizeString(rawPhone && rawPhone.id);
  if (!phoneNumberId) return null;
  const displayPhoneNumber = normalizeString(rawPhone && rawPhone.display_phone_number) || null;
  const verifiedName = normalizeString(rawPhone && rawPhone.verified_name) || null;
  const qualityRating = rawPhone && rawPhone.quality_rating ? String(rawPhone.quality_rating) : null;
  const status = rawPhone && rawPhone.name_status ? String(rawPhone.name_status) : null;
  const label = [verifiedName || null, displayPhoneNumber || null].filter(Boolean).join(' · ') || phoneNumberId;

  return {
    wabaId,
    wabaName: null,
    phoneNumberId,
    displayPhoneNumber,
    verifiedName,
    qualityRating,
    status,
    label
  };
}

async function discoverTenantWhatsAppAssets(tenantId, payload) {
  const safeTenantId = normalizeString(tenantId);
  const accessToken = normalizeString(payload && payload.accessToken);

  if (!safeTenantId) {
    return buildReason('missing_tenant_id', 'No recibimos el tenant para descubrir activos de WhatsApp.');
  }
  if (!accessToken) {
    return buildReason('missing_access_token', 'Pega un Access Token valido para buscar tus cuentas de WhatsApp.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const requestId = `wa_discovery_${crypto.randomUUID()}`;
  logInfo('portal_whatsapp_discovery_started', {
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    requestId,
    accessToken: redactToken(accessToken)
  });

  const debugTokenData = await debugMetaAccessToken(accessToken, requestId);
  const candidateWabaIds = extractCandidateWabaIds(debugTokenData);

  if (!candidateWabaIds.length) {
    logInfo('portal_whatsapp_discovery_empty', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      candidateWabaIds: 0
    });
    return {
      ok: true,
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      items: []
    };
  }

  const discovered = [];
  for (const wabaId of candidateWabaIds) {
    const numbers = await fetchWabaPhoneNumbers(accessToken, wabaId, requestId);
    if (!numbers.ok) {
      logWarn('portal_whatsapp_discovery_waba_failed', {
        tenantId: safeTenantId,
        clinicId: context.clinic.id,
        requestId,
        wabaId,
        reason: numbers.reason,
        detail: numbers.detail
      });
      continue;
    }

    for (const rawPhone of numbers.items) {
      const item = normalizeDiscoveryItem(wabaId, rawPhone);
      if (item) discovered.push(item);
    }
  }

  const deduped = Array.from(
    new Map(discovered.map((item) => [`${item.wabaId}:${item.phoneNumberId}`, item])).values()
  );

  logInfo('portal_whatsapp_discovery_completed', {
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    requestId,
    items: deduped.length
  });

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    items: deduped
  };
}

module.exports = {
  discoverTenantWhatsAppAssets
};
