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
assert.match(ordersService, /product\.inventoryTrackingMode === 'lot_based'[\s\S]*consumeLotBasedOrderItem\(context, order, orderItem, product, client\)[\s\S]*continue;/, 'lot_based products must be routed through FEFO allocation');
assert.match(ordersService, /async function consumeLotBasedOrderItem\(context, order, item, product, client\)[\s\S]*listEligibleLotsForFefo\(context\.clinic\.id, product\.id, client\)/, 'FEFO must load eligible lots for lot_based orders');
assert.match(ordersService, /createInventoryLotAllocation\([\s\S]*status: 'consumed'[\s\S]*auditAction: 'inventory_fefo_allocated'/, 'FEFO must create consumed lot allocations');
assert.match(ordersService, /insertInventoryMovement\([\s\S]*movementType: 'sale'[\s\S]*auditAction: 'inventory_sale_consumed'/, 'FEFO must create sale inventory movements');
assert.match(ordersService, /await syncProductStockFromLots\(product\.id, context\.clinic\.id, client\)/, 'FEFO must sync product stock from lots after allocation');
assert.match(ordersService, /product && product\.inventoryTrackingMode === 'lot_based'\) continue/, 'lot_based cancellations must restore lot allocations instead of legacy stock');

console.log('inventory-mode.test.js passed');
