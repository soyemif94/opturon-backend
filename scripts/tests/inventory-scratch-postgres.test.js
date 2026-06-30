const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const { Client } = require('pg');

const POSTGRES_IMAGE = 'postgres:16-alpine';
const SCRATCH_DB = 'opturon_inventory_scratch';
const SCRATCH_USER = 'postgres';
const SCRATCH_PASSWORD = 'postgres';
const SCRATCH_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function runCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    ...options
  });
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function migrationEnv(dbUrl) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl,
    TOKENS_ENCRYPTION_KEY: SCRATCH_KEY,
    PORTAL_INTERNAL_KEY: 'scratch-internal-key'
  };
}

async function waitForPostgres(dbUrl, timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const client = new Client({ connectionString: dbUrl });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      try {
        await client.end();
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error('scratch_postgres_not_ready');
}

async function withScratchDatabase(testFn) {
  const containerName = `inventory-scratch-${Date.now()}`;
  const containerId = execFileSync(
    'docker',
    ['run', '--name', containerName, '-d', '-e', `POSTGRES_PASSWORD=${SCRATCH_PASSWORD}`, '-e', `POSTGRES_DB=${SCRATCH_DB}`, '-P', POSTGRES_IMAGE],
    { cwd: process.cwd(), encoding: 'utf8' }
  ).trim();

  try {
    const portOutput = execFileSync('docker', ['port', containerId, '5432/tcp'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    const mappedPort = portOutput.split(':').pop();
    const dbUrl = `postgresql://${SCRATCH_USER}:${SCRATCH_PASSWORD}@127.0.0.1:${mappedPort}/${SCRATCH_DB}`;

    await waitForPostgres(dbUrl);
    await testFn(dbUrl);
  } finally {
    try {
      execFileSync('docker', ['rm', '-f', '-v', containerId], { cwd: process.cwd() });
    } catch {}
  }
}

async function expectDbReject(client, sql, params, label) {
  let rejected = false;
  try {
    await client.query(sql, params);
  } catch {
    rejected = true;
  }
  assert.strictEqual(rejected, true, `${label} must be rejected`);
}

async function seedTenantAndProduct(client, suffix, stock = 0) {
  const clinic = await client.query(
    `INSERT INTO clinics(name, "externalTenantId", settings)
     VALUES ($1, $2, '{}'::jsonb)
     RETURNING id`,
    [`Inventory ${suffix}`, `tenant_inventory_${suffix}`]
  );
  const clinicId = clinic.rows[0].id;
  const product = await client.query(
    `INSERT INTO products("clinicId", name, description, price, currency, stock, status, metadata, "updatedAt")
     VALUES ($1::uuid, $2, NULL, 100, 'ARS', $3, 'active', '{"catalog":{}}'::jsonb, NOW())
     RETURNING id`,
    [clinicId, `Yogur scratch ${suffix}`, stock]
  );
  return { clinicId, productId: product.rows[0].id };
}

async function inspectSchema(client) {
  const tables = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('inventory_lots', 'inventory_movements')`
  );
  assert.strictEqual(tables.rowCount, 2, 'inventory tables must exist');

  const indexes = await client.query(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename IN ('inventory_lots', 'inventory_movements')`
  );
  for (const expected of [
    'idx_inventory_lots_tenant_product',
    'idx_inventory_lots_tenant_expires_at',
    'idx_inventory_lots_tenant_lot_number',
    'idx_inventory_lots_tenant_location',
    'uniq_inventory_lots_id_tenant_product',
    'idx_inventory_movements_tenant_created_at',
    'idx_inventory_movements_lot_created_at',
    'idx_inventory_movements_product_created_at'
  ]) {
    assert.ok(indexes.rows.some((row) => row.indexname === expected), `${expected} must exist`);
  }

  const constraints = await client.query(
    `SELECT conname
     FROM pg_constraint
     WHERE conname IN (
       'chk_inventory_lots_status',
       'chk_inventory_movements_type',
       'fk_inventory_lots_product_tenant',
       'fk_inventory_movements_product_tenant',
       'fk_inventory_movements_lot_tenant_product'
     )`
  );
  assert.strictEqual(constraints.rowCount, 5, 'inventory constraints must exist');
}

async function testConstraints(client) {
  const tenantA = await seedTenantAndProduct(client, 'a', 0);
  const tenantB = await seedTenantAndProduct(client, 'b', 0);

  await expectDbReject(
    client,
    `INSERT INTO inventory_lots("tenantId", "productId", "initialQuantity", "availableQuantity", status)
     VALUES ($1::uuid, $2::uuid, -1, 0, 'active')`,
    [tenantA.clinicId, tenantA.productId],
    'negative initial quantity'
  );
  await expectDbReject(
    client,
    `INSERT INTO inventory_lots("tenantId", "productId", "initialQuantity", "availableQuantity", status)
     VALUES ($1::uuid, $2::uuid, 1, -1, 'active')`,
    [tenantA.clinicId, tenantA.productId],
    'negative available quantity'
  );
  await expectDbReject(
    client,
    `INSERT INTO inventory_lots("tenantId", "productId", "initialQuantity", "availableQuantity", status)
     VALUES ($1::uuid, $2::uuid, 1, 1, 'unknown')`,
    [tenantA.clinicId, tenantA.productId],
    'invalid lot status'
  );
  await expectDbReject(
    client,
    `INSERT INTO inventory_lots("tenantId", "productId", "initialQuantity", "availableQuantity", status)
     VALUES ($1::uuid, gen_random_uuid(), 1, 1, 'active')`,
    [tenantA.clinicId],
    'missing product'
  );
  await expectDbReject(
    client,
    `INSERT INTO inventory_lots("tenantId", "productId", "initialQuantity", "availableQuantity", status)
     VALUES ($1::uuid, $2::uuid, 1, 1, 'active')`,
    [tenantA.clinicId, tenantB.productId],
    'cross-tenant product'
  );

  const lot = await client.query(
    `INSERT INTO inventory_lots("tenantId", "productId", "lotNumber", "initialQuantity", "availableQuantity", status)
     VALUES ($1::uuid, $2::uuid, 'A123', 10, 10, 'active')
     RETURNING id`,
    [tenantA.clinicId, tenantA.productId]
  );
  const lotId = lot.rows[0].id;

  await expectDbReject(
    client,
    `INSERT INTO inventory_movements("tenantId", "productId", "lotId", "movementType", quantity)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'manual_adjustment_out', 0)`,
    [tenantA.clinicId, tenantA.productId, lotId],
    'zero movement quantity'
  );
  await expectDbReject(
    client,
    `INSERT INTO inventory_movements("tenantId", "productId", "lotId", "movementType", quantity)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'sale', 1)`,
    [tenantA.clinicId, tenantA.productId, lotId],
    'unsupported movement type'
  );
  await expectDbReject(
    client,
    `INSERT INTO inventory_movements("tenantId", "productId", "lotId", "movementType", quantity)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'manual_adjustment_out', 1)`,
    [tenantB.clinicId, tenantB.productId, lotId],
    'cross-tenant lot movement'
  );
  await client.query(
    `INSERT INTO inventory_movements("tenantId", "productId", "lotId", "movementType", quantity, "quantityBefore", "quantityAfter")
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'purchase_receipt', 10, 0, 10)`,
    [tenantA.clinicId, tenantA.productId, lotId]
  );
  await expectDbReject(
    client,
    `DELETE FROM inventory_lots WHERE id = $1::uuid`,
    [lotId],
    'lot deletion with movements protected'
  );
}

async function testActivationAndConcurrency(dbUrl) {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = dbUrl;
  process.env.TOKENS_ENCRYPTION_KEY = SCRATCH_KEY;
  process.env.PORTAL_INTERNAL_KEY = 'scratch-internal-key';

  const { setPortalProductInventoryMode, createPortalInventoryLot, adjustPortalInventoryLot } = require('../../src/services/inventory-lots.service');
  const { query, closePool } = require('../../src/db/client');

  const seed = await seedTenantAndProduct({ query }, 'activation', 60);
  const tenantId = `tenant_inventory_activation`;

  const rejected = await setPortalProductInventoryMode(tenantId, seed.productId, { mode: 'lot_based' });
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'initial_lot_required');

  const activated = await setPortalProductInventoryMode(tenantId, seed.productId, {
    mode: 'lot_based',
    initialLot: {
      quantity: 60,
      lotNumber: 'INICIAL',
      receivedAt: new Date().toISOString()
    }
  });
  assert.strictEqual(activated.ok, true);
  assert.strictEqual(activated.product.inventoryTrackingMode, 'lot_based');
  assert.strictEqual(activated.product.stock, 60);

  const initialMovement = await query(
    `SELECT "movementType", quantity, "quantityBefore", "quantityAfter"
     FROM inventory_movements
     WHERE "productId" = $1::uuid
     ORDER BY "createdAt" ASC
     LIMIT 1`,
    [seed.productId]
  );
  assert.strictEqual(initialMovement.rows[0].movementType, 'initial_stock');
  assert.strictEqual(Number(initialMovement.rows[0].quantity), 60);

  const lotProduct = await seedTenantAndProduct({ query }, 'concurrency', 0);
  const created = await createPortalInventoryLot('tenant_inventory_concurrency', {
    productId: lotProduct.productId,
    lotNumber: 'CONCURRENCY',
    quantity: 10
  });
  assert.strictEqual(created.ok, true);

  const race = await Promise.allSettled([
    adjustPortalInventoryLot('tenant_inventory_concurrency', created.lot.id, {
      movementType: 'manual_adjustment_out',
      quantity: 7,
      reason: 'race A'
    }),
    adjustPortalInventoryLot('tenant_inventory_concurrency', created.lot.id, {
      movementType: 'manual_adjustment_out',
      quantity: 7,
      reason: 'race B'
    })
  ]);
  const raceResults = race.map((item) => (item.status === 'fulfilled' ? item.value : { ok: false, reason: item.reason?.message }));
  assert.strictEqual(raceResults.filter((result) => result.ok).length, 1);
  assert.strictEqual(raceResults.some((result) => result.reason === 'insufficient_lot_quantity'), true);

  const remaining = await query(`SELECT "availableQuantity" FROM inventory_lots WHERE id = $1::uuid`, [created.lot.id]);
  assert.strictEqual(Number(remaining.rows[0].availableQuantity), 3);

  const second = await createPortalInventoryLot('tenant_inventory_concurrency', {
    productId: lotProduct.productId,
    lotNumber: 'CONCURRENCY-2',
    quantity: 10
  });
  const pair = await Promise.all([
    adjustPortalInventoryLot('tenant_inventory_concurrency', second.lot.id, {
      movementType: 'manual_adjustment_out',
      quantity: 4,
      reason: 'pair A'
    }),
    adjustPortalInventoryLot('tenant_inventory_concurrency', second.lot.id, {
      movementType: 'manual_adjustment_out',
      quantity: 6,
      reason: 'pair B'
    })
  ]);
  assert.strictEqual(pair.every((result) => result.ok), true);
  const depleted = await query(`SELECT "availableQuantity", status FROM inventory_lots WHERE id = $1::uuid`, [second.lot.id]);
  assert.strictEqual(Number(depleted.rows[0].availableQuantity), 0);
  assert.strictEqual(depleted.rows[0].status, 'depleted');

  await closePool();
}

async function main() {
  await withScratchDatabase(async (dbUrl) => {
    runCommand('node', ['src/db/migrate.js'], { env: migrationEnv(dbUrl) });

    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await inspectSchema(client);
      await testConstraints(client);
    } finally {
      await client.end();
    }

    await testActivationAndConcurrency(dbUrl);
  });

  console.log('inventory-scratch-postgres.test.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
