const crypto = require('crypto');
const env = require('../config/env');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { logInfo, logWarn } = require('../utils/logger');
const {
  normalizeString,
  buildReason,
  listWhatsAppAssetsForWaba
} = require('./portal-whatsapp-assets.service');

function redactToken(value) {
  const safe = normalizeString(value);
  if (!safe) return null;
  if (safe.length <= 8) return `${safe.slice(0, 2)}***`;
  return `${safe.slice(0, 4)}***${safe.slice(-4)}`;
}

async function debugMetaAccessToken(accessToken, requestId) {
  const appId = normalizeString(env.whatsappAppId);
  const appSecret = normalizeString(env.metaAppSecret);
  if (!appId || !appSecret) {
    return null;
  }

  const url = new URL(
    `https://graph.facebook.com/${normalizeString(env.whatsappApiVersion || env.whatsappGraphVersion || 'v25.0')}/debug_token`
  );
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
      reason: 'WHATSAPP_DISCOVERY_EMPTY',
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
    const numbers = await listWhatsAppAssetsForWaba(accessToken, wabaId, requestId, {
      context: 'discovery'
    });
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

    for (const item of numbers.items) {
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
