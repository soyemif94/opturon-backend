const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { requireGeneration, validateRuntimeState } = require('../../src/repositories/saas-billing-runtime.repository');
const { activateCutover } = require('../billing/activate-billing-contract-v2-cutover');

test('Durable cutover: local PostgreSQL activation and row barrier', async t => {
  const url = new URL(process.env.BILLING_TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, 'billing_test'); assert.equal(url.password, '');
  const admin = new Pool({ connectionString: url.href });
  async function isolated(fn) {
    const schema = `cutover_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}` });
    try { await fn(pool); } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
  }
  const migrate = pool => pool.query(fs.readFileSync(path.resolve(__dirname, '../../db/migrations/087_saas_billing_runtime_state.sql'), 'utf8'));
  try {
    await t.test('M0 absent fails closed; invalid state cannot authorize', () => isolated(async pool => {
      await assert.rejects(requireGeneration(1, pool), /does not exist/);
      for (const row of [null, {}, { id: 1, schemaVersion: 1, generation: 2, billingContractV2CutoverActive: false }]) {
        assert.throws(() => validateRuntimeState(row), /invalid/);
      }
    }));
    await t.test('Generation 1 admits legacy, denies v2; dry-run leaves singleton unchanged', () => isolated(async pool => {
      await migrate(pool); assert.equal((await requireGeneration(1, pool)).generation, 1);
      await assert.rejects(requireGeneration(2, pool), /disabled/);
      const client = await pool.connect();
      try { assert.equal((await activateCutover(client)).dryRun, true); } finally { client.release(); }
      assert.equal((await requireGeneration(1, pool)).generation, 1);
    }));
    await t.test('Activation is atomic, exact 24h, irreversible; denies legacy and admits v2', () => isolated(async pool => {
      await migrate(pool); const client = await pool.connect();
      try { await activateCutover(client, { apply: true }); } finally { client.release(); }
      const state = await requireGeneration(2, pool);
      assert.equal(new Date(state.autoApplyNotBefore) - new Date(state.cutoverAt), 86400000);
      await assert.rejects(requireGeneration(1, pool), /disabled/);
      await assert.rejects(pool.query('UPDATE saas_billing_runtime_state SET generation=1'), /irreversible/);
      await assert.rejects(pool.query('DELETE FROM saas_billing_runtime_state'), /irreversible/);
    }));
    await t.test('Legacy final mutation holds shared barrier; activation waits for commit', () => isolated(async pool => {
      await migrate(pool); const legacy = await pool.connect(); const activation = await pool.connect();
      try {
        await legacy.query('BEGIN'); await requireGeneration(1, legacy, { lock: true });
        const activationPid = (await activation.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        let activated = false;
        const pending = activateCutover(activation, { apply: true }).then(() => { activated = true; });
        // Observe an actual blocked exclusive lock instead of relying on a sleep.
        for (let i = 0; i < 100; i++) {
          const r = await pool.query('SELECT 1 WHERE cardinality(pg_blocking_pids($1)) > 0', [activationPid]);
          if (r.rowCount) break;
          await new Promise(resolve => setTimeout(resolve, 5));
          if (i === 99) assert.fail('activation did not wait on barrier');
        }
        assert.equal(activated, false); await legacy.query('COMMIT'); await pending;
        assert.equal(activated, true);
      } finally { await legacy.query('ROLLBACK'); legacy.release(); activation.release(); }
    }));
    await t.test('Activation wins: in-flight provider read cannot enter legacy mutation section', () => isolated(async pool => {
      await migrate(pool); await requireGeneration(1, pool); // Admission before provider I/O.
      const activate = await pool.connect(); try { await activateCutover(activate, { apply: true }); } finally { activate.release(); }
      const legacy = await pool.connect(); let mutations = 0;
      try {
        await legacy.query('BEGIN');
        await assert.rejects(async () => { await requireGeneration(1, legacy, { lock: true }); mutations += 1; }, /disabled/);
        assert.equal(mutations, 0); await legacy.query('ROLLBACK');
      } finally { legacy.release(); }
    }));
  } finally { await admin.end(); }
});
