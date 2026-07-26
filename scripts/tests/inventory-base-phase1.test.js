const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

function read(relativePath) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = read('db/migrations/065_inventory_base_internal_codes_phase1.sql');
const inventoryBaseRepo = read('src/repositories/inventory-base.repository.js');
const inventoryBaseService = read('src/services/inventory-base.service.js');
const productsService = read('src/services/portal-products.service.js');
const importService = read('src/services/catalog-imports.service.js');
const routes = read('src/routes/portal.routes.js');
const backfillScript = read('scripts/backfill-product-internal-codes.js');

assert.match(migration, /ALTER TABLE products[\s\S]*ADD COLUMN IF NOT EXISTS "internalCode" TEXT/);
assert.match(migration, /CHECK \("internalCode" IS NULL OR "internalCode" ~ '\^\[A-Z\]-\[0-9\]\{4\}\$'\)/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS product_internal_code_allocators/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS inventory_locations/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS inventory_balances/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_inventory_movements_tenant_type_idempotency/);

assert.match(inventoryBaseRepo, /async function reserveNextInternalCodeNumber/);
assert.match(inventoryBaseRepo, /async function ensurePrimaryInventoryLocation/);
assert.match(inventoryBaseRepo, /FOR UPDATE/);
assert.match(inventoryBaseRepo, /async function findInventoryMovementByIdempotencyKey/);
assert.match(inventoryBaseRepo, /COALESCE\(p\.metadata->'catalog'->>'inventoryTrackingMode', 'legacy'\) <> 'lot_based'/);
assert.match(inventoryBaseRepo, /COALESCE\(b\.quantity, p\.stock, 0\)/);

assert.match(inventoryBaseService, /function formatInternalCodeFromNumber/);
assert.match(inventoryBaseService, /if \(!Number\.isInteger\(safeValue\) \|\| safeValue < 0 \|\| safeValue > 259999\)/);
assert.match(inventoryBaseService, /throw new Error\('internal_code_range_exhausted'\)/);
assert.match(inventoryBaseService, /async function applyInventoryMovementWithClient/);
assert.match(inventoryBaseService, /findInventoryMovementByIdempotencyKey/);
assert.match(inventoryBaseService, /error && error\.code === '23505'/);
assert.match(inventoryBaseService, /inventory_negative_stock_blocked/);
assert.match(inventoryBaseService, /inventory_opening_balance_already_exists/);
assert.match(inventoryBaseService, /idempotencyKey: draft\.idempotencyKey/);
assert.match(inventoryBaseService, /inventory_base_not_supported_for_lot_based_product/);
assert.match(inventoryBaseService, /initialQuantity: Math\.max\(0, Number\(product\.stock \|\| 0\)\)/);
assert.match(inventoryBaseService, /function resolveDisplayedStock/);
assert.match(inventoryBaseService, /if \(row && row\.balanceQuantity !== undefined && row\.balanceQuantity !== null && row\.balanceQuantity !== ''\)/);

assert.match(productsService, /reserveNextInternalCode/);
assert.match(productsService, /product\.stock = 0/);

assert.match(importService, /stock: 0/);
assert.match(importService, /stock: current\.stock/);

assert.match(routes, /router\.get\('\/tenants\/:tenantId\/inventory\/products'/);
assert.match(routes, /router\.get\('\/tenants\/:tenantId\/inventory\/products\/:productId\/movements'/);
assert.match(routes, /router\.post\('\/tenants\/:tenantId\/inventory\/products\/:productId\/movements'/);
assert.match(routes, /inventoryCapability/);

assert.match(backfillScript, /--tenant-id=/);
assert.match(backfillScript, /--clinic-id=/);
assert.match(backfillScript, /--chunk=/);
assert.match(backfillScript, /process\.argv\.includes\('--apply'\)/);
assert.match(backfillScript, /"deletedAt" IS NULL/);
assert.match(backfillScript, /product_internal_code_backfilled/);

console.log('inventory-base-phase1.test.js passed');
