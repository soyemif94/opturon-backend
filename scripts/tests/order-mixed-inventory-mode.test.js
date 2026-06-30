const assert = require('assert');
const { readFileSync } = require('fs');

const service = readFileSync('src/services/portal-orders.service.js', 'utf8');

assert.match(service, /product\.inventoryTrackingMode === 'lot_based'/);
assert.match(service, /consumeLotBasedOrderItem\(context, order, orderItem, product, client\)/);
assert.match(service, /decrementProductStock\(orderItem\.productId, context\.clinic\.id, orderItem\.quantity, client\)/);
assert.match(service, /product && product\.inventoryTrackingMode === 'lot_based'\) continue/);
assert.match(service, /incrementProductStock\(item\.productId, context\.clinic\.id, item\.quantity, client\)/);

console.log('order-mixed-inventory-mode.test.js passed');
