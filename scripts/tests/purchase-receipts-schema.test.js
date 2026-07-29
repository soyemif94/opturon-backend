const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function sanitizeMigrationForIsolatedExecution(source) {
  return source
    .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/gi, '')
    .replace(/DEFAULT gen_random_uuid\(\)/g, '');
}

const migration071Path = 'db/migrations/071_purchase_receipts_phase1.sql';
const migration010 = read('db/migrations/010_products.sql');
const migration059 = read('db/migrations/059_inventory_lots_phase1.sql');
const migration065 = read('db/migrations/065_inventory_base_internal_codes_phase1.sql');
const migration067 = read('db/migrations/067_inventory_lot_location_and_uniqueness.sql');
const migration068 = read('db/migrations/068_inventory_lot_operational_state.sql');
const migration069 = read('db/migrations/069_inventory_lot_operation_idempotency.sql');
const migration070 = read('db/migrations/070_suppliers_master_phase1.sql');
const migration071 = read(migration071Path);

async function apply(db, sql) {
  await db.exec(sanitizeMigrationForIsolatedExecution(sql));
}

async function listColumns(db, tableName) {
  const result = await db.query(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );
  return result.rows;
}

async function listConstraints(db, tableName) {
  const result = await db.query(
    `SELECT
       tc.constraint_name,
       tc.constraint_type,
       rc.update_rule,
       rc.delete_rule
     FROM information_schema.table_constraints tc
     LEFT JOIN information_schema.referential_constraints rc
       ON rc.constraint_name = tc.constraint_name
     WHERE tc.table_name = $1
     ORDER BY tc.constraint_name`,
    [tableName]
  );
  return result.rows;
}

async function listConstraintColumns(db, constraintName) {
  const result = await db.query(
    `SELECT column_name
     FROM information_schema.key_column_usage
     WHERE constraint_name = $1
     ORDER BY ordinal_position`,
    [constraintName]
  );
  return result.rows.map((row) => row.column_name);
}

async function getForeignKeyMapping(db, constraintName) {
  const result = await db.query(
    `SELECT
       local_attr.attname AS column_name,
       foreign_table.relname AS foreign_table_name,
       foreign_attr.attname AS foreign_column_name
     FROM pg_constraint constraint_row
     JOIN pg_class local_table
       ON local_table.oid = constraint_row.conrelid
     JOIN pg_class foreign_table
       ON foreign_table.oid = constraint_row.confrelid
     JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
       WITH ORDINALITY AS key_map(local_attnum, foreign_attnum, ordinal_position)
       ON TRUE
     JOIN pg_attribute local_attr
       ON local_attr.attrelid = local_table.oid
      AND local_attr.attnum = key_map.local_attnum
     JOIN pg_attribute foreign_attr
       ON foreign_attr.attrelid = foreign_table.oid
      AND foreign_attr.attnum = key_map.foreign_attnum
     WHERE constraint_row.conname = $1
     ORDER BY key_map.ordinal_position`,
    [constraintName]
  );
  return result.rows;
}

