const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '../..');
const modulePath = (relativePath) => path.join(root, relativePath);

async function withModuleStubs(stubs, action) {
  const previous = new Map();
  try {
    for (const [relativePath, exports] of Object.entries(stubs)) {
      const resolved = require.resolve(modulePath(relativePath));
      previous.set(resolved, require.cache[resolved]);
      require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    }
    return await action();
  } finally {
    for (const [resolved, prior] of previous) {
      if (prior) require.cache[resolved] = prior;
      else delete require.cache[resolved];
    }
  }
}

test('public registration creates only an unactivated client workspace', async (t) => {
  await t.test('the real SQL initializer removes paid entitlements and preserves tenant data', async () => {
    const db = new PGlite();
    const tenantId = '00000000-0000-4000-8000-000000000111';
    try {
      await db.exec(`CREATE TABLE clinics (
        id UUID PRIMARY KEY,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.query(`INSERT INTO clinics (id, settings) VALUES ($1, $2::jsonb)`, [tenantId, JSON.stringify({
        botActive: true,
        portal: {
          entitlements: { source: 'billing', planKey: 'growth', entitlementProfileVersion: 1, capabilities: { 'bot.enabled': true } },
          billing: { entitlement: { state: 'active', paidAccessAllowed: true }, unrelatedSetting: 'preserve' },
          whatsapp: { connected: true }
        }
      })]);

      const result = await withModuleStubs({
        'src/db/client.js': { query: (sql, params) => db.query(sql, params) }
      }, async () => {
        const resolved = require.resolve(modulePath('src/repositories/tenant.repository.js'));
        const prior = require.cache[resolved];
        delete require.cache[resolved];
        try {
          const repository = require(resolved);
          return repository.initializeClinicUnactivatedBillingById(tenantId);
        } finally {
          if (prior) require.cache[resolved] = prior;
          else delete require.cache[resolved];
        }
      });

      assert.equal(result.id, tenantId);
      assert.equal(result.settings.portal.billing.entitlement.state, 'unactivated');
      assert.equal(result.settings.portal.billing.entitlement.paidAccessAllowed, false);
      assert.equal(result.settings.portal.entitlements, undefined);
      assert.equal(result.settings.portal.billing.unrelatedSetting, 'preserve');
      assert.equal(result.settings.portal.whatsapp.connected, true);
      const { resolveEffectiveEntitlements } = require(modulePath('src/services/effective-entitlements.js'));
      const effective = resolveEffectiveEntitlements(result.settings);
      assert.equal(effective.state, 'unactivated');
      assert.equal(effective.capabilities['bot.enabled'], false);
    } finally {
      await db.close();
    }
  });

  await t.test('owner signup creates an audited tenant without accepting a selected plan', async () => {
    const events = [];
    const userId = '00000000-0000-4000-8000-000000000222';
    const clinic = { id: '00000000-0000-4000-8000-000000000333', externalTenantId: 'tenant_local_test' };
    const stubs = {
      'src/db/client.js': { withTransaction: async (fn) => fn({ transaction: true }) },
      'src/services/portal-context.service.js': {},
      'src/repositories/tenant.repository.js': {
        provisionCleanClinicForExternalTenant: async (input) => { events.push(['tenant', input]); return clinic; },
        initializeClinicUnactivatedBillingById: async (id) => { events.push(['unactivated', id]); },
        updateClinicPortalPrimaryUserIdById: async (clinicId, id) => { events.push(['primary', clinicId, id]); }
      },
      'src/repositories/portal-users.repository.js': {
        findAnyPortalUserByEmail: async (email) => { events.push(['lookup', email]); return null; },
        createPortalUser: async (input) => { events.push(['owner', input]); return { id: userId, email: input.email, name: input.name }; }
      },
      'src/repositories/portal-user-invitations.repository.js': {},
      'src/repositories/portal-user-audit.repository.js': {
        createPortalUserAuditEvent: async (input) => { events.push(['audit', input]); }
      },
      'src/services/tenant-policy.service.js': {}
    };

    const result = await withModuleStubs(stubs, async () => {
      const resolved = require.resolve(modulePath('src/services/portal-users.service.js'));
      const prior = require.cache[resolved];
      delete require.cache[resolved];
      try {
        const service = require(resolved);
        return service.registerPortalOwnerAccount({
          name: ' Ada Lovelace ', businessName: ' Analytical Engines ', email: ' OWNER@EXAMPLE.INVALID ',
          password: 'correct-horse-battery-staple', planKey: 'growth', amount: 1, capabilities: ['bot.enabled']
        });
      } finally {
        if (prior) require.cache[resolved] = prior;
        else delete require.cache[resolved];
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.user.tenantRole, 'owner');
    assert.equal(result.user.accountScope, 'client');
    assert.equal(events[0][0], 'lookup');
    assert.equal(events[0][1], 'owner@example.invalid');
    assert.equal(events[1][0], 'tenant');
    assert.deepEqual(Object.keys(events[1][1]).sort(), ['externalTenantId', 'name', 'timezone']);
    assert.equal(events[2][0], 'unactivated');
    assert.equal(events[2][1], clinic.id);
    assert.equal(events[3][0], 'owner');
    assert.equal(events[3][1].role, 'owner');
    assert.notEqual(events[3][1].passwordHash, 'correct-horse-battery-staple');
    assert.equal(events[4][0], 'primary');
    assert.equal(events[5][0], 'audit');
    assert.equal(events[5][1].action, 'tenant_portal_owner_self_registered');
    assert.deepEqual(events[5][1].payload, { accountScope: 'client', billingState: 'unactivated' });
    assert.equal(JSON.stringify(events).includes('growth'), false);
    assert.equal(JSON.stringify(events).includes('bot.enabled'), false);
  });
});
