const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

function read(relativePath) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const serviceSource = read('src/services/portal-products.service.js');
const importServiceSource = read('src/services/catalog-imports.service.js');
const controllerSource = read('src/controllers/portal.controller.js');
const routesSource = read('src/routes/portal.routes.js');
const productRepositorySource = read('src/repositories/products.repository.js');
const importRepositorySource = read('src/repositories/catalog-imports.repository.js');
const auditRepositorySource = read('src/repositories/portal-user-audit.repository.js');

assert.match(serviceSource, /async function previewPortalProductsBulkDelete/);
assert.match(serviceSource, /async function executePortalProductsBulkDelete/);
assert.match(serviceSource, /async function withBulkDeleteAdvisoryLock/);
assert.match(serviceSource, /pg_advisory_xact_lock/);
assert.doesNotMatch(serviceSource, /pg_advisory_unlock/);
assert.match(serviceSource, /withTransaction\(async \(client\) => \{/);
assert.match(serviceSource, /mode === 'import_batch'/);
assert.match(serviceSource, /findLatestPortalUserAuditEventByIdempotencyKey/);
assert.match(serviceSource, /missing_bulk_delete_idempotency_key/);
assert.match(serviceSource, /catalog_import_rollback|catalog_bulk_delete/);
assert.match(serviceSource, /listProductsByClinicIdIncludingDeleted/);
assert.match(serviceSource, /executePortalProductDeletionWithClient/);
assert.match(serviceSource, /resolveBulkDeleteSelection\(context, selection, \{ includeDeleted: true \}, client\)/);

assert.match(importServiceSource, /metadata:\s*\{[\s\S]*source: 'catalog_import'/);
assert.match(importServiceSource, /async function listCatalogImports/);

assert.match(productRepositorySource, /async function listProductsByClinicIdIncludingDeleted/);
assert.match(productRepositorySource, /async function findProductsByIds/);
assert.match(importRepositorySource, /async function listCatalogImportJobsByClinicId/);
assert.match(auditRepositorySource, /async function findLatestPortalUserAuditEventByIdempotencyKey/);

assert.match(controllerSource, /async function postPortalProductsBulkDeletePreview/);
assert.match(controllerSource, /async function postPortalProductsBulkDeleteExecute/);
assert.match(controllerSource, /async function getPortalCatalogImports/);
assert.match(controllerSource, /async function postPortalCatalogImportRollbackPreview/);
assert.match(controllerSource, /async function postPortalCatalogImportRollbackExecute/);

assert.match(routesSource, /router\.post\('\/tenants\/:tenantId\/products\/bulk-delete\/preview'/);
assert.match(routesSource, /router\.post\('\/tenants\/:tenantId\/products\/bulk-delete\/execute'/);
assert.match(routesSource, /router\.get\('\/tenants\/:tenantId\/catalog-imports'/);
assert.match(routesSource, /router\.post\('\/tenants\/:tenantId\/catalog-imports\/:importId\/rollback\/preview'/);
assert.match(routesSource, /router\.post\('\/tenants\/:tenantId\/catalog-imports\/:importId\/rollback'/);

console.log('catalog-bulk-delete-import-rollback.test.js passed');
