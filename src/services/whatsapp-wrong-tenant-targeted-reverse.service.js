'use strict';

const crypto = require('node:crypto');

const IDS = Object.freeze({
  canonicalChannelId: '7f86db7a-0b3f-4aeb-9546-d0f2f921456a',
  sourceClinicId: '8e117b14-7c5c-44fb-a4a4-ac86eb6c5074',
  sourceTenantId: 'tenant_1772601586508_w1e4fs',
  targetClinicId: 'a335961a-75c3-443b-a35f-5cc8dd243b1d',
  targetTenantId: 'tenant_cliente_demo_02_20260312',
  legacyChannelId: 'b3ef8ab5-4610-4571-a91b-e34d10b98dfa',
  collisionSourceId: '751ae358-3663-4e6d-a0d3-31e16cd03f08',
  collisionTargetId: '18418399-c961-4800-8749-819b00560438',
  wabaId: '27184268844495361',
  phoneNumberId: '1070249406167861',
  legacyWabaId: '874990162205399',
  legacyPhoneNumberId: '1063597556834198'
});

const CONFIRMATION = 'REVERSE_WRONG_TENANT_WHATSAPP_OWNERSHIP';
const TERMINAL_JOBS = Object.freeze(['done', 'failed', 'completed', 'cancelled', 'canceled', 'dead']);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(stable(value)))
    .digest('hex');
}

async function one(client, text, params = []) {
  return (await client.query(text, params)).rows[0] || null;
}

async function databaseIdentity(client) {
  return one(client, `SELECT current_database() database,current_setting('server_version') version,
    encode(digest(current_database() || ':' || inet_server_addr()::text || ':' || inet_server_port()::text,'sha256'),'hex') identifier`);
}

