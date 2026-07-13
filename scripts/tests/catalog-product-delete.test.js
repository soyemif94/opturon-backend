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

assert.match(routesSource, /router\.delete\('\/tenants\/:tenantId\/products\/:productId'/);
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

assert.match(serviceSource, /findProductById\(safeProductId, context\.clinic\.id\)/);
assert.match(serviceSource, /deleted\?\.blocked/);
assert.match(serviceSource, /reason: deleted\.reason \|\| 'product_delete_blocked'/);
assert.match(serviceSource, /No se puede eliminar porque tiene ventas, pedidos o movimientos de stock asociados/);
assert.match(serviceSource, /error\.code === '23503'/);

assert.match(controllerSource, /result\.reason === 'product_delete_blocked'[\s\S]+\? 409/);
assert.match(controllerSource, /message: result\.message \|\| null/);

console.log('catalog-product-delete.test.js passed');
