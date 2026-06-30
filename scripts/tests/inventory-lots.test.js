const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(root, 'db/migrations/059_inventory_lots_phase1.sql'), 'utf8');
const repository = fs.readFileSync(path.join(root, 'src/repositories/inventory.repository.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');

assert(migration.includes('CREATE TABLE IF NOT EXISTS inventory_lots'), 'inventory_lots table must be created');
assert(migration.includes('CREATE TABLE IF NOT EXISTS inventory_movements'), 'inventory_movements table must be created');
assert(migration.includes('FOREIGN KEY ("productId", "tenantId")'), 'lot/product FK must be tenant-safe');
assert(migration.includes('FOREIGN KEY ("lotId", "tenantId", "productId")'), 'movement/lot FK must be tenant-safe and product-safe');
assert(migration.includes("status IN ('active', 'depleted', 'expired', 'quarantined', 'cancelled')"), 'lot statuses must be constrained');
assert(repository.includes('normalizeLot'), 'repository must normalize lots for API responses');
assert(routes.includes("'/tenants/:tenantId/inventory/lots'"), 'portal list/create routes must exist');

console.log('inventory-lots.test.js passed');
