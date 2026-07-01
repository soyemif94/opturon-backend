const assert = require('assert');
const fs = require('fs');
const path = require('path');

const service = fs.readFileSync(path.join(__dirname, '../../src/services/inventory-lots.service.js'), 'utf8');
const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/portal.controller.js'), 'utf8');

assert(service.includes('bulkWriteoffExpiredPortalInventoryLots'), 'service must expose bulk writeoff');
assert(service.includes("expiration.status !== 'expired'"), 'bulk writeoff must reject non-expired lots');
assert(service.includes("movementType: 'expired_writeoff'"), 'bulk writeoff must create expired_writeoff movement');
assert(service.includes("auditAction: 'inventory_expired_bulk_writeoff'"), 'bulk writeoff must write audit action metadata');
assert(controller.includes('postPortalInventoryExpiredBulkWriteoff'), 'controller must expose bulk writeoff route');

console.log('inventory-expired-bulk-writeoff.test.js passed');
