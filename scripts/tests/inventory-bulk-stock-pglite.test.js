const assert = require('assert');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..', '..');
const CLINIC_ID = '40000000-0000-4000-8000-000000000001';
const ACTOR_ID = '40000000-0000-4000-8000-000000000002';
const LOCATION_ID = '40000000-0000-4000-8000-000000000003';

function uuidFor(index) {
  return `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

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

async function scalar(db, sql, params = []) {
  const result = await db.query(sql, params);
  const row = result.rows[0] || {};
  return Number(Object.values(row)[0] || 0);
}

async function main() {
  const db = new PGlite();
  const touched = [];
  const counters = { begin: 0, commit: 0, rollback: 0, advisory: 0 };
  let failProductUpdateId = null;

  try {
    await db.exec(`
      CREATE TABLE product_categories (
        id UUID PRIMARY KEY,
        "clinicId" UUID NOT NULL,
        name TEXT NOT NULL
      );

      CREATE TABLE suppliers (
        id UUID PRIMARY KEY,
        "tenantId" UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        "tradeName" TEXT NULL,
        "legalName" TEXT NULL
      );

      CREATE TABLE products (
        id UUID PRIMARY KEY,
        "clinicId" UUID NOT NULL,
        name TEXT NOT NULL,
        description TEXT NULL,
        price NUMERIC(12,2) NOT NULL DEFAULT 0,
        "unitPrice" NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'ARS',
        "vatRate" NUMERIC(5,2) NOT NULL DEFAULT 0,
        stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
        status TEXT NOT NULL DEFAULT 'active',
        sku TEXT NULL,
        "internalCode" TEXT NULL,
        "categoryId" UUID NULL,
        "defaultSupplierId" UUID NULL,
        "expirationDate" DATE NULL,
        "discountPercentage" NUMERIC(5,2) NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        "deletedAt" TIMESTAMPTZ NULL,
        "deletedBy" UUID NULL,
        "deleteReason" TEXT NULL,
        "deletionMetadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (id, "clinicId")
      );

      CREATE TABLE product_internal_code_allocators (
        "clinicId" UUID PRIMARY KEY,
        "nextValue" INTEGER NOT NULL DEFAULT 0,
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
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE ("tenantId", code),
        UNIQUE (id, "tenantId")
      );
      CREATE UNIQUE INDEX inventory_locations_one_primary
        ON inventory_locations("tenantId") WHERE "isPrimary" = TRUE;

      CREATE TABLE inventory_balances (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "productId" UUID NOT NULL,
        "locationId" UUID NOT NULL,
        quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE ("tenantId", "productId", "locationId")
      );

      CREATE TABLE inventory_movements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "productId" UUID NOT NULL,
        "lotId" UUID NULL,
        "locationId" UUID NULL,
        "movementType" TEXT NOT NULL,
        quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
        "quantityBefore" NUMERIC(14,3) NULL CHECK ("quantityBefore" IS NULL OR "quantityBefore" >= 0),
        "quantityAfter" NUMERIC(14,3) NULL CHECK ("quantityAfter" IS NULL OR "quantityAfter" >= 0),
        "referenceType" TEXT NULL,
        "referenceId" UUID NULL,
        reason TEXT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        "createdBy" UUID NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "idempotencyKey" TEXT NULL,
        unit TEXT NULL,
        status TEXT NOT NULL DEFAULT 'posted',
        "reversalOfMovementId" UUID NULL,
        "reversedByMovementId" UUID NULL
      );
      CREATE UNIQUE INDEX inventory_movement_idempotency
        ON inventory_movements("tenantId", "movementType", "idempotencyKey")
        WHERE "idempotencyKey" IS NOT NULL;

      CREATE TABLE portal_user_audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" TEXT NOT NULL,
        "clinicId" UUID NOT NULL,
        "actorUserId" UUID NULL,
        "targetUserId" UUID NULL,
        action TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const dbClient = {
      query: (text, params) => db.query(text, params),
      withTransaction: async (work) => {
        await db.exec('BEGIN');
        counters.begin += 1;
        const client = {
          query: async (text, params) => {
            if (/pg_advisory_xact_lock/.test(String(text))) {
              counters.advisory += 1;
              return { rows: [{}] };
            }
            if (
              failProductUpdateId &&
              /^\s*UPDATE products\s/i.test(String(text)) &&
              String(params && params[0] || '').toLowerCase() === failProductUpdateId
            ) {
              throw new Error('forced late product update failure');
            }
            return db.query(text, params);
          }
        };
        try {
          const result = await work(client);
          await db.exec('COMMIT');
          counters.commit += 1;
          return result;
        } catch (error) {
          await db.exec('ROLLBACK');
          counters.rollback += 1;
          throw error;
        }
      }
    };
    touched.push(mockModule('src/db/client.js', dbClient));
    touched.push(
      mockModule('src/services/portal-context.service.js', {
        resolvePortalTenantContext: async (tenantId) => ({
          ok: true,
          tenantId,
          clinic: { id: CLINIC_ID, name: 'PGlite QA' }
        })
      })
    );

    for (const relativePath of [
      'src/repositories/products.repository.js',
      'src/repositories/portal-user-audit.repository.js',
      'src/repositories/inventory.repository.js',
      'src/repositories/inventory-base.repository.js',
      'src/services/inventory-base.service.js',
      'src/services/inventory-bulk-stock.service.js'
    ]) {
      clearModule(relativePath);
    }

    const productIds = Array.from({ length: 505 }, (_, index) => uuidFor(index + 1));
    const productParams = [];
    const productValues = productIds.map((productId, index) => {
      const base = productParams.length;
      productParams.push(
        productId,
        CLINIC_ID,
        `Producto ${index + 1}`,
        index === 0 ? 10 : index === 1 ? 5 : 0,
        index === 504 ? 'archived' : 'active',
        `SKU-${index + 1}`,
        `A-${String(index + 1).padStart(4, '0')}`,
        JSON.stringify({ catalog: { inventoryTrackingMode: 'legacy' } })
      );
      return `($${base + 1}::uuid,$${base + 2}::uuid,$${base + 3},0,0,'ARS',0,$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8}::jsonb,NOW(),NOW())`;
    });
    await db.query(
      `INSERT INTO products
       (id,"clinicId",name,price,"unitPrice",currency,"vatRate",stock,status,sku,"internalCode",metadata,"createdAt","updatedAt")
       VALUES ${productValues.join(',')}`,
      productParams
    );
    await db.query(
      `INSERT INTO inventory_locations
       (id,"tenantId",code,name,"isPrimary",active,metadata)
       VALUES ($1::uuid,$2::uuid,'main','Principal',TRUE,TRUE,'{}'::jsonb)`,
      [LOCATION_ID, CLINIC_ID]
    );

    const balanceParams = [];
    const balanceValues = productIds.map((productId, index) => {
      const base = balanceParams.length;
      balanceParams.push(CLINIC_ID, productId, LOCATION_ID, index === 0 ? 10 : index === 1 ? 5 : 0);
      return `($${base + 1}::uuid,$${base + 2}::uuid,$${base + 3}::uuid,$${base + 4},'{}'::jsonb)`;
    });
    await db.query(
      `INSERT INTO inventory_balances ("tenantId","productId","locationId",quantity,metadata)
       VALUES ${balanceValues.join(',')}`,
      balanceParams
    );

    const { createPortalInventoryBulkAdjustment } = require(path.join(root, 'src/services/inventory-bulk-stock.service.js'));
    const operationId = uuidFor(6001);
    const items = productIds.map((productId, index) => ({
      productId,
      expectedCurrentQuantity: index === 0 ? 10 : index === 1 ? 5 : 0,
      targetQuantity: index === 0 ? 0 : index === 1 ? 9 : index === 2 ? 0 : 1
    }));
    const payload = {
      idempotencyKey: operationId,
      reason: 'physical_count',
      note: 'PGlite 505',
      items
    };

    const first = await createPortalInventoryBulkAdjustment('tenant-pglite', payload, { actorId: ACTOR_ID });
    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);
    assert.deepStrictEqual(first.summary, {
      submittedItems: 505,
      changedItems: 504,
      unchangedItems: 1,
      increases: 503,
      reductions: 1,
      unitsAdded: 506,
      unitsRemoved: 10
    });
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_balances'), 505);
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'), 504);
    assert.equal(await scalar(db, `SELECT COUNT(*) FROM portal_user_audit_log WHERE action = 'inventory_correction_created'`), 504);
    assert.equal(await scalar(db, `SELECT COUNT(*) FROM portal_user_audit_log WHERE action = 'inventory_bulk_stock_adjusted'`), 1);
    assert.equal(await scalar(db, 'SELECT stock FROM products WHERE id = $1::uuid', [productIds[0]]), 0);
    assert.equal(await scalar(db, 'SELECT quantity FROM inventory_balances WHERE "productId" = $1::uuid', [productIds[0]]), 0);
    assert.equal(await scalar(db, 'SELECT stock FROM products WHERE id = $1::uuid', [productIds[1]]), 9);
    assert.equal(await scalar(db, 'SELECT quantity FROM inventory_balances WHERE "productId" = $1::uuid', [productIds[1]]), 9);
    assert.equal(await scalar(db, `SELECT COUNT(*) FROM inventory_movements WHERE metadata ->> 'bulkOperationId' = $1`, [operationId]), 504);
    assert.equal(await scalar(db, `SELECT COUNT(*) FROM inventory_movements WHERE "createdBy" = $1::uuid`, [ACTOR_ID]), 504);
    assert.equal(await scalar(db, `SELECT COUNT(*) FROM inventory_movements WHERE "referenceType" = 'inventory_bulk_stock' AND "referenceId" = $1::uuid`, [operationId]), 504);
    const decrease = await db.query(
      `SELECT quantity::int AS quantity, "quantityBefore"::int AS before, "quantityAfter"::int AS after
       FROM inventory_movements WHERE "productId" = $1::uuid`,
      [productIds[0]]
    );
    assert.deepStrictEqual(decrease.rows[0], { quantity: 10, before: 10, after: 0 });
    assert.deepStrictEqual(counters, { begin: 1, commit: 1, rollback: 0, advisory: 1 });

    const replay = await createPortalInventoryBulkAdjustment('tenant-pglite', payload, { actorId: ACTOR_ID });
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent, true);
    assert.deepStrictEqual(replay.summary, first.summary);
    assert.deepStrictEqual(replay.items, first.items);
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'), 504);
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM portal_user_audit_log'), 505);
    assert.deepStrictEqual(counters, { begin: 2, commit: 2, rollback: 0, advisory: 2 });

    const mismatch = await createPortalInventoryBulkAdjustment(
      'tenant-pglite',
      { ...payload, note: 'Payload distinto' },
      { actorId: ACTOR_ID }
    );
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'inventory_bulk_idempotency_payload_mismatch');
    assert.equal(await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'), 504);
    assert.deepStrictEqual(counters, { begin: 3, commit: 2, rollback: 1, advisory: 3 });

    const countsBeforeConflict = {
      movements: await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'),
      audits: await scalar(db, 'SELECT COUNT(*) FROM portal_user_audit_log'),
      firstProduct: await scalar(db, 'SELECT stock FROM products WHERE id = $1::uuid', [productIds[0]]),
      firstBalance: await scalar(db, 'SELECT quantity FROM inventory_balances WHERE "productId" = $1::uuid', [productIds[0]])
    };
    const optimisticConflict = await createPortalInventoryBulkAdjustment(
      'tenant-pglite',
      {
        idempotencyKey: uuidFor(6002),
        reason: 'inventory_correction',
        note: 'Conflicto optimista',
        items: [
          { productId: productIds[0], expectedCurrentQuantity: 0, targetQuantity: 2 },
          { productId: productIds[1], expectedCurrentQuantity: 8, targetQuantity: 12 }
        ]
      },
      { actorId: ACTOR_ID }
    );
    assert.equal(optimisticConflict.ok, false);
    assert.equal(optimisticConflict.reason, 'inventory_changed');
    assert.deepStrictEqual(
      {
        movements: await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'),
        audits: await scalar(db, 'SELECT COUNT(*) FROM portal_user_audit_log'),
        firstProduct: await scalar(db, 'SELECT stock FROM products WHERE id = $1::uuid', [productIds[0]]),
        firstBalance: await scalar(db, 'SELECT quantity FROM inventory_balances WHERE "productId" = $1::uuid', [productIds[0]])
      },
      countsBeforeConflict,
      'all expected quantities must be checked before the first write'
    );
    assert.deepStrictEqual(counters, { begin: 4, commit: 2, rollback: 2, advisory: 4 });

    const countsBeforeLateRollback = {
      movements: await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'),
      audits: await scalar(db, 'SELECT COUNT(*) FROM portal_user_audit_log'),
      firstProduct: await scalar(db, 'SELECT stock FROM products WHERE id = $1::uuid', [productIds[0]]),
      firstBalance: await scalar(db, 'SELECT quantity FROM inventory_balances WHERE "productId" = $1::uuid', [productIds[0]]),
      secondProduct: await scalar(db, 'SELECT stock FROM products WHERE id = $1::uuid', [productIds[1]]),
      secondBalance: await scalar(db, 'SELECT quantity FROM inventory_balances WHERE "productId" = $1::uuid', [productIds[1]])
    };
    failProductUpdateId = productIds[1];
    try {
      await assert.rejects(
        () => createPortalInventoryBulkAdjustment(
          'tenant-pglite',
          {
            idempotencyKey: uuidFor(6003),
            reason: 'inventory_correction',
            note: 'Falla tardia forzada',
            items: [
              { productId: productIds[0], expectedCurrentQuantity: 0, targetQuantity: 2 },
              { productId: productIds[1], expectedCurrentQuantity: 9, targetQuantity: 12 }
            ]
          },
          { actorId: ACTOR_ID }
        ),
        /forced late product update failure/
      );
    } finally {
      failProductUpdateId = null;
    }
    assert.deepStrictEqual(
      {
        movements: await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'),
        audits: await scalar(db, 'SELECT COUNT(*) FROM portal_user_audit_log'),
        firstProduct: await scalar(db, 'SELECT stock FROM products WHERE id = $1::uuid', [productIds[0]]),
        firstBalance: await scalar(db, 'SELECT quantity FROM inventory_balances WHERE "productId" = $1::uuid', [productIds[0]]),
        secondProduct: await scalar(db, 'SELECT stock FROM products WHERE id = $1::uuid', [productIds[1]]),
        secondBalance: await scalar(db, 'SELECT quantity FROM inventory_balances WHERE "productId" = $1::uuid', [productIds[1]])
      },
      countsBeforeLateRollback,
      'a failure after the first item writes must roll back products, balances, movements and audits'
    );
    assert.deepStrictEqual(counters, { begin: 5, commit: 2, rollback: 3, advisory: 5 });

    const noopProductId = uuidFor(7001);
    await db.query(
      `INSERT INTO products
       (id,"clinicId",name,price,"unitPrice",currency,"vatRate",stock,status,sku,"internalCode",metadata,"createdAt","updatedAt")
       VALUES ($1::uuid,$2::uuid,'Sin cambios',0,0,'ARS',0,7,'active','NOOP',NULL,$3::jsonb,NOW(),NOW())`,
      [noopProductId, CLINIC_ID, JSON.stringify({ catalog: { inventoryTrackingMode: 'legacy' } })]
    );
    const noopBefore = {
      products: await scalar(db, 'SELECT COUNT(*) FROM products'),
      balances: await scalar(db, 'SELECT COUNT(*) FROM inventory_balances'),
      movements: await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'),
      audits: await scalar(db, 'SELECT COUNT(*) FROM portal_user_audit_log'),
      locations: await scalar(db, 'SELECT COUNT(*) FROM inventory_locations')
    };
    const noop = await createPortalInventoryBulkAdjustment(
      'tenant-pglite',
      {
        idempotencyKey: uuidFor(7002),
        reason: 'physical_count',
        note: 'No-op real',
        items: [{ productId: noopProductId, expectedCurrentQuantity: 7, targetQuantity: 7 }]
      },
      { actorId: ACTOR_ID }
    );
    assert.equal(noop.ok, true);
    assert.equal(noop.location, null);
    assert.equal(noop.summary.changedItems, 0);
    assert.deepStrictEqual(
      {
        products: await scalar(db, 'SELECT COUNT(*) FROM products'),
        balances: await scalar(db, 'SELECT COUNT(*) FROM inventory_balances'),
        movements: await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'),
        audits: await scalar(db, 'SELECT COUNT(*) FROM portal_user_audit_log'),
        locations: await scalar(db, 'SELECT COUNT(*) FROM inventory_locations')
      },
      noopBefore,
      'all-noop payload must not materialize location/balance, movement, product code or audit rows'
    );
    const noopProduct = await db.query('SELECT stock, "internalCode" FROM products WHERE id = $1::uuid', [noopProductId]);
    assert.equal(noopProduct.rows[0].stock, 7);
    assert.equal(noopProduct.rows[0].internalCode, null);
    assert.deepStrictEqual(counters, { begin: 6, commit: 3, rollback: 3, advisory: 6 });

    const staleNoopProductId = uuidFor(7011);
    await db.query(
      `INSERT INTO products
       (id,"clinicId",name,price,"unitPrice",currency,"vatRate",stock,status,sku,"internalCode",metadata,"createdAt","updatedAt")
       VALUES ($1::uuid,$2::uuid,'No-op stale',0,0,'ARS',0,5,'active','STALE-NOOP',NULL,$3::jsonb,NOW(),NOW())`,
      [staleNoopProductId, CLINIC_ID, JSON.stringify({ catalog: { inventoryTrackingMode: 'legacy' } })]
    );
    const staleBefore = {
      balances: await scalar(db, 'SELECT COUNT(*) FROM inventory_balances'),
      movements: await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'),
      audits: await scalar(db, 'SELECT COUNT(*) FROM portal_user_audit_log'),
      locations: await scalar(db, 'SELECT COUNT(*) FROM inventory_locations')
    };
    const staleNoop = await createPortalInventoryBulkAdjustment(
      'tenant-pglite',
      {
        idempotencyKey: uuidFor(7012),
        reason: 'physical_count',
        note: 'No-op stale real',
        items: [{ productId: staleNoopProductId, expectedCurrentQuantity: 7, targetQuantity: 7 }]
      },
      { actorId: ACTOR_ID }
    );
    assert.equal(staleNoop.ok, false);
    assert.equal(staleNoop.reason, 'inventory_changed');
    assert.deepStrictEqual(staleNoop.details, {
      productId: staleNoopProductId,
      expectedCurrentQuantity: 7,
      currentQuantity: 5
    });
    assert.deepStrictEqual(
      {
        balances: await scalar(db, 'SELECT COUNT(*) FROM inventory_balances'),
        movements: await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'),
        audits: await scalar(db, 'SELECT COUNT(*) FROM portal_user_audit_log'),
        locations: await scalar(db, 'SELECT COUNT(*) FROM inventory_locations')
      },
      staleBefore,
      'stale all-noop validation must remain write-free'
    );
    const staleNoopProduct = await db.query(
      'SELECT stock, "internalCode" FROM products WHERE id = $1::uuid',
      [staleNoopProductId]
    );
    assert.equal(staleNoopProduct.rows[0].stock, 5);
    assert.equal(staleNoopProduct.rows[0].internalCode, null);
    assert.deepStrictEqual(counters, { begin: 7, commit: 3, rollback: 4, advisory: 7 });

    const mixedStale = await createPortalInventoryBulkAdjustment(
      'tenant-pglite',
      {
        idempotencyKey: uuidFor(7013),
        reason: 'inventory_correction',
        note: 'Mixto stale real',
        items: [
          { productId: productIds[0], expectedCurrentQuantity: 0, targetQuantity: 2 },
          { productId: staleNoopProductId, expectedCurrentQuantity: 7, targetQuantity: 7 }
        ]
      },
      { actorId: ACTOR_ID }
    );
    assert.equal(mixedStale.ok, false);
    assert.equal(mixedStale.reason, 'inventory_changed');
    assert.equal(mixedStale.details.productId, staleNoopProductId);
    assert.equal(await scalar(db, 'SELECT stock FROM products WHERE id = $1::uuid', [productIds[0]]), 0);
    assert.equal(await scalar(db, 'SELECT quantity FROM inventory_balances WHERE "productId" = $1::uuid', [productIds[0]]), 0);
    assert.deepStrictEqual(
      {
        balances: await scalar(db, 'SELECT COUNT(*) FROM inventory_balances'),
        movements: await scalar(db, 'SELECT COUNT(*) FROM inventory_movements'),
        audits: await scalar(db, 'SELECT COUNT(*) FROM portal_user_audit_log'),
        locations: await scalar(db, 'SELECT COUNT(*) FROM inventory_locations')
      },
      staleBefore,
      'a stale no-op in a mixed payload must prevent every write'
    );
    assert.deepStrictEqual(counters, { begin: 8, commit: 3, rollback: 5, advisory: 8 });

    console.log('inventory-bulk-stock-pglite.test.js passed');
  } finally {
    for (const relativePath of [
      'src/services/inventory-bulk-stock.service.js',
      'src/services/inventory-base.service.js',
      'src/repositories/inventory-base.repository.js',
      'src/repositories/inventory.repository.js',
      'src/repositories/portal-user-audit.repository.js',
      'src/repositories/products.repository.js'
    ]) {
      clearModule(relativePath);
    }
    for (const resolved of touched) delete require.cache[resolved];
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