async function listIndexes(db, tableName) {
  const result = await db.query(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE tablename = $1
     ORDER BY indexname`,
    [tableName]
  );
  return result.rows;
}

async function assertRejectsQuery(db, query, expectedPattern, params = []) {
  try {
    await db.query(query, params);
    throw new Error(`expected query to fail: ${query}`);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    assert.match(message, expectedPattern);
  }
}

async function run() {
  const db = new PGlite();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const supplierA = randomUUID();
  const supplierB = randomUUID();
  const locationA = randomUUID();
  const locationB = randomUUID();
  const productA = randomUUID();
  const productB = randomUUID();
  const lotA = randomUUID();
  const lotB = randomUUID();
  const receiptA = randomUUID();
  const receiptB = randomUUID();
  const movementId = randomUUID();

  await db.exec(`
    CREATE TABLE clinics (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE order_items (
      id UUID PRIMARY KEY,
      "productId" UUID NULL
    );
  `);

  await apply(db, migration010);
  await apply(db, migration059);
  await apply(db, migration065);
  await apply(db, migration067);
  await apply(db, migration068);
  await apply(db, migration069);
  await apply(db, migration070);
  await apply(db, migration071);

  await db.query(
    `INSERT INTO clinics (id, name)
     VALUES ($1, 'Tenant A'), ($2, 'Tenant B')`,
    [tenantA, tenantB]
  );

  await db.query(
    `INSERT INTO suppliers (id, "tenantId", "legalName", status)
     VALUES
       ($1, $2, 'Supplier A', 'active'),
       ($3, $4, 'Supplier B', 'active')`,
    [supplierA, tenantA, supplierB, tenantB]
  );

  await db.query(
    `INSERT INTO products (id, "clinicId", name, price, stock, status)
     VALUES
       ($1, $2, 'Product A', 100, 0, 'active'),
       ($3, $4, 'Product B', 100, 0, 'active')`,
    [productA, tenantA, productB, tenantB]
  );

  await db.query(
    `INSERT INTO inventory_locations (id, "tenantId", code, name, "isPrimary", active)
     VALUES
       ($1, $2, 'MAIN-A', 'Main A', TRUE, TRUE),
       ($3, $4, 'MAIN-B', 'Main B', TRUE, TRUE)`,
    [locationA, tenantA, locationB, tenantB]
  );

  await db.query(
    `INSERT INTO inventory_lots (
       id, "tenantId", "productId", "lotNumber", "normalizedLotNumber",
       "locationId", "initialQuantity", "availableQuantity", status
     )
     VALUES
       ($1, $2, $3, 'L-A', 'LA', $4, 5, 5, 'active'),
       ($5, $6, $7, 'L-B', 'LB', $8, 5, 5, 'active')`,
    [lotA, tenantA, productA, locationA, lotB, tenantB, productB, locationB]
  );

  const tablesResult = await db.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('purchase_receipts', 'purchase_receipt_items')
    ORDER BY table_name
  `);
  assert.deepStrictEqual(
    tablesResult.rows.map((row) => row.table_name),
    ['purchase_receipt_items', 'purchase_receipts']
  );

  const receiptColumns = await listColumns(db, 'purchase_receipts');
  const itemColumns = await listColumns(db, 'purchase_receipt_items');

  const receiptColumnMap = new Map(receiptColumns.map((column) => [column.column_name, column]));
  const itemColumnMap = new Map(itemColumns.map((column) => [column.column_name, column]));

  assert.strictEqual(receiptColumnMap.get('id').udt_name, 'uuid');
  assert.strictEqual(receiptColumnMap.get('tenantId').udt_name, 'uuid');
  assert.strictEqual(receiptColumnMap.get('supplierId').udt_name, 'uuid');
  assert.strictEqual(receiptColumnMap.get('locationId').udt_name, 'uuid');
  assert.strictEqual(receiptColumnMap.get('receivedAt').udt_name, 'timestamptz');
  assert.strictEqual(receiptColumnMap.get('idempotencyKey').data_type, 'text');
  assert.match(receiptColumnMap.get('metadata').column_default || '', /'\{\}'::jsonb/);
  assert.match(receiptColumnMap.get('createdAt').column_default || '', /now\(\)/i);
  assert.match(receiptColumnMap.get('confirmedAt').column_default || '', /now\(\)/i);
  assert.strictEqual(receiptColumnMap.has('status'), false);
  assert.strictEqual(receiptColumnMap.has('documentType'), false);

  assert.strictEqual(itemColumnMap.get('quantity').data_type, 'numeric');
  assert.strictEqual(itemColumnMap.get('quantity').udt_name, 'numeric');
  assert.strictEqual(itemColumnMap.get('unitCost').data_type, 'numeric');
  assert.strictEqual(itemColumnMap.get('unitCost').udt_name, 'numeric');
  assert.strictEqual(itemColumnMap.get('inventoryLotId').udt_name, 'uuid');
  assert.strictEqual(itemColumnMap.get('inventoryMovementId').udt_name, 'uuid');
  assert.match(itemColumnMap.get('metadata').column_default || '', /'\{\}'::jsonb/);
  assert.match(itemColumnMap.get('createdAt').column_default || '', /now\(\)/i);
  assert.strictEqual(itemColumnMap.has('status'), false);
  assert.strictEqual(itemColumnMap.has('draft'), false);
  assert.strictEqual(itemColumnMap.has('cancelled'), false);

  const receiptConstraints = await listConstraints(db, 'purchase_receipts');
  const itemConstraints = await listConstraints(db, 'purchase_receipt_items');
  const receiptConstraintNames = receiptConstraints.map((constraint) => constraint.constraint_name);
  const itemConstraintNames = itemConstraints.map((constraint) => constraint.constraint_name);

  assert(receiptConstraintNames.includes('purchase_receipts_pkey'));
  assert(receiptConstraintNames.includes('uq_purchase_receipts_id_tenant'));
  assert(receiptConstraintNames.includes('fk_purchase_receipts_supplier_tenant'));
  assert(receiptConstraintNames.includes('fk_purchase_receipts_location_tenant'));
  assert(receiptConstraintNames.includes('chk_purchase_receipts_idempotency_key_non_empty'));
  assert(itemConstraintNames.includes('purchase_receipt_items_pkey'));
  assert(itemConstraintNames.includes('fk_purchase_receipt_items_receipt_tenant'));
  assert(itemConstraintNames.includes('fk_purchase_receipt_items_product_tenant'));
  assert(itemConstraintNames.includes('fk_purchase_receipt_items_inventory_lot_tenant_product'));
  assert(itemConstraintNames.includes('chk_purchase_receipt_items_quantity_positive'));
  assert(itemConstraintNames.includes('chk_purchase_receipt_items_unit_cost_non_negative'));
  assert(itemConstraintNames.every((name) => !/inventoryMovement/i.test(name)));

  const receiptTenantColumns = await listConstraintColumns(db, 'uq_purchase_receipts_id_tenant');
  assert.deepStrictEqual(receiptTenantColumns, ['id', 'tenantId']);

  const supplierFk = receiptConstraints.find((constraint) => constraint.constraint_name === 'fk_purchase_receipts_supplier_tenant');
  const locationFk = receiptConstraints.find((constraint) => constraint.constraint_name === 'fk_purchase_receipts_location_tenant');
  const receiptFk = itemConstraints.find((constraint) => constraint.constraint_name === 'fk_purchase_receipt_items_receipt_tenant');
  const productFk = itemConstraints.find((constraint) => constraint.constraint_name === 'fk_purchase_receipt_items_product_tenant');
  const lotFk = itemConstraints.find((constraint) => constraint.constraint_name === 'fk_purchase_receipt_items_inventory_lot_tenant_product');

  assert.strictEqual(supplierFk.delete_rule, 'RESTRICT');
  assert.strictEqual(supplierFk.update_rule, 'NO ACTION');
  assert.strictEqual(locationFk.delete_rule, 'RESTRICT');
  assert.strictEqual(locationFk.update_rule, 'NO ACTION');
  assert.strictEqual(receiptFk.delete_rule, 'RESTRICT');
  assert.strictEqual(receiptFk.update_rule, 'NO ACTION');
  assert.strictEqual(productFk.delete_rule, 'RESTRICT');
  assert.strictEqual(productFk.update_rule, 'NO ACTION');
  assert.strictEqual(lotFk.delete_rule, 'RESTRICT');
  assert.strictEqual(lotFk.update_rule, 'NO ACTION');

  const supplierMapping = await getForeignKeyMapping(db, 'fk_purchase_receipts_supplier_tenant');
  const locationMapping = await getForeignKeyMapping(db, 'fk_purchase_receipts_location_tenant');
  const receiptMapping = await getForeignKeyMapping(db, 'fk_purchase_receipt_items_receipt_tenant');
  const productMapping = await getForeignKeyMapping(db, 'fk_purchase_receipt_items_product_tenant');
  const lotMapping = await getForeignKeyMapping(db, 'fk_purchase_receipt_items_inventory_lot_tenant_product');

  assert.deepStrictEqual(
    supplierMapping.map((row) => `${row.column_name}:${row.foreign_table_name}.${row.foreign_column_name}`),
    ['supplierId:suppliers.id', 'tenantId:suppliers.tenantId']
  );
  assert.deepStrictEqual(
    locationMapping.map((row) => `${row.column_name}:${row.foreign_table_name}.${row.foreign_column_name}`),
    ['locationId:inventory_locations.id', 'tenantId:inventory_locations.tenantId']
  );
  assert.deepStrictEqual(
    receiptMapping.map((row) => `${row.column_name}:${row.foreign_table_name}.${row.foreign_column_name}`),
    ['receiptId:purchase_receipts.id', 'tenantId:purchase_receipts.tenantId']
  );
  assert.deepStrictEqual(
    productMapping.map((row) => `${row.column_name}:${row.foreign_table_name}.${row.foreign_column_name}`),
    ['productId:products.id', 'tenantId:products.clinicId']
  );
  assert.deepStrictEqual(
    lotMapping.map((row) => `${row.column_name}:${row.foreign_table_name}.${row.foreign_column_name}`),
    ['inventoryLotId:inventory_lots.id', 'tenantId:inventory_lots.tenantId', 'productId:inventory_lots.productId']
  );

  const receiptIndexes = await listIndexes(db, 'purchase_receipts');
  const itemIndexes = await listIndexes(db, 'purchase_receipt_items');
  const receiptIndexDefs = new Map(receiptIndexes.map((index) => [index.indexname, index.indexdef]));
  const itemIndexDefs = new Map(itemIndexes.map((index) => [index.indexname, index.indexdef]));

  assert(receiptIndexDefs.has('uniq_purchase_receipts_tenant_idempotency'));
  assert(receiptIndexDefs.has('idx_purchase_receipts_tenant_received_at'));
  assert(receiptIndexDefs.has('idx_purchase_receipts_tenant_supplier_received_at'));
  assert(receiptIndexDefs.has('idx_purchase_receipts_tenant_location_received_at'));
  assert(itemIndexDefs.has('idx_purchase_receipt_items_receipt_tenant'));
  assert(itemIndexDefs.has('idx_purchase_receipt_items_tenant_product'));
  assert(itemIndexDefs.has('idx_purchase_receipt_items_inventory_lot'));
  assert(itemIndexDefs.has('idx_purchase_receipt_items_inventory_movement'));

  assert.match(receiptIndexDefs.get('uniq_purchase_receipts_tenant_idempotency'), /UNIQUE/i);
  assert.match(itemIndexDefs.get('idx_purchase_receipt_items_inventory_lot'), /WHERE .*"inventoryLotId" IS NOT NULL/i);
  assert.match(itemIndexDefs.get('idx_purchase_receipt_items_inventory_movement'), /WHERE .*"inventoryMovementId" IS NOT NULL/i);

  assert(
    migration071.indexOf('ADD CONSTRAINT uq_purchase_receipts_id_tenant') <
      migration071.indexOf('CREATE TABLE IF NOT EXISTS purchase_receipt_items'),
    'receipt composite unique must exist before item-to-receipt FK'
  );

  assert(
    migration070.includes('UNIQUE (id, "tenantId")'),
    'suppliers must expose a composite unique candidate before receipt FK creation'
  );
  assert(
    migration065.includes('uniq_inventory_locations_id_tenant'),
    'inventory_locations must expose a composite unique candidate before receipt FK creation'
  );
  assert(
    migration059.includes('uniq_products_id_clinic_id'),
    'products must expose a composite unique candidate before item-to-product FK creation'
  );
  assert(
    migration059.includes('uniq_inventory_lots_id_tenant_product'),
    'inventory_lots must expose a composite unique candidate before item-to-lot FK creation'
  );

  assert.doesNotMatch(migration071, /\b061\b/);
  assert.doesNotMatch(migration071, /ALTER TABLE\s+products\b/i);
  assert.doesNotMatch(migration071, /ALTER TABLE\s+suppliers\b/i);
  assert.doesNotMatch(migration071, /ALTER TABLE\s+inventory_lots\b/i);
  assert.doesNotMatch(migration071, /ALTER TABLE\s+inventory_movements\b/i);
  assert.doesNotMatch(migration071, /ALTER TABLE\s+inventory_balances\b/i);
  assert.doesNotMatch(migration071, /\bUPDATE\s+products\b/i);
  assert.doesNotMatch(migration071, /\bUPDATE\s+inventory_lots\b/i);
  assert.doesNotMatch(migration071, /\bINSERT\s+INTO\s+inventory_movements\b/i);
  assert.doesNotMatch(migration071, /\bINSERT\s+INTO\s+inventory_lots\b/i);
  assert.doesNotMatch(migration071, /supplierName/i);

  await db.query(
    `INSERT INTO purchase_receipts (
       id, "tenantId", "supplierId", "locationId", "receivedAt", "idempotencyKey", metadata
     )
     VALUES ($1, $2, $3, $4, NOW(), 'idem-a', '{}'::jsonb)`,
    [receiptA, tenantA, supplierA, locationA]
  );

  await db.query(
    `INSERT INTO purchase_receipts (
       id, "tenantId", "supplierId", "locationId", "receivedAt", "idempotencyKey", metadata
     )
     VALUES ($1, $2, $3, $4, NOW(), 'idem-a', '{}'::jsonb)`,
    [receiptB, tenantB, supplierB, locationB]
  );

  await db.query(
    `INSERT INTO purchase_receipt_items (
       id, "receiptId", "tenantId", "productId", quantity, "unitCost",
       "lotNumber", "normalizedLotNumber", "expiresAt", "inventoryLotId",
       "inventoryMovementId", metadata
     )
     VALUES (
       $1, $2, $3, $4, 2.500, 10.2500,
       'L-A', 'LA', DATE '2026-12-31', $5, $6, '{}'::jsonb
     )`,
    [randomUUID(), receiptA, tenantA, productA, lotA, movementId]
  );

  await db.query(
    `INSERT INTO purchase_receipt_items (
       id, "receiptId", "tenantId", "productId", quantity, "unitCost",
       "inventoryLotId", "inventoryMovementId", metadata
     )
     VALUES (
       $1, $2, $3, $4, 1.000, NULL,
       NULL, NULL, '{}'::jsonb
     )`,
    [randomUUID(), receiptA, tenantA, productA]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO purchase_receipts (
       id, "tenantId", "supplierId", "locationId", "receivedAt", "idempotencyKey"
     )
     VALUES ($1, $2, $3, $4, NOW(), '   ')`,
    /chk_purchase_receipts_idempotency_key_non_empty/i,
    [randomUUID(), tenantA, supplierA, locationA]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO purchase_receipts (
       id, "tenantId", "supplierId", "locationId", "receivedAt", "idempotencyKey"
     )
     VALUES ($1, $2, $3, $4, NOW(), 'idem-a')`,
    /uniq_purchase_receipts_tenant_idempotency|duplicate key value/i,
    [randomUUID(), tenantA, supplierA, locationA]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO purchase_receipts (
       id, "tenantId", "supplierId", "locationId", "receivedAt", "idempotencyKey"
     )
     VALUES ($1, $2, $3, $4, NOW(), 'cross-supplier')`,
    /fk_purchase_receipts_supplier_tenant/i,
    [randomUUID(), tenantA, supplierB, locationA]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO purchase_receipts (
       id, "tenantId", "supplierId", "locationId", "receivedAt", "idempotencyKey"
     )
     VALUES ($1, $2, $3, $4, NOW(), 'cross-location')`,
    /fk_purchase_receipts_location_tenant/i,
    [randomUUID(), tenantA, supplierA, locationB]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO purchase_receipt_items (
       id, "receiptId", "tenantId", "productId", quantity, metadata
     )
     VALUES ($1, $2, $3, $4, 0, '{}'::jsonb)`,
    /chk_purchase_receipt_items_quantity_positive/i,
    [randomUUID(), receiptA, tenantA, productA]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO purchase_receipt_items (
       id, "receiptId", "tenantId", "productId", quantity, metadata
     )
     VALUES ($1, $2, $3, $4, -1, '{}'::jsonb)`,
    /chk_purchase_receipt_items_quantity_positive/i,
    [randomUUID(), receiptA, tenantA, productA]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO purchase_receipt_items (
       id, "receiptId", "tenantId", "productId", quantity, "unitCost", metadata
     )
     VALUES ($1, $2, $3, $4, 1, -0.0001, '{}'::jsonb)`,
    /chk_purchase_receipt_items_unit_cost_non_negative/i,
    [randomUUID(), receiptA, tenantA, productA]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO purchase_receipt_items (
       id, "receiptId", "tenantId", "productId", quantity, metadata
     )
     VALUES ($1, $2, $3, $4, 1, '{}'::jsonb)`,
    /fk_purchase_receipt_items_receipt_tenant/i,
    [randomUUID(), receiptA, tenantB, productB]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO purchase_receipt_items (
       id, "receiptId", "tenantId", "productId", quantity, metadata
     )
     VALUES ($1, $2, $3, $4, 1, '{}'::jsonb)`,
    /fk_purchase_receipt_items_product_tenant/i,
    [randomUUID(), receiptA, tenantA, productB]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO purchase_receipt_items (
       id, "receiptId", "tenantId", "productId", quantity, "inventoryLotId", metadata
     )
     VALUES ($1, $2, $3, $4, 1, $5, '{}'::jsonb)`,
    /fk_purchase_receipt_items_inventory_lot_tenant_product/i,
    [randomUUID(), receiptA, tenantA, productA, lotB]
  );

  const receiptCount = await db.query(`SELECT COUNT(*)::int AS total FROM purchase_receipts`);
  const itemCount = await db.query(`SELECT COUNT(*)::int AS total FROM purchase_receipt_items`);
  assert.strictEqual(receiptCount.rows[0].total, 2);
  assert.strictEqual(itemCount.rows[0].total, 2);

  await db.close();
}

assert(fs.existsSync(path.join(root, migration071Path)), '071 migration must exist');
assert.match(migration071, /CREATE TABLE IF NOT EXISTS purchase_receipts/);
assert.match(migration071, /CREATE TABLE IF NOT EXISTS purchase_receipt_items/);
assert.match(migration071, /FOREIGN KEY \("supplierId", "tenantId"\)\s+REFERENCES suppliers\(id, "tenantId"\)/);
assert.match(migration071, /FOREIGN KEY \("locationId", "tenantId"\)\s+REFERENCES inventory_locations\(id, "tenantId"\)/);
assert.match(migration071, /FOREIGN KEY \("receiptId", "tenantId"\)\s+REFERENCES purchase_receipts\(id, "tenantId"\)/);
assert.match(migration071, /FOREIGN KEY \("productId", "tenantId"\)\s+REFERENCES products\(id, "clinicId"\)/);
assert.match(migration071, /FOREIGN KEY \("inventoryLotId", "tenantId", "productId"\)\s+REFERENCES inventory_lots\(id, "tenantId", "productId"\)/);
assert.doesNotMatch(migration071, /FOREIGN KEY \("inventoryMovementId"/);
assert.doesNotMatch(migration071, /\bstatus\b/i);
assert.doesNotMatch(migration071, /\bdraft\b/i);
assert.doesNotMatch(migration071, /\bcancelled\b/i);

run()
  .then(() => {
    console.log('purchase-receipts-schema.test.js passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
