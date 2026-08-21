const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { PGlite } = require('@electric-sql/pglite');

const root = process.cwd();

function mockModule(relativePath, exportsValue) {
  const resolved = require.resolve(path.join(root, relativePath));
  delete require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
  return resolved;
}

async function main() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE product_categories (id UUID PRIMARY KEY, "clinicId" UUID NOT NULL, name TEXT NOT NULL);
    CREATE TABLE suppliers (id UUID PRIMARY KEY, "tenantId" UUID NOT NULL, status TEXT, "tradeName" TEXT, "legalName" TEXT);
    CREATE TABLE products (
      id UUID PRIMARY KEY, "clinicId" UUID NOT NULL, name TEXT NOT NULL, description TEXT,
      price NUMERIC DEFAULT 0, "unitPrice" NUMERIC DEFAULT 0, currency TEXT DEFAULT 'ARS', "vatRate" NUMERIC DEFAULT 0,
      stock INTEGER DEFAULT 0, status TEXT DEFAULT 'active', sku TEXT, "internalCode" TEXT,
      "categoryId" UUID, "defaultSupplierId" UUID, "expirationDate" DATE, "discountPercentage" NUMERIC,
      metadata JSONB DEFAULT '{}'::jsonb, "deletedAt" TIMESTAMPTZ, "deletedBy" UUID,
      "deleteReason" TEXT, "deletionMetadata" JSONB, "createdAt" TIMESTAMPTZ DEFAULT NOW(), "updatedAt" TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const categoryA = randomUUID();
  const categoryB = randomUUID();
  await db.query('INSERT INTO product_categories (id,"clinicId",name) VALUES ($1,$3,\'Categoría A\'),($2,$3,\'Categoría B\')', [categoryA, categoryB, tenantA]);

  const productsA = Array.from({ length: 505 }, (_, index) => ({
    id: randomUUID(),
    name: index === 249 ? 'Producto Operativo Especial' : `Producto ${String(index + 1).padStart(3, '0')}`,
    sku: index === 300 ? 'SKU-OPERATIVO-UNICO' : `SKU-${String(index + 1).padStart(4, '0')}`,
    code: `INT-${String(index + 1).padStart(4, '0')}`,
    stock: index < 7 ? index + 1 : 0,
    status: index >= 500 ? 'archived' : 'active',
    categoryId: index % 2 === 0 ? categoryA : categoryB,
    metadata: {
      catalog: {
        inventoryTrackingMode: index === 0 ? 'lot_based' : 'legacy',
        ...(index < 17 ? { image: { url: `https://images.example/${index + 1}.webp` } } : {})
      }
    }
  }));
  const productsB = [{ id: randomUUID(), name: 'Privado B', sku: 'B-1', code: 'B-INT', stock: 99, status: 'active', categoryId: null, metadata: {} }];

  for (const [tenantId, products] of [[tenantA, productsA], [tenantB, productsB]]) {
    for (let start = 0; start < products.length; start += 100) {
      const batch = products.slice(start, start + 100);
      const params = [];
      const values = batch.map((product) => {
        const offset = params.length;
        params.push(product.id, tenantId, product.name, product.stock, product.status, product.sku, product.code, product.categoryId, JSON.stringify(product.metadata));
        return `($${offset + 1}::uuid,$${offset + 2}::uuid,$${offset + 3},10,10,'ARS',0,$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8}::uuid,$${offset + 9}::jsonb)`;
      });
      await db.query(`INSERT INTO products (id,"clinicId",name,price,"unitPrice",currency,"vatRate",stock,status,sku,"internalCode","categoryId",metadata) VALUES ${values.join(',')}`, params);
    }
  }

  const dbClientPath = mockModule('src/db/client.js', { query: (text, params) => db.query(text, params), closePool: async () => {} });
  const repositoryPath = require.resolve(path.join(root, 'src/repositories/products.repository.js'));
  delete require.cache[repositoryPath];
  const { listProductImagesByClinicId } = require(repositoryPath);

  const first = await listProductImagesByClinicId(tenantA, { page: 1, pageSize: 50 });
  assert.equal(first.total, 505);
  assert.equal(first.products.length, 50);
  assert.deepEqual(first.summary, { totalProducts: 505, withStock: 7, withoutStock: 498, withImage: 17, withoutImage: 488, activeProducts: 500, archivedProducts: 5 });
  assert.equal(first.products[0].inventoryTrackingMode, 'lot_based');
  assert.equal(first.products[0].stock, 1);

  const second = await listProductImagesByClinicId(tenantA, { page: 2, pageSize: 50 });
  assert.equal(second.products.length, 50);
  const last = await listProductImagesByClinicId(tenantA, { page: 11, pageSize: 50 });
  assert.equal(last.products.length, 5);
  assert.equal(last.total, 505);

  assert.equal((await listProductImagesByClinicId(tenantA, { search: 'Operativo Especial' })).total, 1);
  assert.equal((await listProductImagesByClinicId(tenantA, { search: 'SKU-OPERATIVO-UNICO' })).total, 1);
  assert.equal((await listProductImagesByClinicId(tenantA, { stockFilter: 'with_stock' })).total, 7);
  assert.equal((await listProductImagesByClinicId(tenantA, { stockFilter: 'without_stock' })).total, 498);
  assert.equal((await listProductImagesByClinicId(tenantA, { imageFilter: 'without_image' })).total, 488);
  assert.equal((await listProductImagesByClinicId(tenantA, { stockFilter: 'without_stock', imageFilter: 'with_image' })).total, 10);
  assert.equal((await listProductImagesByClinicId(tenantA, { statusFilter: 'archived' })).total, 5);
  assert.equal((await listProductImagesByClinicId(tenantA, { categoryId: categoryA })).total, 253);

  const tenantBResult = await listProductImagesByClinicId(tenantB, {});
  assert.equal(tenantBResult.total, 1);
  assert.equal(tenantBResult.products[0].name, 'Privado B');

  const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  assert.match(routes, /products\/workspace', requirePortalInternalAuth, catalogModule, getPortalProductImages/);

  delete require.cache[repositoryPath];
  delete require.cache[dbClientPath];
  await db.close();
  console.log('catalog-operations-workspace.test.js passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
