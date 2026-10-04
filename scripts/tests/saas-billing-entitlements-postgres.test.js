const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { resolveEffectiveEntitlements: resolve, canCapability: can } = require('../../src/services/effective-entitlements');
test('BILL-008 real PostgreSQL migration, module/tool boundary and settings security', async t => {
  const url = new URL(process.env.BILLING_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, 'billing_test'); assert.equal(url.password, '');
  const schema = `entitlement_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}` });
  const root = path.resolve(__dirname, '../..'), originals = new Map();
  const stub = (name, exports) => {
    const id = require.resolve(path.join(root, name)); originals.set(id, require.cache[id]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  const id = crypto.randomUUID(), otherId = crypto.randomUUID(), malformedId = crypto.randomUUID(), invalidRootId = crypto.randomUUID();
  const current = async () => (await pool.query('SELECT * FROM clinics WHERE id=$1',[id])).rows[0];
  const replace = value => pool.query('UPDATE clinics SET settings=$2::jsonb WHERE id=$1',[id,JSON.stringify(value)]);
  try {
    await pool.query('CREATE TABLE clinics(id UUID PRIMARY KEY,name TEXT,timezone TEXT,"externalTenantId" TEXT,settings JSONB,"updatedAt" TIMESTAMPTZ)');
    for (const prefix of ['050_', '085_', '086_', '087_', '088_', '089_']) {
      const name = fs.readdirSync(path.join(root,'db/migrations')).find(name => name.startsWith(prefix));
      await pool.query(fs.readFileSync(path.join(root,'db/migrations',name),'utf8'));
    }
    const legacy = { bot: { enabled: false }, untouched: { configuration: true }, portal: {
      policy: { planCode: 'empresa', policyVersion: 1, capabilities: ['inbox','inventory'], enabledModules: { inventory: true } }
    } };
    const malformed = { botActive:false, portal:{ policy:{ policyVersion:1, capabilities:{ inventory:true }, enabledModules:{ inventory:true } } } };
    await pool.query('INSERT INTO clinics(id,"externalTenantId",settings) VALUES ($1,\'tenant-a\',$2::jsonb),($3,\'tenant-b\',\'{}\'),($4,\'tenant-malformed\',$5::jsonb),($6,\'tenant-invalid-root\',$7::jsonb)',
      [id,JSON.stringify(legacy),otherId,malformedId,JSON.stringify(malformed),invalidRootId,JSON.stringify([])]);
    const revision = (await current()).billingEntitlementRevision;
    await pool.query(fs.readFileSync(path.join(root,'db/migrations/090_canonical_plan_entitlements.sql'),'utf8'));
    await t.test('Z/AA migration freezes permissions, preserves config and explicit disabled Bot without guessing Empresa', async () => {
      const row = await current(), effective = resolve(row.settings);
      assert.equal(row.billingEntitlementRevision, revision);
      assert.deepEqual(row.settings.untouched, legacy.untouched); assert.deepEqual(row.settings.portal.policy, legacy.portal.policy);
      assert.equal(row.settings.botActive, false); assert.equal(effective.planKey, 'legacy_grandfathered');
      assert.equal(can(effective, 'inventory'), true); assert.equal(can(effective, 'catalog'), false);
      assert.equal(can(effective, 'orders'), false);
    });
    await t.test('malformed legacy capability containers fail closed without rewriting malformed tenant settings', async () => {
      const malformedRow = (await pool.query('SELECT settings FROM clinics WHERE id=$1',[malformedId])).rows[0];
      assert.equal(resolve(malformedRow.settings).planKey,'legacy_grandfathered');
      assert.equal(can(resolve(malformedRow.settings),'inventory'),false);
      const invalidRoot = (await pool.query('SELECT settings FROM clinics WHERE id=$1',[invalidRootId])).rows[0].settings;
      assert.deepEqual(invalidRoot,[]); assert.equal(resolve(invalidRoot).planKey,null);
    });
    stub('src/db/client.js', { query: (sql,args) => pool.query(sql,args) });
    stub('src/services/portal-context.service.js', { resolvePortalTenantContext: async tenantId => {
      if (tenantId !== 'tenant-a') return { ok: false, reason: 'tenant_mapping_not_found' };
      return { ok: true, clinic: await current() };
    } });
    const tenantRepo = require('../../src/repositories/tenant.repository');
    const botSettings = require('../../src/services/portal-bot-settings.service');
    await t.test('K strictly closed settings payload denies capability/tier injection before writes', async () => {
      const before = await current();
      for (const payload of [{ botActive: 'true' },{ botActive: true, inventory: true },{ enterprise: true },
        { 'bot.tier': 'custom' },{ botConfig: { tier: 'custom' } },{ botConfig: [] },{ entitlements: {} }]) {
        assert.equal((await botSettings.updatePortalBotSettings('tenant-a',payload)).reason, 'invalid_bot_settings_payload');
      }
      assert.deepEqual(await current(), before);
    });
    const canonical = key => ({ botActive: true, portal: { entitlements: { source: 'billing', planKey:key, entitlementProfileVersion:1 } } });
    await t.test('F tenant Bot preference can persist without granting Core capabilities; cannot target foreign tenant', async () => {
      await replace(canonical('core'));
      assert.equal((await botSettings.updatePortalBotSettings('tenant-b',{ botActive:true })).ok, false);
      assert.equal((await botSettings.updatePortalBotSettings('tenant-a',{ botActive:true })).ok,true);
      assert.equal(can(resolve((await current()).settings), 'bot.enabled'),false);
      const other = (await pool.query('SELECT settings FROM clinics WHERE id=$1',[otherId])).rows[0];
      assert.equal(other.settings.botActive,true); // same migration default, never rewritten by tenant-a
      assert.equal((await tenantRepo.getClinicBotSettingsById(id)).settings.botActive,true);
    });
    await t.test('G/H/I/J actual tool invocation never reaches denied repository and reflects fresh suspension', async () => {
      const { guardedBotTool, guardedProducts } = require('../../src/services/bot-entitlement-guard');
      let calls = 0;
      const inventory = guardedBotTool(async () => { calls++; return 'real-tool'; },'inventory', () => id);
      const catalog = guardedBotTool(async () => { calls++; return 'catalog'; },'catalog', () => id);
      await replace(canonical('core')); assert.equal(await catalog(),null);
      await replace(canonical('growth')); assert.equal(await inventory(),null); assert.equal(await catalog(),'catalog');
      await replace(canonical('distribution')); assert.equal(await inventory(),'real-tool');
      const suspended = canonical('distribution'); suspended.portal.billing={entitlement:{state:'suspended_for_nonpayment',paidAccessAllowed:false}};
      await replace(suspended); assert.equal(await inventory(),null); assert.equal(calls,2);
      await replace(canonical('growth'));
      const products = guardedProducts({ listProductsByClinicId: async () => [{ id:'p1', name:'Item', stock:7,
        cost:3, defaultSupplierId:'s1', inventoryTrackingMode:'lot_based', expirationDate:'2026-12-01',
        metadata:{ shortDescription:'public detail', catalog:{ cost:3, defaultSupplier:'private vendor', shortDescription:'catalog detail' } } }] });
      const projected = (await products.listProductsByClinicId(id))[0];
      assert.equal(projected.stock,null); assert.equal(projected.stockVisible,false); assert.equal(projected.cost,null);
      assert.equal(projected.defaultSupplierId,null); assert.equal(projected.inventoryTrackingMode,null);
      assert.deepEqual(projected.metadata,{ shortDescription:'public detail', catalog:{ shortDescription:'catalog detail' } });
      await replace(canonical('distribution'));
      assert.equal((await products.listProductsByClinicId(id))[0].stock,7);
    });
    await t.test('M/N/O/P/Q real middleware enforces Core/Growth/Distribution and suspension without cache', async () => {
      stub('src/services/tenant-policy.service.js', { resolveTenantPolicyByExternalTenantId: async tenant => {
        if (tenant !== 'tenant-a') return { ok:false };
        const row=await current(); return { ok:true,clinic:row,policy:{entitlements:resolve(row.settings),billingEntitlement:row.settings.portal.billing?.entitlement} };
      }, isModuleEnabled: (policy, key) => can(policy.entitlements,key) });
      const { requirePortalCapability } = require('../../src/middlewares/portal-module-gate.middleware');
      async function request(capability='inventory',tenant='tenant-a') {
        let status = 200; const res = { status: value => {status=value;return res;}, json: () => {} };
        await requirePortalCapability(capability)({activeTenantId:tenant,params:{}},res,()=>{}); return status;
      }
      for (const [key,status] of [['core',403],['growth',403],['distribution',200]]) { await replace(canonical(key)); assert.equal(await request(),status); }
      const suspended=canonical('distribution'); suspended.portal.billing={entitlement:{state:'suspended_for_nonpayment',paidAccessAllowed:false}};
      await replace(suspended); assert.equal(await request(),403);
      await replace(canonical('distribution')); assert.equal(await request(),200);
      assert.equal(await request('unknown'),403); assert.equal(await request('inventory','tenant-b'),403);
    });
    await t.test('authoritative profile changes advance BILL-007 revision; preference updates do not', async () => {
      const before = await current(); await tenantRepo.updateClinicBotActiveById(id,false);
      assert.equal((await current()).billingEntitlementRevision,before.billingEntitlementRevision);
      await replace(canonical('growth'));
      assert.equal(BigInt((await current()).billingEntitlementRevision),BigInt(before.billingEntitlementRevision)+1n);
    });
  } finally {
    for (const [id,entry] of originals) { if (entry) require.cache[id]=entry; else delete require.cache[id]; }
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
