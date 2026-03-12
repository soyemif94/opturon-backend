const crypto = require('crypto');
const env = require('../config/env');
const { logInfo, logWarn, logError } = require('../utils/logger');
const { resolvePortalTenantContext } = require('./portal-context.service');
const graphClient = require('../whatsapp/whatsapp-graph.client');
const {
  createOnboardingSession,
  expirePreviousPendingSessions,
  findOnboardingSessionByStateToken,
  findLatestOnboardingSessionByClinicId,
  markOnboardingSessionFailed,
  markOnboardingSessionPending,
  markOnboardingSessionCompleted,
  findWhatsAppChannelByPhoneNumberId,
  upsertWhatsAppChannel,
  deactivateOtherClinicWhatsAppChannels,
  withOnboardingTransaction
} = require('../repositories/whatsapp-onboarding.repository');

const DEFAULT_PROVIDER = 'meta_embedded_signup';
const DEFAULT_GRAPH_VERSION = String(env.whatsappApiVersion || env.whatsappGraphVersion || 'v25.0').trim();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildMetaConfigStatus() {
  const appId = String(env.whatsappAppId || '').trim();
  const appSecret = String(env.metaAppSecret || '').trim();

  return {
    appIdConfigured: Boolean(appId),
    appSecretConfigured: Boolean(appSecret),
    ready: Boolean(appId && appSecret)
  };
}

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString('hex');
}

function normalizeActorUserId(value) {
  const safeValue = String(value || '').trim();
  return UUID_PATTERN.test(safeValue) ? safeValue : null;
}

function redactToken(value) {
  const safeValue = String(value || '').trim();
  if (!safeValue) return null;
  if (safeValue.length <= 8) return `${safeValue.slice(0, 2)}***`;
  return `${safeValue.slice(0, 4)}***${safeValue.slice(-4)}`;
}

function summarizeCode(code) {
  const safeValue = String(code || '').trim();
  if (!safeValue) return null;
  return {
    preview: redactToken(safeValue),
    length: safeValue.length
  };
}

function summarizeMetaEvent(eventPayload) {
  if (!eventPayload) {
    return null;
  }

  return {
    eventName: eventPayload.eventName || null,
    businessId: eventPayload.businessId || null,
    wabaId: eventPayload.wabaId || null,
    phoneNumberId: eventPayload.phoneNumberId || null,
    errorCode: eventPayload.errorCode || null,
    errorMessage: eventPayload.errorMessage || null
  };
}

function withReason(reason, detail = null, extra = null) {
  return {
    ok: false,
    reason,
    detail,
    ...(extra || {})
  };
}

function parseEventPayload(rawPayload) {
  if (!rawPayload) return null;
  if (typeof rawPayload === 'object') return rawPayload;
  if (typeof rawPayload !== 'string') return null;

  try {
    return JSON.parse(rawPayload);
  } catch {
    return null;
  }
}

