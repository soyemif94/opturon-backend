const assert = require('assert');
const { readFileSync } = require('fs');

const service = readFileSync('src/services/portal-orders.service.js', 'utf8');
const repo = readFileSync('src/repositories/inventory.repository.js', 'utf8');

assert.match(repo, /ORDER BY\s+CASE WHEN l\."expiresAt" IS NULL THEN 1 ELSE 0 END ASC,\s+l\."expiresAt" ASC NULLS LAST,\s+l\."receivedAt" ASC,\s+l\.id ASC/s);
assert.match(repo, /FOR UPDATE OF l/);
assert.match(service, /for \(const lot of lots\)/);
assert.match(service, /const quantity = Math\.min\(before, remaining\)/);
assert.match(service, /remaining = Number\(\(remaining - quantity\)\.toFixed\(3\)\)/);
assert.match(service, /nextStatus = after <= 0 \? 'depleted' : 'active'/);

console.log('inventory-fefo-multilot.test.js passed');
