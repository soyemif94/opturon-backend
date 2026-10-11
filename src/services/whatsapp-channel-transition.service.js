const transitionRepository = require('../repositories/whatsapp-channel-transition.repository');
const {
  REQUIRED_WEBHOOK_FIELDS,
  readWhatsAppTransitionProviderEvidence
} = require('../whatsapp/whatsapp-transition-provider-readiness');

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const NEXT_STAGE = Object.freeze({
  prepared: 'cloud_api_disconnected',
  cloud_api_disconnected: 'business_app_ready',
  business_app_ready: 'coexistence_onboarding'
});
const SAFE_METADATA_KEYS = Object.freeze([
  'onboardingProvider', 'businessId', 'subscriptionOk', 'subscriptionAlreadyExisted', 'channelAction'
]);

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeMetaPhoneNumber(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('+')) return null;
  const normalized = `+${raw.slice(1).replace(/\D/g, '')}`;
  return E164_PATTERN.test(normalized) ? normalized : null;
}

function maskPhone(value) {
  const normalized = normalizeMetaPhoneNumber(value);
  if (!normalized) return null;
  return `${normalized.slice(0, 3)}••••${normalized.slice(-4)}`;
}

function safeConnectionMetadata(value) {
  const source = parseObject(value);
  const safe = {};
  for (const key of SAFE_METADATA_KEYS) {
    const item = source[key];
    if (typeof item === 'string' && item.length <= 120) safe[key] = item;
    else if (typeof item === 'boolean') safe[key] = item;
  }
  return safe;
}

function buildSnapshot(context, normalizedPhone, providerEvidence) {
  const metadata = safeConnectionMetadata(context.connectionMetadata);
  const settings = parseObject(context.settings);
  const wabaId = String(context.wabaId || '').trim();
  const phoneNumberId = String(context.phoneNumberId || '').trim();
  return {
    externalTenantId: String(context.externalTenantId || '').trim(),
    clinicId: context.clinicId,
    channelId: context.channelId,
    wabaId,
    phoneNumberId,
    normalizedPhone,
    connectionMode: 'API_ONLY',
    channelStatus: String(context.channelStatus || '').trim().toLowerCase(),
    connectionSource: String(context.connectionSource || '').trim().slice(0, 80) || null,
    integrationMetadata: metadata,
    botActive: settings.botActive === true,
    accessCredentialPresent: Boolean(context.accessToken),
    appSubscriptionPreviouslyConfirmed: metadata.subscriptionOk === true
      || metadata.subscriptionAlreadyExisted === true,
    providerPreflight: {
      platformType: providerEvidence.platformType,
      isOnBizApp: providerEvidence.isOnBizApp,
      appId: providerEvidence.appId,
      appSubscribed: providerEvidence.appSubscribed,
      webhookActive: providerEvidence.webhookActive,
      callbackUrlMatches: providerEvidence.callbackUrlMatches,
      subscribedFields: providerEvidence.subscribedFields
    },
    webhookAssociation: {
      provider: 'whatsapp_cloud',
      channelId: context.channelId,
      wabaId,
      phoneNumberId,
      localResolution: 'channels.phoneNumberId'
    }
  };
}

function snapshotIsRecoverySufficient(snapshot) {
  return Boolean(snapshot && snapshot.clinicId && snapshot.channelId && snapshot.wabaId
    && snapshot.phoneNumberId && snapshot.normalizedPhone && snapshot.accessCredentialPresent
    && snapshot.webhookAssociation
    && snapshot.providerPreflight && snapshot.providerPreflight.platformType === 'CLOUD_API'
    && snapshot.providerPreflight.isOnBizApp === false && snapshot.providerPreflight.appSubscribed === true
    && snapshot.providerPreflight.webhookActive === true && snapshot.providerPreflight.callbackUrlMatches === true
    && Array.isArray(snapshot.providerPreflight.subscribedFields)
    && REQUIRED_WEBHOOK_FIELDS.every((field) => snapshot.providerPreflight.subscribedFields.includes(field))
    && snapshot.webhookAssociation.channelId === snapshot.channelId
    && snapshot.webhookAssociation.wabaId === snapshot.wabaId
    && snapshot.webhookAssociation.phoneNumberId === snapshot.phoneNumberId);
}