async function collectCurrentState(client, forwardManifest, activityCutoff) {
  const contactMapping = forwardManifest.contactMapping || [];
  const cloneIds = contactMapping.filter((row) => row.kind === 'MINIMAL_CLONE').map((row) => row.targetId);
  const mappedTargetIds = contactMapping.map((row) => row.targetId);
  const channels = (await client.query(`SELECT id,"clinicId","wabaId","phoneNumberId",status,"createdAt","updatedAt",
    encode(digest(COALESCE("accessToken",''),'sha256'),'hex') "credentialFingerprint"
    FROM channels WHERE id=ANY($1::uuid[]) ORDER BY id`, [[IDS.canonicalChannelId, IDS.legacyChannelId]])).rows;
  const counts = await one(client, `WITH cc AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid)
    SELECT
      (SELECT count(*)::int FROM cc) conversations,
      (SELECT count(*)::int FROM conversation_messages WHERE "conversationId" IN (SELECT id FROM cc)) "conversationMessages",
      (SELECT count(*)::int FROM messages WHERE "channelId"=$1::uuid) messages,
      (SELECT count(*)::int FROM conversation_events WHERE "conversationId" IN (SELECT id FROM cc)) events,
      (SELECT count(*)::int FROM handoff_requests WHERE "conversationId" IN (SELECT id FROM cc)) handoffs,
      (SELECT count(*)::int FROM agenda_items WHERE "conversationId" IN (SELECT id FROM cc)) agenda,
      (SELECT count(*)::int FROM leads WHERE "channelId"=$1::uuid) leads,
      (SELECT count(*)::int FROM appointments WHERE "channelId"=$1::uuid) appointments,
      (SELECT count(*)::int FROM jobs WHERE "channelId"=$1::uuid) jobs,
      (SELECT count(*)::int FROM jobs WHERE "channelId"=$1::uuid AND status='done') "jobsDone",
      (SELECT count(*)::int FROM jobs WHERE "channelId"=$1::uuid AND status='failed') "jobsFailed",
      (SELECT count(*)::int FROM jobs WHERE "channelId"=$1::uuid AND lower(status)<>ALL($2::text[])) "executableJobs",
      (SELECT count(*)::int FROM jobs WHERE "channelId"=$1::uuid AND "lockedAt" IS NOT NULL) "leasedJobs",
      (SELECT count(*)::int FROM whatsapp_templates WHERE "channelId"=$1::uuid) templates,
      (SELECT count(*)::int FROM whatsapp_template_canary_attempts WHERE "channelId"=$1::uuid) canary,
      (SELECT count(*)::int FROM channel_onboarding_sessions WHERE "channelId"=$1::uuid) onboarding,
      (SELECT count(*)::int FROM contacts WHERE id=ANY($3::uuid[])) clones,
      (SELECT count(*)::int FROM conversations WHERE "channelId"=$4::uuid) "legacyConversations",
      (SELECT count(*)::int FROM conversation_messages WHERE "conversationId" IN
        (SELECT id FROM conversations WHERE "channelId"=$4::uuid)) "legacyConversationMessages",
      (SELECT count(*)::int FROM jobs WHERE "channelId"=$4::uuid) "legacyJobs",
      (SELECT count(*)::int FROM channels WHERE "phoneNumberId"=$5 AND id<>$1::uuid) "thirdPhoneOwners"`,
  [IDS.canonicalChannelId, TERMINAL_JOBS, cloneIds, IDS.legacyChannelId, IDS.phoneNumberId]);

  const drift = await one(client, `WITH cc AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid)
    SELECT
      (SELECT count(*)::int FROM conversations WHERE "channelId"=$1::uuid AND "createdAt">$2::timestamptz) "newConversations",
      (SELECT count(*)::int FROM conversation_messages WHERE "conversationId" IN (SELECT id FROM cc)
        AND "createdAt">$2::timestamptz AND direction='inbound') "newInbound",
      (SELECT count(*)::int FROM conversation_messages WHERE "conversationId" IN (SELECT id FROM cc)
        AND "createdAt">$2::timestamptz AND direction='outbound') "newOutbound",
      (SELECT count(*)::int FROM conversation_messages WHERE "conversationId" IN (SELECT id FROM cc) AND "createdAt">$2::timestamptz) "newConversationMessages",
      (SELECT count(*)::int FROM messages WHERE "channelId"=$1::uuid AND "createdAt">$2::timestamptz) "newMessages",
      (SELECT count(*)::int FROM conversation_events WHERE "conversationId" IN (SELECT id FROM cc) AND "createdAt">$2::timestamptz) "newEvents",
      (SELECT count(*)::int FROM leads WHERE "channelId"=$1::uuid AND "createdAt">$2::timestamptz) "newLeads",
      (SELECT count(*)::int FROM appointments WHERE "channelId"=$1::uuid AND "createdAt">$2::timestamptz) "newAppointments",
      (SELECT count(*)::int FROM jobs WHERE "channelId"=$1::uuid AND "createdAt">$2::timestamptz AND lower(status)<>ALL($3::text[])) "newExecutableJobs",
      (SELECT count(*)::int FROM whatsapp_template_canary_attempts WHERE "channelId"=$1::uuid AND "createdAt">$2::timestamptz) "canaryAttempts",
      (SELECT count(*)::int FROM conversations WHERE "channelId"=$1::uuid AND "updatedAt">$2::timestamptz) "conversationUserEdits"`,
  [IDS.canonicalChannelId, activityCutoff, TERMINAL_JOBS]);

  const clones = (await client.query(`SELECT c.id,c."clinicId",c."createdAt",c."updatedAt",
    (SELECT count(*)::int FROM conversations WHERE "contactId"=c.id) conversations,
    (SELECT count(*)::int FROM leads WHERE "contactId"=c.id) leads,
    (SELECT count(*)::int FROM appointments WHERE "contactId"=c.id) appointments,
    (SELECT count(*)::int FROM agenda_items WHERE "contactId"=c.id) agenda,
    (SELECT count(*)::int FROM handoff_requests WHERE "contactId"=c.id) handoffs,
    (SELECT count(*)::int FROM orders WHERE "contactId"=c.id) orders,
    (SELECT count(*)::int FROM invoices WHERE "contactId"=c.id) invoices,
    (SELECT count(*)::int FROM payments WHERE "contactId"=c.id) payments
    FROM contacts c WHERE c.id=ANY($1::uuid[]) ORDER BY c.id`, [mappedTargetIds])).rows;

  const template = await one(client, `SELECT id,"clinicId","externalTenantId","channelId","wabaId","templateKey",
    "metaTemplateId","metaTemplateName",language,category,status,"lastSyncedAt","updatedAt",
    encode(digest((to_jsonb(t)-ARRAY['clinicId','externalTenantId','updatedAt'])::text,'sha256'),'hex') "currentStateFingerprint"
    FROM whatsapp_templates t WHERE "channelId"=$1::uuid`, [IDS.canonicalChannelId]);
  const fingerprints = await one(client, `WITH cc AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid)
    SELECT
      encode(digest(COALESCE(string_agg((to_jsonb(j)-ARRAY['clinicId','updatedAt'])::text,'' ORDER BY id),''),'sha256'),'hex') jobs,
      (SELECT encode(digest(COALESCE(string_agg((to_jsonb(cm))::text,'' ORDER BY id),''),'sha256'),'hex') FROM conversation_messages cm WHERE "conversationId" IN (SELECT id FROM cc)) "conversationMessages",
      (SELECT encode(digest(COALESCE(string_agg((to_jsonb(m))::text,'' ORDER BY id),''),'sha256'),'hex') FROM messages m WHERE "channelId"=$1::uuid) messages
    FROM jobs j WHERE "channelId"=$1::uuid`, [IDS.canonicalChannelId]);
  const uniqueness = await one(client, `WITH cc AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid)
    SELECT
      (SELECT count(*)::int FROM (SELECT "providerMessageId" FROM messages WHERE "channelId"=$1::uuid
        AND "providerMessageId" IS NOT NULL GROUP BY 1 HAVING count(*)>1) d) "providerMessageIdDuplicates",
      (SELECT count(*)::int FROM (SELECT "waMessageId" FROM conversation_messages WHERE "conversationId" IN (SELECT id FROM cc)
        AND "waMessageId" IS NOT NULL GROUP BY 1 HAVING count(*)>1) d) "wamidDuplicates"`, [IDS.canonicalChannelId]);
  const constraints = (await client.query(`SELECT conrelid::regclass::text table,conname name,contype type,condeferrable deferrable,
    convalidated validated,encode(digest(pg_get_constraintdef(oid),'sha256'),'hex') "definitionSha256"
    FROM pg_constraint WHERE connamespace='public'::regnamespace AND conrelid::regclass::text=ANY($1::text[]) ORDER BY 1,2`,
  [['channels','contacts','conversations','conversation_messages','messages','conversation_events','handoff_requests',
    'agenda_items','leads','appointments','jobs','whatsapp_templates','orders','order_customer_notifications','operational_alert_rules']])).rows;
  return { channels, counts, drift, clones, template, fingerprints, uniqueness, constraints };
}

