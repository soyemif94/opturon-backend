const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { __internal: billingInternal } = require('../../src/services/saas-billing.service');
const { updateTenantLifecycleStatus } = require('../../src/services/tenant-lifecycle.service');

const TENANT_ID = 'tenant_guadaluipe_villarreal_mpp58vxs';

function buildClinic(lifecycleStatus = 'active', tenantId = TENANT_ID) {
  return {
    id: 'ceb9e460-6141-4af2-90cd-75c2403db2ab',
    externalTenantId: tenantId,
    settings: {
      portal: {
        lifecycle: { status: lifecycleStatus, source: 'explicit_lifecycle_operation' },
        billing: { status: 'pending', marker: 'preserve-me' },
        policy: { planCode: 'basic', enabledModules: { automations: true } }
      },
      bot: { mode: 'automatic' }
    }
  };
}

function buildSubscription(localStatus, tenantId = TENANT_ID) {
  return {
    id: '5bf4a207-e973-46aa-b84b-fe2134710748',
    externalTenantId: tenantId,
    planCode: 'crecimiento',
    localStatus,
    mercadoPagoStatus: localStatus,
    metadata: {}
  };
}

async function syncAndReadSettings(lifecycleStatus, billingStatus) {
  let savedSettings = null;
  const client = {
    query: async (_sql, params) => {
      savedSettings = JSON.parse(params[1]);
      return { rows: [] };
    }
  };
  await billingInternal.syncTenantBillingState(client, buildClinic(lifecycleStatus), buildSubscription(billingStatus));
  return savedSettings;
}

for (const billingStatus of ['pending', 'active', 'paused', 'canceled', 'expired']) {
  test(`billing ${billingStatus} preserves active tenant lifecycle`, async () => {
    const settings = await syncAndReadSettings('active', billingStatus);
    assert.equal(settings.portal.lifecycle.status, 'active');
    assert.equal(settings.portal.lifecycle.source, 'explicit_lifecycle_operation');
    assert.equal(settings.portal.billing.status, billingStatus);
    assert.equal(settings.portal.policy.planCode, 'basic');
    assert.equal(settings.bot.mode, 'automatic');
  });
}

for (const billingStatus of ['active', 'canceled']) {
  test(`manually suspended tenant remains suspended when billing becomes ${billingStatus}`, async () => {
    const settings = await syncAndReadSettings('suspended', billingStatus);
    assert.equal(settings.portal.lifecycle.status, 'suspended');
    assert.equal(settings.portal.billing.status, billingStatus);
  });
}

test('explicit tenant reactivation preserves billing status and emits CLIENT_REACTIVATED', async () => {
  const clinic = buildClinic('suspended');
  let savedSettings = null;
  let auditEntry = null;
  const client = {
    query: async (sql, params) => {
      if (sql.includes('FOR UPDATE')) return { rows: [clinic] };
      savedSettings = JSON.parse(params[1]);
      return { rows: [{ ...clinic, settings: savedSettings, updatedAt: '2026-08-26T00:00:00.000Z' }] };
    }
  };
  const result = await updateTenantLifecycleStatus({
    tenantId: TENANT_ID,
    status: 'active',
    expectedCurrentStatus: 'suspended',
    reason: 'repair billing lifecycle coupling',
    actorLabel: 'release_operator'
  }, {
    withTransaction: async (callback) => callback(client),
    createTenantPolicyAuditEvent: async (entry) => {
      auditEntry = entry;
      return { id: 'audit-1', action: entry.action };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(savedSettings.portal.lifecycle.status, 'active');
  assert.equal(savedSettings.portal.billing.status, 'pending');
  assert.equal(savedSettings.portal.billing.marker, 'preserve-me');
  assert.equal(auditEntry.action, 'CLIENT_REACTIVATED');
  assert.equal(auditEntry.metadata.reason, 'repair billing lifecycle coupling');
});

test('billing sync fails closed on cross-tenant clinic/subscription mismatch', async () => {
  let writes = 0;
  await assert.rejects(
    billingInternal.syncTenantBillingState(
      { query: async () => { writes += 1; } },
      buildClinic('active', 'tenant-a'),
      buildSubscription('canceled', 'tenant-b')
    ),
    /billing_tenant_mismatch/
  );
  assert.equal(writes, 0);
});

test('Guadalupe fixture is canceled billing with active tenant lifecycle', async () => {
  const settings = await syncAndReadSettings('active', 'canceled');
  assert.equal(settings.portal.lifecycle.status, 'active');
  assert.equal(settings.portal.billing.status, 'canceled');
});

test('every billing flow uses the lifecycle-safe billing synchronizer', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/services/saas-billing.service.js'), 'utf8');
  const syncBody = source.slice(
    source.indexOf('async function syncTenantBillingState'),
    source.indexOf('function resolveBillingAuditEventType')
  );
  assert.doesNotMatch(syncBody, /lifecycle|CLIENT_SUSPENDED|CLIENT_REACTIVATED/);
  assert.doesNotMatch(source, /deriveTenantLifecycleStatus/);
  assert.equal((source.match(/await syncTenantBillingState\(/g) || []).length, 4);
  assert.equal((source.match(/await syncBilling\(/g) || []).length, 1);
});
