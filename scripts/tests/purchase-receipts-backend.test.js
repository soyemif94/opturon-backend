const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { PGlite } = require('@electric-sql/pglite');

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {}
}

function sanitizeMigration(source) {
  return source.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/gi, '');
}

function installPortalContextStub(tenantMap) {
  const modulePath = path.join(root, 'src/services/portal-context.service.js');
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: {
      resolvePortalTenantContext: async (tenantId) => {
        const clinic = tenantMap.get(String(tenantId || '').trim());
        if (!clinic) return { ok: false, tenantId, clinic: null, reason: 'tenant_mapping_not_found' };
        return {
          ok: true,
          tenantId: String(tenantId || '').trim(),
          clinic: {
            ...clinic,
            id: clinic.clinicId
          }
        };
      }
    }
  };
}

function installDbClientStub(db) {
  const modulePath = path.join(root, 'src/db/client.js');
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: {
      query: (text, params) => db.query(text, params),
      withTransaction: async (fn) => {
        await db.exec('BEGIN');
        try {
          const client = {
            query: (text, params) => db.query(text, params)
          };
          const result = await fn(client);
          await db.exec('COMMIT');
          return result;
        } catch (error) {
          await db.exec('ROLLBACK');
          throw error;
        }
      },
      closePool: async () => {
        await db.close();
      }
    }
  };
}

function loadPurchaseReceiptsServices(db, tenantMap) {
  clearModule('./src/db/client.js');
  clearModule('./src/services/portal-context.service.js');
  clearModule('./src/services/purchase-receipts.service.js');
  clearModule('./src/services/inventory-base.service.js');
  clearModule('./src/services/inventory-lots.service.js');
  clearModule('./src/repositories/purchase-receipts.repository.js');
  clearModule('./src/repositories/products.repository.js');
  clearModule('./src/repositories/suppliers.repository.js');
  clearModule('./src/repositories/inventory.repository.js');
  clearModule('./src/repositories/inventory-base.repository.js');
  clearModule('./src/repositories/inventory-lot-operations.repository.js');
  clearModule('./src/repositories/portal-user-audit.repository.js');
  clearModule('./src/repositories/tenant.repository.js');

  installDbClientStub(db);
  installPortalContextStub(tenantMap);

  return require(path.join(root, 'src/services/purchase-receipts.service.js'));
}

async function createBaseSchema(db) {
  await db.exec(`
    CREATE FUNCTION gen_random_uuid() RETURNS uuid AS $$
      SELECT (
        substr(md5(random()::text || clock_timestamp()::text), 1, 8) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 1, 4) || '-' ||
        '4' || substr(md5(random()::text || clock_timestamp()::text), 1, 3) || '-' ||
        '8' || substr(md5(random()::text || clock_timestamp()::text), 1, 3) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 1, 12)
      )::uuid;
    $$ LANGUAGE SQL;

    CREATE TABLE clinics (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'America/Buenos_Aires',
      "externalTenantId" TEXT NOT NULL UNIQUE,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE staff_users (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      name TEXT NULL,
      email TEXT NULL,
      role TEXT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE contacts (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      phone TEXT NULL,
      "waId" TEXT NULL
    );

    CREATE TABLE conversations (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE
    );

    CREATE TABLE product_categories (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE orders (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      "contactId" UUID NULL,
      subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
      total NUMERIC(12, 2) NOT NULL DEFAULT 0,
      "orderStatus" TEXT NULL DEFAULT 'new'
    );

    CREATE TABLE order_items (
      id UUID PRIMARY KEY,
      "orderId" UUID NULL REFERENCES orders(id) ON DELETE CASCADE,
      "productId" UUID NULL,
      "nameSnapshot" TEXT NULL,
      "priceSnapshot" NUMERIC(12, 2) NOT NULL DEFAULT 0,
      quantity NUMERIC(12, 3) NOT NULL DEFAULT 1
    );

    CREATE TABLE portal_user_audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "tenantId" TEXT NOT NULL,
      "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      "actorUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
      "targetUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_portal_user_audit_log_clinic_created_at
      ON portal_user_audit_log ("clinicId", "createdAt" DESC);
  `);
}

