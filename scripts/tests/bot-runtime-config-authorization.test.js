const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function modulePath(relativePath) {
  return path.resolve(root, relativePath);
}

function stubModule(relativePath, exportsValue) {
  const resolved = modulePath(relativePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue
  };
}

const dbCalls = [];
stubModule('src/db/client.js', {
  query: async (sql, params) => {
    dbCalls.push({ sql, params });
    return {
      rows: [{
        id: params[0],
        botRuntimeConfig: JSON.parse(params[1])
      }]
    };
  }
});
stubModule('src/utils/secret-crypto.js', {
  maybeDecryptSecret: (value) => value,
  maybeEncryptSecret: (value) => value
});

const tenantRepository = require('../../src/repositories/tenant.repository.js');
const { BOT_RUNTIME_CONFIG_MUTATION_SOURCES } = tenantRepository;

async function validateRepositoryBoundary() {
  await assert.rejects(
    tenantRepository.updateClinicBotRuntimeConfigById(
      'clinic-1',
      { enabled: true },
      null,
      { source: BOT_RUNTIME_CONFIG_MUTATION_SOURCES.CUSTOMER_CONVERSATION }
    ),
    (error) => error && error.code === 'BOT_RUNTIME_CONFIG_MUTATION_UNAUTHORIZED'
  );
  assert.strictEqual(dbCalls.length, 0);

  const updated = await tenantRepository.updateClinicBotRuntimeConfigById(
    'clinic-1',
    { enabled: false, templateKey: 'generated_sales_bot' },
    null,
    { source: BOT_RUNTIME_CONFIG_MUTATION_SOURCES.AUTHORIZED_ADMIN_CONFIGURATION }
  );
  assert.strictEqual(dbCalls.length, 1);
  assert.match(dbCalls[0].sql, /UPDATE clinics/);
  assert.strictEqual(updated.id, 'clinic-1');
}

async function validatePortalAdminSurface() {
  let adminMutation = null;

  stubModule('src/services/portal-context.service.js', {
    resolvePortalTenantContext: async () => ({
      ok: true,
      tenantId: 'tenant-1',
      clinic: { id: 'clinic-1' }
    })
  });
  stubModule('src/repositories/automations.repository.js', {
    createAutomation: async () => null,
    countAutomationsByClinicId: async () => 0,
    listAutomationsByClinicId: async () => [],
    updateAutomationById: async () => null,
    deleteAutomationById: async () => null
  });
  stubModule('src/repositories/tenant.repository.js', {
    BOT_RUNTIME_CONFIG_MUTATION_SOURCES,
    getClinicBusinessProfileById: async () => ({
      id: 'clinic-1',
      businessProfile: { businessType: 'commerce', capabilities: [] },
      settings: {}
    }),
    getClinicBotSettingsById: async () => ({
      id: 'clinic-1',
      botSettings: {
        runtimeConfig: {
          enabled: true,
          templateKey: 'generated_sales_bot'
        }
      }
    }),
    updateClinicBotRuntimeConfigById: async (clinicId, runtimeConfig, client, mutationContext) => {
      adminMutation = { clinicId, runtimeConfig, client, mutationContext };
      return {
        id: clinicId,
        botSettings: { runtimeConfig }
      };
    }
  });
  stubModule('src/repositories/automation-templates.repository.js', {
    listAutomationTemplates: async () => [],
    findAutomationTemplateByKey: async () => ({
      key: 'generated_sales_bot',
      status: 'active',
      defaultEnabled: true,
      metadata: {}
    }),
    listTenantAutomationTemplatesByClinicId: async () => [],
    upsertTenantAutomationTemplate: async (input) => ({
      templateKey: input.templateKey,
      enabled: input.enabled
    })
  });
  stubModule('src/services/automation-enablement.service.js', {
    normalizeBusinessType: (value) => value || 'commerce',
    normalizeCapabilities: (value) => Array.isArray(value) ? value : [],
    buildResolvedCapabilities: async () => [],
    evaluateTemplateCompatibility: () => ({
      compatible: true,
      businessTypeMatch: true,
      missingCapabilities: []
    })
  });
  stubModule('src/services/automation-runtime.service.js', {
    ensureClinicConversationFlowAutomations: async () => []
  });
  stubModule('src/services/tenant-policy.service.js', {
    buildTenantPolicyFromSettings: () => ({ capabilities: [] })
  });

  delete require.cache[modulePath('src/services/portal-automations.service.js')];
  const { updatePortalAutomationTemplate } = require('../../src/services/portal-automations.service.js');
  const result = await updatePortalAutomationTemplate('tenant-1', 'generated_sales_bot', { enabled: false });

  assert.strictEqual(result.ok, true);
  assert.ok(adminMutation);
  assert.strictEqual(adminMutation.clinicId, 'clinic-1');
  assert.strictEqual(adminMutation.runtimeConfig.enabled, false);
  assert.strictEqual(
    adminMutation.mutationContext.source,
    BOT_RUNTIME_CONFIG_MUTATION_SOURCES.AUTHORIZED_ADMIN_CONFIGURATION
  );
}

async function run() {
  await validateRepositoryBoundary();
  await validatePortalAdminSurface();
  console.log('BOT.RUNTIME.CONFIG.AUTHORIZATION validation passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
