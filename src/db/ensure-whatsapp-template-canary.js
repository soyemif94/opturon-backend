const fs = require('fs/promises');
const path = require('path');
const { withTransaction } = require('./client');

const MIGRATION_NAME = '077_whatsapp_template_canary_attempts.sql';

async function ensureWhatsAppTemplateCanarySchema() {
  return withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['schema_bootstrap', 'whatsapp_template_canary_v1']
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
        to_regclass('whatsapp_template_canary_attempts') IS NOT NULL AS "tableExists",
        (SELECT COUNT(*)::int FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'whatsapp_template_canary_attempts') AS columns,
        (SELECT COUNT(*)::int FROM pg_constraint
          WHERE conrelid = to_regclass('whatsapp_template_canary_attempts')) AS constraints,
        (SELECT COUNT(*)::int FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'whatsapp_template_canary_attempts') AS indexes
    `);
    const schema = verification.rows[0] || {};
    if (schema.tableExists !== true || Number(schema.columns) !== 24 || Number(schema.constraints) < 10 || Number(schema.indexes) < 3) {
      throw new Error('whatsapp_template_canary_schema_verification_failed');
    }
    return { migration: MIGRATION_NAME, schema };
  });
}

module.exports = { MIGRATION_NAME, ensureWhatsAppTemplateCanarySchema };
