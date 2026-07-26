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
  const originalArgv = process.argv.slice();
  const originalExitCode = process.exitCode;
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = '';

  try {
    process.argv = ['node', 'scripts/normalize-inventory-capability-policy.js'];
    process.exitCode = 0;

    touched.push(
      mockModule('src/db/client.js', {
        query: async () => ({
          rows: [
            {
              id: 'clinic-1',
              tenantId: 'tenant-client-1',
              settings: {
                portal: {
                  accountScope: 'client',
                  policy: {
                    policyVersion: 1,
                    capabilities: ['catalog'],
                    enabledModules: { catalog: true }
                  }
                }
              },
              accountScope: 'client',
              activeTotal: 3,
              activeBase: 3,
              activeLot: 0
            },
            {
              id: 'clinic-2',
              tenantId: 'tenant-client-2',
              settings: {
                portal: {
                  accountScope: 'client',
                  policy: {
                    policyVersion: 1,
                    capabilities: ['catalog', 'inventory'],
                    enabledModules: { catalog: true }
                  }
                }
              },
              accountScope: 'client',
              activeTotal: 2,
              activeBase: 0,
              activeLot: 2
            },
            {
              id: 'clinic-3',
              tenantId: 'tenant-admin',
              settings: {
                portal: {
                  accountScope: 'opturon_admin',
                  policy: {
                    policyVersion: 1,
                    capabilities: [],
                    enabledModules: {}
                  }
                }
              },
              accountScope: 'opturon_admin',
              activeTotal: 5,
              activeBase: 5,
              activeLot: 0
            }
          ]
        })
      })
    );

    touched.push(
      mockModule('src/services/tenant-policy.service.js', {
        updateTenantPolicyByExternalTenantId: async () => {
          throw new Error('dry-run should not normalize');
        }
      })
    );

    process.stdout.write = (chunk, encoding, callback) => {
      output += String(chunk);
      if (typeof callback === 'function') callback();
      return true;
    };

    const scriptPath = path.join(root, 'scripts/normalize-inventory-capability-policy.js');
    delete require.cache[require.resolve(scriptPath)];
    require(scriptPath);
    await new Promise((resolve) => setImmediate(resolve));

    const lines = output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(lines[0].mode, 'dry-run');
    assert.equal(lines[0].candidates, 3);
    assert.equal(lines[0].eligible, 1);
    assert.equal(lines[0].alreadyAligned, 1);
    assert.equal(lines[0].skipped, 1);
    assert.equal(lines[1].action, 'would_normalize');
    assert.equal(lines[1].visibleByLegacyCompatibility, true);
    assert.equal(lines[1].hasInventorySignals, true);
    assert.equal(lines[2].action, 'already_aligned');

    console.log('normalize-inventory-capability-policy.test.js passed');
  } finally {
    process.stdout.write = originalWrite;
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    clearModule('scripts/normalize-inventory-capability-policy.js');
    for (const resolved of touched) {
      delete require.cache[resolved];
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
