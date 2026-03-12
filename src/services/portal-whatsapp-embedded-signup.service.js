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
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
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
    return { ok: false, reason: 'missing_tenant_id' };
  }
  if (!safeRedirectUri) {
    return { ok: false, reason: 'missing_redirect_uri' };
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok) {
    return context;
  }

  const metaConfig = buildMetaConfigStatus();
  if (!metaConfig.ready) {
    return {
      ok: true,
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      ready: false,
      status: 'pending_meta',
      reason: 'meta_embedded_signup_credentials_missing',
      session: null
    };
  }

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
    sessionId: session && session.id ? session.id : null
  });

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    ready: true,
    status: 'launching',
    reason: context.reason,
    session: summarizeSession(session)
  };
}

async function getPortalWhatsAppSignupStatus(tenantId) {
  const safeTenantId = String(tenantId || '').trim();
  if (!safeTenantId) {
    return { ok: false, reason: 'missing_tenant_id' };
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok) {
    return context;
  }

  const session = await findLatestOnboardingSessionByClinicId(context.clinic.id);
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
    return { ok: false, reason: 'missing_state_token' };
  }

  const session = await findOnboardingSessionByStateToken(safeStateToken);
  if (!session) {
    return { ok: false, reason: 'embedded_signup_session_not_found' };
  }

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
    return { ok: false, reason: 'embedded_signup_session_expired' };
  }

  if (error) {
    const failed = await markOnboardingSessionFailed(session.id, {
      errorCode: String(error).trim() || 'meta_embedded_signup_error',
      errorMessage: String(errorDescription || error).trim() || 'Meta devolvio un error al finalizar el Embedded Signup.',
      metadata: metaPayload || null
    });
    return {
      ok: false,
      reason: failed && failed.errorCode ? failed.errorCode : 'meta_embedded_signup_error'
    };
  }

  if (!safeCode) {
    return { ok: false, reason: 'missing_meta_code' };
  }

  if (!safeRedirectUri || safeRedirectUri !== String(session.redirectUri || '').trim()) {
    return { ok: false, reason: 'embedded_signup_redirect_uri_mismatch' };
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
      return { ok: false, reason: 'channel_belongs_to_another_workspace' };
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
      reason
    };
  }
}

module.exports = {
  createPortalWhatsAppSignupSession,
  getPortalWhatsAppSignupStatus,
  finalizePortalWhatsAppSignup,
  buildMetaConfigStatus
};
