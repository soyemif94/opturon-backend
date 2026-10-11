const fs = require('fs/promises');
const path = require('path');
const { withTransaction } = require('./client');

const MIGRATION_NAME = '095_whatsapp_channel_transition.sql';

async function ensureWhatsAppChannelTransitionSchema() {
  return withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['schema_bootstrap', 'whatsapp_channel_transition_v1']
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
        to_regclass('whatsapp_channel_transitions') IS NOT NULL AS "transitionsExists",
        to_regclass('whatsapp_channel_phone_aliases') IS NOT NULL AS "aliasesExists",
        (SELECT COUNT(*)::int FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'whatsapp_channel_transitions') AS "transitionColumns",
        (SELECT COUNT(*)::int FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'whatsapp_channel_phone_aliases') AS "aliasColumns"
    `);
    const schema = verification.rows[0] || {};
    if (schema.transitionsExists !== true || schema.aliasesExists !== true
      || Number(schema.transitionColumns) < 18 || Number(schema.aliasColumns) < 7) {
      throw new Error('whatsapp_channel_transition_schema_verification_failed');
    }
    return { migration: MIGRATION_NAME, schema };
  });
}

module.exports = { MIGRATION_NAME, ensureWhatsAppChannelTransitionSchema };
