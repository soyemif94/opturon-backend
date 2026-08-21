const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

function read(relativePath) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const repositorySource = read('src/repositories/products.repository.js');
const serviceSource = read('src/services/portal-products.service.js');
const controllerSource = read('src/controllers/portal.controller.js');
const routesSource = read('src/routes/portal.routes.js');
const migrationSource = read('db/migrations/062_catalog_product_tombstones.sql');

assert.match(routesSource, /router\.delete\('\/tenants\/:tenantId\/products\/:productId', requirePortalInternalAuth, catalogWriteRole, catalogModule, destroyPortalProduct\)/);
assert.match(routesSource, /destroyPortalProduct/);

assert.match(repositorySource, /function buildProductDeleteReferenceSummary/);
assert.match(repositorySource, /function getProductDeleteReferenceSummary/);
assert.match(repositorySource, /FROM inventory_lots il[\s\S]+il\."tenantId" = \$2::uuid[\s\S]+il\."productId" = \$1::uuid/);
assert.match(repositorySource, /FROM inventory_movements im[\s\S]+im\."tenantId" = \$2::uuid[\s\S]+im\."productId" = \$1::uuid/);
assert.match(repositorySource, /FROM inventory_lot_allocations ila[\s\S]+ila\."tenantId" = \$2::uuid[\s\S]+ila\."productId" = \$1::uuid/);
assert.match(repositorySource, /INNER JOIN orders o ON o\.id = oi\."orderId"[\s\S]+o\."clinicId" = \$2::uuid[\s\S]+oi\."productId" = \$1::uuid/);
assert.match(repositorySource, /INNER JOIN invoices i ON i\.id = ii\."invoiceId"[\s\S]+i\."clinicId" = \$2::uuid[\s\S]+ii\."productId" = \$1::uuid/);
assert.match(repositorySource, /if \(references\.total > 0\)/);
assert.match(repositorySource, /reason: 'product_delete_blocked'/);
assert.match(repositorySource, /DELETE FROM products[\s\S]+WHERE id = \$1::uuid[\s\S]+AND "clinicId" = \$2::uuid/);
assert.match(repositorySource, /AND p\."deletedAt" IS NULL/);
assert.match(repositorySource, /async function tombstoneProductById/);
assert.match(repositorySource, /UPDATE products[\s\S]+"deletedAt" = NOW\(\)[\s\S]+AND "clinicId" = \$2::uuid/);

assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ NULL/);
assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS "deletedBy" TEXT NULL/);
assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS "deletionMetadata" JSONB/);
assert.match(migrationSource, /WHERE sku IS NOT NULL AND "deletedAt" IS NULL/);

assert.match(serviceSource, /findProductById\(safeProductId, context\.clinic\.id\)/);
assert.match(serviceSource, /deleted\?\.blocked/);
assert.match(serviceSource, /reason: deleted\.reason \|\| 'product_delete_blocked'/);
assert.match(serviceSource, /No se puede eliminar porque tiene ventas, pedidos o movimientos de stock asociados/);
assert.match(serviceSource, /error\.code === '23503'/);
assert.match(serviceSource, /force_delete_confirmation_required/);
assert.match(serviceSource, /getProductDeleteReferenceSummary\(safeProductId, context\.clinic\.id, transactionClient\)/);
assert.match(serviceSource, /const forced = client \? await performForcedDelete\(client\) : await withTransaction\(performForcedDelete\)/);
assert.match(serviceSource, /createPortalUserAuditEvent/);
assert.match(serviceSource, /action: 'catalog_product_force_deleted'/);
assert.doesNotMatch(serviceSource, /DELETE FROM inventory_(lots|movements|lot_allocations)/);
assert.doesNotMatch(serviceSource, /DELETE FROM (orders|order_items|invoices|invoice_items)/);

assert.match(controllerSource, /result\.reason === 'product_delete_blocked'[\s\S]+\? 409/);
assert.match(controllerSource, /message: result\.message \|\| null/);
assert.match(controllerSource, /req\.query\.force/);
assert.match(controllerSource, /req\.body\?\.confirmForceDelete === true/);
assert.match(controllerSource, /req\.body\?\.acknowledgedReferences === true/);
assert.match(controllerSource, /force_delete_confirmation_required/);

console.log('catalog-product-delete.test.js passed');