function validateState(state, forwardManifest) {
  const blockers = [];
  const canonical = state.channels.find((row) => row.id === IDS.canonicalChannelId);
  const legacy = state.channels.find((row) => row.id === IDS.legacyChannelId);
  if (!canonical || canonical.clinicId !== IDS.targetClinicId || canonical.status !== 'active'
    || canonical.wabaId !== IDS.wabaId || canonical.phoneNumberId !== IDS.phoneNumberId) blockers.push('canonical_current_state_mismatch');
  if (!legacy || legacy.clinicId !== IDS.targetClinicId || legacy.status !== 'inactive'
    || legacy.wabaId !== IDS.legacyWabaId || legacy.phoneNumberId !== IDS.legacyPhoneNumberId) blockers.push('legacy_current_state_mismatch');
  const expected = { conversations: 77, conversationMessages: 1804, messages: 43, events: 117, handoffs: 11,
    agenda: 9, leads: 23, appointments: 1, jobs: 782, jobsDone: 759, jobsFailed: 23, templates: 1,
    clones: 76, legacyConversations: 1, legacyConversationMessages: 10, legacyJobs: 5 };
  for (const [key, value] of Object.entries(expected)) if (Number(state.counts[key]) !== value) blockers.push(`count:${key}:${state.counts[key]}!=${value}`);
  for (const key of ['executableJobs','leasedJobs','canary','onboarding','thirdPhoneOwners']) if (Number(state.counts[key]) !== 0) blockers.push(`active:${key}:${state.counts[key]}`);
  for (const [key, value] of Object.entries(state.drift)) if (Number(value) !== 0) blockers.push(`post_t0:${key}:${value}`);
  if (Number(state.uniqueness.providerMessageIdDuplicates) || Number(state.uniqueness.wamidDuplicates)) blockers.push('message_uniqueness_violation');
  const minimalClones = state.clones.filter((row) => row.id !== IDS.collisionTargetId);
  if (minimalClones.length !== 76) blockers.push('clone_cardinality_mismatch');
  for (const clone of minimalClones) {
    if (clone.clinicId !== IDS.targetClinicId || clone.createdAt.toISOString() !== '2026-08-22T08:31:10.090Z'
      || clone.updatedAt.toISOString() !== '2026-08-22T08:31:10.090Z') blockers.push(`clone_state_drift:${clone.id}`);
    if (Number(clone.orders) || Number(clone.invoices) || Number(clone.payments)) blockers.push(`clone_commercial_reference:${clone.id}`);
  }
  if (!forwardManifest || (forwardManifest.contactMapping || []).length !== 77) blockers.push('forward_contact_mapping_invalid');
  return [...new Set(blockers)];
}

