const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');

const protectedReadPatterns = [
  /router\.get\('\/tenants\/:tenantId\/products', requirePortalInternalAuth, inventoryReadRole, catalogModule, getPortalProducts\)/,
  /router\.get\('\/tenants\/:tenantId\/products\/images', requirePortalInternalAuth, inventoryReadRole, catalogModule, getPortalProductImages\)/,
  /router\.get\('\/tenants\/:tenantId\/products\/workspace', requirePortalInternalAuth, inventoryReadRole, catalogModule, getPortalProductImages\)/,
  /router\.get\('\/tenants\/:tenantId\/products\/:productId', requirePortalInternalAuth, inventoryReadRole, catalogModule, getPortalProduct\)/,
  /router\.get\('\/tenants\/:tenantId\/product-categories', requirePortalInternalAuth, inventoryReadRole, catalogModule, getPortalProductCategories\)/,
  /router\.get\('\/tenants\/:tenantId\/suppliers', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalSuppliers\)/,
  /router\.get\('\/tenants\/:tenantId\/suppliers\/:supplierId', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalSupplier\)/,
  /router\.get\('\/tenants\/:tenantId\/purchase-receipts', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalPurchaseReceiptsController\)/,
  /router\.get\('\/tenants\/:tenantId\/purchase-receipts\/:receiptId', requirePortalInternalAuth, inventoryReadRole, inventoryCapability, getPortalPurchaseReceiptController\)/
];

const protectedWritePatterns = [
  /router\.post\('\/tenants\/:tenantId\/products', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalProduct\)/,
  /router\.post\('\/tenants\/:tenantId\/products\/image-upload', requirePortalInternalAuth, catalogWriteRole, catalogModule, handleCatalogImageUpload, postPortalProductImageUpload\)/,
  /router\.post\('\/tenants\/:tenantId\/products\/bulk', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalProductsBulk\)/,
  /router\.post\('\/tenants\/:tenantId\/products\/bulk-delete\/preview', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalProductsBulkDeletePreview\)/,
  /router\.post\('\/tenants\/:tenantId\/products\/bulk-delete\/execute', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalProductsBulkDeleteExecute\)/,
  /router\.patch\('\/tenants\/:tenantId\/products\/:productId', requirePortalInternalAuth, catalogWriteRole, catalogModule, updatePortalProduct\)/,
  /router\.patch\('\/tenants\/:tenantId\/products\/:productId\/status', requirePortalInternalAuth, catalogWriteRole, catalogModule, updatePortalProductStatus\)/,
  /router\.post\('\/tenants\/:tenantId\/product-categories', requirePortalInternalAuth, catalogWriteRole, catalogModule, postPortalProductCategory\)/,
  /router\.patch\('\/tenants\/:tenantId\/product-categories\/:categoryId', requirePortalInternalAuth, catalogWriteRole, catalogModule, updatePortalProductCategory\)/,
  /router\.delete\('\/tenants\/:tenantId\/product-categories\/:categoryId', requirePortalInternalAuth, catalogWriteRole, catalogModule, destroyPortalProductCategory\)/,
  /router\.delete\('\/tenants\/:tenantId\/products\/:productId', requirePortalInternalAuth, catalogWriteRole, catalogModule, destroyPortalProduct\)/,
  /router\.post\('\/tenants\/:tenantId\/suppliers', requirePortalInternalAuth, inventoryReceiptRole, inventoryCapability, postPortalSupplier\)/,
  /router\.patch\('\/tenants\/:tenantId\/suppliers\/:supplierId', requirePortalInternalAuth, inventoryReceiptRole, inventoryCapability, patchPortalSupplier\)/,
  /router\.patch\('\/tenants\/:tenantId\/suppliers\/:supplierId\/status', requirePortalInternalAuth, inventoryReceiptRole, inventoryCapability, patchPortalSupplierStatus\)/,
  /router\.post\('\/tenants\/:tenantId\/purchase-receipts', requirePortalInternalAuth, inventoryReceiptRole, inventoryCapability, postPortalPurchaseReceiptController\)/
];

for (const pattern of [...protectedReadPatterns, ...protectedWritePatterns]) {
  assert.match(routes, pattern);
}

for (const line of routes.split(/\r?\n/).filter((candidate) => /catalog-imports/.test(candidate) && /router\.(get|post)/.test(candidate))) {
  assert.match(line, /requirePortalInternalAuth/);
  assert.match(line, /catalog(Read|Write)Role/, `catalog import route lacks actor scope gate: ${line}`);
}

console.log('inventory-multitenant-route-security.test.js passed');