async function applyMigration(db, relativePath) {
  await db.exec(sanitizeMigration(read(relativePath)));
}

async function seedTenant(db, tenantId, clinicId, name) {
  await db.query(
    `INSERT INTO clinics (id, name, "externalTenantId", settings)
     VALUES ($1::uuid, $2, $3, '{"portal":{"enabledModules":{"inventory":true}}}'::jsonb)`,
    [clinicId, name, tenantId]
  );
}

async function seedSupplier(db, input) {
  await db.query(
    `INSERT INTO suppliers (
       id, "tenantId", "legalName", "tradeName", status, "createdAt", "updatedAt"
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, NOW(), NOW())`,
    [input.id, input.tenantId, input.legalName, input.tradeName || null, input.status || 'active']
  );
}

async function seedLocation(db, input) {
  await db.query(
    `INSERT INTO inventory_locations (
       id, "tenantId", code, name, "isPrimary", active, metadata, "createdAt", "updatedAt"
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, '{}'::jsonb, NOW(), NOW())`,
    [input.id, input.tenantId, input.code, input.name, input.isPrimary === true, input.active !== false]
  );
}

async function seedProduct(db, input) {
  const categoryId = randomUUID();
  await db.query(
    `INSERT INTO product_categories (id, "clinicId", name)
     VALUES ($1::uuid, $2::uuid, $3)`,
    [categoryId, input.clinicId, `Category ${input.name}`]
  );

  await db.query(
    `INSERT INTO products (
       id, "clinicId", name, description, price, "unitPrice", currency, "vatRate",
       stock, status, sku, "internalCode", "categoryId", metadata, "createdAt", "updatedAt",
       "deletedAt", "deletedBy", "deleteReason", "deletionMetadata"
     )
     VALUES (
       $1::uuid, $2::uuid, $3, NULL, 100, 100, 'ARS', 0,
       $4, 'active', NULL, $5, $6::uuid, $7::jsonb, NOW(), NOW(),
       $8::timestamptz, NULL, NULL, '{}'::jsonb
     )`,
    [
      input.id,
      input.clinicId,
      input.name,
      input.stock || 0,
      input.internalCode || null,
      categoryId,
      JSON.stringify({
        catalog: {
          inventoryTrackingMode: input.inventoryTrackingMode === 'lot_based' ? 'lot_based' : 'legacy'
        }
      }),
      input.deletedAt || null
    ]
  );
}

async function scalar(db, sql, params = []) {
  const result = await db.query(sql, params);
  const row = result.rows[0] || {};
  return row[Object.keys(row)[0]];
}