function buildRestoreRows(forwardManifest) {
  const detached = forwardManifest.detachedReferences || [];
  const actors = forwardManifest.actorReferences || [];
  return {
    orders: detached.filter((row) => row.kind === 'orders').map((row) => ({ id: row.id, referenceId: row.referenceId })),
    notificationChannel: detached.find((row) => row.kind === 'notification_channel') || null,
    notificationConversation: detached.find((row) => row.kind === 'notification_conversation') || null,
    alertRule: detached.find((row) => row.kind === 'alert_rule_channel') || null,
    actors
  };
}

async function prepareTempTables(client, manifest) {
  await client.query('CREATE TEMP TABLE reverse_contact_map ("sourceId" uuid PRIMARY KEY,"targetId" uuid UNIQUE NOT NULL,kind text NOT NULL) ON COMMIT DROP');
  for (const row of manifest.contactMapping) await client.query(
    'INSERT INTO reverse_contact_map("sourceId","targetId",kind) VALUES($1::uuid,$2::uuid,$3)',
    [row.sourceId, row.targetId, row.kind]
  );
  await client.query('CREATE TEMP TABLE reverse_orders (id uuid PRIMARY KEY,"conversationId" uuid NOT NULL) ON COMMIT DROP');
  for (const row of manifest.restore.orders) await client.query(
    'INSERT INTO reverse_orders(id,"conversationId") VALUES($1::uuid,$2::uuid)', [row.id, row.referenceId]
  );
  await client.query('CREATE TEMP TABLE reverse_actors (kind text NOT NULL,id uuid NOT NULL,"actorId" uuid NOT NULL,PRIMARY KEY(kind,id)) ON COMMIT DROP');
  for (const row of manifest.restore.actors) await client.query(
    'INSERT INTO reverse_actors(kind,id,"actorId") VALUES($1,$2::uuid,$3::uuid)', [row.kind, row.id, row.actorId]
  );
}

