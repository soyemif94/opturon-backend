const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..', '..');
const ids = {
  tenant: '10000000-0000-4000-8000-000000000001',
  otherTenant: '10000000-0000-4000-8000-000000000002',
  actor: '10000000-0000-4000-8000-000000000003',
  channel: '10000000-0000-4000-8000-000000000004',
  contact: '10000000-0000-4000-8000-000000000005',
  conversation: '10000000-0000-4000-8000-000000000006'
};

function mockModule(relative, exportsValue) {
  const resolved = require.resolve(path.join(root, relative));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
  return resolved;
}

async function main() {
  const db = new PGlite();
  const touched = [];
  try {
    await db.exec(`
      CREATE TABLE staff_users (id UUID PRIMARY KEY);
      CREATE TABLE conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "clinicId" UUID NOT NULL,
        "channelId" UUID NOT NULL, "contactId" UUID NOT NULL,
        "assignedSellerUserId" UUID NULL, "leadStatus" TEXT DEFAULT 'NEW',
        "nextActionAt" TIMESTAMPTZ NULL, "nextActionNote" TEXT NULL,
        "waFrom" TEXT, "waTo" TEXT, status TEXT DEFAULT 'open', stage TEXT DEFAULT 'new',
        state TEXT DEFAULT 'NEW', context JSONB DEFAULT '{}'::jsonb,
        "lastInboundAt" TIMESTAMPTZ, "lastOutboundAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ DEFAULT NOW(), "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE ("clinicId", "channelId", "contactId")
      );
      CREATE UNIQUE INDEX uniq_conversations_channel_wa_from_wa_to ON conversations("channelId", "waFrom", "waTo");
      CREATE TABLE contacts (id UUID PRIMARY KEY, "clinicId" UUID NOT NULL, name TEXT, phone TEXT, "profileImageUrl" TEXT);
      CREATE TABLE conversation_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "conversationId" UUID NOT NULL REFERENCES conversations(id),
        direction TEXT, "waMessageId" TEXT UNIQUE, "from" TEXT, "to" TEXT, type TEXT, text TEXT, raw JSONB,
        "createdAt" TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "clinicId" UUID, "channelId" UUID, type TEXT,
        payload JSONB, status TEXT, attempts INT DEFAULT 0, "maxAttempts" INT DEFAULT 10,
        "runAt" TIMESTAMPTZ DEFAULT NOW(), "lockedAt" TIMESTAMPTZ, "lockedBy" TEXT,
        "lastError" TEXT, "updatedAt" TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE handoff_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "clinicId" UUID, "conversationId" UUID,
        status TEXT, "updatedAt" TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE portal_user_audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" TEXT, "clinicId" UUID,
        "actorUserId" UUID, "targetUserId" UUID, action TEXT, payload JSONB,
        "createdAt" TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await db.query('INSERT INTO staff_users(id) VALUES ($1)', [ids.actor]);
    await db.exec(fs.readFileSync(path.join(root, 'db/migrations/076_inbox_conversation_soft_delete.sql'), 'utf8'));
    await db.query(`INSERT INTO contacts VALUES ($1,$2,'Cliente QA','54911','https://avatar.test/qa.png')`, [ids.contact, ids.tenant]);
    await db.query(
      `INSERT INTO conversations (
        id,"clinicId","channelId","contactId","assignedSellerUserId","leadStatus","nextActionNote","waFrom","waTo",state,context
       ) VALUES ($1,$2,$3,$4,$5,'FOLLOW_UP','Llamar mañana','54911','54922','WAITING_PAYMENT',$6::jsonb)`,
      [ids.conversation, ids.tenant, ids.channel, ids.contact, ids.actor, JSON.stringify({
        portalAssignedTo: 'Owner QA', portalDealStage: 'proposal', portalNotes: [{ text: 'permanente' }],
        portalTasks: [{ title: 'seguimiento' }], portalBotEnabled: false,
        intent: 'comprar', pendingConfirmation: { productId: 'secret-temporary' }, summary: 'memoria vieja'
      })]
    );
    await db.query(`INSERT INTO conversation_messages("conversationId",direction,"waMessageId",text,raw) VALUES ($1,'inbound','provider-old','hola','{}')`, [ids.conversation]);
    await db.query(`INSERT INTO jobs("clinicId","channelId",type,payload,status) VALUES ($1,$2,'conversation_reply',$3::jsonb,'queued')`, [ids.tenant, ids.channel, JSON.stringify({ conversationId: ids.conversation })]);
    await db.query(`INSERT INTO handoff_requests("clinicId","conversationId",status) VALUES ($1,$2,'open')`, [ids.tenant, ids.conversation]);

    const queryClient = {
      query(text, params) {
        if (/pg_advisory_(xact_)?lock|pg_advisory_unlock/.test(text)) return Promise.resolve({ rows: [{}], rowCount: 1 });
        return db.query(text, params);
      }
    };
    const dbClient = mockModule('src/db/client.js', {
      query: queryClient.query.bind(queryClient),
      withTransaction: async (fn) => {
        await db.exec('BEGIN');
        try { const value = await fn(queryClient); await db.exec('COMMIT'); return value; }
        catch (error) { await db.exec('ROLLBACK'); throw error; }
      }
    });
    const contextService = mockModule('src/services/portal-context.service.js', {
      resolvePortalTenantContext: async (tenantId) => ({ ok: true, tenantId, clinic: { id: tenantId } })
    });
    const auditRepo = mockModule('src/repositories/portal-user-audit.repository.js', {
      createPortalUserAuditEvent: async (entry, client) => (await client.query(
        `INSERT INTO portal_user_audit_log("tenantId","clinicId","actorUserId",action,payload)
         VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *`,
        [entry.tenantId, entry.clinicId, entry.actorUserId, entry.action, JSON.stringify(entry.payload)]
      )).rows[0]
    });
    touched.push(dbClient, contextService, auditRepo);
    const servicePath = require.resolve(path.join(root, 'src/services/conversation-deletion.service.js'));
    delete require.cache[servicePath];
    touched.push(servicePath);
    const { deletePortalConversation } = require(servicePath);

    const denied = await deletePortalConversation(ids.otherTenant, ids.conversation, { id: ids.actor });
    assert.equal(denied.ok, false, 'cross-tenant delete must not reveal or mutate the row');
    assert.equal(denied.reason, 'conversation_not_found');

    await db.query(`UPDATE conversations SET "lastInboundAt" = NOW() + INTERVAL '1 minute' WHERE id=$1`, [ids.conversation]);
    const concurrentInbound = await deletePortalConversation(ids.tenant, ids.conversation, { id: ids.actor });
    assert.equal(concurrentInbound.reason, 'conversation_changed');
    assert.equal((await db.query('SELECT "deletedAt" FROM conversations WHERE id=$1', [ids.conversation])).rows[0].deletedAt, null);
    await db.query(`UPDATE conversations SET "lastInboundAt" = NOW() - INTERVAL '1 minute' WHERE id=$1`, [ids.conversation]);

    const deleted = await deletePortalConversation(ids.tenant, ids.conversation, { id: ids.actor });
    assert.equal(deleted.deleted, true);
    const old = (await db.query('SELECT * FROM conversations WHERE id=$1', [ids.conversation])).rows[0];
    assert.ok(old.deletedAt);
    assert.equal(old.state, 'DELETED');
    assert.deepEqual(old.context.portalNotes, [{ text: 'permanente' }]);
    assert.equal(old.context.portalDealStage, 'proposal');
    assert.equal(old.context.intent, undefined);
    assert.equal(old.context.portalBotEnabled, undefined);
    assert.equal((await db.query('SELECT count(*)::int n FROM contacts')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int n FROM conversation_messages')).rows[0].n, 1);
    assert.equal((await db.query('SELECT status FROM jobs')).rows[0].status, 'failed');
    assert.equal((await db.query('SELECT status FROM handoff_requests')).rows[0].status, 'resolved');
    assert.equal((await db.query('SELECT count(*)::int n FROM portal_user_audit_log')).rows[0].n, 1);

    const replay = await deletePortalConversation(ids.tenant, ids.conversation, { id: ids.actor });
    assert.equal(replay.reason, 'already_deleted');
    assert.equal((await db.query('SELECT count(*)::int n FROM portal_user_audit_log')).rows[0].n, 1);

    const repoPath = require.resolve(path.join(root, 'src/conversations/conversation.repo.js'));
    delete require.cache[repoPath];
    touched.push(repoPath);
    const repo = require(repoPath);
    const duplicate = await repo.findInboundMessageByProviderId('provider-old', queryClient);
    assert.equal(duplicate.conversationId, ids.conversation, 'old provider ID remains deduplicated');
    const fresh = await repo.upsertConversation({
      waFrom: '54911', waTo: '54922', clinicId: ids.tenant, channelId: ids.channel, contactId: ids.contact
    }, queryClient);
    assert.notEqual(fresh.id, ids.conversation);
    assert.equal(fresh.state, 'NEW');
    assert.equal(fresh.context.portalDealStage, 'proposal');
    assert.equal(fresh.context.intent, undefined);
    assert.equal(fresh.context.portalBotEnabled, undefined);
    assert.equal(fresh.assignedSellerUserId, ids.actor);
    assert.equal((await db.query('SELECT count(*)::int n FROM conversations WHERE "deletedAt" IS NULL')).rows[0].n, 1);

    console.log('inbox-conversation-delete-reset.test.js passed');
  } finally {
    for (const file of touched) delete require.cache[file];
    await db.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
