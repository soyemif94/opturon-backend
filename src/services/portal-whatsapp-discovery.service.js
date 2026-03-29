const crypto = require('crypto');
const env = require('../config/env');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { logInfo, logWarn } = require('../utils/logger');
const {
  normalizeString,
  buildReason,
  extractGraphErrorMeta,
  inferMetaDomainReason,
  buildMetaGraphDetail,
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
    return buildReason(
      'meta_debug_token_not_configured',
      'Faltan credenciales internas de Meta para validar el Access Token recibido.'
    );
  }

  const url = new URL(
    `https://graph.facebook.com/${normalizeString(env.getWhatsAppGraphVersion())}/debug_token`
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
    const meta = extractGraphErrorMeta({ status: response.status, data: json });
    const reason = inferMetaDomainReason(meta, 'discovery');
    logWarn('portal_whatsapp_discovery_debug_token_failed', {
      requestId,
      status: response.status,
      reason,
      fbtraceId: meta.fbtraceId,
      graphCode: meta.code,
      graphSubcode: meta.subcode
    });
    return buildReason(reason, buildMetaGraphDetail(reason, meta, 'discovery'), {
      graphStatus: meta.status,
      graphCode: meta.code,
      graphSubcode: meta.subcode,
      fbtraceId: meta.fbtraceId
    });
  }

  return {
    ok: true,
    data: json.data
  };
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

  const debugToken = await debugMetaAccessToken(accessToken, requestId);
  if (!debugToken.ok) {
    logWarn('portal_whatsapp_discovery_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      reason: debugToken.reason,
      detail: debugToken.detail
    });
    return {
      ...debugToken,
      tenantId: safeTenantId,
      clinicId: context.clinic.id
    };
  }

  const candidateWabaIds = extractCandidateWabaIds(debugToken.data);

  if (!candidateWabaIds.length) {
    logWarn('portal_whatsapp_discovery_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      reason: 'meta_business_assets_not_found',
      candidateWabaIds: 0
    });
    return buildReason(
      'meta_business_assets_not_found',
      'El token no expone WABAs accesibles para esta app. Revisa permisos y acceso al Business Manager.',
      {
        tenantId: safeTenantId,
        clinicId: context.clinic.id
      }
    );
  }

  const discovered = [];
  let firstFailure = null;
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
      if (!firstFailure) firstFailure = numbers;
      continue;
    }

    for (const item of numbers.items) {
      if (item) discovered.push(item);
    }
  }

  const deduped = Array.from(
    new Map(discovered.map((item) => [`${item.wabaId}:${item.phoneNumberId}`, item])).values()
  );

  if (!deduped.length) {
    const failure = firstFailure
      ? buildReason(firstFailure.reason, firstFailure.detail, {
          tenantId: safeTenantId,
          clinicId: context.clinic.id,
          graphStatus: firstFailure.graphStatus || null,
          graphCode: firstFailure.graphCode || null,
          graphSubcode: firstFailure.graphSubcode || null,
          fbtraceId: firstFailure.fbtraceId || null
        })
      : buildReason(
          'meta_business_assets_not_found',
          'Meta no devolvio numeros de WhatsApp accesibles para el token recibido.',
          {
            tenantId: safeTenantId,
            clinicId: context.clinic.id
          }
        );

    logWarn('portal_whatsapp_discovery_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      reason: failure.reason,
      detail: failure.detail
    });
    return failure;
  }

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
