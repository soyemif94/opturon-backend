const crypto = require('crypto');
const env = require('../config/env');
const { logInfo, logWarn, logError } = require('../utils/logger');
const { resolvePortalTenantContext } = require('./portal-context.service');
const graphClient = require('../whatsapp/whatsapp-graph.client');
const {
  extractGraphErrorMeta,
  inferMetaDomainReason,
  buildMetaGraphDetail
} = require('./portal-whatsapp-assets.service');
const {
  createOnboardingSession,
  expirePreviousPendingSessions,
  findOnboardingSessionByStateToken,
  findLatestOnboardingSessionByClinicId,
  markOnboardingSessionFailed,
  markOnboardingSessionCancelled,
  markOnboardingSessionExpired,
  markOnboardingSessionProcessing,
  markOnboardingSessionPending,
  markOnboardingSessionCompleted,
  findWhatsAppChannelByPhoneNumberId,
  upsertWhatsAppChannel,
  deactivateOtherClinicWhatsAppChannels,
  withOnboardingTransaction
} = require('../repositories/whatsapp-onboarding.repository');
const { createPortalUserAuditEvent } = require('../repositories/portal-user-audit.repository');

const DEFAULT_PROVIDER = 'meta_embedded_signup';
const DEFAULT_GRAPH_VERSION = String(env.getWhatsAppGraphVersion()).trim();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ONBOARDING_SESSION_TTL_MS = 60 * 60 * 1000;
const RECOVERABLE_SESSION_STATUSES = new Set(['created', 'launching', 'awaiting_callback']);
const PROCESSING_SESSION_STATUSES = new Set(['exchanging_code', 'discovering_assets', 'subscribing_app', 'persisting_channel']);
const ACTIVE_SESSION_STATUSES = new Set([...RECOVERABLE_SESSION_STATUSES, ...PROCESSING_SESSION_STATUSES]);
const TERMINAL_SESSION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);

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

function normalizeSessionStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function buildSessionSafeErrorMessage(reason) {
  if (reason === 'popup_closed_without_callback') {
    return 'El popup de Meta se cerro antes de completar la conexion.';
  }
  if (reason === 'meta_flow_not_completed') {
    return 'Meta no completo el flujo de conexion para este intento.';
  }
  if (reason === 'embedded_signup_session_expired') {
    return 'La sesion de conexion con Meta expiro antes de completarse.';
  }
  if (reason === 'meta_embedded_signup_not_available_for_bsp_or_tp') {
    return 'Meta rechazo la conexion porque Opturon todavia no esta habilitado como Tech Provider o BSP.';
  }
  return 'No pudimos completar la conexion con Meta.';
}

function isMetaBlockedMessage(message) {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) return false;

  return [
    'embedded signup is only available for bsps or tps',
    'only available for bsps or tps',
    'only available for tech providers',
    'tech provider',
    'business solution provider',
    'bsp'
  ].some((pattern) => normalized.includes(pattern));
}

function buildSessionAuditAction(status) {
  if (status === 'cancelled') return 'whatsapp_embedded_signup_session_cancelled';
  if (status === 'expired') return 'whatsapp_embedded_signup_session_expired';
  if (status === 'failed') return 'whatsapp_embedded_signup_session_failed';
  if (status === 'completed') return 'whatsapp_embedded_signup_session_completed';
  return 'whatsapp_embedded_signup_session_updated';
}

function isRecoverableSessionStatus(status) {
  return RECOVERABLE_SESSION_STATUSES.has(normalizeSessionStatus(status));
}

function isProcessingSessionStatus(status) {
  return PROCESSING_SESSION_STATUSES.has(normalizeSessionStatus(status));
}

function isActiveSessionStatus(status) {
  return ACTIVE_SESSION_STATUSES.has(normalizeSessionStatus(status));
}

