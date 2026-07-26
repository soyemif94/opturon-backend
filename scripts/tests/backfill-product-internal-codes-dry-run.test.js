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
    process.argv = ['node', 'scripts/backfill-product-internal-codes.js'];
    process.exitCode = 0;

    touched.push(
      mockModule('src/db/client.js', {
        withTransaction: async (work) =>
          work({
            query: async (sql, params = []) => {
              const text = String(sql);
              if (/FROM clinics/.test(text)) {
                return { rows: [{ id: 'clinic-1', externalTenantId: 'tenant-demo' }] };
              }
              if (/COUNT\(\*\)::int AS total/.test(text)) {
                return { rows: [{ total: 2 }] };
              }
              if (/allocatorNextValue/.test(text)) {
                return { rows: [{ maxValue: -1, allocatorNextValue: null }] };
              }
              if (/SELECT id\s+FROM products/.test(text)) {
                return { rows: [{ id: 'p1' }, { id: 'p2' }] };
              }
              if (/INSERT INTO product_internal_code_allocators/.test(text) || /UPDATE products/.test(text) || /portal_user_audit_log/.test(text)) {
                throw new Error(`dry_run_write_attempt:${text}`);
              }
              throw new Error(`unexpected_query:${text}`);
            }
          }),
        closePool: async () => {}
      })
    );

    touched.push(
      mockModule('src/services/inventory-base.service.js', {
        formatInternalCodeFromNumber: (value) => `A-${String(value).padStart(4, '0')}`
      })
    );

    process.stdout.write = (chunk, encoding, callback) => {
      output += String(chunk);
      if (typeof callback === 'function') callback();
      return true;
    };

    const scriptPath = path.join(root, 'scripts/backfill-product-internal-codes.js');
    delete require.cache[require.resolve(scriptPath)];
    require(scriptPath);
    await new Promise((resolve) => setImmediate(resolve));

    const parsed = JSON.parse(output.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, 'dry-run');
    assert.equal(parsed.summary.missingBefore, 2);
    assert.equal(parsed.results[0].allocatorBaseline.baselineNextValue, 0);

    console.log('backfill-product-internal-codes-dry-run.test.js passed');
  } finally {
    process.stdout.write = originalWrite;
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    clearModule('scripts/backfill-product-internal-codes.js');
    for (const resolved of touched) {
      delete require.cache[resolved];
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