function validateTransitionProviderIdentity(transition, provider) {
  if (!transition || !provider) return { ok: false, reason: 'transition_or_provider_state_missing' };
  if (String(provider.wabaId || '').trim() !== String(transition.originalWabaId || '').trim()) {
    return { ok: false, reason: 'transition_waba_mismatch' };
  }
  const normalizedPhone = normalizeMetaPhoneNumber(provider.displayPhoneNumber);
  if (!normalizedPhone || normalizedPhone !== transition.originalNormalizedPhone) {
    return { ok: false, reason: 'transition_phone_number_mismatch' };
  }
  if (provider.platformType !== 'CLOUD_API' || provider.isOnBizApp !== true) {
    return { ok: false, reason: 'transition_coexistence_state_unverified' };
  }
  if (!String(provider.phoneNumberId || '').trim()) {
    return { ok: false, reason: 'transition_phone_number_id_missing' };
  }
  return { ok: true, normalizedPhone };
}

function validateRollbackProviderIdentity(transition, provider) {
  if (!transition || !provider) return { ok: false, reason: 'transition_or_provider_state_missing' };
  if (String(provider.wabaId || '').trim() !== String(transition.originalWabaId || '').trim()) {
    return { ok: false, reason: 'transition_waba_mismatch' };
  }
  const normalizedPhone = normalizeMetaPhoneNumber(provider.displayPhoneNumber);
  if (!normalizedPhone || normalizedPhone !== transition.originalNormalizedPhone) {
    return { ok: false, reason: 'transition_phone_number_mismatch' };
  }
  if (provider.platformType !== 'CLOUD_API' || provider.isOnBizApp !== false) {
    return { ok: false, reason: 'rollback_cloud_api_state_unverified' };
  }
  if (!String(provider.phoneNumberId || '').trim()) {
    return { ok: false, reason: 'transition_phone_number_id_missing' };
  }
  return { ok: true, normalizedPhone };
}

async function prepareWhatsAppChannelTransition(externalTenantId, actorUserId = null) { // eslint-disable-line no-unused-vars
  const tenantId = String(externalTenantId || '').trim();
  if (!tenantId) return { ok: false, reason: 'missing_tenant_id' };
  const context = await transitionRepository.findTransitionChannelContext(tenantId);
  if (!context) return { ok: false, reason: 'transition_requires_one_whatsapp_channel' };
  if (String(context.provider || '') !== 'whatsapp_cloud'
    || String(context.channelStatus || '').toLowerCase() !== 'active') {
    return { ok: false, reason: 'transition_channel_not_active' };
  }
  if (String(context.connectionMode || 'API_ONLY') !== 'API_ONLY') {
    return { ok: false, reason: 'transition_requires_api_only_channel' };
  }
  const normalizedPhone = normalizeMetaPhoneNumber(context.displayPhoneNumber);
  if (!context.wabaId || !context.phoneNumberId || !normalizedPhone) {
    return { ok: false, reason: 'transition_identity_snapshot_incomplete' };
  }
  const providerEvidence = await readWhatsAppTransitionProviderEvidence({
    wabaId: context.wabaId,
    phoneNumberId: context.phoneNumberId,
    accessToken: context.accessToken
  });
  if (!providerEvidence.ok) return { ok: false, reason: providerEvidence.reason };
  if (!providerEvidence.ready || normalizeMetaPhoneNumber(providerEvidence.displayPhoneNumber) !== normalizedPhone) {
    return { ok: false, reason: 'transition_provider_preflight_not_ready' };
  }
  const snapshot = buildSnapshot(context, normalizedPhone, providerEvidence);
  const created = await transitionRepository.prepareWhatsAppChannelTransition({
    clinicId: context.clinicId,
    channelId: context.channelId,
    externalTenantId: tenantId,
    snapshot
  });
  if (!created.ok) return created;
  const sufficient = snapshotIsRecoverySufficient(created.transition.snapshot);
  return {
    ok: true,
    transitionId: created.transition.id,
    status: created.transition.status,
    replayed: created.replayed,
    rollbackReady: sufficient,
    safeToDisconnect: sufficient,
    channelId: created.transition.channelId,
    phoneNumberMasked: maskPhone(normalizedPhone),
    phoneNumberId: created.transition.originalPhoneNumberId,
    wabaId: created.transition.originalWabaId,
    snapshotRecoverySufficient: sufficient
  };
}

