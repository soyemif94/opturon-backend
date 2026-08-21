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
    CREATE TABLE suppliers (
      id UUID PRIMARY KEY, "tenantId" UUID NOT NULL, status TEXT,
      "tradeName" TEXT, "legalName" TEXT
    );
    CREATE TABLE products (
      id UUID PRIMARY KEY, "clinicId" UUID NOT NULL, name TEXT NOT NULL,
      description TEXT, price NUMERIC NOT NULL DEFAULT 0, "unitPrice" NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'ARS', "vatRate" NUMERIC NOT NULL DEFAULT 0,
      stock INTEGER DEFAULT 0, status TEXT DEFAULT 'active', sku TEXT, "internalCode" TEXT,
      "categoryId" UUID, "defaultSupplierId" UUID, "expirationDate" DATE,
      "discountPercentage" NUMERIC, metadata JSONB DEFAULT '{}'::jsonb,
      "deletedAt" TIMESTAMPTZ, "deletedBy" UUID, "deleteReason" TEXT,
      "deletionMetadata" JSONB, "createdAt" TIMESTAMPTZ DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const productsA = Array.from({ length: 505 }, (_, index) => ({
    id: randomUUID(),
    name: index === 249 ? 'Producto Especial Buscable' : `Producto ${String(index + 1).padStart(3, '0')}`,
    sku: index === 300 ? 'SKU-UNICO-BUSCABLE' : `SKU-${String(index + 1).padStart(4, '0')}`,
    code: `INT-${String(index + 1).padStart(4, '0')}`,
    image: index < 17 ? `https://images.example/${index + 1}.webp` : null
  }));
  const productsB = Array.from({ length: 3 }, (_, index) => ({
    id: randomUUID(), name: `Privado B ${index + 1}`, sku: `B-${index + 1}`, code: null, image: null
  }));

  for (const [tenantId, products] of [[tenantA, productsA], [tenantB, productsB]]) {
    for (let start = 0; start < products.length; start += 100) {
      const batch = products.slice(start, start + 100);
      const params = [];
      const values = batch.map((product) => {
        const offset = params.length;
        params.push(product.id, tenantId, product.name, product.sku, product.code, JSON.stringify(product.image
          ? { catalog: { image: { url: product.image, source: 'uploaded' } } }
          : {}));
        return `($${offset + 1}::uuid,$${offset + 2}::uuid,$${offset + 3},10,10,'ARS',0,0,'active',$${offset + 4},$${offset + 5},$${offset + 6}::jsonb)`;
      });
      await db.query(
        `INSERT INTO products (id,"clinicId",name,price,"unitPrice",currency,"vatRate",stock,status,sku,"internalCode",metadata)
         VALUES ${values.join(',')}`,
        params
      );
    }
  }

  const dbClientPath = mockModule('src/db/client.js', {
    query: (text, params) => db.query(text, params),
    closePool: async () => {}
  });
  const repositoryPath = require.resolve(path.join(root, 'src/repositories/products.repository.js'));
  delete require.cache[repositoryPath];
  const { listProductImagesByClinicId, updateProduct } = require(repositoryPath);

  const first = await listProductImagesByClinicId(tenantA, { page: 1, pageSize: 50, imageFilter: 'all' });
  assert.equal(first.total, 505);
  assert.equal(first.products.length, 50);
  assert.deepEqual(first.summary, {
    totalProducts: 505,
    withStock: 0,
    withoutStock: 505,
    withImage: 17,
    withoutImage: 488,
    activeProducts: 505,
    archivedProducts: 0
  });

  const last = await listProductImagesByClinicId(tenantA, { page: 11, pageSize: 50 });
  assert.equal(last.products.length, 5);
  assert.equal(last.total, 505);
  const beyond = await listProductImagesByClinicId(tenantA, { page: 12, pageSize: 50 });
  assert.equal(beyond.products.length, 0);
  assert.equal(beyond.total, 505);

  const byName = await listProductImagesByClinicId(tenantA, { search: 'Especial Buscable' });
  assert.equal(byName.total, 1);
  assert.equal(byName.products[0].name, 'Producto Especial Buscable');
  const bySku = await listProductImagesByClinicId(tenantA, { search: 'SKU-UNICO-BUSCABLE' });
  assert.equal(bySku.total, 1);
  const withImage = await listProductImagesByClinicId(tenantA, { imageFilter: 'with_image', pageSize: 50 });
  assert.equal(withImage.total, 17);
  assert.equal(withImage.products.length, 17);
  assert.deepEqual(withImage.summary, first.summary);
  const withoutImage = await listProductImagesByClinicId(tenantA, { imageFilter: 'without_image', pageSize: 50 });
  assert.equal(withoutImage.total, 488);
  assert.equal(withoutImage.products.length, 50);

  const isolated = await listProductImagesByClinicId(tenantB, { pageSize: 50 });
  assert.equal(isolated.total, 3);
  assert.ok(isolated.products.every((product) => product.name.startsWith('Privado B')));
  const crossTenantUpdate = await updateProduct(productsB[0].id, tenantA, { image: { url: 'https://bad.example/image.webp' } });
  assert.equal(crossTenantUpdate, null);
  const untouched = await db.query('SELECT metadata FROM products WHERE id = $1::uuid', [productsB[0].id]);
  assert.deepEqual(untouched.rows[0].metadata, {});

  const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  assert.match(routes, /products\/images', requirePortalInternalAuth, inventoryReadRole, catalogModule, getPortalProductImages/);
  assert.match(routes, /products\/:productId', requirePortalInternalAuth, catalogWriteRole, catalogModule, updatePortalProduct/);

  delete require.cache[repositoryPath];
  delete require.cache[dbClientPath];
  await db.close();
  console.log('catalog-images-workspace.test.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