const REVERSE_CTE = `WITH canonical_conversations AS MATERIALIZED (
  SELECT id FROM conversations WHERE "channelId"=$1::uuid
), restored_orders AS (
  UPDATE orders o SET "conversationId"=r."conversationId" FROM reverse_orders r WHERE o.id=r.id RETURNING o.id
), restored_notification AS (
  UPDATE order_customer_notifications SET "channelId"=$1::uuid,"conversationId"=$7::uuid
  WHERE id=$6::uuid AND "channelId" IS NULL AND "conversationId" IS NULL RETURNING id
), restored_rule AS (
  UPDATE operational_alert_rules SET "channelId"=$1::uuid WHERE id=$8::uuid AND "channelId" IS NULL RETURNING id
), moved_templates AS (
  UPDATE whatsapp_templates SET "clinicId"=$2::uuid,"externalTenantId"=$4 WHERE "channelId"=$1::uuid RETURNING id
), moved_conversations AS (
  UPDATE conversations c SET "clinicId"=$2::uuid,"contactId"=m."sourceId",
    "deletedByUserId"=(SELECT a."actorId" FROM reverse_actors a WHERE a.kind='conversation_deleter' AND a.id=c.id),
    "assignedSellerUserId"=NULL
  FROM reverse_contact_map m
  WHERE c."channelId"=$1::uuid AND c."contactId"=m."targetId" RETURNING c.id
), moved_messages AS (
  UPDATE messages SET "clinicId"=$2::uuid WHERE "channelId"=$1::uuid RETURNING id
), moved_events AS (
  UPDATE conversation_events SET "clinicId"=$2::uuid WHERE "conversationId" IN (SELECT id FROM canonical_conversations) RETURNING id
), moved_handoffs AS (
  UPDATE handoff_requests h SET "clinicId"=$2::uuid,"contactId"=m."sourceId",
    "assignedTo"=(SELECT a."actorId" FROM reverse_actors a WHERE a.kind='handoff_assignee' AND a.id=h.id)
  FROM reverse_contact_map m
  WHERE h."conversationId" IN (SELECT id FROM canonical_conversations) AND h."contactId"=m."targetId" RETURNING h.id
), moved_agenda AS (
  UPDATE agenda_items a SET "clinicId"=$2::uuid,"contactId"=m."sourceId","assignedUserId"=NULL
  FROM reverse_contact_map m WHERE a."conversationId" IN (SELECT id FROM canonical_conversations) AND a."contactId"=m."targetId" RETURNING a.id
), moved_leads AS (
  UPDATE leads l SET "clinicId"=$2::uuid,"contactId"=m."sourceId",
    "assignedTo"=(SELECT a."actorId" FROM reverse_actors a WHERE a.kind='lead_assignee' AND a.id=l.id)
  FROM reverse_contact_map m
  WHERE l."channelId"=$1::uuid AND l."contactId"=m."targetId" RETURNING l.id
), moved_appointments AS (
  UPDATE appointments a SET "clinicId"=$2::uuid,"contactId"=m."sourceId"
  FROM reverse_contact_map m WHERE a."channelId"=$1::uuid AND a."contactId"=m."targetId" RETURNING a.id
), moved_jobs AS (
  UPDATE jobs SET "clinicId"=$2::uuid WHERE "channelId"=$1::uuid RETURNING id
), moved_channels AS (
  UPDATE channels SET "clinicId"=CASE WHEN id=$1::uuid THEN $2::uuid ELSE $3::uuid END,
    status=CASE WHEN id=$1::uuid THEN 'active' ELSE 'active' END
  WHERE id IN ($1::uuid,$5::uuid) RETURNING id
), deleted_clones AS (
  DELETE FROM contacts c USING reverse_contact_map m WHERE m.kind='MINIMAL_CLONE' AND c.id=m."targetId" RETURNING c.id
)
SELECT (SELECT count(*)::int FROM restored_orders) "restoredOrders",
  (SELECT count(*)::int FROM restored_notification) "restoredNotification",
  (SELECT count(*)::int FROM restored_rule) "restoredRule",
  (SELECT count(*)::int FROM moved_templates) templates,(SELECT count(*)::int FROM moved_conversations) conversations,
  (SELECT count(*)::int FROM moved_messages) messages,(SELECT count(*)::int FROM moved_events) events,
  (SELECT count(*)::int FROM moved_handoffs) handoffs,(SELECT count(*)::int FROM moved_agenda) agenda,
  (SELECT count(*)::int FROM moved_leads) leads,(SELECT count(*)::int FROM moved_appointments) appointments,
  (SELECT count(*)::int FROM moved_jobs) jobs,(SELECT count(*)::int FROM moved_channels) channels,
  (SELECT count(*)::int FROM deleted_clones) "deletedClones"`;