async function getWhatsAppChannelTransitionDiagnostics(externalTenantId) {
  const tenantId = String(externalTenantId || '').trim();
  const context = await transitionRepository.findTransitionChannelContext(tenantId);
  if (!context) return { ok: false, reason: 'transition_requires_one_whatsapp_channel' };
  const transitions = await transitionRepository.listWhatsAppChannelTransitionsForClinic(context.clinicId);
  return {
    ok: true,
    transitions: transitions.map((transition) => ({
      transitionId: transition.id,
      channelId: transition.channelId,
      status: transition.status,
      targetMode: transition.targetMode,
      originalPhoneNumberId: transition.originalPhoneNumberId,
      currentPhoneNumberId: transition.candidatePhoneNumberId || transition.currentPhoneNumberId || transition.channelPhoneNumberId,
      phoneNumberMasked: maskPhone(transition.originalNormalizedPhone),
      startedAt: transition.createdAt,
      updatedAt: transition.updatedAt,
      failureCode: transition.failureCode || null,
      rollbackAvailable: ['cloud_api_disconnected', 'business_app_ready', 'coexistence_onboarding', 'rollback_pending'].includes(transition.status)
        && snapshotIsRecoverySufficient(transition.snapshot)
    }))
  };
}

async function advanceWhatsAppChannelTransition(transitionId, nextStatus, failureCode = null) {
  const safeCode = failureCode && /^[a-z0-9_]{1,120}$/i.test(String(failureCode)) ? String(failureCode) : null;
  if (nextStatus === 'rollback_pending') {
    return transitionRepository.advanceWhatsAppChannelTransition({
      transitionId,
      expectedStatuses: ['cloud_api_disconnected', 'business_app_ready', 'coexistence_onboarding', 'completed'],
      nextStatus,
      failureCode: safeCode
    });
  }
  const expected = Object.entries(NEXT_STAGE).find(([, next]) => next === nextStatus)?.[0];
  if (!expected) return { ok: false, reason: 'transition_stage_invalid' };
  return transitionRepository.advanceWhatsAppChannelTransition({
    transitionId,
    expectedStatuses: [expected],
    nextStatus
  });
}

async function validateAndCompleteWhatsAppCoexistenceTransition({ transition, provider, accessToken, verifiedName = null, client = null }) {
  const validated = validateTransitionProviderIdentity(transition, provider);
  if (!validated.ok) return validated;
  const idempotentCompletion = transition.status === 'completed'
    && String(provider.phoneNumberId || '').trim() === String(transition.currentPhoneNumberId || '').trim();
  if (!idempotentCompletion && !['business_app_ready', 'coexistence_onboarding'].includes(transition.status)) {
    return { ok: false, reason: 'transition_not_ready_for_coexistence' };
  }
  const persisted = await transitionRepository.persistTransitionChannelRebind({
    transitionId: transition.id,
    phoneNumberId: String(provider.phoneNumberId).trim(),
    wabaId: String(provider.wabaId).trim(),
    accessToken,
    displayPhoneNumber: validated.normalizedPhone,
    verifiedName,
    connectionMode: 'COEXISTENCE',
    terminalStatus: 'completed',
    connectionMetadata: {
      onboardingProvider: 'meta_embedded_signup_transition',
      transitionId: transition.id,
      subscriptionOk: true
    },
    client
  });
  return persisted.ok ? { ok: true, ...persisted } : persisted;
}

async function finalizeWhatsAppTransitionRollback({ transition, provider, accessToken }) {
  const validated = validateRollbackProviderIdentity(transition, provider);
  if (!validated.ok) return validated;
  if (!['rollback_pending', 'cloud_api_disconnected', 'business_app_ready', 'coexistence_onboarding', 'completed'].includes(transition.status)) {
    return { ok: false, reason: 'transition_not_ready_for_rollback' };
  }
  const persisted = await transitionRepository.persistTransitionChannelRebind({
    transitionId: transition.id,
    phoneNumberId: String(provider.phoneNumberId).trim(),
    wabaId: String(provider.wabaId).trim(),
    accessToken,
    displayPhoneNumber: validated.normalizedPhone,
    connectionMode: 'API_ONLY',
    terminalStatus: 'rolled_back',
    connectionMetadata: {
      onboardingProvider: 'whatsapp_transition_rollback',
      transitionId: transition.id,
      subscriptionOk: true
    }
  });
  return persisted.ok ? { ok: true, ...persisted } : persisted;
}

