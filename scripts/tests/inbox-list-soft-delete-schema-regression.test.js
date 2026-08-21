const assert = require('assert');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..', '..');
const TENANT_A = '20000000-0000-4000-8000-000000000001';
const TENANT_B = '20000000-0000-4000-8000-000000000002';
const CHANNEL_WA = '20000000-0000-4000-8000-000000000003';
const CHANNEL_IG = '20000000-0000-4000-8000-000000000004';

async function main() {
  const db = new PGlite();
  const touched = [];
  try {
    await db.exec(`
      CREATE TABLE staff_users (id UUID PRIMARY KEY);
      CREATE TABLE conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "clinicId" UUID NOT NULL,
        "channelId" UUID NOT NULL, "contactId" UUID NOT NULL,
        "waFrom" TEXT, "waTo" TEXT, status TEXT DEFAULT 'open', stage TEXT DEFAULT 'new',
        state TEXT DEFAULT 'NEW', context JSONB DEFAULT '{}'::jsonb,
        "lastInboundAt" TIMESTAMPTZ, "lastOutboundAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ DEFAULT NOW(), "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE ("clinicId", "channelId", "contactId")
      );
      CREATE UNIQUE INDEX uniq_conversations_channel_wa_from_wa_to
        ON conversations("channelId", "waFrom", "waTo");
    `);

    let reproduced = null;
    try {
      await db.query(`SELECT c.id FROM conversations c WHERE c."clinicId"=$1 AND c."deletedAt" IS NULL`, [TENANT_A]);
    } catch (error) {
      reproduced = error;
    }
    assert.ok(reproduced, 'pre-fix production schema must reproduce the listing failure');
    assert.match(reproduced.message, /deletedAt.*does not exist/i);

    const client = {
      query(sql, params) {
        if (/pg_advisory_xact_lock/.test(sql)) return Promise.resolve({ rows: [{}], rowCount: 1 });
        return db.query(sql, params);
      }
    };
    const dbClientPath = require.resolve(path.join(root, 'src/db/client.js'));
    require.cache[dbClientPath] = {
      id: dbClientPath, filename: dbClientPath, loaded: true,
      exports: {
        withTransaction: async (fn) => {
          await db.exec('BEGIN');
          try { const value = await fn(client); await db.exec('COMMIT'); return value; }
          catch (error) { await db.exec('ROLLBACK'); throw error; }
        }
      }
    };
    touched.push(dbClientPath);
    const ensurePath = require.resolve(path.join(root, 'src/db/ensure-inbox-conversation-soft-delete.js'));
    delete require.cache[ensurePath];
    touched.push(ensurePath);
    const { MIGRATION_NAME, ensureInboxConversationSoftDeleteSchema } = require(ensurePath);
    await ensureInboxConversationSoftDeleteSchema();
    await ensureInboxConversationSoftDeleteSchema();

    const columns = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name='conversations' AND column_name IN ('deletedAt','deletedByUserId','deleteReason')
      ORDER BY column_name
    `);
    assert.deepEqual(columns.rows.map((row) => [row.column_name, row.data_type, row.is_nullable]), [
      ['deleteReason', 'text', 'YES'],
      ['deletedAt', 'timestamp with time zone', 'YES'],
      ['deletedByUserId', 'uuid', 'YES']
    ]);
    const indexes = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='conversations' ORDER BY indexname`);
    const names = indexes.rows.map((row) => row.indexname);
    assert.ok(names.includes('uniq_conversations_active_owner'));
    assert.ok(names.includes('uniq_conversations_active_channel_pair'));
    assert.ok(names.includes('idx_conversations_deleted_at'));
    assert.ok(!names.includes('uniq_conversations_channel_wa_from_wa_to'));
    assert.equal((await db.query('SELECT count(*)::int n FROM schema_migrations WHERE name=$1', [MIGRATION_NAME])).rows[0].n, 1);

    const rows = [
      [TENANT_A, CHANNEL_WA, '20000000-0000-4000-8000-000000000011', 'wa-active', '5491', '5490', '{}', null],
      [TENANT_A, CHANNEL_WA, '20000000-0000-4000-8000-000000000012', 'wa-archived', '5492', '5490', JSON.stringify({ portalHiddenAt: '2026-01-01T00:00:00.000Z' }), null],
      [TENANT_A, CHANNEL_IG, '20000000-0000-4000-8000-000000000013', 'ig-active', 'ig1', 'ig0', '{}', null],
      [TENANT_A, CHANNEL_IG, '20000000-0000-4000-8000-000000000014', 'ig-deleted', 'ig2', 'ig0', '{}', '2026-01-02T00:00:00.000Z'],
      [TENANT_B, CHANNEL_WA, '20000000-0000-4000-8000-000000000015', 'other-tenant', '5493', '5490', '{}', null]
    ];
    for (const [clinicId, channelId, contactId, label, waFrom, waTo, context, deletedAt] of rows) {
      await db.query(
        `INSERT INTO conversations("clinicId","channelId","contactId","waFrom","waTo",context,"deletedAt","deleteReason")
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [clinicId, channelId, contactId, waFrom, waTo, context, deletedAt, label]
      );
    }

    async function list({ tenantId, channelId = null, archived = false, search = '' }) {
      return (await db.query(
        `SELECT c."deleteReason" AS label
         FROM conversations c
         WHERE c."clinicId"=$1::uuid
           AND c."deletedAt" IS NULL
           AND ($2::uuid IS NULL OR c."channelId"=$2::uuid)
           AND (($3::boolean AND NULLIF(c.context->>'portalHiddenAt','') IS NOT NULL)
             OR (NOT $3::boolean AND NULLIF(c.context->>'portalHiddenAt','') IS NULL))
           AND ($4='' OR c."deleteReason" ILIKE '%' || $4 || '%')
         ORDER BY label`,
        [tenantId, channelId, archived, search]
      )).rows.map((row) => row.label);
    }

    assert.deepEqual(await list({ tenantId: TENANT_A, channelId: CHANNEL_WA }), ['wa-active']);
    assert.deepEqual(await list({ tenantId: TENANT_A, channelId: CHANNEL_WA, archived: true }), ['wa-archived']);
    assert.deepEqual(await list({ tenantId: TENANT_A, channelId: CHANNEL_IG }), ['ig-active']);
    assert.deepEqual(await list({ tenantId: TENANT_A }), ['ig-active', 'wa-active']);
    assert.deepEqual(await list({ tenantId: TENANT_A, search: 'wa-' }), ['wa-active']);
    assert.deepEqual(await list({ tenantId: TENANT_B }), ['other-tenant']);
    assert.deepEqual(await list({ tenantId: '20000000-0000-4000-8000-000000000099' }), []);

    console.log('inbox-list-soft-delete-schema-regression.test.js passed');
  } finally {
    for (const file of touched) delete require.cache[file];
    await db.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
