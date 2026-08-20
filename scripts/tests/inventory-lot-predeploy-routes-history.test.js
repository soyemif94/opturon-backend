const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
const repository = fs.readFileSync(path.join(root, 'src/repositories/inventory.repository.js'), 'utf8');
const middleware = fs.readFileSync(path.join(root, 'src/middlewares/portal-inventory-authorization.middleware.js'), 'utf8');

assert.match(middleware, /function requireSensitiveInventoryRole\(\)\s*\{\s*return buildInventoryRoleGate\(SENSITIVE_TENANT_ROLES\)/);
assert.match(middleware, /allowOpturonAdmin && normalizeString\(actor\.accountScope\)/);
assert.match(middleware, /req\.params\?\.tenantId/);
assert.match(routes, /inventoryReceiptRole = requireInventoryReceiptRole\(\)/);
assert.match(routes, /router\.post\('\/tenants\/:tenantId\/inventory\/lots', requirePortalInternalAuth, inventoryCapability, inventoryReceiptRole, postPortalInventoryLot\)/);
assert.match(routes, /router\.post\('\/tenants\/:tenantId\/inventory\/lots\/:lotId\/block', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, postPortalInventoryLotBlock\)/);
assert.match(routes, /router\.put\('\/tenants\/:tenantId\/inventory\/expiration-settings', requirePortalInternalAuth, inventoryCapability, sensitiveInventoryRole, putPortalInventoryExpirationSettings\)/);

assert.match(repository, /op\.status = 'failed'\s+OR op\."operationType" IN \('block', 'unblock', 'change_expiration'\)/);
assert.match(repository, /ORDER BY "createdAt" DESC, id DESC/);

console.log('inventory-lot-predeploy-routes-history.test.js passed');
