const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const runnerSource = fs.readFileSync(path.join(root, 'src/db/migrate.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(root, 'src/db/client.js'), 'utf8');
const target = '079_whatsapp_phone_registrations.sql';
const historical = [
  '061_whatsapp_chat_imports_phase1.sql',
  '073_order_customer_notification_delivery_states.sql',
  '074_operational_alerts_foundation.sql',
  '075_whatsapp_templates_channel_waba_identity.sql'
];
const earlierApplied = '078_previous.sql';

async function runRunner({ args = [], applied = [earlierApplied], failMigration, failTracking = false, realTarget, targetIsFile = true } = {}) {
  const calls = [];
  const logs = [];
  const reads = [];
  const exits = [];
  const database = { applied: [...applied], effects: [] };
  let transaction;
  let connected = 0;
  let released = 0;
  let closed = 0;
  const files = [target, ...historical.slice().reverse(), earlierApplied];
  const sqlByFile = new Map(files.map((file) => [file, `-- migration ${file}`]));
  const migrationsDir = path.join(root, 'db', 'migrations');
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'BEGIN') transaction = { applied: [...database.applied], effects: [...database.effects] };
      else if (sql === 'COMMIT') Object.assign(database, transaction);
      else if (sql === 'ROLLBACK') transaction = null;
      else if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return { rows: [] };
      else if (sql === 'SELECT name FROM schema_migrations') return { rows: transaction.applied.map((name) => ({ name })) };
      else if (sql === 'INSERT INTO schema_migrations(name) VALUES($1)') {
        if (failTracking) throw new Error('simulated tracking failure');
        transaction.applied.push(params[0]);
      } else if ([...sqlByFile.values()].includes(sql)) {
        transaction.effects.push(sql);
        if (sql === sqlByFile.get(failMigration)) throw new Error('simulated migration failure');
      } else throw new Error('Unexpected query in isolated runner test');
      return { rows: [] };
    },
    release() { released += 1; }
  };
  class Pool {
    on() {}
    async connect() { connected += 1; return client; }
    async end() { closed += 1; }
  }
  const clientModule = { exports: {} };
  vm.runInNewContext(clientSource, {
    module: clientModule,
    URL,
    console: { error() { throw new Error('Unexpected pool error'); } },
    require(name) {
      if (name === 'pg') return { Pool };
      if (name === '../config/env') return { databaseUrl: '' };
      if (name === '../utils/logger') return { logInfo() {}, logWarn() {} };
      throw new Error(`Unexpected client dependency: ${name}`);
    }
  }, { filename: 'src/db/client.js' });
  const mockedFs = {
    async readdir(dir, options) {
      assert.equal(dir, migrationsDir);
      assert.equal(options.withFileTypes, true);
      return [...files.map((name) => ({ name, isFile: () => name !== target || targetIsFile })),
        { name: 'README.md', isFile: () => true },
        { name: 'directory.sql', isFile: () => false }];
    },
    async realpath(value) {
      if (value === migrationsDir) return value;
      assert.equal(value, path.join(migrationsDir, target));
      return realTarget || value;
    },
    async readFile(value, encoding) {
      assert.equal(path.dirname(value), migrationsDir);
      assert.equal(encoding, 'utf-8');
      const file = path.basename(value);
      reads.push(file);
      assert.ok(sqlByFile.has(file));
      return sqlByFile.get(file);
    }
  };
  await vm.runInNewContext(runnerSource, {
    require(name) {
      if (name === 'fs/promises') return mockedFs;
      if (name === 'path') return path;
      if (name === './client') return clientModule.exports;
      throw new Error(`Unexpected runner dependency: ${name}`);
    },
    process: { argv: ['node', 'src/db/migrate.js', ...args], cwd: () => root, exit: (code) => exits.push(code) },
    console: { log: (line) => logs.push(JSON.parse(line)), error: (line) => logs.push(JSON.parse(line)) }
  }, { filename: 'src/db/migrate.js' });
  return { calls, logs, reads, exits, database, connected, released, closed };
}

function tracked(result) {
  return result.calls.filter((call) => call.sql.startsWith('INSERT INTO schema_migrations')).map((call) => call.params[0]);
}

test('--only applies exactly the requested migration and leaves historical pending migrations untouched', async () => {
  const result = await runRunner({ args: ['--only', target] });
  assert.deepEqual(result.exits, [0]);
  assert.deepEqual(result.reads, [target]);
  assert.deepEqual(tracked(result), [target]);
  assert.deepEqual(result.database.applied, [earlierApplied, target]);
  assert.ok(historical.every((file) => !result.database.applied.includes(file)));
  assert.deepEqual(result.database.effects, [`-- migration ${target}`]);
  assert.ok(result.logs.some((log) => log.message === 'migration_target_selected' && log.file === target));
  assert.equal(result.calls[0].sql, 'BEGIN');
  assert.equal(result.calls.at(-1).sql, 'COMMIT');
  assert.equal(result.released, 1);
  assert.equal(result.closed, 1);
});

