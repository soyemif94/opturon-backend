const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

function read(relativePath) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const repositorySource = read('src/repositories/products.repository.js');
const portalServiceSource = read('src/services/portal-products.service.js');
const controllerSource = read('src/controllers/portal.controller.js');

for (const field of [
  'manufacturer',
  'barcode',
  'unitOfMeasure',
  'cost',
  'defaultSupplier',
  'weight',
  'weightUnit',
  'presentation',
  'subcategory',
  'attributes'
]) {
  assert.match(repositorySource, new RegExp(`${field}: catalogMetadata\\.${field}|${field}: normalizeCatalog`));
  assert.match(portalServiceSource, new RegExp(`${field}`));
}

assert.match(repositorySource, /function normalizeProductAttributeRecord/);
assert.match(repositorySource, /attributes: normalizeProductAttributeRecord\(input\.attributes\)/);
assert.match(portalServiceSource, /function normalizeNullableNumber/);
assert.match(portalServiceSource, /invalid_product_cost/);
assert.match(portalServiceSource, /invalid_product_weight/);
assert.match(controllerSource, /invalid_product_cost/);
assert.match(controllerSource, /invalid_product_weight/);

console.log('catalog-product-fields.test.js passed');