async function main() {
  const db = new PGlite();
  try {
    await createBaseSchema(db);
    for (const migration of [
      'db/migrations/010_products.sql',
      'db/migrations/018_billing_crm_phase1.sql',
      'db/migrations/019_billing_crm_hardening.sql',
      'db/migrations/029_product_categories_phase4.sql',
      'db/migrations/039_products_expiration_date.sql',
      'db/migrations/040_products_discount_percentage.sql',
      'db/migrations/059_inventory_lots_phase1.sql',
      'db/migrations/060_inventory_fefo_allocations.sql',
      'db/migrations/062_catalog_product_tombstones.sql',
      'db/migrations/065_inventory_base_internal_codes_phase1.sql',
      'db/migrations/067_inventory_lot_location_and_uniqueness.sql',
      'db/migrations/068_inventory_lot_operational_state.sql',
      'db/migrations/069_inventory_lot_operation_idempotency.sql',
      'db/migrations/070_suppliers_master_phase1.sql',
      'db/migrations/071_purchase_receipts_phase1.sql'
    ]) {
      await applyMigration(db, migration);
    }

    const tenantA = { tenantId: 'tenant-purchase-a', clinicId: randomUUID(), name: 'Tenant A', timezone: 'America/Buenos_Aires', externalTenantId: 'tenant-purchase-a' };
    const tenantB = { tenantId: 'tenant-purchase-b', clinicId: randomUUID(), name: 'Tenant B', timezone: 'America/Buenos_Aires', externalTenantId: 'tenant-purchase-b' };
    await seedTenant(db, tenantA.tenantId, tenantA.clinicId, tenantA.name);
    await seedTenant(db, tenantB.tenantId, tenantB.clinicId, tenantB.name);

    const supplierA = { id: randomUUID(), tenantId: tenantA.clinicId, legalName: 'Proveedor A', tradeName: 'Distribuidora A', status: 'active' };
    const supplierB = { id: randomUUID(), tenantId: tenantB.clinicId, legalName: 'Proveedor B', tradeName: 'Distribuidora B', status: 'active' };
    const inactiveSupplier = { id: randomUUID(), tenantId: tenantA.clinicId, legalName: 'Proveedor Inactivo', tradeName: null, status: 'inactive' };
    await seedSupplier(db, supplierA);
    await seedSupplier(db, supplierB);
    await seedSupplier(db, inactiveSupplier);

    const locationA = { id: randomUUID(), tenantId: tenantA.clinicId, code: 'main', name: 'Principal', isPrimary: true, active: true };
    const locationB = { id: randomUUID(), tenantId: tenantB.clinicId, code: 'main', name: 'Principal', isPrimary: true, active: true };
    const inactiveLocationA = { id: randomUUID(), tenantId: tenantA.clinicId, code: 'INACTIVE-A', name: 'Inactive A', isPrimary: false, active: false };
    await seedLocation(db, locationA);
    await seedLocation(db, locationB);
    await seedLocation(db, inactiveLocationA);

    const legacyProductA = { id: randomUUID(), clinicId: tenantA.clinicId, name: 'Legacy A', inventoryTrackingMode: 'legacy', stock: 0, internalCode: 'A-0001' };
    const lotProductA = { id: randomUUID(), clinicId: tenantA.clinicId, name: 'Lot A', inventoryTrackingMode: 'lot_based', stock: 0, internalCode: 'A-0002' };
    const tombstonedProductA = { id: randomUUID(), clinicId: tenantA.clinicId, name: 'Deleted A', inventoryTrackingMode: 'legacy', stock: 0, internalCode: 'A-0003', deletedAt: new Date().toISOString() };
    const crossTenantProduct = { id: randomUUID(), clinicId: tenantB.clinicId, name: 'Legacy B', inventoryTrackingMode: 'legacy', stock: 0, internalCode: 'B-0001' };
    await seedProduct(db, legacyProductA);
    await seedProduct(db, lotProductA);
    await seedProduct(db, tombstonedProductA);
    await seedProduct(db, crossTenantProduct);

    const tenantMap = new Map([
      [tenantA.tenantId, tenantA],
      [tenantB.tenantId, tenantB]
    ]);

    const {
      createPortalPurchaseReceipt,
      listPortalPurchaseReceipts,
      getPortalPurchaseReceiptDetail
    } = loadPurchaseReceiptsServices(db, tenantMap);

    const routesSource = read('src/routes/portal.routes.js');
    assert.match(routesSource, /router\.get\('\/tenants\/:tenantId\/purchase-receipts'/);
    assert.match(routesSource, /router\.get\('\/tenants\/:tenantId\/purchase-receipts\/:receiptId'/);
    assert.match(routesSource, /router\.post\('\/tenants\/:tenantId\/purchase-receipts'/);

    const legacyCreate = await createPortalPurchaseReceipt(tenantA.tenantId, {
      supplierId: supplierA.id,
      locationId: locationA.id,
      documentNumber: ' FC-001 ',
      receivedAt: '2026-07-29T10:00:00.000Z',
      notes: ' ingreso legacy ',
      idempotencyKey: 'receipt-legacy-1',
      items: [
        {
          productId: legacyProductA.id,
          quantity: '5',
          unitCost: '10.5000'
        }
      ]
    });
    assert.strictEqual(legacyCreate.ok, true);
    assert.strictEqual(legacyCreate.idempotent, false);
    assert.strictEqual(legacyCreate.receipt.items.length, 1);
    assert.strictEqual(legacyCreate.receipt.items[0].inventoryLotId, null);
    assert.strictEqual(legacyCreate.receipt.items[0].inventoryMovementId !== null, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(legacyCreate.receipt.metadata || {}, 'payloadSignature'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(legacyCreate.receipt.items[0].metadata || {}, 'lineFingerprint'), false);
    assert.strictEqual(Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM purchase_receipts`)), 1);
    assert.strictEqual(Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM purchase_receipt_items`)), 1);
    assert.strictEqual(Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM inventory_movements WHERE "referenceType" = 'purchase_receipt'`)), 1);
    assert.strictEqual(Number(await scalar(db, `SELECT quantity::text AS quantity FROM inventory_balances WHERE "tenantId" = $1::uuid AND "productId" = $2::uuid`, [tenantA.clinicId, legacyProductA.id])), 5);
    assert.strictEqual(Number(await scalar(db, `SELECT stock AS stock FROM products WHERE id = $1::uuid`, [legacyProductA.id])), 5);
    assert.strictEqual(Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM portal_user_audit_log WHERE action = 'purchase_receipt_confirmed'`)), 1);

    const lotCreate = await createPortalPurchaseReceipt(tenantA.tenantId, {
      supplierId: supplierA.id,
      locationId: locationA.id,
      documentNumber: 'LOT-001',
      receivedAt: '2026-07-29T11:00:00.000Z',
      idempotencyKey: 'receipt-lot-1',
      items: [
        {
          productId: lotProductA.id,
          quantity: '3.000',
          unitCost: '7.2500',
          lotNumber: 'L-001',
          expiresAt: '2099-08-15'
        }
      ]
    });
    assert.strictEqual(lotCreate.ok, true);
    assert.strictEqual(lotCreate.receipt.items[0].inventoryLotId !== null, true);
    assert.strictEqual(lotCreate.receipt.items[0].inventoryMovementId !== null, true);
    assert.strictEqual(
      await scalar(db, `SELECT "supplierName" AS name FROM inventory_lots WHERE id = $1::uuid`, [lotCreate.receipt.items[0].inventoryLotId]),
      supplierA.tradeName
    );

    const existingLot = await createPortalPurchaseReceipt(tenantA.tenantId, {
      supplierId: supplierA.id,
      locationId: locationA.id,
      documentNumber: 'LOT-002',
      receivedAt: '2026-07-29T12:00:00.000Z',
      idempotencyKey: 'receipt-lot-2',
      items: [
        {
          productId: lotProductA.id,
          quantity: '2.000',
          unitCost: '7.2500',
          lotNumber: 'L-001',
          expiresAt: '2099-08-15'
        }
      ]
    });
    assert.strictEqual(existingLot.ok, true);
    assert.strictEqual(Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM inventory_lots WHERE "tenantId" = $1::uuid AND "productId" = $2::uuid`, [tenantA.clinicId, lotProductA.id])), 1);
    assert.strictEqual(await scalar(db, `SELECT "availableQuantity"::text AS quantity FROM inventory_lots WHERE "tenantId" = $1::uuid AND "productId" = $2::uuid`, [tenantA.clinicId, lotProductA.id]), '5.000');

    const beforeRollbackCounts = {
      receipts: Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM purchase_receipts`)),
      items: Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM purchase_receipt_items`)),
      movements: Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM inventory_movements`)),
      lots: Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM inventory_lots`))
    };

    const conflictLot = await createPortalPurchaseReceipt(tenantA.tenantId, {
      supplierId: supplierA.id,
      locationId: locationA.id,
      documentNumber: 'LOT-CONFLICT',
      receivedAt: '2026-07-29T13:00:00.000Z',
      idempotencyKey: 'receipt-lot-conflict',
      items: [
        {
          productId: lotProductA.id,
          quantity: '1.000',
          unitCost: '7.2500',
          lotNumber: 'L-001',
          expiresAt: '2099-08-16'
        }
      ]
    });
    assert.strictEqual(conflictLot.ok, false);
    assert.strictEqual(conflictLot.reason, 'inventory_lot_conflict_requires_new_physical_lot');

    const afterRollbackCounts = {
      receipts: Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM purchase_receipts`)),
      items: Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM purchase_receipt_items`)),
      movements: Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM inventory_movements`)),
      lots: Number(await scalar(db, `SELECT COUNT(*)::int AS total FROM inventory_lots`))
    };
    assert.deepStrictEqual(afterRollbackCounts, beforeRollbackCounts);

    const mixedReceipt = await createPortalPurchaseReceipt(tenantA.tenantId, {
      supplierId: supplierA.id,
      locationId: locationA.id,
      documentNumber: 'MIX-001',
      receivedAt: '2026-07-29T14:00:00.000Z',
      idempotencyKey: 'receipt-mixed-1',
      items: [
        {
          productId: legacyProductA.id,
          quantity: '2',
          unitCost: '10.0000'
        },
        {
          productId: lotProductA.id,
          quantity: '1.000',
          unitCost: '7.2500',
          lotNumber: 'L-002',
          expiresAt: '2099-08-20'
        }
      ]
    });
    assert.strictEqual(mixedReceipt.ok, true);
    assert.strictEqual(mixedReceipt.receipt.items.length, 2);
    assert.strictEqual(mixedReceipt.receipt.summary.totalQuantity, '3.000');
    assert.strictEqual(mixedReceipt.receipt.summary.totalCost, '27.2500');

    const firstIdempotent = await createPortalPurchaseReceipt(tenantA.tenantId, {
      supplierId: supplierA.id,
      locationId: locationA.id,
      documentNumber: 'IDEMP-001',
      receivedAt: '2026-07-29T15:00:00.000Z',
      idempotencyKey: 'receipt-idempotent-1',
      items: [
        {
          productId: legacyProductA.id,
          quantity: '1',
          unitCost: '11.0000'
        }
      ]
    });
    const secondIdempotent = await createPortalPurchaseReceipt(tenantA.tenantId, {
      supplierId: supplierA.id,
      locationId: locationA.id,
      documentNumber: 'IDEMP-001',
      receivedAt: '2026-07-29T15:00:00.000Z',
      idempotencyKey: 'receipt-idempotent-1',
      items: [
        {
          productId: legacyProductA.id,
          quantity: '1',
          unitCost: '11.0000'
        }
      ]
    });
    const conflictIdempotent = await createPortalPurchaseReceipt(tenantA.tenantId, {
      supplierId: supplierA.id,
      locationId: locationA.id,
      documentNumber: 'IDEMP-001-DIFF',
      receivedAt: '2026-07-29T15:00:00.000Z',
      idempotencyKey: 'receipt-idempotent-1',
      items: [
        {
          productId: legacyProductA.id,
          quantity: '2',
          unitCost: '11.0000'
        }
      ]
    });
    assert.strictEqual(firstIdempotent.ok, true);
    assert.strictEqual(firstIdempotent.idempotent, false);
    assert.strictEqual(secondIdempotent.ok, true);
    assert.strictEqual(secondIdempotent.idempotent, true);
    assert.strictEqual(conflictIdempotent.ok, false);
    assert.strictEqual(conflictIdempotent.reason, 'purchase_receipt_idempotency_payload_mismatch');

    const invalidCases = await Promise.all([
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierA.id,
        locationId: locationA.id,
        receivedAt: '2026-07-29T16:00:00.000Z',
        idempotencyKey: 'invalid-no-items',
        items: []
      }),
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierA.id,
        locationId: locationA.id,
        receivedAt: '2026-07-29T16:00:00.000Z',
        idempotencyKey: 'invalid-negative',
        items: [{ productId: legacyProductA.id, quantity: '-1' }]
      }),
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierA.id,
        locationId: locationA.id,
        receivedAt: '2026-07-29T16:00:00.000Z',
        idempotencyKey: 'invalid-unit-cost',
        items: [{ productId: legacyProductA.id, quantity: '1', unitCost: '-1' }]
      }),
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierA.id,
        locationId: locationA.id,
        receivedAt: '2026-07-29T16:00:00.000Z',
        idempotencyKey: 'invalid-lot-based',
        items: [{ productId: lotProductA.id, quantity: '1.000' }]
      }),
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierA.id,
        locationId: locationA.id,
        receivedAt: '2026-07-29T16:00:00.000Z',
        idempotencyKey: 'invalid-legacy-lot',
        items: [{ productId: legacyProductA.id, quantity: '1', lotNumber: 'SHOULD-FAIL' }]
      }),
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierA.id,
        locationId: locationA.id,
        receivedAt: '2026-07-29T16:00:00.000Z',
        idempotencyKey: 'invalid-expired',
        items: [{ productId: lotProductA.id, quantity: '1.000', lotNumber: 'OLD-1', expiresAt: '2000-07-01' }]
      }),
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierA.id,
        locationId: locationA.id,
        receivedAt: '2026-07-29T16:00:00.000Z',
        idempotencyKey: 'invalid-quantity-scale',
        items: [{ productId: lotProductA.id, quantity: '1.0001', lotNumber: 'LOT-OVER', expiresAt: '2099-08-21' }]
      }),
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierA.id,
        locationId: locationA.id,
        receivedAt: '2026-07-29T16:00:00.000Z',
        idempotencyKey: 'invalid-unit-cost-scale',
        items: [{ productId: lotProductA.id, quantity: '1.000', unitCost: '1.00001', lotNumber: 'LOT-COST', expiresAt: '2099-08-21' }]
      })
    ]);
    assert.deepStrictEqual(
      invalidCases.map((result) => result.reason),
      [
        'missing_purchase_receipt_items',
        'invalid_purchase_receipt_quantity',
        'invalid_purchase_receipt_unit_cost',
        'purchase_receipt_lot_number_required',
        'purchase_receipt_legacy_lot_not_allowed',
        'purchase_receipt_lot_expired',
        'invalid_purchase_receipt_quantity',
        'invalid_purchase_receipt_unit_cost'
      ]
    );

    const crossTenantCases = await Promise.all([
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierB.id,
        locationId: locationA.id,
        receivedAt: '2026-07-29T17:00:00.000Z',
        idempotencyKey: 'cross-supplier',
        items: [{ productId: legacyProductA.id, quantity: '1' }]
      }),
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierA.id,
        locationId: locationB.id,
        receivedAt: '2026-07-29T17:00:00.000Z',
        idempotencyKey: 'cross-location',
        items: [{ productId: legacyProductA.id, quantity: '1' }]
      }),
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierA.id,
        locationId: locationA.id,
        receivedAt: '2026-07-29T17:00:00.000Z',
        idempotencyKey: 'cross-product',
        items: [{ productId: crossTenantProduct.id, quantity: '1' }]
      }),
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: inactiveSupplier.id,
        locationId: locationA.id,
        receivedAt: '2026-07-29T17:00:00.000Z',
        idempotencyKey: 'inactive-supplier',
        items: [{ productId: legacyProductA.id, quantity: '1' }]
      }),
      createPortalPurchaseReceipt(tenantA.tenantId, {
        supplierId: supplierA.id,
        locationId: inactiveLocationA.id,
        receivedAt: '2026-07-29T17:00:00.000Z',
        idempotencyKey: 'inactive-location',
        items: [{ productId: legacyProductA.id, quantity: '1' }]
      })
    ]);
    assert.deepStrictEqual(
      crossTenantCases.map((result) => result.reason),
      [
        'supplier_not_found',
        'inventory_location_not_found',
        'product_not_found',
        'supplier_inactive',
        'inventory_location_inactive'
      ]
    );

    const listResult = await listPortalPurchaseReceipts(tenantA.tenantId, { page: 1, pageSize: 20, supplierId: supplierA.id });
    assert.strictEqual(listResult.ok, true);
    assert.strictEqual(listResult.items.length >= 1, true);
    assert.strictEqual(listResult.total >= listResult.items.length, true);

    const detailResult = await getPortalPurchaseReceiptDetail(tenantA.tenantId, legacyCreate.receipt.id);
    const crossTenantDetail = await getPortalPurchaseReceiptDetail(tenantB.tenantId, legacyCreate.receipt.id);
    assert.strictEqual(detailResult.ok, true);
    assert.strictEqual(detailResult.receipt.id, legacyCreate.receipt.id);
    assert.strictEqual(crossTenantDetail.ok, false);
    assert.strictEqual(crossTenantDetail.reason, 'purchase_receipt_not_found');

    console.log('purchase-receipts-backend.test.js passed');
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
