const { closePool } = require('../../src/db/client');
const { getCanaryWorkspace, maskPhone } = require('../../src/services/portal-whatsapp-template-canary.service');
const { listOperationalAlertRecipients } = require('../../src/repositories/operational-alert-recipients.repository');
const { readPersistedCredential } = require('../../src/repositories/whatsapp-system-user-token-rotation.repository');
const { ROTATION_TARGET } = require('../../src/services/whatsapp-system-user-token-rotation.service');
const graphClient = require('../../src/whatsapp/whatsapp-graph.client');
const {
  templateComponents,
  variableDescriptors,
  validateVariables,
  buildTemplatePayload,
  unsupportedTemplateReason
} = require('../../src/whatsapp/whatsapp-template-canary-domain');

const TEMPLATE = Object.freeze({ name: 'inventory_lot_expiring_v1', language: 'es_AR', status: 'approved', category: 'UTILITY' });

function normalize(value) { return String(value || '').trim(); }
function hasExplicitTestAuthorization(recipient) {
  return /(canary|test|prueba|qa|internal|interno)/i.test(normalize(recipient && recipient.consentSource));
}
function mode() {
  const arg = process.argv.find((item) => item.startsWith('--mode='));
  return normalize(arg && arg.slice('--mode='.length)).toUpperCase();
}
function writeResult(result) {
  process.stdout.write(`CANARY_RESULT_JSON=${JSON.stringify(result)}\n`);
}

async function metaReadiness(accessToken) {
  const requestId = `wa_canary_preflight_${Date.now()}`;
  const [waba, phones, templates] = await Promise.all([
    graphClient.request('GET', `/${ROTATION_TARGET.wabaId}`, {
      requestId, accessToken, query: { fields: 'id,name' }
    }),
    graphClient.request('GET', `/${ROTATION_TARGET.wabaId}/phone_numbers`, {
      requestId,
      accessToken,
      query: { fields: 'id,status,quality_rating,name_status,code_verification_status', limit: '100' }
    }),
    graphClient.request('GET', `/${ROTATION_TARGET.wabaId}/message_templates`, {
      requestId,
      accessToken,
      query: { fields: 'id,name,language,status,category,components', limit: '100' }
    })
  ]);
  const phone = Array.isArray(phones.data && phones.data.data)
    ? phones.data.data.find((item) => normalize(item.id) === ROTATION_TARGET.phoneNumberId)
    : null;
  const template = Array.isArray(templates.data && templates.data.data)
    ? templates.data.data.find((item) => normalize(item.name) === TEMPLATE.name && normalize(item.language) === TEMPLATE.language)
    : null;
  return {
    wabaHttp: waba.status || null,
    wabaMatched: waba.ok === true && normalize(waba.data && waba.data.id) === ROTATION_TARGET.wabaId,
    phoneNumbersHttp: phones.status || null,
    phone: phone ? {
      id: normalize(phone.id),
      status: normalize(phone.status) || null,
      qualityRating: normalize(phone.quality_rating) || null,
      nameStatus: normalize(phone.name_status) || null,
      codeVerificationStatus: normalize(phone.code_verification_status) || null
    } : null,
    templatesHttp: templates.status || null,
    template: template ? {
      name: normalize(template.name),
      language: normalize(template.language),
      status: normalize(template.status),
      category: normalize(template.category)
    } : null
  };
}

async function preflight() {
  const workspace = await getCanaryWorkspace(ROTATION_TARGET.tenantId);
  if (!workspace.ok) throw new Error(workspace.reason || 'canary_workspace_unavailable');
  const recipients = await listOperationalAlertRecipients(ROTATION_TARGET.clinicId, { active: true, limit: 100 });
  const eligible = recipients.filter((recipient) =>
    recipient.active === true &&
    recipient.consentStatus === 'granted' &&
    /^\+[1-9][0-9]{7,14}$/.test(normalize(recipient.phoneE164)) &&
    Boolean(normalize(recipient.consentSource)) &&
    Boolean(recipient.consentedAt) &&
    !recipient.revokedAt &&
    hasExplicitTestAuthorization(recipient)
  );
  const template = workspace.templates.find((item) =>
    normalize(item.metaTemplateName) === TEMPLATE.name &&
    normalize(item.language) === TEMPLATE.language &&
    normalize(item.status).toLowerCase() === TEMPLATE.status &&
    normalize(item.category).toUpperCase() === TEMPLATE.category
  );
  if (!template) throw new Error('approved_canary_template_not_found');
  const descriptors = variableDescriptors(template);
  const variables = {};
  const validation = validateVariables(template, variables);
  const unsupportedReason = unsupportedTemplateReason(template);
  const preview = validation.ok && !unsupportedReason ? buildTemplatePayload(template, variables).preview : [];
  const persisted = await readPersistedCredential(ROTATION_TARGET);
  try {
    const meta = await metaReadiness(persisted.accessToken);
    const blockers = [];
    if (eligible.length !== 1) blockers.push(`eligible_test_recipient_count:${eligible.length}`);
    if (unsupportedReason) blockers.push(`unsupported_template:${unsupportedReason}`);
    if (!validation.ok) blockers.push(`unresolved_template_variables:${validation.missing.join(',')}`);
    if (!meta.wabaMatched || meta.wabaHttp !== 200) blockers.push('meta_waba_not_ready');
    if (!meta.phone || meta.phone.id !== ROTATION_TARGET.phoneNumberId || meta.phoneNumbersHttp !== 200) blockers.push('meta_phone_not_ready');
    if (!meta.template || meta.template.status !== 'APPROVED' || meta.templatesHttp !== 200) blockers.push('meta_template_not_ready');
    return {
      ok: blockers.length === 0,
      target: ROTATION_TARGET,
      recipientCount: eligible.length,
      activeRecipientDiagnostics: recipients.map((recipient) => ({
        id: recipient.id,
        name: recipient.name,
        roleLabel: recipient.roleLabel || null,
        phoneMasked: maskPhone(recipient.phoneE164),
        e164Valid: /^\+[1-9][0-9]{7,14}$/.test(normalize(recipient.phoneE164)),
        active: recipient.active,
        consentStatus: recipient.consentStatus,
        consentSource: recipient.consentSource,
        consentedAt: recipient.consentedAt,
        revokedAt: recipient.revokedAt,
        explicitTestAuthorization: hasExplicitTestAuthorization(recipient)
      })),
      recipients: eligible.map((recipient) => ({
        id: recipient.id,
        name: recipient.name,
        roleLabel: recipient.roleLabel || null,
        phoneMasked: maskPhone(recipient.phoneE164),
        active: recipient.active,
        consentStatus: recipient.consentStatus,
        consentSource: recipient.consentSource,
        consentedAt: recipient.consentedAt,
        explicitTestAuthorization: true
      })),
      template: {
        id: template.id,
        name: template.metaTemplateName,
        language: template.language,
        status: template.status,
        category: template.category,
        components: templateComponents(template),
        variableDescriptors: descriptors,
        resolvedVariables: variables,
        preview,
        unsupportedReason: unsupportedReason || null
      },
      meta,
      existingAttemptCount: workspace.attempts.length,
      blockers
    };
  } finally {
    persisted.accessToken = null;
  }
}

async function run() {
  if (mode() !== 'PREFLIGHT') throw new Error('only_PREFLIGHT_is_available_before_confirmation');
  writeResult(await preflight());
}

run()
  .catch((error) => {
    process.stderr.write(`CANARY_PREFLIGHT_FAILED=${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await closePool(); }
    catch { process.exitCode = 1; }
  });
