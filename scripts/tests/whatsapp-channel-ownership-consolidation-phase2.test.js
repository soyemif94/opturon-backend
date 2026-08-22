const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const {
  IDS, CONFIRMATION_PHRASE, APPLY_CTE, assertApplyGate, safetyBlockers, sha256
} = require('../../src/services/whatsapp-channel-ownership-phase2.service');
const { analyzeWhatsAppOnlySnapshot } = require('../../src/services/whatsapp-channel-ownership-whatsapp-only.service');

function gateFixture(overrides = {}) {
  return { mode: 'APPLY', execution: 'ROLLBACK_SIMULATION', sourceChannelId: IDS.sourceChannelId,
    targetClinicId: IDS.targetClinicId, phoneNumberId: IDS.phoneNumberId,
    manifestPath: 'manifest.json', manifestSha256: 'a'.repeat(64), ...overrides };
}

assert.doesNotThrow(() => assertApplyGate(gateFixture(), {
  WHATSAPP_OWNERSHIP_CONFIRMATION: CONFIRMATION_PHRASE,
  WHATSAPP_OWNERSHIP_WORKERS_PAUSED: 'CONFIRMED'
}));
for (const changed of [
  { mode: 'DRY_RUN' }, { sourceChannelId: 'wrong' }, { targetClinicId: 'wrong' }, { phoneNumberId: 'wrong' }
]) assert.throws(() => assertApplyGate(gateFixture(changed), {
  WHATSAPP_OWNERSHIP_CONFIRMATION: CONFIRMATION_PHRASE,
  WHATSAPP_OWNERSHIP_WORKERS_PAUSED: 'CONFIRMED'
}), /APPLY gate rejected/);
assert.throws(() => assertApplyGate(gateFixture(), {
  WHATSAPP_OWNERSHIP_CONFIRMATION: 'yes', WHATSAPP_OWNERSHIP_WORKERS_PAUSED: 'CONFIRMED'
}), /confirmation_phrase_mismatch/);
assert.deepStrictEqual(safetyBlockers({ executableJobs: 0, leasedJobs: 0, thirdPhoneOwners: 0 }), []);
assert.deepStrictEqual(safetyBlockers({ executableJobs: 0, leasedJobs: 0, thirdPhoneOwners: 1 }), ['thirdPhoneOwners']);
assert.strictEqual(sha256({ b: 2, a: 1 }), sha256({ a: 1, b: 2 }));