test('an already applied target is a safe no-op even while other migrations remain pending', async () => {
  const result = await runRunner({ args: ['--only', target], applied: [target] });
  assert.deepEqual(result.exits, [0]);
  assert.deepEqual(result.reads, []);
  assert.deepEqual(tracked(result), []);
  assert.deepEqual(result.database.applied, [target]);
  assert.deepEqual(result.database.effects, []);
  assert.ok(result.logs.some((log) => log.message === 'migration_already_applied' && log.file === target));
});

const invalidInputs = [
  ['nonexistent filename', ['--only', '999_missing.sql']],
  ['wrong filename case', ['--only', target.toUpperCase()]],
  ['parent path traversal', ['--only', `../${target}`]],
  ['Windows path traversal', ['--only', `..\\${target}`]],
  ['nested path', ['--only', `nested/${target}`]],
  ['absolute POSIX path', ['--only', `/${target}`]],
  ['absolute Windows path', ['--only', `C:\\migrations\\${target}`]],
  ['glob pattern', ['--only', '079_*.sql']],
  ['question mark pattern', ['--only', '079_?.sql']],
  ['bracket pattern', ['--only', '079_[ab].sql']],
  ['multiple filenames', ['--only', target, historical[0]]],
  ['multiple --only flags', ['--only', target, '--only', historical[0]]],
  ['empty filename', ['--only', '']],
  ['whitespace filename', ['--only', ' ']],
  ['missing filename', ['--only']],
  ['ambiguous equals form', [`--only=${target}`]],
  ['unexpected option', ['--unknown', target]],
  ['unexpected positional filename', [target]],
  ['directory with SQL suffix', ['--only', 'directory.sql']]
];
for (const [description, args] of invalidInputs) {
  test(`rejects ${description} before acquiring a DB connection or issuing any query`, async () => {
    const result = await runRunner({ args });
    assert.deepEqual(result.exits, [1]);
    assert.equal(result.connected, 0);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.reads, []);
    assert.equal(result.closed, 1);
    assert.ok(result.logs.some((log) => log.message === 'migrations_failed'));
  });
}

test('rejects a symlink entry instead of accepting it as a local migration', async () => {
  const result = await runRunner({ args: ['--only', target], targetIsFile: false });
  assert.deepEqual(result.exits, [1]);
  assert.equal(result.connected, 0);
  assert.deepEqual(result.calls, []);
});

test('rejects a resolved target outside the migration directory before any DB query', async () => {
  const result = await runRunner({ args: ['--only', target], realTarget: path.join(root, 'outside', target) });
  assert.deepEqual(result.exits, [1]);
  assert.equal(result.connected, 0);
  assert.deepEqual(result.calls, []);
});

test('default invocation preserves sorted execution of all pending SQL files in one transaction', async () => {
  const result = await runRunner();
  const expected = [...historical, target].sort();
  assert.deepEqual(result.exits, [0]);
  assert.deepEqual(result.reads, expected);
  assert.deepEqual(tracked(result), expected);
  assert.deepEqual(result.database.applied, [earlierApplied, ...expected]);
  assert.equal(result.calls.filter((call) => call.sql === 'BEGIN').length, 1);
  assert.equal(result.calls.filter((call) => call.sql === 'COMMIT').length, 1);
  assert.ok(!result.logs.some((log) => log.message === 'migration_target_selected'));
});

test('migration failure rolls back all effects and never inserts tracking', async () => {
  const result = await runRunner({ args: ['--only', target], failMigration: target });
  assert.deepEqual(result.exits, [1]);
  assert.equal(result.calls.at(-1).sql, 'ROLLBACK');
  assert.ok(!result.calls.some((call) => call.sql === 'COMMIT'));
  assert.deepEqual(tracked(result), []);
  assert.deepEqual(result.database, { applied: [earlierApplied], effects: [] });
  assert.equal(result.released, 1);
  assert.equal(result.closed, 1);
});

test('tracking is inserted only after successful SQL execution and before transaction commit', async () => {
  const result = await runRunner({ args: ['--only', target] });
  const execution = result.calls.findIndex((call) => call.sql === `-- migration ${target}`);
  const tracking = result.calls.findIndex((call) => call.sql.startsWith('INSERT INTO schema_migrations'));
  const commit = result.calls.findIndex((call) => call.sql === 'COMMIT');
  assert.ok(execution >= 0 && tracking > execution && commit > tracking);
  assert.deepEqual(tracked(result), [target]);
});

test('tracking failure rolls back the migration itself', async () => {
  const result = await runRunner({ args: ['--only', target], failTracking: true });
  assert.deepEqual(result.exits, [1]);
  assert.equal(result.calls.at(-1).sql, 'ROLLBACK');
  assert.deepEqual(result.database, { applied: [earlierApplied], effects: [] });
});

test('default invocation retains whole-batch rollback when a later migration fails', async () => {
  const result = await runRunner({ failMigration: target });
  assert.deepEqual(result.exits, [1]);
  assert.deepEqual(tracked(result), historical);
  assert.equal(result.calls.at(-1).sql, 'ROLLBACK');
  assert.deepEqual(result.database, { applied: [earlierApplied], effects: [] });
});
