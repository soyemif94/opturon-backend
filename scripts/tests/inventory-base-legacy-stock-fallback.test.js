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
          clinic: { id: 'clinic-1' }
        })
      })
    );

    let currentProductStock = 25;
    let balanceQuantity = null;
    let updatedProductStock = null;
    let updatedBalanceQuantity = null;

    touched.push(
      mockModule('src/repositories/products.repository.js', {
        findProductById: async () => ({
          id: 'prod-1',
          clinicId: 'clinic-1',
          name: 'Producto legacy',
          description: null,
          unitPrice: 100,
          currency: 'ARS',
          vatRate: 0,
          stock: currentProductStock,
          status: 'active',
          sku: 'SKU-1',
          metadata: {},
          internalCode: 'A-0001',
          inventoryTrackingMode: 'legacy'
        }),
        updateProduct: async (productId, clinicId, payload) => {
          updatedProductStock = payload.stock;
          currentProductStock = payload.stock;
          return {
            id: productId,
            clinicId,
            ...payload,
            inventoryTrackingMode: 'legacy'
          };
        }
      })
    );

    touched.push(
      mockModule('src/repositories/portal-user-audit.repository.js', {
        createPortalUserAuditEvent: async () => ({ ok: true })
      })
    );

    touched.push(
      mockModule('src/repositories/inventory.repository.js', {
        insertInventoryMovement: async (input) => ({
          id: 'mov-1',
          movementType: input.movementType,
          quantity: input.quantity,
          quantityBefore: input.quantityBefore,
          quantityAfter: input.quantityAfter,
          idempotencyKey: input.idempotencyKey,
          reason: input.reason || null
        })
      })
    );

    touched.push(
      mockModule('src/repositories/inventory-base.repository.js', {
        reserveNextInternalCodeNumber: async () => 0,
        ensurePrimaryInventoryLocation: async () => ({ id: 'loc-1', code: 'main', name: 'Principal' }),
        ensureInventoryBalanceRow: async (_tenantId, _productId, _locationId, _client, options = {}) => {
          if (balanceQuantity == null) {
            balanceQuantity = Number(options.initialQuantity || 0);
          }
          return { id: 'bal-1', quantity: balanceQuantity };
        },
        updateInventoryBalanceQuantity: async (_balanceId, _tenantId, quantity) => {
          updatedBalanceQuantity = quantity;
          balanceQuantity = quantity;
          return { id: 'bal-1', quantity };
        },
        listInventoryBalancesByTenant: async () => ({
          total: 2,
          rows: [
            {
              id: 'prod-legacy-no-balance',
              clinicId: 'clinic-1',
              name: 'Legacy sin balance',
              price: 10,
              unitPrice: 10,
              currency: 'ARS',
              vatRate: 0,
              stock: 25,
              balanceQuantity: null,
              status: 'active',
              sku: 'LEG-25',
              internalCode: 'A-0001',
              metadata: {}
            },
            {
              id: 'prod-balance-zero',
              clinicId: 'clinic-1',
              name: 'Balance cero',
              price: 10,
              unitPrice: 10,
              currency: 'ARS',
              vatRate: 0,
              stock: 25,
              balanceQuantity: 0,
              status: 'active',
              sku: 'BAL-0',
              internalCode: 'A-0002',
              metadata: {}
            }
          ]
        }),
        listInventoryMovementsByProductId: async () => [],
        findInventoryMovementByIdempotencyKey: async () => null
      })
    );

    const servicePath = path.join(root, 'src/services/inventory-base.service.js');
    delete require.cache[require.resolve(servicePath)];
    const {
      listPortalInventoryProducts,
      createPortalInventoryMovement
    } = require(servicePath);

    const listed = await listPortalInventoryProducts('tenant-1', { page: 1, pageSize: 50 });
    assert.equal(listed.ok, true);
    assert.equal(listed.products[0].stock, 25, 'legacy product without balance must fallback to products.stock');
    assert.equal(listed.products[1].stock, 0, 'existing zero balance must remain zero and not fallback to stale products.stock');

    const movement = await createPortalInventoryMovement(
      'tenant-1',
      'prod-1',
      {
        movementType: 'manual_increase',
        quantity: 5,
        reason: 'QA legacy seed',
        idempotencyKey: 'legacy-seed-1'
      },
      { actorId: 'actor-1' }
    );

    assert.equal(movement.ok, true);
    assert.equal(movement.movement.quantityBefore, 25);
    assert.equal(movement.movement.quantityAfter, 30);
    assert.equal(movement.balance.quantity, 30);
    assert.equal(updatedBalanceQuantity, 30);
    assert.equal(updatedProductStock, 30);

    console.log('inventory-base-legacy-stock-fallback.test.js passed');
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