function isTerminalSessionStatus(status) {
  return TERMINAL_SESSION_STATUSES.has(normalizeSessionStatus(status));
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
  if (!session) return false;
  const explicitExpiresAt = new Date(session.expiresAt || '').getTime();
  if (Number.isFinite(explicitExpiresAt)) {
    return explicitExpiresAt <= Date.now();
  }

  const createdAt = new Date(session.createdAt || '').getTime();
  if (!Number.isFinite(createdAt)) return false;
  return createdAt + ONBOARDING_SESSION_TTL_MS <= Date.now();
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

async function writeOnboardingAuditEvent({
  tenantId,
  clinicId,
  actorUserId = null,
  session,
  action,
  reason = null,
  detail = null,
  client = null
}) {
  if (!tenantId || !clinicId || !session || !session.id) return null;

  return createPortalUserAuditEvent(
    {
      tenantId,
      clinicId,
      actorUserId: normalizeActorUserId(actorUserId),
      targetUserId: null,
      action: action || buildSessionAuditAction(session.status),
      payload: {
        sessionId: session.id,
        sessionStatus: session.status || null,
        reason: reason || null,
        detail: detail || null,
        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,
        channelId: session.channelId || null
      }
    },
    client
  );
}

async function normalizeLatestOnboardingSession({
  tenantId,
  clinicId,
  session,
  actorUserId = null,
  reason = null
}) {
  if (!session) return null;

  const normalizedStatus = normalizeSessionStatus(session.status);
  if (!isRecoverableSessionStatus(normalizedStatus)) {
    return session;
  }

  if (!isExpired(session)) {
    return session;
  }

  const expiredSession = await withOnboardingTransaction(async (client) => {
    const updated = await markOnboardingSessionExpired(
      session.id,
      {
        errorCode: 'embedded_signup_session_expired',
        errorMessage: buildSessionSafeErrorMessage('embedded_signup_session_expired'),
        metadata: {
          ...(session.metadata && typeof session.metadata === 'object' ? session.metadata : {}),
          recovery: {
            reason: reason || 'status_refresh_timeout',
            expiredAt: new Date().toISOString()
          }
        }
      },
      client
    );

    await writeOnboardingAuditEvent({
      tenantId,
      clinicId,
      actorUserId,
      session: updated,
      reason: 'embedded_signup_session_expired',
      detail: reason || 'status_refresh_timeout',
      client
    });

    return updated;
  });

  logInfo('portal_whatsapp_embedded_signup_session_expired', {
    tenantId,
    clinicId,
    sessionId: session.id,
    previousStatus: normalizedStatus,
    reason: reason || 'status_refresh_timeout'
  });

  return expiredSession;
}

function buildOnboardingUiState(session) {
  const status = normalizeSessionStatus(session && session.status);

  if (status === 'completed') return 'connected';
  if (status === 'failed') return 'error';
  if (status === 'cancelled' || status === 'expired') return 'idle';
  if (isActiveSessionStatus(status) || status === 'pending_meta') return 'pending_meta';
  return 'idle';
}

function buildStatusPayload(context, session) {
  const normalizedStatus = normalizeSessionStatus(session && session.status);
  const isActive = isActiveSessionStatus(normalizedStatus);
  const isRecoverable = isRecoverableSessionStatus(normalizedStatus);
  const isProcessing = isProcessingSessionStatus(normalizedStatus);
  const canStartNewAttempt = !session || normalizedStatus === 'completed' || normalizedStatus === 'failed' || normalizedStatus === 'cancelled' || normalizedStatus === 'expired' || normalizedStatus === 'pending_meta';

  return {
    tenantId: context.tenantId,
    clinicId: context.clinic && context.clinic.id ? context.clinic.id : null,
    session: summarizeSession(session),
    onboardingState: buildOnboardingUiState(session),
    activeSession: isActive,
    recoverableSession: isRecoverable,
    processingSession: isProcessing,
    canCancel: isRecoverable,
    canStartNewAttempt
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
    const meta = extractGraphErrorMeta(result);
    const reason = inferMetaDomainReason(meta, 'manual_connect');
    const error = new Error(buildMetaGraphDetail(reason, meta, 'manual_connect'));
    error.reason = reason;
    error.graphStatus = result.status || null;
    error.body = result.data || null;
    error.graphCode = meta.code;
    error.graphSubcode = meta.subcode;
    error.fbtraceId = meta.fbtraceId;
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
  const bootstrapRequestId = `wa_bootstrap_${crypto.randomUUID()}`;
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
  logInfo('portal_whatsapp_embedded_signup_bootstrap_started', {
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    requestId: bootstrapRequestId,
    redirectUri: safeRedirectUri,
    backendMetaReady: metaConfig.ready
  });

  if (!metaConfig.ready) {
    logWarn('portal_whatsapp_embedded_signup_bootstrap_failed', {
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      requestId: bootstrapRequestId,
      reason: 'meta_embedded_signup_not_configured',
      metaConfig
    });
    return withReason(
      'meta_embedded_signup_not_configured',
      'Faltan credenciales internas de Meta para iniciar el Embedded Signup en este entorno.',
      {
        tenantId: safeTenantId,
        clinicId: context.clinic.id,
        metaConfig
      }
    );
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
        status: 'awaiting_callback',
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
    requestId: bootstrapRequestId,
    stateToken: session && session.stateToken ? redactToken(session.stateToken) : null,
    redirectUri: safeRedirectUri,
    backendMetaReady: metaConfig.ready
  });

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    ready: true,
    status: 'awaiting_callback',
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

  const latestSession = await findLatestOnboardingSessionByClinicId(context.clinic.id);
  const session = await normalizeLatestOnboardingSession({
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    session: latestSession,
    reason: 'status_poll'
  });
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
  expectedTenantId = null,
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

  const rawSession = await findOnboardingSessionByStateToken(safeStateToken);
  const session = rawSession
    ? await normalizeLatestOnboardingSession({
        tenantId: rawSession.externalTenantId,
        clinicId: rawSession.clinicId,
        session: rawSession,
        reason: 'finalize_received'
      })
    : null;
  if (!session) {
    return withReason('embedded_signup_session_not_found', 'No encontramos una sesion activa para el state recibido desde Meta.');
  }

  const safeExpectedTenantId = String(expectedTenantId || '').trim();
  if (safeExpectedTenantId && safeExpectedTenantId !== String(session.externalTenantId || '').trim()) {
    logWarn('portal_whatsapp_embedded_signup_tenant_mismatch', {
      expectedTenantId: safeExpectedTenantId,
      sessionTenantId: session.externalTenantId || null,
      clinicId: session.clinicId,
      sessionId: session.id
    });
    return withReason(
      'embedded_signup_session_tenant_mismatch',
      'La sesion de Meta no pertenece al tenant seleccionado.'
    );
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
    return withReason(
      'embedded_signup_state_already_consumed',
      'La sesion de Meta ya fue finalizada y no puede reutilizarse.'
    );
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
    const normalizedExternalReason = isMetaBlockedMessage(`${error} ${errorDescription || ''}`)
      ? 'meta_embedded_signup_not_available_for_bsp_or_tp'
      : String(error).trim() || 'meta_embedded_signup_error';
    const failed = await markOnboardingSessionFailed(session.id, {
      errorCode: normalizedExternalReason,
      errorMessage:
        normalizedExternalReason === 'meta_embedded_signup_not_available_for_bsp_or_tp'
          ? buildSessionSafeErrorMessage('meta_embedded_signup_not_available_for_bsp_or_tp')
          : String(errorDescription || error).trim() || 'Meta devolvio un error al finalizar el Embedded Signup.',
      metadata: {
        metaPayload: metaPayload || null
      }
    });
    await writeOnboardingAuditEvent({
      tenantId: session.externalTenantId,
      clinicId: session.clinicId,
      actorUserId: session.createdByUserId || null,
      session: failed || session,
      reason: normalizedExternalReason,
      detail: 'meta_callback_error'
    });
    return withReason(
      failed && failed.errorCode ? failed.errorCode : 'meta_embedded_signup_error',
      failed && failed.errorMessage ? failed.errorMessage : 'Meta devolvio un error al finalizar el Embedded Signup.'
    );
  }

  if (!safeCode) {
    const cancelled = await markOnboardingSessionCancelled(session.id, {
      errorCode: 'meta_flow_not_completed',
      errorMessage: buildSessionSafeErrorMessage('meta_flow_not_completed'),
      metadata: {
        metaPayload: metaPayload || null
      }
    });
    await writeOnboardingAuditEvent({
      tenantId: session.externalTenantId,
      clinicId: session.clinicId,
      actorUserId: session.createdByUserId || null,
      session: cancelled || session,
      reason: 'meta_flow_not_completed',
      detail: 'finalize_without_code'
    });
    return withReason('missing_meta_code', 'Meta no devolvio el code de autorizacion necesario para finalizar la conexion.');
  }

  if (!safeRedirectUri || safeRedirectUri !== String(session.redirectUri || '').trim()) {
    return withReason(
      'embedded_signup_redirect_uri_mismatch',
      'La redirectUri del callback no coincide con la que inicio la sesion de onboarding.'
    );
  }

  try {
    await markOnboardingSessionProcessing(session.id, {
      status: 'exchanging_code',
      metadata: {
        ...(session.metadata && typeof session.metadata === 'object' ? session.metadata : {}),
        processing: {
          stage: 'exchanging_code',
          updatedAt: new Date().toISOString()
        }
      }
    });
    const token = await exchangeMetaCodeForAccessToken({
      code: safeCode,
      redirectUri: safeRedirectUri,
      requestId
    });
    await markOnboardingSessionProcessing(session.id, {
      status: 'discovering_assets',
      metadata: {
        processing: {
          stage: 'discovering_assets',
          updatedAt: new Date().toISOString()
        }
      }
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

    await markOnboardingSessionProcessing(session.id, {
      status: 'subscribing_app',
      metadata: {
        processing: {
          stage: 'subscribing_app',
          updatedAt: new Date().toISOString()
        }
      }
    });
    const subscription = await subscribeCurrentAppToWaba({
      accessToken: token.accessToken,
      wabaId: assets.wabaId,
      requestId
    });
    if (!subscription.ok) {
      const meta = extractGraphErrorMeta({
        status: subscription.status || null,
        data: subscription.body || null
      });
      logWarn('portal_whatsapp_embedded_signup_subscription_failed', {
        requestId,
        tenantId: session.externalTenantId,
        clinicId: session.clinicId,
        sessionId: session.id,
        reason: 'meta_app_subscription_failed',
        graphStatus: meta.status,
        graphCode: meta.code,
        graphSubcode: meta.subcode,
        fbtraceId: meta.fbtraceId
      });
    }

    const persisted = await withOnboardingTransaction(async (client) => {
      await markOnboardingSessionProcessing(
        session.id,
        {
          status: 'persisting_channel',
          metadata: {
            processing: {
              stage: 'persisting_channel',
              updatedAt: new Date().toISOString()
            }
          }
        },
        client
      );
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
    await writeOnboardingAuditEvent({
      tenantId: session.externalTenantId,
      clinicId: session.clinicId,
      actorUserId: session.createdByUserId || null,
      session: latestSession || session,
      reason: subscription.ok ? 'embedded_signup_completed' : 'meta_app_subscription_failed',
      detail: subscription.ok ? 'finalize_success' : 'finalize_pending_subscription'
    });
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
      channel: buildSafeChannelPayload(persisted.channel),
      session: summarizeSession(latestSession)
    };
  } catch (finalizeError) {
    const reason = String(finalizeError.reason || finalizeError.message || 'meta_embedded_signup_finalize_failed').trim();
    const normalizedFailureReason = isMetaBlockedMessage(`${reason} ${finalizeError.message || ''}`)
      ? 'meta_embedded_signup_not_available_for_bsp_or_tp'
      : reason;
    await markOnboardingSessionFailed(session.id, {
      errorCode: normalizedFailureReason,
      errorMessage:
        normalizedFailureReason === 'meta_embedded_signup_not_available_for_bsp_or_tp'
          ? buildSessionSafeErrorMessage('meta_embedded_signup_not_available_for_bsp_or_tp')
          : String(finalizeError.message || reason).trim(),
      metadata: {
        body: finalizeError.body || null,
        details: finalizeError.details || null
      }
    });
    await writeOnboardingAuditEvent({
      tenantId: session.externalTenantId,
      clinicId: session.clinicId,
      actorUserId: session.createdByUserId || null,
      session: {
        ...session,
        status: 'failed'
      },
      reason: normalizedFailureReason,
      detail: 'finalize_exception'
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
      reason: normalizedFailureReason,
      detail:
        normalizedFailureReason === 'meta_embedded_signup_not_available_for_bsp_or_tp'
          ? buildSessionSafeErrorMessage('meta_embedded_signup_not_available_for_bsp_or_tp')
          : String(finalizeError.message || reason).trim()
    };
  }
}

async function refreshPortalWhatsAppSignupSession(tenantId, options = {}) {
  const safeTenantId = String(tenantId || '').trim();
  if (!safeTenantId) {
    return withReason('missing_tenant_id', 'No recibimos el tenantId para refrescar la sesion de onboarding.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok) {
    return context;
  }

  const latestSession = await findLatestOnboardingSessionByClinicId(context.clinic.id);
  let session = await normalizeLatestOnboardingSession({
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    session: latestSession,
    actorUserId: options.actorUserId || null,
    reason: options.reason || 'manual_refresh'
  });

  const normalizedStatus = normalizeSessionStatus(session && session.status);
  const requestedReason = String(options.reason || '').trim() || 'manual_refresh';
  const safeMessage = buildSessionSafeErrorMessage(
    requestedReason === 'popup_closed_without_callback' ? 'popup_closed_without_callback' : 'meta_flow_not_completed'
  );

  if (
    session &&
    !isTerminalSessionStatus(normalizedStatus) &&
    !isProcessingSessionStatus(normalizedStatus) &&
    isRecoverableSessionStatus(normalizedStatus) &&
    (requestedReason === 'popup_closed_without_callback' || requestedReason === 'meta_flow_not_completed')
  ) {
    session = await withOnboardingTransaction(async (client) => {
      const updated = await markOnboardingSessionCancelled(
        session.id,
        {
          errorCode: requestedReason,
          errorMessage: safeMessage,
          metadata: {
            ...(session.metadata && typeof session.metadata === 'object' ? session.metadata : {}),
            recovery: {
              reason: requestedReason,
              source: options.source || 'admin_refresh',
              detectedAt: new Date().toISOString()
            }
          }
        },
        client
      );

      await writeOnboardingAuditEvent({
        tenantId: safeTenantId,
        clinicId: context.clinic.id,
        actorUserId: options.actorUserId || null,
        session: updated,
        reason: requestedReason,
        detail: options.source || 'admin_refresh',
        client
      });

      return updated;
    });
  }

  return {
    ok: true,
    ...buildStatusPayload(context, session)
  };
}

async function cancelPortalWhatsAppSignupSession(tenantId, options = {}) {
  const safeTenantId = String(tenantId || '').trim();
  if (!safeTenantId) {
    return withReason('missing_tenant_id', 'No recibimos el tenantId para cancelar la sesion de onboarding.');
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok) {
    return context;
  }

  const latestSession = await findLatestOnboardingSessionByClinicId(context.clinic.id);
  const session = await normalizeLatestOnboardingSession({
    tenantId: safeTenantId,
    clinicId: context.clinic.id,
    session: latestSession,
    actorUserId: options.actorUserId || null,
    reason: 'cancel_request'
  });

  if (!session) {
    return withReason('embedded_signup_session_not_found', 'No encontramos una sesion activa para cancelar.');
  }

  const normalizedStatus = normalizeSessionStatus(session.status);
  if (normalizedStatus === 'completed') {
    return withReason('embedded_signup_session_already_completed', 'La sesion ya fue completada y no se puede cancelar.');
  }

  if (isProcessingSessionStatus(normalizedStatus)) {
    return withReason('embedded_signup_session_processing', 'La sesion esta siendo procesada por backend y no se cancela de forma preventiva.');
  }

  if (!isRecoverableSessionStatus(normalizedStatus)) {
    return withReason('embedded_signup_session_not_cancelable', 'La sesion actual no esta en un estado recuperable para cancelar.');
  }

  const cancelledSession = await withOnboardingTransaction(async (client) => {
    const updated = await markOnboardingSessionCancelled(
      session.id,
      {
        errorCode: 'popup_closed_without_callback',
        errorMessage: buildSessionSafeErrorMessage('popup_closed_without_callback'),
        metadata: {
          ...(session.metadata && typeof session.metadata === 'object' ? session.metadata : {}),
          recovery: {
            reason: 'popup_closed_without_callback',
            source: options.source || 'admin_cancel',
            cancelledAt: new Date().toISOString()
          }
        }
      },
      client
    );

    await writeOnboardingAuditEvent({
      tenantId: safeTenantId,
      clinicId: context.clinic.id,
      actorUserId: options.actorUserId || null,
      session: updated,
      reason: 'popup_closed_without_callback',
      detail: options.source || 'admin_cancel',
      client
    });

    return updated;
  });

  return {
    ok: true,
    ...buildStatusPayload(context, cancelledSession)
  };
}

module.exports = {
  createPortalWhatsAppSignupSession,
  getPortalWhatsAppSignupStatus,
  refreshPortalWhatsAppSignupSession,
  cancelPortalWhatsAppSignupSession,
  finalizePortalWhatsAppSignup,
  buildMetaConfigStatus,
  __private__: {
    ONBOARDING_SESSION_TTL_MS,
    buildOnboardingUiState,
    isRecoverableSessionStatus,
    isProcessingSessionStatus,
    isActiveSessionStatus,
    isMetaBlockedMessage,
    buildSessionSafeErrorMessage
  }
};
