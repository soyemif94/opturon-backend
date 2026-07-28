const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function mockModule(relativePath, exportsValue) {
  const resolved = require.resolve(path.join(root, relativePath));
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue
  };
  return resolved;
}

function clearModule(relativePath) {
  const resolved = require.resolve(path.join(root, relativePath));
  delete require.cache[resolved];
}

async function main() {
  const touched = [];
  try {
    touched.push(
      mockModule('src/db/client.js', {
        withTransaction: async (work) => work({ mocked: true })
      })
    );

    touched.push(
      mockModule('src/services/portal-context.service.js', {
        resolvePortalTenantContext: async (tenantId) => ({
          ok: true,
          tenantId,
          clinic: { id: 'clinic-1', name: 'Tenant QA' }
        })
      })
    );

    let requestedProductId = null;
    let requestedClinicId = null;
    let movementLookup = null;

    touched.push(
      mockModule('src/repositories/products.repository.js', {
        findProductById: async (productId, clinicId) => {
          requestedProductId = productId;
          requestedClinicId = clinicId;
          return {
            id: productId,
            clinicId,
            name: 'Producto sin movimientos',
            description: null,
            unitPrice: 100,
            price: 100,
            currency: 'ARS',
            vatRate: 0,
            taxRate: 0,
            stock: 7,
            status: 'active',
            active: true,
            sku: 'SKU-EMPTY',
            internalCode: 'A-0007',
            inventoryTrackingMode: 'legacy',
            metadata: {},
            deletionMetadata: {},
            createdAt: '2026-07-27T00:00:00.000Z',
            updatedAt: '2026-07-27T00:00:00.000Z'
          };
        },
        updateProduct: async () => null
      })
    );

    touched.push(
      mockModule('src/repositories/portal-user-audit.repository.js', {
        createPortalUserAuditEvent: async () => ({ ok: true })
      })
    );

    touched.push(
      mockModule('src/repositories/inventory.repository.js', {
        insertInventoryMovement: async () => {
          throw new Error('not_expected_in_history_test');
        }
      })
    );

    touched.push(
      mockModule('src/repositories/inventory-base.repository.js', {
        reserveNextInternalCodeNumber: async () => 0,
        ensurePrimaryInventoryLocation: async () => ({ id: 'loc-1', code: 'main', name: 'Principal' }),
        ensureInventoryBalanceRow: async () => ({ id: 'bal-1', quantity: 7 }),
        updateInventoryBalanceQuantity: async () => ({ id: 'bal-1', quantity: 7 }),
        listInventoryBalancesByTenant: async () => ({ total: 0, rows: [] }),
        listInventoryMovementsByProductId: async (tenantId, productId, options) => {
          movementLookup = { tenantId, productId, options };
          return [];
        },
        findInventoryMovementByIdempotencyKey: async () => null
      })
    );

    const servicePath = path.join(root, 'src/services/inventory-base.service.js');
    delete require.cache[require.resolve(servicePath)];
    const { getPortalInventoryProductHistory } = require(servicePath);

    const result = await getPortalInventoryProductHistory('tenant-enabled', 'prod-empty', { page: 1, pageSize: 25 });

    assert.equal(result.ok, true);
    assert.equal(result.tenantId, 'tenant-enabled');
    assert.equal(result.product.id, 'prod-empty');
    assert.deepEqual(result.movements, []);
    assert.equal(requestedProductId, 'prod-empty');
    assert.equal(requestedClinicId, 'clinic-1');
    assert.deepEqual(movementLookup, {
      tenantId: 'clinic-1',
      productId: 'prod-empty',
      options: { page: 1, pageSize: 25 }
    });

    console.log('inventory-product-history-empty.test.js passed');
  } finally {
    clearModule('src/services/inventory-base.service.js');
    for (const resolved of touched) {
      delete require.cache[resolved];
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