async function rollbackSimulation() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clinics(id uuid PRIMARY KEY,"externalTenantId" text,settings jsonb);
    CREATE TABLE staff_users(id uuid PRIMARY KEY,"clinicId" uuid,active boolean);
    CREATE TABLE channels(id uuid PRIMARY KEY,"clinicId" uuid NOT NULL,provider text,"phoneNumberId" text,"wabaId" text,"accessToken" text,status text,UNIQUE(id,"clinicId"));
    CREATE TABLE contacts(id uuid PRIMARY KEY,"clinicId" uuid NOT NULL,"waId" text,phone text,"whatsappPhone" text,name text,"profileImageUrl" text,"optedOut" boolean,metadata jsonb,status text,UNIQUE(id,"clinicId"));
    CREATE TABLE conversations(id uuid PRIMARY KEY,"clinicId" uuid NOT NULL,"channelId" uuid NOT NULL,"contactId" uuid NOT NULL,"assignedSellerUserId" uuid,"deletedByUserId" uuid,UNIQUE(id,"clinicId"),FOREIGN KEY("channelId","clinicId") REFERENCES channels(id,"clinicId"),FOREIGN KEY("contactId","clinicId") REFERENCES contacts(id,"clinicId"));
    CREATE TABLE conversation_messages(id uuid PRIMARY KEY,"conversationId" uuid REFERENCES conversations(id),"providerMessageId" text UNIQUE);
    CREATE TABLE messages(id uuid PRIMARY KEY,"clinicId" uuid,"channelId" uuid,"conversationId" uuid,"providerMessageId" text UNIQUE);
    CREATE TABLE conversation_events(id uuid PRIMARY KEY,"clinicId" uuid,"conversationId" uuid);
    CREATE TABLE leads(id uuid PRIMARY KEY,"clinicId" uuid,"channelId" uuid,"conversationId" uuid,"contactId" uuid,"assignedTo" uuid,status text);
    CREATE TABLE handoff_requests(id uuid PRIMARY KEY,"clinicId" uuid,"conversationId" uuid,"contactId" uuid,"leadId" uuid,"assignedTo" uuid,status text);
    CREATE TABLE agenda_items(id uuid PRIMARY KEY,"clinicId" uuid,"conversationId" uuid,"contactId" uuid,"assignedUserId" uuid);
    CREATE TABLE appointments(id uuid PRIMARY KEY,"clinicId" uuid,"channelId" uuid,"conversationId" uuid,"contactId" uuid);
    CREATE TABLE jobs(id uuid PRIMARY KEY,"clinicId" uuid,"channelId" uuid,status text,attempts int,payload jsonb);
    CREATE TABLE whatsapp_templates(id uuid PRIMARY KEY,"clinicId" uuid,"channelId" uuid,"externalTenantId" text,UNIQUE(id,"clinicId"),FOREIGN KEY("channelId","clinicId") REFERENCES channels(id,"clinicId"));
    CREATE TABLE operational_alert_rules(id uuid PRIMARY KEY,"clinicId" uuid,"channelId" uuid);
    CREATE TABLE orders(id uuid PRIMARY KEY,"clinicId" uuid,"conversationId" uuid);
    CREATE TABLE order_customer_notifications(id uuid PRIMARY KEY,"clinicId" uuid,"channelId" uuid,"conversationId" uuid,"contactId" uuid);
    CREATE TABLE whatsapp_template_canary_attempts(id uuid PRIMARY KEY,"clinicId" uuid,"channelId" uuid);
    CREATE TABLE channel_onboarding_sessions(id uuid PRIMARY KEY,"clinicId" uuid,"channelId" uuid,"externalTenantId" text,"createdByUserId" uuid);
  `);
  const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const cloneSource = u(1); const cloneTarget = u(2); const conversationA = u(3); const conversationB = u(4);
  const primary = u(5); const lead = u(6);
  await db.query('INSERT INTO clinics VALUES($1,$2,$3),($4,$5,$6)', [IDS.sourceClinicId, 'source', '{}', IDS.targetClinicId, 'target', '{}']);
  await db.query('INSERT INTO staff_users VALUES($1,$2,true)', [primary, IDS.targetClinicId]);
  await db.query(`INSERT INTO channels VALUES
    ($1,$2,'whatsapp_cloud',$3,$4,'ciphertext','active'),($5,$6,'whatsapp_cloud',NULL,NULL,NULL,'active')`,
  [IDS.sourceChannelId, IDS.sourceClinicId, IDS.phoneNumberId, IDS.wabaId, IDS.legacyChannelId, IDS.targetClinicId]);
  await db.query(`INSERT INTO contacts VALUES
    ($1,$2,'wa-collision','1','1','source collision',NULL,false,'{}','active'),
    ($3,$2,'wa-clone','2','2','source clone',NULL,false,'{}','active'),
    ($4,$5,'wa-collision','1','1','target collision',NULL,false,'{}','active')`,
  [IDS.collisionSourceId, IDS.sourceClinicId, cloneSource, IDS.collisionTargetId, IDS.targetClinicId]);
  await db.query('INSERT INTO conversations VALUES($1,$2,$3,$4,NULL,NULL),($5,$2,$3,$6,NULL,NULL)',
    [conversationA, IDS.sourceClinicId, IDS.sourceChannelId, IDS.collisionSourceId, conversationB, cloneSource]);
  await db.query("INSERT INTO conversation_messages VALUES($1,$2,'wamid.a'),($3,$4,'wamid.b')", [u(7), conversationA, u(8), conversationB]);
  await assert.rejects(
    db.query("INSERT INTO conversation_messages VALUES($1,$2,'wamid.a')", [u(70), conversationA]),
    /unique|duplicate/i
  );
  await db.query("INSERT INTO messages VALUES($1,$2,$3,$4,'provider.a')", [u(9), IDS.sourceClinicId, IDS.sourceChannelId, conversationA]);
  await db.query('INSERT INTO conversation_events VALUES($1,$2,$3)', [u(10), IDS.sourceClinicId, conversationA]);
  await db.query("INSERT INTO leads VALUES($1,$2,$3,$4,$5,$6,'open')", [lead, IDS.sourceClinicId, IDS.sourceChannelId, conversationA, IDS.collisionSourceId, u(30)]);
  await db.query("INSERT INTO handoff_requests VALUES($1,$2,$3,$4,$5,$6,'assigned')", [u(11), IDS.sourceClinicId, conversationA, IDS.collisionSourceId, lead, u(31)]);
  await db.query('INSERT INTO agenda_items VALUES($1,$2,$3,$4,$5)', [u(12), IDS.sourceClinicId, conversationA, IDS.collisionSourceId, u(32)]);
  await db.query('INSERT INTO appointments VALUES($1,$2,$3,$4,$5)', [u(13), IDS.sourceClinicId, IDS.sourceChannelId, conversationA, IDS.collisionSourceId]);
  await db.query("INSERT INTO jobs VALUES($1,$2,$3,'done',2,'{\"safe\":true}')", [u(14), IDS.sourceClinicId, IDS.sourceChannelId]);
  await db.query('INSERT INTO whatsapp_templates VALUES($1,$2,$3,$4)', [u(15), IDS.sourceClinicId, IDS.sourceChannelId, 'source']);
  await db.query('INSERT INTO operational_alert_rules VALUES($1,$2,$3)', [u(16), IDS.sourceClinicId, IDS.sourceChannelId]);
  await db.query('INSERT INTO orders VALUES($1,$2,$3)', [u(17), IDS.sourceClinicId, conversationA]);
  await db.query('INSERT INTO order_customer_notifications VALUES($1,$2,$3,$4,$5)', [u(18), IDS.sourceClinicId, IDS.sourceChannelId, conversationA, IDS.collisionSourceId]);

  await db.exec('BEGIN');
  await db.exec('CREATE TEMP TABLE phase2_contact_map ("sourceId" uuid PRIMARY KEY,"targetId" uuid UNIQUE NOT NULL,kind text NOT NULL) ON COMMIT DROP');
  await db.query("INSERT INTO phase2_contact_map VALUES($1,$2,'EXISTING_TARGET_COLLISION'),($3,$4,'MINIMAL_CLONE')",
    [IDS.collisionSourceId, IDS.collisionTargetId, cloneSource, cloneTarget]);
  await db.query(`INSERT INTO contacts(id,"clinicId","waId",phone,"whatsappPhone",name,"profileImageUrl","optedOut",metadata,status)
    SELECT m."targetId",$1,c."waId",c.phone,c."whatsappPhone",c.name,c."profileImageUrl",c."optedOut",'{}','active'
    FROM phase2_contact_map m JOIN contacts c ON c.id=m."sourceId" WHERE m.kind='MINIMAL_CLONE'`, [IDS.targetClinicId]);
  const moved = (await db.query(APPLY_CTE, [IDS.sourceChannelId, IDS.sourceClinicId, IDS.targetClinicId,
    IDS.legacyChannelId, IDS.phoneNumberId, 'target', primary])).rows[0];
  assert.strictEqual(moved.conversations, 2);
  assert.strictEqual(moved.detachedOrders, 1);
  assert.strictEqual(moved.detachedNotifications, 1);
  assert.strictEqual(moved.jobs, 1);
  assert.strictEqual((await db.query('SELECT count(*)::int n FROM conversations WHERE "clinicId"=$1', [IDS.targetClinicId])).rows[0].n, 2);
  assert.strictEqual((await db.query('SELECT "clinicId" FROM orders')).rows[0].clinicId, IDS.sourceClinicId);
  assert.strictEqual((await db.query('SELECT "conversationId" FROM orders')).rows[0].conversationId, null);
  assert.strictEqual((await db.query('SELECT status,attempts,payload FROM jobs')).rows[0].status, 'done');
  assert.strictEqual((await db.query('SELECT status FROM channels WHERE id=$1', [IDS.legacyChannelId])).rows[0].status, 'inactive');
  assert.strictEqual((await db.query('SELECT "accessToken" FROM channels WHERE id=$1', [IDS.sourceChannelId])).rows[0].accessToken, 'ciphertext');
  assert.strictEqual((await db.query('SELECT count(*)::int n FROM conversation_messages')).rows[0].n, 2);
  await db.exec('ROLLBACK');
  assert.strictEqual((await db.query('SELECT "clinicId" FROM channels WHERE id=$1', [IDS.sourceChannelId])).rows[0].clinicId, IDS.sourceClinicId);
  assert.strictEqual((await db.query('SELECT count(*)::int n FROM contacts WHERE id=$1', [cloneTarget])).rows[0].n, 0);
  await db.close();
}

(async () => {
  await rollbackSimulation();
  const apply = fs.readFileSync(path.resolve(__dirname, '../ops/whatsapp-channel-ownership-consolidation-phase2-apply.js'), 'utf8');
  const dryRun = fs.readFileSync(path.resolve(__dirname, '../ops/whatsapp-channel-ownership-consolidation-phase1b-dry-run.js'), 'utf8');
  assert.match(apply, /assertApplyGate/);
  assert.match(apply, /manifest_checksum_mismatch/);
  assert.match(apply, /manifest_stale_over_15_minutes/);
  assert.match(dryRun, /Only --mode=DRY_RUN is supported/);
  assert.doesNotMatch(APPLY_CTE, /\bDELETE\b|DISABLE\s+TRIGGER|DROP\s+CONSTRAINT|ALTER\s+TABLE/i);
  assert.match(APPLY_CTE, /moved_channels/);
  assert.match(APPLY_CTE, /status=CASE WHEN id=\$1::uuid THEN 'active' ELSE 'inactive'/);
  assert(!analyzeWhatsAppOnlySnapshot.toString().includes('accessToken'));
  console.log('whatsapp channel ownership consolidation Phase2 tests: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
