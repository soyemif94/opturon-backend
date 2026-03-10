const { Pool } = require('pg');
const env = require('../config/env');
const { logInfo, logWarn } = require('../utils/logger');

function parseDatabaseConfig(connectionString) {
  const raw = String(connectionString || '').trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    return {
      source: 'DATABASE_URL',
      hostname: parsed.hostname || null,
      database: (parsed.pathname || '').replace(/^\//, '') || null
    };
  } catch (error) {
    return {
      source: 'DATABASE_URL',
      hostname: null,
      database: null,
      parseError: error.message
    };
  }
}

const dbConfig = parseDatabaseConfig(env.databaseUrl);

if (dbConfig && !dbConfig.parseError) {
  logInfo('db_config_loaded', dbConfig);
} else if (env.databaseUrl) {
  logWarn('db_config_parse_failed', dbConfig || { source: 'DATABASE_URL' });
}

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error(JSON.stringify({ level: 'error', message: 'db_pool_error', error: err.message, ts: new Date().toISOString() }));
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  withTransaction,
  closePool
};
