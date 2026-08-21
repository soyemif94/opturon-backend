const { withTransaction } = require('./client');

const MIGRATION_NAME = '076_inbox_conversation_soft_delete.sql';

async function ensureInboxConversationSoftDeleteSchema() {
  return withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      ['schema_bootstrap', 'inbox_conversation_soft_delete_v1']
    );

    await client.query(`
      ALTER TABLE conversations
        ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "deletedByUserId" UUID NULL REFERENCES staff_users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS "deleteReason" TEXT NULL
    `);
    await client.query(`ALTER TABLE conversations DROP CONSTRAINT IF EXISTS "conversations_clinicId_channelId_contactId_key"`);
    await client.query(`DROP INDEX IF EXISTS uniq_conversations_channel_wa_from_wa_to`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_active_owner
      ON conversations("clinicId", "channelId", "contactId") WHERE "deletedAt" IS NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversations_active_channel_pair
      ON conversations("channelId", "waFrom", "waTo") WHERE "deletedAt" IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_deleted_at
      ON conversations("clinicId", "deletedAt")`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id BIGSERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT (name) DO NOTHING`,
      [MIGRATION_NAME]
    );

    const verification = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE column_name = 'deletedAt')::int AS "deletedAt",
        COUNT(*) FILTER (WHERE column_name = 'deletedByUserId')::int AS "deletedByUserId",
        COUNT(*) FILTER (WHERE column_name = 'deleteReason')::int AS "deleteReason"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'conversations'
        AND column_name IN ('deletedAt', 'deletedByUserId', 'deleteReason')
    `);
    const columns = verification.rows[0] || {};
    if (Number(columns.deletedAt) !== 1 || Number(columns.deletedByUserId) !== 1 || Number(columns.deleteReason) !== 1) {
      throw new Error('inbox_conversation_soft_delete_schema_verification_failed');
    }

    return { migration: MIGRATION_NAME, columns };
  });
}

module.exports = { MIGRATION_NAME, ensureInboxConversationSoftDeleteSchema };
