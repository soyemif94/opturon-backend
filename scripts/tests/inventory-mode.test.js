const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const productsRepository = fs.readFileSync(path.join(root, 'src/repositories/products.repository.js'), 'utf8');
const inventoryRepository = fs.readFileSync(path.join(root, 'src/repositories/inventory.repository.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src/services/inventory-lots.service.js'), 'utf8');
const ordersService = fs.readFileSync(path.join(root, 'src/services/portal-orders.service.js'), 'utf8');

assert(productsRepository.includes("inventoryTrackingMode"), 'products must expose inventoryTrackingMode');
assert(productsRepository.includes("catalog.inventoryTrackingMode === 'lot_based' ? 'lot_based' : 'legacy'"), 'legacy must be the default mode');
assert(inventoryRepository.includes("metadata->'catalog'->>'inventoryTrackingMode'"), 'stock sync must guard by lot_based mode');
assert(service.includes('setPortalProductInventoryMode'), 'mode endpoint service must exist');
assert(ordersService.includes('order_item_lot_based_not_supported'), 'orders must not silently decrement lot-based stock before FEFO allocation exists');

console.log('inventory-mode.test.js passed');