async function executeWhatsAppTransitionRollback(transitionId, confirmRecovery = false) {
  if (confirmRecovery !== true) return { ok: false, reason: 'rollback_confirmation_required' };
  const transition = await transitionRepository.findWhatsAppChannelTransitionById(transitionId);
  if (!transition) return { ok: false, reason: 'transition_not_found' };
  if (!['rollback_pending', 'cloud_api_disconnected', 'business_app_ready', 'coexistence_onboarding', 'completed'].includes(transition.status)) {
    return { ok: false, reason: 'transition_not_ready_for_rollback' };
  }
  if (!transition.accessToken) return { ok: false, reason: 'rollback_credentials_unavailable' };
  const phoneNumberId = transition.candidatePhoneNumberId
    || transition.currentPhoneNumberId
    || transition.originalPhoneNumberId;
  const evidence = await readWhatsAppTransitionProviderEvidence({
    wabaId: transition.originalWabaId,
    phoneNumberId,
    accessToken: transition.accessToken
  });
  if (!evidence.ok || !evidence.ready || evidence.isOnBizApp !== false
    || normalizeMetaPhoneNumber(evidence.displayPhoneNumber) !== transition.originalNormalizedPhone) {
    return { ok: false, reason: 'rollback_provider_preflight_failed' };
  }

  try {
    // This path only registers/re-registers Cloud API; it never deregisters or disconnects a number.
    const { ensureWhatsAppPhoneRegistered } = require('./portal-whatsapp-embedded-signup.service');
    await ensureWhatsAppPhoneRegistered({
      clinicId: transition.clinicId,
      phoneNumberId,
      accessToken: transition.accessToken,
      requestId: `wa_transition_rollback_${transition.id}`,
      force: true
    });
  } catch {
    return { ok: false, reason: 'rollback_cloud_api_registration_failed' };
  }

  const verified = await readWhatsAppTransitionProviderEvidence({
    wabaId: transition.originalWabaId,
    phoneNumberId,
    accessToken: transition.accessToken
  });
  if (!verified.ok || !verified.ready || verified.isOnBizApp !== false
    || normalizeMetaPhoneNumber(verified.displayPhoneNumber) !== transition.originalNormalizedPhone) {
    return { ok: false, reason: 'rollback_provider_verification_failed' };
  }
  const result = await finalizeWhatsAppTransitionRollback({
    transition,
    provider: {
      phoneNumberId,
      wabaId: transition.originalWabaId,
      displayPhoneNumber: verified.displayPhoneNumber,
      platformType: verified.platformType,
      isOnBizApp: verified.isOnBizApp
    },
    accessToken: transition.accessToken
  });
  return result.ok ? {
    ok: true,
    replayed: result.replayed || false,
    transitionId: transition.id,
    channelId: transition.channelId,
    status: 'rolled_back',
    phoneNumberId
  } : result;
}

function simulateRollbackDryRun({ transition, provider }) {
  const validation = validateRollbackProviderIdentity(transition, provider);
  return {
    ok: validation.ok,
    reason: validation.reason || null,
    channelId: validation.ok ? transition.channelId : null,
    phoneNumberId: validation.ok ? provider.phoneNumberId : null,
    dataPreserved: validation.ok
  };
}

module.exports = {
  advanceWhatsAppChannelTransition,
  executeWhatsAppTransitionRollback,
  finalizeWhatsAppTransitionRollback,
  getWhatsAppChannelTransitionDiagnostics,
  normalizeMetaPhoneNumber,
  prepareWhatsAppChannelTransition,
  safeConnectionMetadata,
  simulateRollbackDryRun,
  snapshotIsRecoverySufficient,
  validateAndCompleteWhatsAppCoexistenceTransition,
  validateRollbackProviderIdentity,
  validateTransitionProviderIdentity
};
