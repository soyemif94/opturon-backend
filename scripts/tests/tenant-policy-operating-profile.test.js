const assert = require('assert');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');

function modulePath(relativePath) {
  return path.join(rootDir, relativePath);
}

function mockModule(relativePath, exportsValue) {
  const fullPath = modulePath(relativePath);
  require.cache[fullPath] = {
    id: fullPath,
    filename: fullPath,
    loaded: true,
    exports: exportsValue
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildServiceHarness() {
  const state = {
    queries: [],
    audits: [],
    clinic: {
      id: 'clinic-1',
      name: 'Tenant One',
      timezone: 'America/Buenos_Aires',
      externalTenantId: 'tenant-one',
      settings: {
        portal: {
          policy: {
            policyVersion: 1,
            planCode: 'basic',
            limits: {
              maxPortalUsers: 5,
              maxAutomations: 20,
              maxContacts: 1000
            },
            operatingProfile: {
              presetKey: 'appointment_services',
              industryProfile: 'appointment_services',
              operatingModel: 'services',
              businessSubtype: 'initial'
            },
            capabilities: ['contacts', 'appointments', 'payments'],
            enabledModules: {
              contacts: true,
              agenda: true,
              payments: true,
              orders: false
            }
          }
        }
      },
      primaryEmail: 'owner@tenant-one.test'
    }
  };

  mockModule('src/db/client.js', {
    query: async (text, params) => {
      state.queries.push({ text, params: clone(params) });
      if (text.includes('SELECT c.id')) {
        return {
          rows: [
            {
              id: state.clinic.id,
              name: state.clinic.name,
              timezone: state.clinic.timezone,
              externalTenantId: state.clinic.externalTenantId,
              settings: clone(state.clinic.settings),
              createdAt: '2026-07-25T10:00:00.000Z',
              updatedAt: '2026-07-25T10:00:00.000Z',
              primaryEmail: state.clinic.primaryEmail
            }
          ]
        };
      }

      if (text.includes('WITH updated_clinic AS')) {
        const nextName = params[1];
        const nextPolicy = JSON.parse(params[2]);
        const nextEmail = params[3];
        state.clinic.name = nextName;
        state.clinic.primaryEmail = nextEmail;
        state.clinic.settings.portal.policy = nextPolicy;
        return {
          rows: [
            {
              id: state.clinic.id,
              name: state.clinic.name,
              externalTenantId: state.clinic.externalTenantId,
              settings: clone(state.clinic.settings),
              timezone: state.clinic.timezone,
              createdAt: '2026-07-25T10:00:00.000Z',
              updatedAt: '2026-07-25T10:10:00.000Z',
              primaryEmail: state.clinic.primaryEmail
            }
          ]
        };
      }

      throw new Error(`Unexpected query: ${text.slice(0, 80)}`);
    }
  });

  mockModule('src/repositories/tenant-policy-audit.repository.js', {
    createTenantPolicyAuditEvent: async (entry) => {
      state.audits.push(clone(entry));
      return { id: 'audit-1' };
    }
  });

  const servicePath = modulePath('src/services/tenant-policy.service.js');
  delete require.cache[servicePath];
  return {
    state,
    service: require(servicePath)
  };
}

function testBuildTenantPolicyLegacyFallback() {
  const { service } = buildServiceHarness();
  const policy = service.buildTenantPolicyFromSettings({
    portal: {
      policy: {
        planCode: 'basic',
        limits: {
          maxPortalUsers: 5
        }
      }
    }
  });

  assert.strictEqual(policy.policyVersion, 0);
  assert.strictEqual(policy.source, 'legacy_fallback');
  assert.strictEqual(policy.enabledModules.orders, true);
  assert.strictEqual(policy.enabledModules.metrics, true);
}

function testBuildTenantPolicyExplicitRestrictions() {
  const { service } = buildServiceHarness();
  const policy = service.buildTenantPolicyFromSettings({
    portal: {
      policy: {
        policyVersion: 1,
        capabilities: ['contacts'],
        enabledModules: {
          contacts: true,
          agenda: true
        },
        operatingProfile: {
          presetKey: 'custom',
          industryProfile: 'custom',
          operatingModel: 'hybrid'
        }
      }
    }
  });

  assert.strictEqual(policy.policyVersion, 1);
  assert.strictEqual(policy.enabledModules.contacts, true);
  assert.strictEqual(policy.enabledModules.agenda, false);
  assert.strictEqual(policy.enabledModules.orders, false);
  assert.strictEqual(policy.enabledModules.inventory, false);
}

function testBuildTenantPolicyInventoryCapabilityEnablesInventoryModule() {
  const { service } = buildServiceHarness();
  const policy = service.buildTenantPolicyFromSettings({
    portal: {
      policy: {
        policyVersion: 1,
        capabilities: ['inventory'],
        enabledModules: {},
        operatingProfile: {
          presetKey: 'retail_commerce',
          industryProfile: 'retail_commerce',
          operatingModel: 'physical_goods'
        }
      }
    }
  });

  assert.strictEqual(policy.enabledModules.inventory, true);
}

async function testTenantPatchCannotEscalateCapabilities() {
  const { state, service } = buildServiceHarness();
  const result = await service.updateTenantPolicyByExternalTenantId(
    'tenant-one',
    {
      capabilities: ['contacts', 'orders', 'inventory'],
      enabledModules: {
        orders: true,
        agenda: false
      },
      operatingProfile: {
        industryProfile: 'wholesale_distribution',
        operatingModel: 'physical_goods',
        businessSubtype: 'services_plus'
      },
      displayName: 'Spoofed Name'
    },
    {
      mode: 'tenant',
      actorUserId: 'portal-user-1',
      actorRole: 'client_portal',
      actorScope: 'client'
    }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.clinic.name, 'Tenant One');
  assert.deepStrictEqual(result.policy.capabilities, ['contacts', 'appointments', 'payments']);
  assert.strictEqual(result.policy.enabledModules.orders, false);
  assert.strictEqual(result.policy.enabledModules.agenda, false);
  assert.strictEqual(result.policy.operatingProfile.industryProfile, 'appointment_services');
  assert.strictEqual(result.policy.operatingProfile.businessSubtype, 'services_plus');
  assert.strictEqual(state.audits.length, 1);
  assert.strictEqual(state.audits[0].metadata.mode, 'tenant');
}

async function testIdempotentPatchSkipsAudit() {
  const { state, service } = buildServiceHarness();
  const result = await service.updateTenantPolicyByExternalTenantId(
    'tenant-one',
    {
      enabledModules: {
        contacts: true,
        agenda: true,
        payments: true,
        orders: false
      },
      operatingProfile: {
        businessSubtype: 'initial'
      }
    },
    {
      mode: 'tenant',
      actorUserId: 'portal-user-1'
    }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.idempotent, true);
  assert.strictEqual(state.audits.length, 0);
  assert.strictEqual(state.queries.filter((entry) => entry.text.includes('WITH updated_clinic AS')).length, 0);
}

async function run() {
  testBuildTenantPolicyLegacyFallback();
  testBuildTenantPolicyExplicitRestrictions();
  testBuildTenantPolicyInventoryCapabilityEnablesInventoryModule();
  await testTenantPatchCannotEscalateCapabilities();
  await testIdempotentPatchSkipsAudit();
  console.log('tenant-policy-operating-profile.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
