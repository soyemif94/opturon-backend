const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const repository = fs.readFileSync(path.join(root, 'src/repositories/inventory-base.repository.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src/services/inventory-base.service.js'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'src/controllers/portal.controller.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');

assert.match(repository, /async function listInventoryMovementsByTenant/);
assert.match(repository, /FROM inventory_movements im/);
assert.match(repository, /INNER JOIN products p/);
assert.match(repository, /LEFT JOIN inventory_lots l/);
assert.match(repository, /LEFT JOIN inventory_locations loc/);
assert.match(repository, /LEFT JOIN staff_users actor/);
assert.match(repository, /im\."tenantId" = \$1::uuid/);
assert.match(repository, /ORDER BY scoped\."createdAt" DESC, scoped\.id DESC/);
assert.doesNotMatch(repository, /SELECT \*/);

assert.match(service, /async function listPortalInventoryMovements/);
assert.match(service, /invalid_inventory_movements_page/);
assert.match(service, /invalid_inventory_movements_page_size/);
assert.match(service, /invalid_inventory_movements_type/);
assert.match(service, /invalid_inventory_movements_date_range/);
assert.match(service, /listInventoryMovementsByTenant/);

assert.match(controller, /async function getPortalInventoryMovementsController/);
assert.match(controller, /portal_inventory_movements_failed/);
assert.match(controller, /invalid_inventory_movements_page/);
assert.match(controller, /items: result\.items/);

assert.match(routes, /router\.get\('\/tenants\/:tenantId\/inventory\/movements', inventoryCapability, getPortalInventoryMovementsController\)/);

console.log('inventory-movements-listing-backend.test.js passed');
