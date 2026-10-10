const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const resolved = (relativePath) => path.resolve(root, relativePath);
function stub(relativePath, exportsValue) {
  const filename = resolved(relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue };
}

let createdAutomationCount = 0;
let updatedAutomations = [];
let listedAutomations = [];
let updatedRuntimeConfig = null;
const tenantTemplateWrites = [];

stub('src/services/portal-context.service.js', {
  resolvePortalTenantContext: async () => ({
    ok: true,
    tenantId: 'tenant-1',
    clinic: { id: 'clinic-1', name: 'Demo', settings: {} },
    policy: { limits: { maxAutomations: 50 }, capabilities: [] }
  })
});
stub('src/repositories/automations.repository.js', {
  createAutomation: async () => { createdAutomationCount += 1; return { id: 'new-rule' }; },
  countAutomationsByClinicId: async () => 0,
  listAutomationsByClinicId: async () => listedAutomations,
  updateAutomationById: async (_clinicId, id, patch) => {
    updatedAutomations.push({ id, patch });
    return { id, ...patch };
  },
  deleteAutomationById: async () => null
});
stub('src/repositories/tenant.repository.js', {
  BOT_RUNTIME_CONFIG_MUTATION_SOURCES: { AUTHORIZED_ADMIN_CONFIGURATION: 'authorized_admin_configuration' },
  getClinicBusinessProfileById: async () => ({ id: 'clinic-1', businessProfile: {}, settings: {} }),
  getClinicBotSettingsById: async () => ({ id: 'clinic-1', botSettings: { runtimeConfig: { templateKey: 'generated_sales_bot', enabled: false } } }),
  updateClinicBotRuntimeConfigById: async (_id, config) => { updatedRuntimeConfig = config; return { botSettings: { runtimeConfig: config } }; }
});
stub('src/repositories/automation-templates.repository.js', {
  listAutomationTemplates: async () => [],
  findAutomationTemplateByKey: async (key) => ({ key, status: 'active', defaultEnabled: false, metadata: {} }),
  listTenantAutomationTemplatesByClinicId: async () => [],
  upsertTenantAutomationTemplate: async (input) => { tenantTemplateWrites.push(input); return input; }
});
stub('src/services/automation-enablement.service.js', {
  normalizeBusinessType: (value) => value || 'commerce',
  normalizeCapabilities: (value) => Array.isArray(value) ? value : [],
  buildResolvedCapabilities: async () => [],
  evaluateTemplateCompatibility: () => ({ compatible: true, businessTypeMatch: true, missingCapabilities: [] })
});
stub('src/services/tenant-policy.service.js', { buildTenantPolicyFromSettings: () => ({ capabilities: [] }) });
stub('src/repositories/ai-provisioning.repository.js', {
  findAiProvisioning: async () => null,
  getAiUsageSummary: async () => ({ quotaAvailable: false })
});

const automationService = require('../../src/services/portal-automations.service.js');
const authorityService = require('../../src/services/modern-assistant-authority.service.js');

test('legacy conversational records remain classifiable without deleting history', () => {
  assert.equal(automationService.classifyPortalAutomation({ trigger: { type: 'message_received' } }), 'CONVERSATIONAL_LEGACY');
  assert.equal(automationService.classifyPortalAutomation({ conditions: { conversationFlow: true } }), 'COMPATIBILITY_LEGACY');
  assert.equal(automationService.classifyPortalAutomation({ trigger: { type: 'order_paid' } }), 'OPERATIONAL_DETERMINISTIC');
});

test('legacy rules cannot be created or re-enabled, while disabling remains available', async () => {
  const create = await automationService.createPortalAutomation('tenant-1', {
    name: 'Legacy welcome', trigger: { type: 'message_received' }, actions: [{ type: 'send_message', message: 'Hi' }]
  });
  assert.equal(create.reason, automationService.LEGACY_AUTOMATION_MUTATION_BLOCKED);
  assert.equal(createdAutomationCount, 0);

  listedAutomations = [{ id: 'legacy-1', enabled: false, trigger: { type: 'message_received' } }];
  const reenable = await automationService.updatePortalAutomation('tenant-1', 'legacy-1', { enabled: true });
  assert.equal(reenable.reason, automationService.LEGACY_AUTOMATION_MUTATION_BLOCKED);
  assert.equal(updatedAutomations.length, 0);

  const disable = await automationService.updatePortalAutomation('tenant-1', 'legacy-1', { enabled: false });
  assert.equal(disable.ok, true);
  assert.deepEqual(updatedAutomations, [{ id: 'legacy-1', patch: { enabled: false } }]);
});

test('legacy templates cannot be reactivated; modern generated assistant configuration remains available', async () => {
  const legacy = await automationService.updatePortalAutomationTemplate('tenant-1', 'conversation_welcome', { enabled: true });
  assert.equal(legacy.reason, automationService.LEGACY_AUTOMATION_MUTATION_BLOCKED);

  const modern = await automationService.updatePortalAutomationTemplate('tenant-1', 'generated_sales_bot', { enabled: true });
  assert.equal(modern.ok, true);
  assert.equal(updatedRuntimeConfig.enabled, true);
});

test('modern assistant authority requires entitlement, active channel, ready provisioning and available quota', async () => {
  const clinicId = 'clinic-1';
  const entitlements = {
    botActive: true,
    capabilities: { 'channels.whatsapp': true, 'bot.enabled': true }
  };
  const channel = { clinicId, provider: 'whatsapp_cloud', status: 'active' };
  const ready = {
    entitlements,
    clinicId,
    channel,
    provisioning: { status: 'ready' },
    usage: { quotaAvailable: true }
  };
  assert.equal(authorityService.isModernAssistantAuthorityEligible(ready), true);
  assert.equal(authorityService.isModernAssistantAuthorityEligible({ ...ready, usage: { quotaAvailable: false } }), false);
  assert.equal(authorityService.isModernAssistantAuthorityEligible({ ...ready, provisioning: { status: 'pending' } }), false);
  assert.equal(authorityService.isModernAssistantAuthorityEligible({ ...ready, channel: { ...channel, status: 'inactive' } }), false);
  assert.equal(authorityService.isModernAssistantAuthorityEligible({ ...ready, entitlements: { ...entitlements, botActive: false } }), false);

  const asyncReady = await authorityService.isModernAssistantAuthorityReady(clinicId, channel, {
    loadEntitlements: async () => entitlements,
    findAiProvisioning: async () => ({ status: 'ready' }),
    getAiUsageSummary: async () => ({ quotaAvailable: true })
  });
  assert.equal(asyncReady, true);
});

test('legacy automation foundation setup does not materialize conversation reply rules', async () => {
  const foundation = await automationService.ensurePortalAutomationFoundation('tenant-1');
  assert.equal(foundation.ok, true);
  assert.equal(createdAutomationCount, 0);
});
