const fs = require('fs/promises');
const path = require('path');
const { withTransaction } = require('./client');

const MIGRATION_NAME = '094_whatsapp_coexistence.sql';

async function ensureWhatsAppCoexistenceSchema() {
  return withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['schema_bootstrap', 'whatsapp_coexistence_v1']
    );

    const source = await fs.readFile(
      path.resolve(process.cwd(), 'db', 'migrations', MIGRATION_NAME),
      'utf8'
    );
    await client.query(source);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id BIGSERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      'INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT (name) DO NOTHING',
      [MIGRATION_NAME]
    );

    const verification = await client.query(`
      SELECT
        to_regclass('whatsapp_coexistence_channel_state') IS NOT NULL AS "stateExists",
        to_regclass('whatsapp_coexistence_events') IS NOT NULL AS "eventsExist",
        (SELECT COUNT(*)::int FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'whatsapp_coexistence_channel_state') AS "stateColumns",
        (SELECT COUNT(*)::int FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'whatsapp_coexistence_events') AS "eventColumns"
    `);
    const schema = verification.rows[0] || {};
    if (schema.stateExists !== true || schema.eventsExist !== true ||
        Number(schema.stateColumns) < 18 || Number(schema.eventColumns) < 13) {
      throw new Error('whatsapp_coexistence_schema_verification_failed');
    }
    return { migration: MIGRATION_NAME, schema };
  });
}

module.exports = { MIGRATION_NAME, ensureWhatsAppCoexistenceSchema };
