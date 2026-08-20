const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { PGlite } = require('@electric-sql/pglite');

const root = process.cwd();

function mockModule(relativePath, exportsValue) {
  const resolved = require.resolve(path.join(root, relativePath));
  delete require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue
  };
  return resolved;
}

function loadInventoryRepository(db) {
  const dbClientPath = mockModule('src/db/client.js', {
    query: (text, params) => db.query(text, params),
    withTransaction: async (work) => work({ query: (text, params) => db.query(text, params) }),
    closePool: async () => {}
  });
  const repositoryPath = require.resolve(path.join(root, 'src/repositories/inventory-base.repository.js'));
  delete require.cache[repositoryPath];
  return {
    repository: require(repositoryPath),
    cachePaths: [repositoryPath, dbClientPath]
  };
}

async function createSchema(db) {
  await db.exec(`
    CREATE TABLE clinics (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE product_categories (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE products (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      price NUMERIC NOT NULL DEFAULT 0,
      "unitPrice" NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'ARS',
      "vatRate" NUMERIC NOT NULL DEFAULT 0,
      stock INTEGER NULL,
      status TEXT NOT NULL DEFAULT 'active',
      sku TEXT NULL,
      "internalCode" TEXT NULL,
      "categoryId" UUID NULL,
      metadata JSONB NULL DEFAULT '{}'::jsonb,
      "deletedAt" TIMESTAMPTZ NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE inventory_locations (
      id UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      "isPrimary" BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE inventory_balances (
      id UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "productId" UUID NOT NULL,
      "locationId" UUID NOT NULL,
      quantity NUMERIC NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE inventory_movements (
      id UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "productId" UUID NOT NULL,
      "movementType" TEXT NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE inventory_lots (
      id UUID PRIMARY KEY,
      "tenantId" UUID NOT NULL,
      "productId" UUID NOT NULL,
      "availableQuantity" NUMERIC NOT NULL DEFAULT 0
    );
  `);
}

async function insertProducts(db, products) {
  const batchSize = 100;
  for (let start = 0; start < products.length; start += batchSize) {
    const batch = products.slice(start, start + batchSize);
    const params = [];
    const values = batch.map((product) => {
      const offset = params.length;
      params.push(
        product.id,
        product.clinicId,
        product.name,
        product.stock,
        product.status,
        product.sku,
        product.internalCode,
        product.categoryId,
        JSON.stringify(product.metadata || {}),
        product.deletedAt || null,
        product.createdAt
      );
      return `(
        $${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}, NULL,
        10, 10, 'ARS', 0, $${offset + 4}, $${offset + 5}, $${offset + 6},
        $${offset + 7}, $${offset + 8}::uuid, $${offset + 9}::jsonb,
        $${offset + 10}::timestamptz, $${offset + 11}::timestamptz, $${offset + 11}::timestamptz
      )`;
    });

    await db.query(
      `INSERT INTO products (
         id, "clinicId", name, description, price, "unitPrice", currency, "vatRate",
         stock, status, sku, "internalCode", "categoryId", metadata, "deletedAt", "createdAt", "updatedAt"
       ) VALUES ${values.join(',')}`,
      params
    );
  }
}

