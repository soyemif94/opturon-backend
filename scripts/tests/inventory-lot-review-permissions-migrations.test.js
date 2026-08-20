const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function mockModule(relativePath, exportsValue) {
  const resolved = require.resolve(path.join(root, relativePath));
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue
  };
  return resolved;
}

function clearModule(relativePath) {
  const resolved = require.resolve(path.join(root, relativePath));
  delete require.cache[resolved];
}

async function testSensitiveInventoryRoles() {
  const touched = [];
  let actorRole = 'owner';
  try {
    touched.push(
      mockModule('src/services/portal-active-tenant.service.js', {
        hasPortalInternalAuth: () => true,
        findPortalActorContext: async () => ({ id: 'actor-1', role: actorRole, tenantId: 'tenant-1', isAdmin: false })
      })
    );
    clearModule('src/middlewares/portal-inventory-authorization.middleware.js');
    const { requireSensitiveInventoryRole } = require(path.join(root, 'src/middlewares/portal-inventory-authorization.middleware.js'));
    const middleware = requireSensitiveInventoryRole();

    const allowedReq = {
      params: { tenantId: 'tenant-1' },
      get: (header) => (header === 'x-portal-actor-id' ? 'actor-1' : '')
    };
    const allowedRes = {
      status() {
        return this;
      },
      json(payload) {
        return payload;
      }
    };
    let allowedNext = false;
    await middleware(allowedReq, allowedRes, () => {
      allowedNext = true;
    });
    assert.strictEqual(allowedNext, true);

    const deniedPayloads = [];
    const deniedReq = {
      params: { tenantId: 'tenant-1' },
      get: (header) => {
        if (header === 'x-portal-actor-id') return 'actor-2';
        return '';
      }
    };
    const deniedRes = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        deniedPayloads.push(payload);
        return payload;
      }
    };
    actorRole = 'seller';
    await middleware(deniedReq, deniedRes, () => {});
    assert.strictEqual(deniedRes.statusCode, 403);
    assert.strictEqual(deniedPayloads[0].error, 'portal_inventory_role_forbidden');
  } finally {
    clearModule('src/middlewares/portal-inventory-authorization.middleware.js');
    for (const resolved of touched) delete require.cache[resolved];
  }
}

function testMigrationsAndScripts() {
  const migration067 = fs.readFileSync(path.join(root, 'db/migrations/067_inventory_lot_location_and_uniqueness.sql'), 'utf8');
  const migration068 = fs.readFileSync(path.join(root, 'db/migrations/068_inventory_lot_operational_state.sql'), 'utf8');
  const migration069 = fs.readFileSync(path.join(root, 'db/migrations/069_inventory_lot_operation_idempotency.sql'), 'utf8');
  const reportScript = fs.readFileSync(path.join(root, 'scripts/report-inventory-lot-consistency.js'), 'utf8');
  const backfillScript = fs.readFileSync(path.join(root, 'scripts/backfill-inventory-lot-locations.js'), 'utf8');
  const preflightLib = fs.readFileSync(path.join(root, 'scripts/lib/inventory-lot-preflight.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');

  assert.match(migration067, /ADD COLUMN IF NOT EXISTS "locationId" UUID NULL/);
  assert.match(migration067, /ADD COLUMN IF NOT EXISTS "normalizedLotNumber" TEXT NULL/);
  assert.match(migration067, /FOREIGN KEY \("locationId", "tenantId"\)/);
  assert.doesNotMatch(migration067, /CREATE UNIQUE INDEX .*normalizedLotNumber/i);

  assert.match(migration068, /ADD COLUMN IF NOT EXISTS "operationalStatus" TEXT NULL/);
  assert.match(migration068, /CHECK \("operationalStatus" IS NULL OR "operationalStatus" IN \('active', 'blocked', 'written_off'\)\)/);
  assert.doesNotMatch(migration068, /DEFAULT 'active'/);

  assert.match(migration069, /CREATE TABLE IF NOT EXISTS inventory_lot_operations/);
  assert.match(migration069, /"idempotencyKey" TEXT NOT NULL/);
  assert.match(migration069, /CHECK \(status IN \('pending', 'processing', 'completed', 'partially_completed', 'failed'\)\)/);
  assert.match(migration069, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_lot_operations_tenant_type_key/);

  assert.match(reportScript, /runInventoryLotConsistencyReport/);
  assert.match(preflightLib, /SET TRANSACTION READ ONLY/);
  assert.match(preflightLib, /conflicting_physical_identity/);
  assert.match(preflightLib, /written_off_with_quantity/);

  assert.match(backfillScript, /runInventoryLotLocationBackfill/);
  assert.match(preflightLib, /if \(!args\.apply \|\| args\.readOnly\) \{\s*await client\.query\('SET TRANSACTION READ ONLY'\);/);
  assert.match(preflightLib, /if \(args\.apply\) await client\.query\('COMMIT'\);\s*else await client\.query\('ROLLBACK'\);/);

  assert.match(routes, /requireSensitiveInventoryRole/);
  assert.match(routes, /inventory\/lots\/:lotId\/block', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole/);
}

Promise.resolve()
  .then(testSensitiveInventoryRoles)
  .then(() => testMigrationsAndScripts())
  .then(() => {
    console.log('inventory-lot-review-permissions-migrations.test.js passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
