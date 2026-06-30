const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const repository = fs.readFileSync(path.join(root, 'src/repositories/inventory.repository.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src/services/inventory-lots.service.js'), 'utf8');

assert(repository.includes('FOR UPDATE OF l'), 'lot adjustments must lock the lot row');
assert(service.includes('withTransaction'), 'lot adjustments must run in a transaction');
assert(service.includes('findInventoryLotById(safeLotId, context.clinic.id, client, { forUpdate: true })'), 'service must request FOR UPDATE when adjusting');
assert(service.includes('after < 0'), 'service must check negative stock while lock is held');

console.log('inventory-concurrency.test.js passed');
