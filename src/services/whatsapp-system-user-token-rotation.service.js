const crypto = require('crypto');
const graphClient = require('../whatsapp/whatsapp-graph.client');
const repository = require('../repositories/whatsapp-system-user-token-rotation.repository');
const { logInfo, logWarn } = require('../utils/logger');

const ROTATION_TARGET = Object.freeze({
  tenantId: 'tenant_cliente_demo_02_20260312',
  channelId: '7f86db7a-0b3f-4aeb-9546-d0f2f921456a',
  clinicId: 'a335961a-75c3-443b-a35f-5cc8dd243b1d',
  legacyChannelId: 'b3ef8ab5-4610-4571-a91b-e34d10b98dfa',
  provider: 'whatsapp_cloud',
  wabaId: '27184268844495361',
  phoneNumberId: '1070249406167861'
});
const ROTATION_CONFIRMATION = 'ROTATE_WHATSAPP_SYSTEM_USER_TOKEN';

function normalize(value) {
  return String(value || '').trim();
}

function safeFingerprint(value) {
  return crypto.createHash('sha256').update(normalize(value), 'utf8').digest('hex');
}

function ensureTenant(tenantId) {
  if (normalize(tenantId) !== ROTATION_TARGET.tenantId) throw new Error('rotation_tenant_mismatch');
}

function summarizeTemplates(items) {
  return items.map((item) => ({
    name: normalize(item.name),
    language: normalize(item.language),
    status: normalize(item.status),
    category: normalize(item.category)
  }));
}

async function validateMetaCredential(accessToken, dependencies = {}) {
  const request = dependencies.graphRequest || graphClient.request;
  const requestId = `wa_token_rotation_${crypto.randomUUID()}`;
  const waba = await request('GET', `/${ROTATION_TARGET.wabaId}`, {
    requestId,
    accessToken,
    query: { fields: 'id,name' }
  });
  if (!waba.ok || Number(waba.status) !== 200 || normalize(waba.data && waba.data.id) !== ROTATION_TARGET.wabaId) {
    throw new Error('meta_waba_validation_failed');
  }
  const phones = await request('GET', `/${ROTATION_TARGET.wabaId}/phone_numbers`, {
    requestId,
    accessToken,
    query: { fields: 'id,display_phone_number,verified_name,status,quality_rating', limit: '100' }
  });
  const phoneItems = Array.isArray(phones.data && phones.data.data) ? phones.data.data : [];
  if (!phones.ok || Number(phones.status) !== 200 || !phoneItems.some((item) => normalize(item.id) === ROTATION_TARGET.phoneNumberId)) {
    throw new Error('meta_phone_numbers_validation_failed');
  }
  const templates = await request('GET', `/${ROTATION_TARGET.wabaId}/message_templates`, {
    requestId,
    accessToken,
    query: { fields: 'id,name,language,status,category', limit: '100' }
  });
  const templateItems = Array.isArray(templates.data && templates.data.data) ? templates.data.data : [];
  if (!templates.ok || Number(templates.status) !== 200) throw new Error('meta_templates_validation_failed');
  return {
    wabaHttp: 200,
    phoneNumbersHttp: 200,
    matchedPhoneNumberId: ROTATION_TARGET.phoneNumberId,
    templatesHttp: 200,
    templateCount: templateItems.length,
    templates: summarizeTemplates(templateItems)
  };
}

async function getSystemUserTokenRotationPreflight(tenantId, dependencies = {}) {
  ensureTenant(tenantId);
  const repo = dependencies.repository || repository;
  const state = repo.assertTargetState(await repo.readRotationState(ROTATION_TARGET), ROTATION_TARGET);
  return {
    ok: true,
    target: ROTATION_TARGET,
    canonical: state.canonical,
    legacy: state.legacy,
    activeOwners: state.activeOwners,
    credentialPresent: state.credentialPresent,
    credentialFingerprint: state.credentialFingerprint,
    ownershipConfirmed: true
  };
}

async function rotateSystemUserToken(tenantId, payload, dependencies = {}) {
  ensureTenant(tenantId);
  if (normalize(payload && payload.confirmation) !== ROTATION_CONFIRMATION) {
    throw new Error('rotation_confirmation_invalid');
  }
  const accessToken = normalize(payload && payload.accessToken);
  if (!accessToken) throw new Error('rotation_access_token_missing');
  const repo = dependencies.repository || repository;
  const metaValidator = dependencies.validateMetaCredential || validateMetaCredential;
  const tokenFingerprint = safeFingerprint(accessToken);
  logInfo('whatsapp_system_user_token_rotation_started', {
    tenantId: ROTATION_TARGET.tenantId,
    clinicId: ROTATION_TARGET.clinicId,
    channelId: ROTATION_TARGET.channelId,
    tokenPresent: true,
    tokenLength: accessToken.length,
    tokenFingerprint
  });
  try {
    const transaction = await repo.rotateCredentialOnly(
      ROTATION_TARGET,
      accessToken,
      (persistedToken) => metaValidator(persistedToken, dependencies)
    );
    const persisted = await repo.readPersistedCredential(ROTATION_TARGET);
    if (persisted.credentialFingerprint !== tokenFingerprint) throw new Error('post_commit_credential_fingerprint_mismatch');
    const postMeta = await metaValidator(persisted.accessToken, dependencies);
    logInfo('whatsapp_system_user_token_rotation_completed', {
      tenantId: ROTATION_TARGET.tenantId,
      clinicId: ROTATION_TARGET.clinicId,
      channelId: ROTATION_TARGET.channelId,
      credentialFingerprint: persisted.credentialFingerprint
    });
    return {
      ok: true,
      target: ROTATION_TARGET,
      preCredentialFingerprint: transaction.pre.credentialFingerprint,
      postCredentialFingerprint: transaction.post.credentialFingerprint,
      immutableIdentityPreserved: JSON.stringify(transaction.pre.canonical) === JSON.stringify(transaction.post.canonical),
      ownershipConfirmed: true,
      postMeta
    };
  } catch (error) {
    logWarn('whatsapp_system_user_token_rotation_failed', {
      tenantId: ROTATION_TARGET.tenantId,
      clinicId: ROTATION_TARGET.clinicId,
      channelId: ROTATION_TARGET.channelId,
      reason: error.message
    });
    throw error;
  }
}

module.exports = {
  ROTATION_TARGET,
  ROTATION_CONFIRMATION,
  validateMetaCredential,
  getSystemUserTokenRotationPreflight,
  rotateSystemUserToken
};
