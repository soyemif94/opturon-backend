const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { PGlite } = require('@electric-sql/pglite');

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const migration = read('db/migrations/070_suppliers_master_phase1.sql');
const repo = read('src/repositories/suppliers.repository.js');
const service = read('src/services/portal-suppliers.service.js');
const productRepo = read('src/repositories/products.repository.js');
const productService = read('src/services/portal-products.service.js');
const controller = read('src/controllers/portal.controller.js');
const routes = read('src/routes/portal.routes.js');

function sanitizeMigrationForIsolatedExecution(source) {
  return source
    .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/i, '')
    .replace(/DEFAULT gen_random_uuid\(\)/g, '');
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

async function runSchemaBehaviorChecks() {
  const db = new PGlite();
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const productA = randomUUID();
  const productB = randomUUID();
  const tombstonedProduct = randomUUID();
  const supplierA = randomUUID();
  const supplierB = randomUUID();
  const duplicateTaxId = 'AR20304050';

  await db.exec(`
    CREATE TABLE clinics (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE products (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      "deletedAt" TIMESTAMPTZ NULL
    );
  `);

  await db.query(`INSERT INTO clinics (id, name) VALUES ($1, 'Clinic A'), ($2, 'Clinic B')`, [clinicA, clinicB]);
  await db.query(
    `INSERT INTO products (id, "clinicId", name, status, "deletedAt")
     VALUES
       ($1, $2, 'Product A', 'active', NULL),
       ($3, $4, 'Product B', 'active', NULL),
       ($5, $2, 'Product Tombstoned', 'archived', NOW())`,
    [productA, clinicA, productB, clinicB, tombstonedProduct]
  );

  await db.exec(sanitizeMigrationForIsolatedExecution(migration));

  const productColumns = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'products'
      AND column_name = 'defaultSupplierId'
  `);
  assert.strictEqual(productColumns.rows.length, 1);

  const uniqueConstraint = await db.query(`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_name = 'suppliers'
      AND constraint_type = 'UNIQUE'
      AND constraint_name = 'uq_suppliers_id_tenant'
  `);
  assert.strictEqual(uniqueConstraint.rows.length, 1);

  const foreignKeyConstraint = await db.query(`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_name = 'products'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name = 'fk_products_default_supplier_tenant'
  `);
  assert.strictEqual(foreignKeyConstraint.rows.length, 1);

  await db.query(
    `INSERT INTO suppliers (id, "tenantId", "legalName", "tradeName", "normalizedTaxId", "taxId", status)
     VALUES ($1, $2, 'Proveedor A', 'Distribuidora A', $3, 'AR-20-304050', 'active')`,
    [supplierA, clinicA, duplicateTaxId]
  );
  await db.query(
    `INSERT INTO suppliers (id, "tenantId", "legalName", "tradeName", "normalizedTaxId", "taxId", status)
     VALUES ($1, $2, 'Proveedor B', 'Distribuidora B', $3, 'AR-20-304050', 'active')`,
    [supplierB, clinicB, duplicateTaxId]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO suppliers (id, "tenantId", "legalName", "normalizedTaxId", status)
     VALUES ($1, $2, 'Proveedor Duplicado', $3, 'active')`,
    /duplicate key value|uniq_suppliers_tenant_normalized_tax_id/i,
    [randomUUID(), clinicA, duplicateTaxId]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO suppliers (id, "tenantId", "legalName", status)
     VALUES ($1, $2, '', 'active')`,
    /chk_suppliers_legal_name_non_empty/i,
    [randomUUID(), clinicA]
  );

  await assertRejectsQuery(
    db,
    `INSERT INTO suppliers (id, "tenantId", "legalName", status)
     VALUES ($1, $2, 'Proveedor Invalido', 'paused')`,
    /chk_suppliers_status/i,
    [randomUUID(), clinicA]
  );

  await db.query(`UPDATE products SET "defaultSupplierId" = $1 WHERE id = $2`, [supplierA, productA]);
  await db.query(`UPDATE products SET "defaultSupplierId" = $1 WHERE id = $2`, [supplierB, productB]);
  await db.query(`UPDATE products SET "defaultSupplierId" = NULL WHERE id = $1`, [productB]);

  await assertRejectsQuery(
    db,
    `UPDATE products SET "defaultSupplierId" = $1 WHERE id = $2`,
    /fk_products_default_supplier_tenant/i,
    [supplierB, productA]
  );

  await db.query(`UPDATE suppliers SET status = 'inactive' WHERE id = $1`, [supplierA]);
  const inactiveLinked = await db.query(`SELECT "defaultSupplierId" FROM products WHERE id = $1`, [productA]);
  assert.strictEqual(inactiveLinked.rows[0].defaultSupplierId, supplierA);

  await assertRejectsQuery(
    db,
    `DELETE FROM suppliers WHERE id = $1`,
    /fk_products_default_supplier_tenant/i,
    [supplierA]
  );

  const totalProducts = await db.query(`SELECT COUNT(*)::int AS total FROM products`);
  const tombstonedProducts = await db.query(`SELECT COUNT(*)::int AS total FROM products WHERE "deletedAt" IS NOT NULL`);
  const linkedProducts = await db.query(`SELECT COUNT(*)::int AS total FROM products WHERE "defaultSupplierId" IS NOT NULL`);
  assert.strictEqual(totalProducts.rows[0].total, 3);
  assert.strictEqual(tombstonedProducts.rows[0].total, 1);
  assert.strictEqual(linkedProducts.rows[0].total, 1);

  await db.exec(sanitizeMigrationForIsolatedExecution(migration));

  await db.close();
}

assert.match(migration, /CREATE TABLE IF NOT EXISTS suppliers/);
assert.match(migration, /"tenantId" UUID NOT NULL REFERENCES clinics\(id\)/);
assert.match(migration, /ADD CONSTRAINT uq_suppliers_id_tenant\s+UNIQUE \(id, "tenantId"\)/);
assert.match(migration, /FOREIGN KEY \("defaultSupplierId", "clinicId"\)\s+REFERENCES suppliers\(id, "tenantId"\)/);
assert.match(migration, /ON DELETE NO ACTION/);
assert.match(migration, /ON UPDATE NO ACTION/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_suppliers_tenant_normalized_tax_id/);
assert.doesNotMatch(migration, /ON DELETE SET NULL/);
assert.doesNotMatch(migration, /purchase_receipts|inventory_lots|inventory_movements|inventory_balances/i);
assert(
  migration.indexOf('ADD CONSTRAINT uq_suppliers_id_tenant') < migration.indexOf('ADD CONSTRAINT fk_products_default_supplier_tenant'),
  'tenant-safe unique constraint must be created before the composite foreign key'
);

assert.match(repo, /async function listSuppliersByTenantId/);
assert.match(repo, /async function findSupplierById/);
assert.match(repo, /async function createSupplier/);
assert.match(repo, /async function updateSupplier/);
assert.match(repo, /async function setSupplierStatus/);
assert.match(repo, /p\."defaultSupplierId" = s\.id/);
assert.match(repo, /s\."tenantId" = \$2::uuid|s\."tenantId" = \$1::uuid/);

assert.match(service, /supplier_created/);
assert.match(service, /supplier_updated/);
assert.match(service, /supplier_deactivated/);
assert.match(service, /supplier_reactivated/);
assert.match(service, /duplicate_supplier_tax_id/);
assert.match(service, /missing_supplier_legal_name/);
assert.match(service, /normalizeTaxIdKey/);
assert(service.includes("replace(/[^a-z0-9]+/gi, '').toUpperCase()"));

assert.match(productRepo, /defaultSupplierId/);
assert.match(productRepo, /defaultSupplierLegacyName/);
assert.match(productRepo, /defaultSupplierStatus/);
assert.match(productService, /product_default_supplier_not_found/);
assert.match(productService, /product_default_supplier_inactive/);
assert.match(productService, /invalid_product_default_supplier/);

assert.match(controller, /async function getPortalSuppliers/);
assert.match(controller, /async function getPortalSupplier/);
assert.match(controller, /async function postPortalSupplier/);
assert.match(controller, /async function patchPortalSupplier/);
assert.match(controller, /async function patchPortalSupplierStatus/);

assert.match(routes, /router\.get\('\/tenants\/:tenantId\/suppliers'/);
assert.match(routes, /router\.get\('\/tenants\/:tenantId\/suppliers\/:supplierId'/);
assert.match(routes, /router\.post\('\/tenants\/:tenantId\/suppliers'/);
assert.match(routes, /router\.patch\('\/tenants\/:tenantId\/suppliers\/:supplierId'/);
assert.match(routes, /router\.patch\('\/tenants\/:tenantId\/suppliers\/:supplierId\/status'/);
assert.doesNotMatch(routes, /router\.delete\('\/tenants\/:tenantId\/suppliers/i);

runSchemaBehaviorChecks()
  .then(() => {
    console.log('suppliers-master-backend.test.js passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