async function seedInventory(db) {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const emptyTenant = randomUUID();
  const categoryA = randomUUID();
  const categoryB = randomUUID();
  const primaryA = randomUUID();
  const duplicatePrimaryA = randomUUID();
  const secondaryA = randomUUID();

  await db.query(
    `INSERT INTO clinics (id, name) VALUES ($1, 'Tenant A'), ($2, 'Tenant B'), ($3, 'Tenant empty')`,
    [tenantA, tenantB, emptyTenant]
  );
  await db.query(
    `INSERT INTO product_categories (id, "clinicId", name) VALUES ($1, $2, 'General'), ($3, $4, 'Other')`,
    [categoryA, tenantA, categoryB, tenantB]
  );
  await db.query(
    `INSERT INTO inventory_locations
       (id, "tenantId", code, name, "isPrimary", active, metadata, "createdAt", "updatedAt")
     VALUES
       ($1, $2, 'main', 'Principal', TRUE, TRUE, '{}'::jsonb, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
       ($3, $2, 'main-drift', 'Primary drift duplicate', TRUE, TRUE, '{}'::jsonb, '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
       ($4, $2, 'secondary', 'Secondary', FALSE, TRUE, '{}'::jsonb, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [primaryA, tenantA, duplicatePrimaryA, secondaryA]
  );

  const eligibleA = Array.from({ length: 505 }, (_, index) => ({
    id: randomUUID(),
    clinicId: tenantA,
    name: index === 249 ? 'Producto Especial Buscable' : `Producto ${String(index + 1).padStart(3, '0')}`,
    stock: index === 0 ? 1 : index === 1 ? 25 : 0,
    status: index === 504 ? 'archived' : 'active',
    sku: `SKU-${String(index + 1).padStart(4, '0')}`,
    internalCode: `A-${String(index + 1).padStart(4, '0')}`,
    categoryId: categoryA,
    metadata: { catalog: {} },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
  }));
  const excludedA = [
    {
      id: randomUUID(),
      clinicId: tenantA,
      name: 'Producto eliminado',
      stock: 100,
      status: 'active',
      sku: 'DELETED-1',
      internalCode: 'Z-9001',
      categoryId: categoryA,
      metadata: { catalog: {} },
      deletedAt: '2026-07-01T00:00:00Z',
      createdAt: '2026-07-01T00:00:00Z'
    },
    {
      id: randomUUID(),
      clinicId: tenantA,
      name: 'Producto por lotes',
      stock: 100,
      status: 'active',
      sku: 'LOT-BASED-1',
      internalCode: 'Z-9002',
      categoryId: categoryA,
      metadata: { catalog: { inventoryTrackingMode: 'lot_based' } },
      createdAt: '2026-07-02T00:00:00Z'
    }
  ];
  const productsB = Array.from({ length: 7 }, (_, index) => ({
    id: randomUUID(),
    clinicId: tenantB,
    name: `Tenant B product ${index + 1}`,
    stock: 50,
    status: 'active',
    sku: `B-${index + 1}`,
    internalCode: `B-${String(index + 1).padStart(4, '0')}`,
    categoryId: categoryB,
    metadata: { catalog: {} },
    createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString()
  }));
  await insertProducts(db, [...eligibleA, ...excludedA, ...productsB]);

  await db.query(
    `INSERT INTO inventory_balances
       (id, "tenantId", "productId", "locationId", quantity, metadata, "createdAt", "updatedAt")
     VALUES
       ($1, $2, $3, $4, 0, '{}'::jsonb, '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z'),
       ($5, $2, $3, $4, 0, '{}'::jsonb, '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z'),
       ($6, $2, $7, $8, 99, '{}'::jsonb, '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z')`,
    [randomUUID(), tenantA, eligibleA[1].id, primaryA, randomUUID(), randomUUID(), eligibleA[2].id, secondaryA]
  );

  const movementParams = [];
  const movementValues = Array.from({ length: 4 }, (_, index) => {
    const offset = movementParams.length;
    movementParams.push(randomUUID(), tenantA, eligibleA[0].id, index === 3 ? 'manual_increase' : 'opening_balance', `2026-05-0${index + 1}T00:00:00Z`);
    return `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}::uuid, $${offset + 4}, $${offset + 5}::timestamptz)`;
  });
  await db.query(
    `INSERT INTO inventory_movements (id, "tenantId", "productId", "movementType", "createdAt") VALUES ${movementValues.join(',')}`,
    movementParams
  );

  await db.query(
    `INSERT INTO inventory_lots (id, "tenantId", "productId", "availableQuantity")
     VALUES ($1, $2, $3, 1), ($4, $2, $3, 2), ($5, $2, $3, 3)`,
    [randomUUID(), tenantA, eligibleA[0].id, randomUUID(), randomUUID()]
  );

  return { tenantA, tenantB, emptyTenant, eligibleA, primaryA };
}

async function testRepositoryPaginationAndTotals() {
  const db = new PGlite();
  let cachePaths = [];
  try {
    await createSchema(db);
    const seeded = await seedInventory(db);
    const loaded = loadInventoryRepository(db);
    cachePaths = loaded.cachePaths;
    const { listInventoryBalancesByTenant } = loaded.repository;

    const page1 = await listInventoryBalancesByTenant(seeded.tenantA, { page: 1, pageSize: 50 });
    assert.equal(page1.page, 1);
    assert.equal(page1.pageSize, 50);
    assert.equal(page1.total, 505);
    assert.deepEqual(page1.summary, { totalProducts: 505, withStock: 1, withoutStock: 504 });
    assert.equal(page1.rows.length, 50);
    assert.equal(page1.rows[0].internalCode, 'A-0001');
    assert.equal(Number(page1.rows[0].balanceQuantity), 1, 'missing balance must fall back to products.stock');
    assert.equal(Number(page1.rows[1].balanceQuantity), 0, 'explicit zero balance must override legacy stock');
    assert.equal(page1.rows[0].lastMovementType, 'manual_increase', 'many movements must not duplicate the product');

    const page2 = await listInventoryBalancesByTenant(seeded.tenantA, { page: 2, pageSize: 50 });
    assert.equal(page2.rows.length, 50);
    assert.equal(page2.rows[0].internalCode, 'A-0051');
    assert.equal(page2.total, 505);
    assert.deepEqual(page2.summary, page1.summary);

    const page11 = await listInventoryBalancesByTenant(seeded.tenantA, { page: 11, pageSize: 50 });
    assert.equal(page11.rows.length, 5);
    assert.equal(page11.rows[0].internalCode, 'A-0501');
    assert.equal(page11.rows[4].internalCode, 'A-0505');
    assert.equal(page11.rows[4].status, 'archived', 'archived products remain in the current inventory scope');
    assert.equal(page11.total, 505);
    assert.deepEqual(page11.summary, page1.summary);

    const outside = await listInventoryBalancesByTenant(seeded.tenantA, { page: 12, pageSize: 50 });
    assert.equal(outside.rows.length, 0);
    assert.equal(outside.total, 505, 'metadata must survive an out-of-range page');
    assert.deepEqual(outside.summary, page1.summary);

    const withStock = await listInventoryBalancesByTenant(seeded.tenantA, { stockFilter: 'with_stock', page: 1, pageSize: 50 });
    assert.equal(withStock.total, 1);
    assert.equal(withStock.rows.length, 1);
    assert.deepEqual(withStock.summary, { totalProducts: 1, withStock: 1, withoutStock: 0 });

    const withoutStock = await listInventoryBalancesByTenant(seeded.tenantA, { stockFilter: 'without_stock', page: 1, pageSize: 100 });
    assert.equal(withoutStock.total, 504);
    assert.equal(withoutStock.rows.length, 100);
    assert.deepEqual(withoutStock.summary, { totalProducts: 504, withStock: 0, withoutStock: 504 });

    const searched = await listInventoryBalancesByTenant(seeded.tenantA, { search: 'especial', page: 1, pageSize: 50 });
    assert.equal(searched.total, 1);
    assert.equal(searched.rows.length, 1);
    assert.equal(searched.rows[0].name, 'Producto Especial Buscable');
    assert.deepEqual(searched.summary, { totalProducts: 1, withStock: 0, withoutStock: 1 });

    const otherTenant = await listInventoryBalancesByTenant(seeded.tenantB, { page: 1, pageSize: 50 });
    assert.equal(otherTenant.total, 7);
    assert.equal(otherTenant.rows.every((row) => row.clinicId === seeded.tenantB), true);

    const empty = await listInventoryBalancesByTenant(seeded.emptyTenant, {});
    assert.equal(empty.total, 0);
    assert.equal(empty.rows.length, 0);
    assert.deepEqual(empty.summary, { totalProducts: 0, withStock: 0, withoutStock: 0 });

    const invalidPagination = await listInventoryBalancesByTenant(seeded.tenantA, { page: '1.5', pageSize: 'invalid' });
    assert.equal(invalidPagination.page, 1);
    assert.equal(invalidPagination.pageSize, 50);
    assert.equal(invalidPagination.rows.length, 50);
    const cappedPagination = await listInventoryBalancesByTenant(seeded.tenantA, { page: 1, pageSize: 500 });
    assert.equal(cappedPagination.pageSize, 100);
    assert.equal(cappedPagination.rows.length, 100);
  } finally {
    for (const cachePath of cachePaths) delete require.cache[cachePath];
    await db.close();
  }
}

async function testServiceContractAndReadOnlyFastPath() {
  let transactionCalls = 0;
  let ensureCalls = 0;
  const writeCalls = [];
  const productSnapshot = { id: 'product-505', stock: 0, updatedAt: '2026-08-01T00:00:00.000Z' };
  const beforeProduct = JSON.stringify(productSnapshot);
  const touched = [];
  try {
    touched.push(mockModule('src/db/client.js', {
      withTransaction: async (work) => {
        transactionCalls += 1;
        return work({ mocked: true });
      }
    }));
    touched.push(mockModule('src/services/portal-context.service.js', {
      resolvePortalTenantContext: async (tenantId) => ({ ok: true, tenantId, clinic: { id: 'clinic-1' } })
    }));
    touched.push(mockModule('src/repositories/products.repository.js', {
      findProductById: async () => null,
      updateProduct: async () => { writeCalls.push('product'); return null; }
    }));
    touched.push(mockModule('src/repositories/portal-user-audit.repository.js', {
      createPortalUserAuditEvent: async () => { writeCalls.push('audit'); return null; }
    }));
    touched.push(mockModule('src/repositories/inventory.repository.js', {
      insertInventoryMovement: async () => { writeCalls.push('movement'); return null; }
    }));
    touched.push(mockModule('src/repositories/inventory-base.repository.js', {
      reserveNextInternalCodeNumber: async () => 0,
      findPrimaryInventoryLocation: async () => null,
      ensurePrimaryInventoryLocation: async () => {
        ensureCalls += 1;
        writeCalls.push('location');
        return { id: 'loc-1', code: 'main', name: 'Principal' };
      },
      ensureInventoryBalanceRow: async () => { writeCalls.push('balance_create'); return null; },
      updateInventoryBalanceQuantity: async () => { writeCalls.push('balance_update'); return null; },
      listInventoryBalancesByTenant: async () => ({
        page: 11,
        pageSize: 50,
        total: 505,
        summary: { totalProducts: 505, withStock: 1, withoutStock: 504 },
        rows: [{ id: 'product-505', clinicId: 'clinic-1', name: 'Last', stock: 0, balanceQuantity: 0, metadata: {} }]
      }),
      listInventoryMovementsByProductId: async () => [],
      listInventoryMovementsByTenant: async () => ({ total: 0, rows: [] }),
      findInventoryMovementByIdempotencyKey: async () => null
    }));

    const servicePath = require.resolve(path.join(root, 'src/services/inventory-base.service.js'));
    delete require.cache[servicePath];
    touched.push(servicePath);
    const { listPortalInventoryProducts } = require(servicePath);
    const result = await listPortalInventoryProducts('tenant-a', { page: 11, pageSize: 50 });

    assert.equal(result.total, 505, 'legacy total must remain available');
    assert.equal(result.page, 11, 'legacy page must remain available');
    assert.equal(result.pageSize, 50, 'legacy pageSize must remain available');
    assert.equal(result.products.length, 1, 'legacy products must remain available');
    assert.deepEqual(result.pagination, { page: 11, pageSize: 50, totalItems: 505, totalPages: 11 });
    assert.deepEqual(result.summary, { totalProducts: 505, withStock: 1, withoutStock: 504 });
    assert.equal(result.location, null, 'missing setup must be represented without creating a location');
    assert.equal(result.products[0].locationId, null, 'missing setup must not invent a location id');
    assert.equal(ensureCalls, 0, 'GET inventory must never create a missing primary location');
    assert.equal(transactionCalls, 0, 'GET inventory must not open a write transaction');
    assert.deepEqual(writeCalls, [], 'GET inventory must not write locations, balances, movements, audits or products');
    assert.equal(JSON.stringify(productSnapshot), beforeProduct, 'GET inventory must preserve product timestamps and values');

    const controller = fs.readFileSync(path.join(root, 'src/controllers/portal.controller.js'), 'utf8');
    assert.match(controller, /pagination: result\.pagination/);
    assert.match(controller, /summary: result\.summary/);
  } finally {
    for (const resolved of touched) delete require.cache[resolved];
  }
}

async function main() {
  await testRepositoryPaginationAndTotals();
  await testServiceContractAndReadOnlyFastPath();
  console.log('inventory-pagination-totals.test.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