function normalizeMetaEventPayload(rawPayload) {
  const parsed = parseEventPayload(rawPayload);
  const payload = parsed && typeof parsed === 'object' ? parsed : {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;

  const eventName = String(payload.event || data.event || payload.type || '').trim().toUpperCase() || null;
  const businessId = String(
    data.business_id ||
      data.businessId ||
      data.business_account_id ||
      data.businessAccountId ||
      ''
  ).trim() || null;
  const wabaId = String(
    data.waba_id ||
      data.wabaId ||
      data.whatsapp_business_account_id ||
      data.whatsappBusinessAccountId ||
      ''
  ).trim() || null;
  const phoneNumberId = String(
    data.phone_number_id ||
      data.phoneNumberId ||
      data.business_phone_number_id ||
      data.businessPhoneNumberId ||
      ''
  ).trim() || null;
  const errorCode = String(data.error_code || data.errorCode || '').trim() || null;
  const errorMessage = String(data.error_message || data.errorMessage || '').trim() || null;

  return {
    raw: payload,
    eventName,
    businessId,
    wabaId,
    phoneNumberId,
    errorCode,
    errorMessage
  };
}

function isExpired(session) {
  if (!session || !session.expiresAt) return false;
  const expiresAt = new Date(session.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function summarizeSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status || null,
    externalTenantId: session.externalTenantId || null,
    clinicId: session.clinicId || null,
    stateToken: session.stateToken || null,
    channelId: session.channelId || null,
    wabaId: session.wabaId || null,
    phoneNumberId: session.phoneNumberId || null,
    displayPhoneNumber: session.displayPhoneNumber || null,
    verifiedName: session.verifiedName || null,
    errorCode: session.errorCode || null,
    errorMessage: session.errorMessage || null,
    completedAt: session.completedAt || null,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
    expiresAt: session.expiresAt || null
  };
}

function buildStatusPayload(context, session) {
  return {
    tenantId: context.tenantId,
    clinicId: context.clinic && context.clinic.id ? context.clinic.id : null,
    session: summarizeSession(session),
    onboardingState:
      session && session.status === 'completed'
        ? 'connected'
        : session && (session.status === 'launching' || session.status === 'pending_meta')
          ? 'pending_meta'
          : session && session.status === 'failed'
            ? 'error'
            : 'idle'
  };
}

async function exchangeMetaCodeForAccessToken({ code, redirectUri, requestId = null }) {
  const appId = String(env.whatsappAppId || '').trim();
  const appSecret = String(env.metaAppSecret || '').trim();

  if (!appId || !appSecret) {
    const error = new Error('meta_embedded_signup_credentials_missing');
    error.reason = 'meta_embedded_signup_credentials_missing';
    throw error;
  }

  logInfo('portal_whatsapp_embedded_signup_exchange_started', {
    requestId,
    redirectUri,
    code: summarizeCode(code)
  });

  const url = new URL(`https://graph.facebook.com/${DEFAULT_GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);

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

  if (!response.ok || !json || !json.access_token) {
    logWarn('portal_whatsapp_embedded_signup_exchange_failed', {
      requestId,
      status: response.status,
      redirectUri,
      code: summarizeCode(code),
      body: json
    });
    const error = new Error((json && json.error && json.error.message) || 'meta_oauth_exchange_failed');
    error.reason = 'meta_oauth_exchange_failed';
    error.status = response.status;
    error.body = json;
    error.requestId = requestId;
    throw error;
  }

  return {
    accessToken: String(json.access_token).trim(),
    tokenType: String(json.token_type || '').trim() || null,
    expiresIn: Number.isFinite(Number(json.expires_in)) ? Number(json.expires_in) : null,
    raw: json
  };
}

async function fetchAccessiblePhoneNumbers({ accessToken, wabaId, requestId = null }) {
  logInfo('portal_whatsapp_embedded_signup_phone_lookup_started', {
    requestId,
    wabaId,
    accessToken: redactToken(accessToken)
  });
  const result = await graphClient.request('GET', `/${wabaId}/phone_numbers`, {
    accessToken,
    requestId,
    apiVersion: DEFAULT_GRAPH_VERSION,
    query: {
      fields: 'id,display_phone_number,verified_name'
    }
  });

  if (!result.ok) {
    const error = new Error(
      (result.data && result.data.error && result.data.error.message) || 'meta_phone_numbers_lookup_failed'
    );
    error.reason = 'meta_phone_numbers_lookup_failed';
    error.graphStatus = result.status || null;
    error.body = result.data || null;
    throw error;
  }

  return Array.isArray(result.data && result.data.data) ? result.data.data : [];
}

async function debugMetaAccessToken({ accessToken, requestId = null }) {
  const appId = String(env.whatsappAppId || '').trim();
  const appSecret = String(env.metaAppSecret || '').trim();
  if (!appId || !appSecret) {
    return null;
  }

  const url = new URL(`https://graph.facebook.com/${DEFAULT_GRAPH_VERSION}/debug_token`);
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
    logWarn('meta_debug_token_failed', {
      requestId,
      status: response.status,
      body: json
    });
    return null;
  }

  return json.data;
}

async function resolveMetaAssets({ accessToken, metaPayload, requestId = null }) {
  const normalized = normalizeMetaEventPayload(metaPayload);
  let wabaId = normalized.wabaId;
  let phoneNumberId = normalized.phoneNumberId;
  let displayPhoneNumber = null;
  let verifiedName = null;

  if (!wabaId) {
    const debugToken = await debugMetaAccessToken({ accessToken, requestId });
    const granularScopes = Array.isArray(debugToken && debugToken.granular_scopes) ? debugToken.granular_scopes : [];
    const candidates = granularScopes
      .flatMap((scope) => (Array.isArray(scope.target_ids) ? scope.target_ids : []))
      .map((id) => String(id || '').trim())
      .filter(Boolean);

    if (candidates.length === 1) {
      wabaId = candidates[0];
    }
  }

  if (!wabaId) {
    const error = new Error('meta_waba_id_missing');
    error.reason = 'meta_waba_id_missing';
    throw error;
  }

  const phoneNumbers = await fetchAccessiblePhoneNumbers({ accessToken, wabaId, requestId });
  const normalizedPhoneNumbers = phoneNumbers.map((item) => ({
    id: String(item.id || '').trim() || null,
    displayPhoneNumber: String(item.display_phone_number || '').trim() || null,
    verifiedName: String(item.verified_name || '').trim() || null
  }));

  const matchedPhone =
    normalizedPhoneNumbers.find((item) => item.id && phoneNumberId && item.id === phoneNumberId) ||
    (normalizedPhoneNumbers.length === 1 ? normalizedPhoneNumbers[0] : null);

  if (!matchedPhone || !matchedPhone.id) {
    const error = new Error('meta_phone_number_id_missing');
    error.reason = 'meta_phone_number_id_missing';
    error.details = {
      wabaId,
      candidateCount: normalizedPhoneNumbers.length
    };
    throw error;
  }

  phoneNumberId = matchedPhone.id;
  displayPhoneNumber = matchedPhone.displayPhoneNumber || null;
  verifiedName = matchedPhone.verifiedName || null;

  return {
    businessId: normalized.businessId || null,
    wabaId,
    phoneNumberId,
    displayPhoneNumber,
    verifiedName,
    raw: normalized.raw
  };
}

async function subscribeCurrentAppToWaba({ accessToken, wabaId, requestId = null }) {
  const result = await graphClient.request('POST', `/${wabaId}/subscribed_apps`, {
    accessToken,
    requestId,
    apiVersion: DEFAULT_GRAPH_VERSION
  });

  if (result.ok) {
    return { ok: true, alreadySubscribed: false, body: result.data || null };
  }

  const errorMessage = String(
    (result.data && result.data.error && result.data.error.message) || ''
  ).toLowerCase();

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

async function createPortalWhatsAppSignupSession({ tenantId, redirectUri, actorUserId = null, metadata = null }) {
  const safeTenantId = String(tenantId || '').trim();
  const safeRedirectUri = String(redirectUri || '').trim();
  if (!safeTenantId) {
    return withReason('missing_tenant_id', 'No recibimos el tenantId para iniciar el onboarding con Meta.');
  }
  if (!safeRedirectUri) {
    return withReason('missing_redirect_uri', 'No recibimos la redirectUri para volver del popup de Meta.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok) {
    return context;
  }

  const metaConfig = buildMetaConfigStatus();

  const session = await withOnboardingTransaction(async (client) => {
    await expirePreviousPendingSessions(context.clinic.id, client);
    return createOnboardingSession(
      {
        clinicId: context.clinic.id,
        externalTenantId: safeTenantId,
        createdByUserId: normalizeActorUserId(actorUserId),
        redirectUri: safeRedirectUri,
        graphVersion: DEFAULT_GRAPH_VERSION,
        stateToken: randomToken(24),
        nonce: randomToken(16),
        metadata: metadata || null
      },
      client
    );
  });

  logInfo('portal_whatsapp_embedded_signup_bootstrap_created', {
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    sessionId: session && session.id ? session.id : null,
    stateToken: session && session.stateToken ? redactToken(session.stateToken) : null,
    redirectUri: safeRedirectUri,
    backendMetaReady: metaConfig.ready
  });

  if (!metaConfig.ready) {
    logWarn('portal_whatsapp_embedded_signup_config_missing', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      sessionId: session && session.id ? session.id : null,
      metaConfig
    });
  }

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    ready: true,
    status: 'launching',
    reason: context.reason,
    session: summarizeSession(session),
    backendMetaReady: metaConfig.ready
  };
}

async function getPortalWhatsAppSignupStatus(tenantId) {
  const safeTenantId = String(tenantId || '').trim();
  if (!safeTenantId) {
    return withReason('missing_tenant_id', 'No recibimos el tenantId para consultar el ultimo onboarding.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok) {
    return context;
  }

  const session = await findLatestOnboardingSessionByClinicId(context.clinic.id);
  logInfo('portal_whatsapp_embedded_signup_status_loaded', {
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    sessionId: session && session.id ? session.id : null,
    sessionStatus: session && session.status ? session.status : null
  });
  return {
    ok: true,
    ...buildStatusPayload(context, session)
  };
}

async function finalizePortalWhatsAppSignup({
  stateToken,
  code,
  redirectUri,
  metaPayload = null,
  requestId = null,
  error = null,
  errorDescription = null
}) {
  const safeStateToken = String(stateToken || '').trim();
  const safeCode = String(code || '').trim();
  const safeRedirectUri = String(redirectUri || '').trim();

  if (!safeStateToken) {
    return withReason('missing_state_token', 'No recibimos el state del onboarding para correlacionar el callback de Meta.');
  }

  const session = await findOnboardingSessionByStateToken(safeStateToken);
  if (!session) {
    return withReason('embedded_signup_session_not_found', 'No encontramos una sesion activa para el state recibido desde Meta.');
  }

  logInfo('portal_whatsapp_embedded_signup_callback_received', {
    tenantId: session.externalTenantId,
    clinicId: session.clinicId,
    sessionId: session.id,
    sessionStatus: session.status,
    stateToken: redactToken(safeStateToken),
    code: summarizeCode(safeCode),
    metaEvent: summarizeMetaEvent(normalizeMetaEventPayload(metaPayload))
  });

  if (session.status === 'completed') {
    return {
      ok: true,
      tenantId: session.externalTenantId,
      clinicId: session.clinicId,
      status: 'connected',
      channelId: session.channelId || null,
      session: summarizeSession(session)
    };
  }

  if (isExpired(session)) {
    await markOnboardingSessionFailed(session.id, {
      errorCode: 'embedded_signup_session_expired',
      errorMessage: 'La sesion de conexion con Meta expiro antes de finalizar.'
    });
    return withReason(
      'embedded_signup_session_expired',
      'La sesion de conexion con Meta ya habia expirado. Inicia de nuevo desde Integraciones.'
    );
  }

  if (error) {
    const failed = await markOnboardingSessionFailed(session.id, {
      errorCode: String(error).trim() || 'meta_embedded_signup_error',
      errorMessage: String(errorDescription || error).trim() || 'Meta devolvio un error al finalizar el Embedded Signup.',
      metadata: metaPayload || null
    });
    return withReason(
      failed && failed.errorCode ? failed.errorCode : 'meta_embedded_signup_error',
      failed && failed.errorMessage ? failed.errorMessage : 'Meta devolvio un error al finalizar el Embedded Signup.'
    );
  }

  if (!safeCode) {
    return withReason('missing_meta_code', 'Meta no devolvio el code de autorizacion necesario para finalizar la conexion.');
  }

  if (!safeRedirectUri || safeRedirectUri !== String(session.redirectUri || '').trim()) {
    return withReason(
      'embedded_signup_redirect_uri_mismatch',
      'La redirectUri del callback no coincide con la que inicio la sesion de onboarding.'
    );
  }

  try {
    const token = await exchangeMetaCodeForAccessToken({
      code: safeCode,
      redirectUri: safeRedirectUri,
      requestId
    });
    const assets = await resolveMetaAssets({
      accessToken: token.accessToken,
      metaPayload,
      requestId
    });

    logInfo('portal_whatsapp_embedded_signup_assets_resolved', {
      requestId,
      tenantId: session.externalTenantId,
      clinicId: session.clinicId,
      sessionId: session.id,
      businessId: assets.businessId,
      wabaId: assets.wabaId,
      phoneNumberId: assets.phoneNumberId,
      displayPhoneNumber: assets.displayPhoneNumber
    });

    const existingChannel = await findWhatsAppChannelByPhoneNumberId(assets.phoneNumberId);
    if (existingChannel && existingChannel.clinicId !== session.clinicId) {
      await markOnboardingSessionFailed(session.id, {
        errorCode: 'channel_belongs_to_another_workspace',
        errorMessage: 'El numero conectado ya esta asociado a otro workspace.',
        metadata: {
          phoneNumberId: assets.phoneNumberId,
          currentClinicId: existingChannel.clinicId
        }
      });
      logWarn('portal_whatsapp_embedded_signup_cross_tenant_conflict', {
        tenantId: session.externalTenantId,
        clinicId: session.clinicId,
        sessionId: session.id,
        phoneNumberId: assets.phoneNumberId,
        conflictingClinicId: existingChannel.clinicId
      });
      return withReason(
        'channel_belongs_to_another_workspace',
        'El numero conectado ya esta asociado a otro workspace y no se puede vincular automaticamente.'
      );
    }

    const subscription = await subscribeCurrentAppToWaba({
      accessToken: token.accessToken,
      wabaId: assets.wabaId,
      requestId
    });

    const persisted = await withOnboardingTransaction(async (client) => {
      const channelStatus = subscription.ok ? 'active' : 'pending';
      const channel = await upsertWhatsAppChannel(
        {
          clinicId: session.clinicId,
          phoneNumberId: assets.phoneNumberId,
          wabaId: assets.wabaId,
          accessToken: token.accessToken,
          displayPhoneNumber: assets.displayPhoneNumber,
          verifiedName: assets.verifiedName,
          status: channelStatus,
          connectionSource: 'embedded_signup',
          connectionMetadata: {
            onboardingProvider: DEFAULT_PROVIDER,
            businessId: assets.businessId,
            subscriptionOk: subscription.ok,
            subscriptionAlreadyExisted: subscription.alreadySubscribed || false
          }
        },
        client
      );

      await deactivateOtherClinicWhatsAppChannels(session.clinicId, channel.id, client);

      if (subscription.ok) {
        await markOnboardingSessionCompleted(
          session.id,
          {
            metaCode: safeCode,
            metaAccessToken: token.accessToken,
            metaTokenType: token.tokenType,
            metaTokenExpiresAt:
              token.expiresIn !== null ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null,
            metaBusinessId: assets.businessId,
            wabaId: assets.wabaId,
            phoneNumberId: assets.phoneNumberId,
            displayPhoneNumber: assets.displayPhoneNumber,
            verifiedName: assets.verifiedName,
            channelId: channel.id,
            metadata: {
              metaPayload: normalizeMetaEventPayload(metaPayload).raw,
              subscription: subscription.body || null
            }
          },
          client
        );
      } else {
        await markOnboardingSessionPending(
          session.id,
          {
            metaCode: safeCode,
            metaAccessToken: token.accessToken,
            metaTokenType: token.tokenType,
            metaTokenExpiresAt:
              token.expiresIn !== null ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null,
            metaBusinessId: assets.businessId,
            wabaId: assets.wabaId,
            phoneNumberId: assets.phoneNumberId,
            displayPhoneNumber: assets.displayPhoneNumber,
            verifiedName: assets.verifiedName,
            errorCode: 'meta_app_subscription_failed',
            errorMessage: 'No pudimos completar la suscripcion del canal en Meta. Revisa la configuracion de la app.',
            metadata: {
              metaPayload: normalizeMetaEventPayload(metaPayload).raw,
              subscription: subscription.body || null
            }
          },
          client
        );
      }

      return {
        channel,
        channelStatus
      };
    });

    const latestSession = await findOnboardingSessionByStateToken(safeStateToken);
    logInfo('portal_whatsapp_embedded_signup_finalize_succeeded', {
      requestId,
      tenantId: session.externalTenantId,
      clinicId: session.clinicId,
      sessionId: session.id,
      channelId: persisted.channel.id,
      channelStatus: persisted.channelStatus,
      phoneNumberId: persisted.channel.phoneNumberId,
      displayPhoneNumber: persisted.channel.displayPhoneNumber || null,
      subscriptionState: subscription.ok ? 'ok' : 'pending'
    });

    return {
      ok: true,
      tenantId: session.externalTenantId,
      clinicId: session.clinicId,
      status: persisted.channelStatus === 'active' ? 'connected' : 'pending_meta',
      channel: persisted.channel,
      session: summarizeSession(latestSession)
    };
  } catch (finalizeError) {
    const reason = String(finalizeError.reason || finalizeError.message || 'meta_embedded_signup_finalize_failed').trim();
    await markOnboardingSessionFailed(session.id, {
      errorCode: reason,
      errorMessage: String(finalizeError.message || reason).trim(),
      metadata: {
        body: finalizeError.body || null,
        details: finalizeError.details || null
      }
    });

    logError('portal_whatsapp_embedded_signup_finalize_failed', {
      tenantId: session.externalTenantId,
      clinicId: session.clinicId,
      sessionId: session.id,
      reason,
      error: finalizeError.message || null,
      status: finalizeError.status || null,
      graphStatus: finalizeError.graphStatus || null
    });

    return {
      ok: false,
      reason,
      detail: String(finalizeError.message || reason).trim()
    };
  }
}

module.exports = {
  createPortalWhatsAppSignupSession,
  getPortalWhatsAppSignupStatus,
  finalizePortalWhatsAppSignup,
  buildMetaConfigStatus
};
