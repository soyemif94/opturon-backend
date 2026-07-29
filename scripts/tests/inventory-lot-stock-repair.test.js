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
    const auditCalls = [];
    let auditShouldFail = false;
    touched.push(
      mockModule('src/repositories/portal-user-audit.repository.js', {
        createPortalUserAuditEvent: async (entry) => {
          auditCalls.push(entry);
          if (auditShouldFail) return null;
          return { id: 'audit-1' };
        },
        findLatestPortalUserAuditEventByIdempotencyKey: async () => null
      })
    );

    clearModule('scripts/repair-lot-product-stock-divergence.js');
    const repairModule = require(path.join(root, 'scripts/repair-lot-product-stock-divergence.js'));

    const fingerprint = require(path.join(root, 'scripts/lib/inventory-lot-stock-divergence.js')).buildRepairFingerprint({
      fingerprint: 'fingerprint-1',
      expectedProductStock: 0
    });
    const dryRunDetail = {
      tenantId: 'tenant-1',
      productId: 'product-1',
      trackingMode: 'lot_based',
      deletedAt: null,
      productStock: 60,
      expectedProductStock: 0,
      physicalTotal: 60,
      committedTotal: 0,
      commercialAvailableTotal: 0,
      expectedSemantics: 'active_non_cancelled_non_expired_available_quantity',
      rootCauseCode: 'stock_semantics_changed',
      repairSafe: true,
      sourceOfTruth: 'LOTS',
      fingerprint: 'fingerprint-1',
      ledgerConsistency: { status: 'consistent' }
    };

    const dryRunClient = {
      connect: async () => {},
      end: async () => {},
      query: async () => ({ rows: [] })
    };
    const dryRun = await repairModule.repairProductStock(
      dryRunClient,
      { tenant: 'tenant-1', product: 'product-1' },
      { loadTargetProductDetail: async () => dryRunDetail }
    );
    assert.strictEqual(dryRun.ok, true);
    assert.strictEqual(dryRun.dryRun, true);
    assert.strictEqual(dryRun.currentProductStock, 60);
    assert.strictEqual(dryRun.expectedProductStock, 0);
    assert.strictEqual(dryRun.repairSafe, true);

    let updatedStock = null;
    const applyQueries = [];
    const loadCalls = [];
    const loadApplyDetail = async () => {
      loadCalls.push('call');
      return { ...dryRunDetail };
    };

    const applyClient = {
      query: async (text, params) => {
        applyQueries.push(text);
        if (/SELECT p\.id, p\.stock/.test(text)) {
          return {
            rows: [{
              id: 'product-1',
              stock: 60,
              status: 'active',
              deletedAt: null,
              updatedAt: '2026-07-01T00:00:00.000Z',
              tracking_mode: 'lot_based',
              timezone: 'America/Argentina/Buenos_Aires'
            }]
          };
        }
        if (/SELECT id, role, active, "clinicId", "accountType"/.test(text)) {
          return {
            rows: [{
              id: '11111111-1111-4111-8111-111111111111',
              role: 'owner',
              active: true,
              clinicId: 'tenant-1',
              accountType: 'client_portal'
            }]
          };
        }
        if (/UPDATE products/.test(text)) {
          updatedStock = params[2];
          return { rows: [] };
        }
        return { rows: [] };
      }
    };
    const apply = await repairModule.repairProductStock(applyClient, {
      tenant: 'tenant-1',
      product: 'product-1',
      apply: true,
      actor: '11111111-1111-4111-8111-111111111111',
      reason: 'qa',
      'expected-current-stock': '60',
      'expected-lot-fingerprint': fingerprint
    }, { loadTargetProductDetail: loadApplyDetail });
    assert.strictEqual(apply.ok, true);
    assert.strictEqual(updatedStock, 0);
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].action, 'inventory_lot_product_stock_resynchronized');

    const invalidActor = await repairModule.repairProductStock(
      dryRunClient,
      {
        tenant: 'tenant-1',
        product: 'product-1',
        apply: true,
        actor: 'invalid',
        reason: 'qa',
        'expected-current-stock': '60',
        'expected-lot-fingerprint': fingerprint
      },
      { loadTargetProductDetail: async () => dryRunDetail }
    );
    assert.strictEqual(invalidActor.ok, false);
    assert.strictEqual(invalidActor.reason, 'inventory_product_stock_repair_actor_invalid');

    const idempotent = await repairModule.repairProductStock(
      dryRunClient,
      { tenant: 'tenant-1', product: 'product-1', apply: true },
      {
        loadTargetProductDetail: async () => ({
          ...dryRunDetail,
          productStock: 0,
          expectedProductStock: 0
        })
      }
    );
    assert.strictEqual(idempotent.ok, true);
    assert.strictEqual(idempotent.alreadyConsistent, true);

    auditShouldFail = true;
    const failed = await repairModule.repairProductStock(applyClient, {
      tenant: 'tenant-1',
      product: 'product-1',
      apply: true,
      actor: '11111111-1111-4111-8111-111111111111',
      reason: 'qa',
      'expected-current-stock': '60',
      'expected-lot-fingerprint': fingerprint
    }, { loadTargetProductDetail: async () => ({ ...dryRunDetail }) });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.reason, 'inventory_product_stock_repair_audit_failed');

    console.log('inventory-lot-stock-repair.test.js passed');
  } finally {
    clearModule('scripts/repair-lot-product-stock-divergence.js');
    for (const resolved of touched) delete require.cache[resolved];
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
