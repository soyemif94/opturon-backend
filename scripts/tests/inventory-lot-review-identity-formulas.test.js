const assert = require('assert');
const fs = require('fs');
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
    const captured = [];
    touched.push(
      mockModule('src/db/client.js', {
        query: async (text, params) => {
          captured.push({ text, params });
          return { rows: [] };
        }
      })
    );

    clearModule('src/repositories/inventory.repository.js');
    const repository = require(path.join(root, 'src/repositories/inventory.repository.js'));
    const lotState = require(path.join(root, 'src/utils/inventory-lot-state.js'));
    const { normalizeLotNumber } = require(path.join(root, 'src/utils/inventory-lot-identity.js'));

    assert.strictEqual(normalizeLotNumber('  a  b-12  '), 'A B-12');

    await repository.findPhysicalInventoryLot({
      tenantId: '11111111-1111-1111-1111-111111111111',
      productId: '22222222-2222-2222-2222-222222222222',
      locationId: null,
      lotNumber: ' a  b-12 ',
      expiresAt: null
    });
    await repository.findConflictingInventoryLot({
      tenantId: '11111111-1111-1111-1111-111111111111',
      productId: '22222222-2222-2222-2222-222222222222',
      locationId: null,
      lotNumber: 'A B12'
    });

    assert.match(captured[0].text, /"locationId" IS NOT DISTINCT FROM \$3::uuid/);
    assert.match(captured[0].text, /"expiresAt" IS NOT DISTINCT FROM \$5::date/);
    assert.strictEqual(captured[0].params[3], 'A B-12');
    assert.match(captured[1].text, /"locationId" IS NOT DISTINCT FROM \$3::uuid/);

    const exampleA = { availableQuantity: 20, committedQuantity: 5, status: 'active', operationalStatus: 'active' };
    assert.strictEqual(lotState.resolveLotPhysicalQuantity(exampleA), 20);
    assert.strictEqual(lotState.resolveLotCommercialAvailableQuantity(exampleA, 'normal'), 15);

    const exampleB = { availableQuantity: 20, committedQuantity: 5, status: 'active', operationalStatus: 'blocked' };
    assert.strictEqual(lotState.resolveLotPhysicalQuantity(exampleB), 20);
    assert.strictEqual(lotState.resolveLotCommercialAvailableQuantity(exampleB, 'normal'), 0);

    const exampleC = { availableQuantity: 20, committedQuantity: 5, status: 'active', operationalStatus: 'active' };
    assert.strictEqual(lotState.resolveLotPhysicalQuantity(exampleC), 20);
    assert.strictEqual(lotState.resolveLotCommercialAvailableQuantity(exampleC, 'expired'), 0);

    const exampleD = { availableQuantity: 20, committedQuantity: 5, status: 'depleted', operationalStatus: 'written_off' };
    assert.strictEqual(lotState.resolveLotPhysicalQuantity(exampleD), 0);
    assert.strictEqual(lotState.resolveLotCommercialAvailableQuantity(exampleD, 'expired'), 0);

    const combined = [exampleA, exampleB, exampleC, exampleD];
    assert.strictEqual(combined.reduce((sum, lot) => sum + lotState.resolveLotPhysicalQuantity(lot), 0), 60);
    assert.strictEqual(combined.reduce((sum, lot) => sum + lotState.resolveLotCommercialAvailableQuantity(lot, lot === exampleC ? 'expired' : 'normal'), 0), 15);

    const repositorySource = fs.readFileSync(path.join(root, 'src/repositories/inventory.repository.js'), 'utf8');
    assert.match(repositorySource, /status <> 'cancelled'/);
    assert.match(repositorySource, /"operationalStatus".*= 'active'/);
    assert.match(repositorySource, /"expiresAt" IS NULL OR "expiresAt" >= COALESCE/);

    console.log('inventory-lot-review-identity-formulas.test.js passed');
  } finally {
    clearModule('src/repositories/inventory.repository.js');
    for (const resolved of touched) delete require.cache[resolved];
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
