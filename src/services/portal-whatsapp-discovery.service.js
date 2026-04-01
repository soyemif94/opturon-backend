const crypto = require('crypto');
const env = require('../config/env');
const graphClient = require('../whatsapp/whatsapp-graph.client');
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

function parseNextGraphPage(nextUrl) {
  const safeUrl = normalizeString(nextUrl);
  if (!safeUrl) return null;

  const parsed = new URL(safeUrl);
  const graphVersion = normalizeString(env.getWhatsAppGraphVersion());
  const versionPrefix = `/${graphVersion}`;
  const path = parsed.pathname.startsWith(versionPrefix)
    ? parsed.pathname.slice(versionPrefix.length) || '/'
    : parsed.pathname;

  const query = {};
  parsed.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  return {
    path,
    query
  };
}

async function fetchPaginatedGraph(path, accessToken, requestId, query = null) {
  const items = [];
  let nextPath = normalizeString(path);
  let nextQuery = query && typeof query === 'object' ? { ...query } : null;

  while (nextPath) {
    const result = await graphClient.request('GET', nextPath, {
      requestId,
      accessToken,
      query: nextQuery
    });

    if (!result.ok) {
      return {
        ok: false,
        result
      };
    }

    const pageItems = Array.isArray(result.data && result.data.data) ? result.data.data : [];
    items.push(...pageItems);

    const nextRef = parseNextGraphPage(result.data && result.data.paging && result.data.paging.next);
    nextPath = nextRef && nextRef.path ? nextRef.path : null;
    nextQuery = nextRef && nextRef.query ? nextRef.query : null;
  }

  return {
    ok: true,
    items
  };
}