async function validateManifestAgainstDatabase(client, manifest) {
  const identity = await databaseIdentity(client);
  if (!manifest.database || identity.identifier !== manifest.database.identifierSha256) throw new Error('database_identity_mismatch');
  const state = await collectCurrentState(
    client,
    { contactMapping: manifest.contactMapping },
    manifest.postApplyActivityCutoffUtc
  );
  const blockers = validateState(state, { contactMapping: manifest.contactMapping });
  const canonical = state.channels.find((row) => row.id === IDS.canonicalChannelId);
  const legacy = state.channels.find((row) => row.id === IDS.legacyChannelId);
  if (!canonical || canonical.credentialFingerprint !== manifest.credentialFingerprints.canonical) blockers.push('canonical_credential_drift');
  if (!legacy || legacy.credentialFingerprint !== manifest.credentialFingerprints.legacy) blockers.push('legacy_credential_drift');
  if (!state.template || state.template.currentStateFingerprint !== manifest.template.currentStateFingerprint) blockers.push('template_current_state_drift');
  if (sha256(state.constraints) !== manifest.constraintFingerprint) blockers.push('constraint_fingerprint_drift');
  return { state, blockers: [...new Set(blockers)] };
}

async function executeReverseTransaction(client, manifest, execution) {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  let finished = false;
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opturon:whatsapp-reverse:' || $1,0))", [IDS.phoneNumberId]);
    await client.query('SELECT id FROM clinics WHERE id IN ($1::uuid,$2::uuid) ORDER BY id FOR UPDATE', [IDS.sourceClinicId, IDS.targetClinicId]);
    await client.query('SELECT id FROM channels WHERE id IN ($1::uuid,$2::uuid) ORDER BY id FOR UPDATE', [IDS.canonicalChannelId, IDS.legacyChannelId]);
    const validation = await validateManifestAgainstDatabase(client, manifest);
    if (validation.blockers.length) throw new Error(`manifest_precondition_failed:${validation.blockers.join(',')}`);
    await prepareTempTables(client, manifest);
    const collision = validation.state.clones.find((row) => row.id === IDS.collisionTargetId);
    if (!collision || Number(collision.conversations) !== 2 || Number(collision.leads) !== 1 || Number(collision.appointments) !== 1) {
      throw new Error('collision_precondition_mismatch');
    }
    for (const clone of validation.state.clones.filter((row) => row.id !== IDS.collisionTargetId)) {
      if (Number(clone.conversations) + Number(clone.leads) + Number(clone.appointments)
        + Number(clone.agenda) + Number(clone.handoffs) === 0) throw new Error(`orphan_clone_before_reverse:${clone.id}`);
    }
    const preCredential = validation.state.channels.find((row) => row.id === IDS.canonicalChannelId).credentialFingerprint;
    const preLegacyCredential = validation.state.channels.find((row) => row.id === IDS.legacyChannelId).credentialFingerprint;
    const result = (await client.query(REVERSE_CTE, [IDS.canonicalChannelId, IDS.sourceClinicId, IDS.targetClinicId,
      IDS.sourceTenantId, IDS.legacyChannelId, manifest.restore.notificationChannel.id,
      manifest.restore.notificationConversation.referenceId, manifest.restore.alertRule.id])).rows[0];
    const expectedResult = { restoredOrders: 30, restoredNotification: 1, restoredRule: 1, templates: 1,
      conversations: 77, messages: 43, events: 117, handoffs: 11, agenda: 9, leads: 23,
      appointments: 1, jobs: 782, channels: 2, deletedClones: 76 };
    for (const [key, value] of Object.entries(expectedResult)) if (Number(result[key]) !== value) throw new Error(`reverse_count:${key}:${result[key]}!=${value}`);
    const post = await one(client, `WITH cc AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid)
      SELECT
        (SELECT count(*)::int FROM conversations WHERE "channelId"=$1::uuid AND "clinicId"=$2::uuid) conversations,
        (SELECT count(*)::int FROM conversation_messages WHERE "conversationId" IN (SELECT id FROM cc)) "conversationMessages",
        (SELECT count(*)::int FROM contacts WHERE id=ANY($3::uuid[])) clones,
        (SELECT count(*)::int FROM channels WHERE id=$1::uuid AND "clinicId"=$2::uuid AND status='active') canonical,
        (SELECT count(*)::int FROM channels WHERE id=$4::uuid AND "clinicId"=$5::uuid AND status='active') legacy,
        (SELECT count(*)::int FROM jobs WHERE "channelId"=$1::uuid AND status='done') "jobsDone",
        (SELECT count(*)::int FROM jobs WHERE "channelId"=$1::uuid AND status='failed') "jobsFailed",
        (SELECT count(*)::int FROM orders o JOIN reverse_orders r ON r.id=o.id AND r."conversationId"=o."conversationId") "restoredOrders"`,
    [IDS.canonicalChannelId, IDS.sourceClinicId, manifest.cloneIds, IDS.legacyChannelId, IDS.targetClinicId]);
    for (const [key, value] of Object.entries({ conversations: 77, conversationMessages: 1804, clones: 0,
      canonical: 1, legacy: 1, jobsDone: 759, jobsFailed: 23, restoredOrders: 30 })) {
      if (Number(post[key]) !== value) throw new Error(`post_reverse:${key}:${post[key]}!=${value}`);
    }
    const credentials = await client.query(`SELECT id,encode(digest(COALESCE("accessToken",''),'sha256'),'hex') fingerprint
      FROM channels WHERE id=ANY($1::uuid[])`, [[IDS.canonicalChannelId, IDS.legacyChannelId]]);
    if (credentials.rows.find((row) => row.id === IDS.canonicalChannelId).fingerprint !== preCredential
      || credentials.rows.find((row) => row.id === IDS.legacyChannelId).fingerprint !== preLegacyCredential) throw new Error('credential_changed');
    const template = await one(client, `SELECT encode(digest((to_jsonb(t)-ARRAY['clinicId','externalTenantId','updatedAt'])::text,'sha256'),'hex') fingerprint
      FROM whatsapp_templates t WHERE "channelId"=$1::uuid`, [IDS.canonicalChannelId]);
    if (template.fingerprint !== manifest.template.currentStateFingerprint) throw new Error('template_current_state_changed');
    if (execution === 'COMMIT') await client.query('COMMIT'); else await client.query('ROLLBACK');
    finished = true;
    return { execution, result, assertions: post, credentialFingerprintUnchanged: true, templateCurrentStatePreserved: true };
  } finally {
    if (!finished) await client.query('ROLLBACK').catch(() => {});
  }
}

module.exports = {
  IDS, CONFIRMATION, TERMINAL_JOBS, REVERSE_CTE, stable, sha256, databaseIdentity,
  collectCurrentState, validateState, buildRestoreRows, validateManifestAgainstDatabase,
  executeReverseTransaction
};
