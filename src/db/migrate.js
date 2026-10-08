const fs = require('fs/promises');
const path = require('path');
const { withTransaction, closePool } = require('./client');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(client) {
  const result = await client.query('SELECT name FROM schema_migrations');
  return new Set(result.rows.map((r) => r.name));
}

async function listMigrationFiles() {
  const migrationsDir = path.resolve(process.cwd(), 'db', 'migrations');
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
}

function validateMigrationFilename(file, option) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/.test(file)
    || file.includes('..') || path.basename(file) !== file || path.win32.basename(file) !== file) {
    throw new Error(`${option} requires one exact migration filename without paths or patterns`);
  }
}

function parseMigrationMode(args) {
  if (args.length === 0) {
    return { only: null, after: null };
  }

  if (args.length !== 2 || !['--only', '--after'].includes(args[0])) {
    throw new Error('Usage: node src/db/migrate.js [--only|--after <exact-filename.sql>]');
  }

  const file = args[1];
  validateMigrationFilename(file, args[0]);
  return { only: args[0] === '--only' ? file : null, after: args[0] === '--after' ? file : null };
}

async function runMigrations() {
  const { only, after } = parseMigrationMode(process.argv.slice(2));
  let files = await listMigrationFiles();
  let executed = 0;
  if (only !== null) {
    if (!files.includes(only)) {
      throw new Error(`Migration file not found: ${only}`);
    }

    const migrationsDir = await fs.realpath(path.resolve(process.cwd(), 'db', 'migrations'));
    const fullPath = await fs.realpath(path.join(migrationsDir, only));
    if (path.dirname(fullPath) !== migrationsDir || path.basename(fullPath) !== only) {
      throw new Error('--only migration must be a file inside the migrations directory');
    }

    files = [only];
    console.log(JSON.stringify({ level: 'info', message: 'migration_target_selected', file: only, ts: new Date().toISOString() }));
  } else if (after !== null) {
    const baselineIndex = files.indexOf(after);
    if (baselineIndex === -1) {
      throw new Error(`Migration file not found: ${after}`);
    }

    files = files.slice(baselineIndex + 1);
    console.log(JSON.stringify({
      level: 'info',
      message: 'migration_forward_window_selected',
      baseline: after,
      eligible: files.length,
      ts: new Date().toISOString()
    }));
  }

  await withTransaction(async (client) => {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    for (const file of files) {
      if (applied.has(file)) {
        if (only !== null || after !== null) {
          console.log(JSON.stringify({ level: 'info', message: 'migration_already_applied', file, ts: new Date().toISOString() }));
        }
        continue;
      }

      const fullPath = path.resolve(process.cwd(), 'db', 'migrations', file);
      const sql = await fs.readFile(fullPath, 'utf-8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
      executed += 1;
      console.log(JSON.stringify({ level: 'info', message: 'migration_applied', file, ts: new Date().toISOString() }));
    }
  });
  return executed;
}

runMigrations()
  .then(async (executed) => {
    console.log(JSON.stringify({ level: 'info', message: 'migrations_complete', executed, ts: new Date().toISOString() }));
    await closePool();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(JSON.stringify({ level: 'error', message: 'migrations_failed', error: error.message, ts: new Date().toISOString() }));
    await closePool();
    process.exit(1);
  });