async function discoverAssetsViaBusinesses(accessToken, requestId) {
  const businessesResult = await fetchPaginatedGraph('/me/businesses', accessToken, requestId, {
    fields: 'id,name'
  });

  if (!businessesResult.ok) {
    const meta = extractGraphErrorMeta(businessesResult.result);
    const reason = inferMetaDomainReason(meta, 'discovery');
    return buildReason(reason, buildMetaGraphDetail(reason, meta, 'discovery'), {
      graphStatus: meta.status,
      graphCode: meta.code,
      graphSubcode: meta.subcode,
      fbtraceId: meta.fbtraceId
    });
  }

  const businesses = businessesResult.items
    .map((item) => ({
      id: normalizeString(item && item.id) || null,
      name: normalizeString(item && item.name) || null
    }))
    .filter((item) => item.id);

  const discovered = [];
  let firstFailure = null;

  for (const business of businesses) {
    const wabasResult = await fetchPaginatedGraph(
      `/${business.id}/owned_whatsapp_business_accounts`,
      accessToken,
      requestId,
      {
        fields: 'id,name'
      }
    );

    if (!wabasResult.ok) {
      const meta = extractGraphErrorMeta(wabasResult.result);
      const reason = inferMetaDomainReason(meta, 'discovery');
      const detail = buildMetaGraphDetail(reason, meta, 'discovery');
      if (!firstFailure) {
        firstFailure = buildReason(reason, detail, {
          graphStatus: meta.status,
          graphCode: meta.code,
          graphSubcode: meta.subcode,
          fbtraceId: meta.fbtraceId
        });
      }
      logWarn('portal_whatsapp_discovery_fallback_business_failed', {
        requestId,
        businessId: business.id,
        reason,
        detail,
        graphStatus: meta.status,
        graphCode: meta.code,
        graphSubcode: meta.subcode,
        fbtraceId: meta.fbtraceId
      });
      continue;
    }

    const wabas = wabasResult.items
      .map((item) => ({
        id: normalizeString(item && item.id) || null,
        name: normalizeString(item && item.name) || null
      }))
      .filter((item) => item.id);

    for (const waba of wabas) {
      const numbers = await listWhatsAppAssetsForWaba(accessToken, waba.id, requestId, {
        context: 'discovery',
        wabaName: waba.name || null
      });
      if (!numbers.ok) {
        if (!firstFailure) firstFailure = numbers;
        logWarn('portal_whatsapp_discovery_fallback_waba_failed', {
          requestId,
          businessId: business.id,
          wabaId: waba.id,
          reason: numbers.reason,
          detail: numbers.detail
        });
        continue;
      }

      for (const item of numbers.items) {
        if (item) discovered.push(item);
      }
    }
  }

  const deduped = Array.from(
    new Map(discovered.map((item) => [`${item.wabaId}:${item.phoneNumberId}`, item])).values()
  );

  if (!deduped.length) {
    return firstFailure
      ? buildReason(firstFailure.reason, firstFailure.detail, {
          graphStatus: firstFailure.graphStatus || null,
          graphCode: firstFailure.graphCode || null,
          graphSubcode: firstFailure.graphSubcode || null,
          fbtraceId: firstFailure.fbtraceId || null
        })
      : buildReason(
          'meta_business_assets_not_found',
          'Meta no devolvio negocios, WABAs o numeros de WhatsApp accesibles para ese token.'
        );
  }

  return {
    ok: true,
    items: deduped,
    businessesCount: businesses.length
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

  const debugToken = await debugMetaAccessToken(accessToken, requestId);
  const canFallback =
    !debugToken.ok
      ? debugToken.reason === 'meta_debug_token_not_configured'
      : true;

  if (!debugToken.ok && !canFallback) {
    logWarn('portal_whatsapp_discovery_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      reason: debugToken.reason,
      detail: debugToken.detail,
      strategy: 'debug_token'
    });
    return {
      ...debugToken,
      tenantId: safeTenantId,
      clinicId: context.clinic.id
    };
  }

  const candidateWabaIds = debugToken.ok ? extractCandidateWabaIds(debugToken.data) : [];
  if (candidateWabaIds.length) {
    logInfo('portal_whatsapp_discovery_primary_path_used', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      strategy: 'debug_token_target_ids',
      wabaCount: candidateWabaIds.length
    });

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

    if (deduped.length) {
      logInfo('portal_whatsapp_discovery_completed', {
        tenantId: safeTenantId,
        clinicId: context.clinic.id,
        requestId,
        strategy: 'debug_token_target_ids',
        items: deduped.length
      });
      return {
        ok: true,
        tenantId: safeTenantId,
        clinicId: context.clinic.id,
        items: deduped
      };
    }

    if (firstFailure) {
      logWarn('portal_whatsapp_discovery_primary_path_empty', {
        tenantId: safeTenantId,
        clinicId: context.clinic.id,
        requestId,
        strategy: 'debug_token_target_ids',
        reason: firstFailure.reason,
        detail: firstFailure.detail
      });
    }
  } else {
    logInfo('portal_whatsapp_discovery_primary_path_used', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      strategy: debugToken.ok ? 'debug_token_target_ids_empty' : 'debug_token_unavailable',
      wabaCount: 0
    });
  }

  logInfo('portal_whatsapp_discovery_fallback_used', {
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    requestId,
    strategy: 'me_businesses_owned_wabas'
  });

  const fallback = await discoverAssetsViaBusinesses(accessToken, requestId);
  if (!fallback.ok) {
    logWarn('portal_whatsapp_discovery_fallback_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId,
      reason: fallback.reason,
      detail: fallback.detail,
      graphStatus: fallback.graphStatus || null,
      graphCode: fallback.graphCode || null,
      graphSubcode: fallback.graphSubcode || null,
      fbtraceId: fallback.fbtraceId || null
    });
    return {
      ...fallback,
      tenantId: safeTenantId,
      clinicId: context.clinic.id
    };
  }

  logInfo('portal_whatsapp_discovery_fallback_succeeded', {
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    requestId,
    strategy: 'me_businesses_owned_wabas',
    businesses: fallback.businessesCount || 0,
    items: fallback.items.length
  });

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    items: fallback.items
  };
}

module.exports = {
  discoverTenantWhatsAppAssets
};
