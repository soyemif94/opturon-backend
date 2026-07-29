const { Client } = require('pg');
const env = require('../../src/config/env');

const READ_ONLY_FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i;

function buildScriptPgConfig() {
  const rawConnectionString = String(env.databaseUrl || process.env.DATABASE_URL || '').trim();
  if (!rawConnectionString) return {};

  let ssl = undefined;
  let connectionString = rawConnectionString;
  try {
    const parsed = new URL(rawConnectionString);
    const sslMode = String(parsed.searchParams.get('sslmode') || process.env.PGSSLMODE || '').trim().toLowerCase();
    if (sslMode && sslMode !== 'disable') {
      ssl = { rejectUnauthorized: false };
      parsed.searchParams.delete('sslmode');
      connectionString = parsed.toString();
    }
  } catch {
    ssl = undefined;
  }

  return ssl ? { connectionString, ssl } : { connectionString };
}

function createScriptPgClient() {
  return new Client(buildScriptPgConfig());
}

function assertReadOnlySql(sql) {
  const text = String(sql || '').trim();
  if (!text) throw new Error('read_only_query_empty');
  if (READ_ONLY_FORBIDDEN_SQL.test(text)) {
    throw new Error('read_only_query_contains_write');
  }
}

async function readOnlyQuery(client, sql, params = []) {
  assertReadOnlySql(sql);
  return client.query(sql, params);
}

async function beginReadOnlyTransaction(client) {
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ ONLY');
}

module.exports = {
  READ_ONLY_FORBIDDEN_SQL,
  assertReadOnlySql,
  beginReadOnlyTransaction,
  buildScriptPgConfig,
  createScriptPgClient,
  readOnlyQuery
};
