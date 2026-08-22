const crypto = require('crypto');

const IDS = Object.freeze({
  sourceChannelId: '7f86db7a-0b3f-4aeb-9546-d0f2f921456a',
  sourceClinicId: '8e117b14-7c5c-44fb-a4a4-ac86eb6c5074',
  targetClinicId: 'a335961a-75c3-443b-a35f-5cc8dd243b1d',
  legacyChannelId: 'b3ef8ab5-4610-4571-a91b-e34d10b98dfa',
  collisionSourceId: '751ae358-3663-4e6d-a0d3-31e16cd03f08',
  collisionTargetId: '18418399-c961-4800-8749-819b00560438',
  wabaId: '27184268844495361',
  phoneNumberId: '1070249406167861'
});

const CONFIRMATION_PHRASE = 'APPLY_WHATSAPP_OWNERSHIP_MIGRATION';
const WORKER_CONFIRMATION = 'CONFIRMED';
const TERMINAL_JOBS = ['done', 'failed', 'completed', 'cancelled', 'canceled', 'dead'];
const APPROVED_PRE_APPLY_COUNTS = Object.freeze({
  sourceContacts: 77, targetContacts: 1, conversations: 77, conversationMessages: 1804,
  messages: 43, events: 117, handoffs: 11, agenda: 9, leads: 23, appointments: 1,
  jobs: 782, jobsDone: 759, jobsFailed: 23, templates: 1, alertRules: 1,
  alertDeliveries: 0, notifications: 1, orders: 37, ordersToDetach: 30, invoices: 16,
  payments: 9, orderItems: 38, paymentAllocations: 1, inventoryAllocations: 3,
  canary: 0, onboarding: 0, media: 83
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex');
}

function assertApplyGate(options, env = process.env) {
  const errors = [];
  if (options.mode !== 'APPLY') errors.push('mode_must_be_APPLY');
  if (!['COMMIT', 'ROLLBACK_SIMULATION'].includes(options.execution)) errors.push('execution_must_be_COMMIT_or_ROLLBACK_SIMULATION');
  if (env.WHATSAPP_OWNERSHIP_CONFIRMATION !== CONFIRMATION_PHRASE) errors.push('confirmation_phrase_mismatch');
  if (env.WHATSAPP_OWNERSHIP_WORKERS_PAUSED !== WORKER_CONFIRMATION) errors.push('workers_pause_not_confirmed');
  for (const field of ['sourceChannelId', 'targetClinicId', 'phoneNumberId']) {
    if (options[field] !== IDS[field]) errors.push(`${field}_mismatch`);
  }
  if (!options.manifestPath || !options.manifestSha256) errors.push('signed_manifest_required');
  if (errors.length) throw new Error(`APPLY gate rejected: ${errors.join(', ')}`);
}

async function verifyWorkerPause(env = process.env) {
  const token = String(env.RENDER_API_KEY || '').trim();
  const serviceId = String(env.RENDER_SERVICE_ID || 'srv-d6n7i5vgi27c73c954t0').trim();
  if (!token) throw new Error('RENDER_API_KEY_required_for_worker_pause_verification');
  const response = await fetch(`https://api.render.com/v1/services/${encodeURIComponent(serviceId)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`worker_pause_verification_http_${response.status}`);
  const body = await response.json();
  if (String(body.suspended || '').toLowerCase() !== 'suspended') throw new Error('render_service_not_suspended');
  return { serviceId, suspended: true };
}

async function one(client, text, params = []) {
  return (await client.query(text, params)).rows[0] || null;
}

async function buildContactMapping(client) {
  const result = await client.query(`
    WITH affected AS (
      SELECT DISTINCT "contactId" id FROM conversations WHERE "channelId"=$1::uuid
      UNION SELECT DISTINCT "contactId" FROM leads WHERE "channelId"=$1::uuid AND "contactId" IS NOT NULL
      UNION SELECT DISTINCT "contactId" FROM appointments WHERE "channelId"=$1::uuid AND "contactId" IS NOT NULL
    )
    SELECT c.id AS "sourceId"
      FROM contacts c JOIN affected a ON a.id=c.id
     WHERE c.id<>$2::uuid ORDER BY c.id`, [IDS.sourceChannelId, IDS.collisionSourceId]);
  return [
    { sourceId: IDS.collisionSourceId, targetId: IDS.collisionTargetId, kind: 'EXISTING_TARGET_COLLISION' },
    ...result.rows.map((row) => ({ sourceId: row.sourceId, targetId: crypto.randomUUID(), kind: 'MINIMAL_CLONE' }))
  ];
}

async function collectSafetyState(client) {
  return one(client, `
    SELECT
      (SELECT COUNT(*)::int FROM jobs WHERE "channelId"=$1::uuid AND lower(status)<>ALL($2::text[])) AS "executableJobs",
      (SELECT COUNT(*)::int FROM jobs WHERE "channelId"=$1::uuid AND "lockedAt" IS NOT NULL) AS "leasedJobs",
      (SELECT COUNT(*)::int FROM whatsapp_template_canary_attempts WHERE "channelId"=$1::uuid AND status='processing') AS "activeCanaryAttempts",
      (SELECT COUNT(*)::int FROM whatsapp_template_canary_attempts WHERE "channelId"=$1::uuid AND status='processing') AS "templateSendsInProgress",
      (SELECT COUNT(*)::int FROM operational_alert_rules WHERE "channelId"=$1::uuid
        AND ("schedulerLockedAt" IS NOT NULL OR "schedulerLeaseExpiresAt" IS NOT NULL)) AS "leasedOperationalAlerts",
      (SELECT COUNT(*)::int FROM channel_onboarding_sessions WHERE "channelId"=$1::uuid AND status IN ('launching','exchanging_code','discovering_assets','persisting')) AS "activeOnboardingSessions",
      (SELECT COUNT(*)::int FROM channels WHERE "phoneNumberId"=$3 AND id NOT IN ($1::uuid,$4::uuid)) AS "thirdPhoneOwners"`,
    [IDS.sourceChannelId, TERMINAL_JOBS, IDS.phoneNumberId, IDS.legacyChannelId]);
}

function safetyBlockers(state) {
  return Object.entries(state || {}).filter(([, value]) => Number(value) !== 0).map(([key]) => key);
}

async function collectPreApplyCounts(client) {
  const row = await one(client, `WITH source_conversations AS (
    SELECT id FROM conversations WHERE "channelId"=$1::uuid
  ), affected_contacts AS (
    SELECT DISTINCT "contactId" id FROM conversations WHERE "channelId"=$1::uuid
  ), affected_orders AS (
    SELECT id FROM orders WHERE "clinicId"=$2::uuid AND ("contactId" IN (SELECT id FROM affected_contacts)
      OR "conversationId" IN (SELECT id FROM source_conversations))
  ), affected_invoices AS (
    SELECT id FROM invoices WHERE "clinicId"=$2::uuid AND ("contactId" IN (SELECT id FROM affected_contacts)
      OR "orderId" IN (SELECT id FROM affected_orders))
  ), affected_payments AS (
    SELECT id FROM payments WHERE "clinicId"=$2::uuid AND ("contactId" IN (SELECT id FROM affected_contacts)
      OR "invoiceId" IN (SELECT id FROM affected_invoices))
  ) SELECT
    (SELECT count(*)::int FROM affected_contacts) "sourceContacts",
    (SELECT count(*)::int FROM contacts WHERE "clinicId"=$3::uuid) "targetContacts",
    (SELECT count(*)::int FROM source_conversations) conversations,
    (SELECT count(*)::int FROM conversation_messages WHERE "conversationId" IN (SELECT id FROM source_conversations)) "conversationMessages",
    (SELECT count(*)::int FROM messages WHERE "channelId"=$1::uuid) messages,
    (SELECT count(*)::int FROM conversation_events WHERE "conversationId" IN (SELECT id FROM source_conversations)) events,
    (SELECT count(*)::int FROM handoff_requests WHERE "conversationId" IN (SELECT id FROM source_conversations)) handoffs,
    (SELECT count(*)::int FROM agenda_items WHERE "conversationId" IN (SELECT id FROM source_conversations)) agenda,
    (SELECT count(*)::int FROM leads WHERE "channelId"=$1::uuid) leads,
    (SELECT count(*)::int FROM appointments WHERE "channelId"=$1::uuid) appointments,
    (SELECT count(*)::int FROM jobs WHERE "channelId"=$1::uuid) jobs,
    (SELECT count(*)::int FROM jobs WHERE "channelId"=$1::uuid AND status='done') "jobsDone",
    (SELECT count(*)::int FROM jobs WHERE "channelId"=$1::uuid AND status='failed') "jobsFailed",
    (SELECT count(*)::int FROM whatsapp_templates WHERE "channelId"=$1::uuid) templates,
    (SELECT count(*)::int FROM operational_alert_rules WHERE "channelId"=$1::uuid) "alertRules",
    (SELECT count(*)::int FROM operational_alert_deliveries WHERE "channelId"=$1::uuid) "alertDeliveries",
    (SELECT count(*)::int FROM order_customer_notifications WHERE "channelId"=$1::uuid) notifications,
    (SELECT count(*)::int FROM affected_orders) orders,
    (SELECT count(*)::int FROM orders WHERE "clinicId"=$2::uuid AND "conversationId" IN (SELECT id FROM source_conversations)) "ordersToDetach",
    (SELECT count(*)::int FROM affected_invoices) invoices,
    (SELECT count(*)::int FROM affected_payments) payments,
    (SELECT count(*)::int FROM order_items WHERE "orderId" IN (SELECT id FROM affected_orders)) "orderItems",
    (SELECT count(*)::int FROM payment_allocations WHERE "paymentId" IN (SELECT id FROM affected_payments)
      OR "invoiceId" IN (SELECT id FROM affected_invoices)) "paymentAllocations",
    (SELECT count(*)::int FROM inventory_lot_allocations WHERE "orderId" IN (SELECT id FROM affected_orders)) "inventoryAllocations",
    (SELECT count(*)::int FROM whatsapp_template_canary_attempts WHERE "channelId"=$1::uuid) canary,
    (SELECT count(*)::int FROM channel_onboarding_sessions WHERE "channelId"=$1::uuid) onboarding,
    (SELECT count(*)::int FROM conversation_messages cm WHERE cm."conversationId" IN (SELECT id FROM source_conversations)
      AND (lower(COALESCE(cm.type,'')) IN ('image','video','audio','document','sticker') OR cm.raw #> '{message,image}' IS NOT NULL
      OR cm.raw #> '{message,video}' IS NOT NULL OR cm.raw #> '{message,audio}' IS NOT NULL
      OR cm.raw #> '{message,document}' IS NOT NULL)) media`, [IDS.sourceChannelId, IDS.sourceClinicId, IDS.targetClinicId]);
  return row;
}

async function collectInvariantFingerprints(client) {
  return one(client, `WITH source_conversations AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid),
    affected_contacts AS (SELECT "sourceId" id FROM phase2_contact_map),
    affected_orders AS (SELECT id FROM orders WHERE "clinicId"=$2::uuid AND ("contactId" IN (SELECT id FROM affected_contacts)
      OR "conversationId" IN (SELECT id FROM source_conversations)))
    SELECT
      (SELECT encode(digest(COALESCE(string_agg((to_jsonb(o)-ARRAY['conversationId','updatedAt'])::text,'' ORDER BY id),''),'sha256'),'hex')
        FROM orders o WHERE id IN (SELECT id FROM affected_orders)) "commercialOrders",
      (SELECT encode(digest(COALESCE(string_agg((to_jsonb(j)-ARRAY['clinicId','updatedAt'])::text,'' ORDER BY id),''),'sha256'),'hex')
        FROM jobs j WHERE "channelId"=$1::uuid) jobs,
      (SELECT encode(digest(COALESCE(string_agg((to_jsonb(n)-ARRAY['channelId','conversationId'])::text,'' ORDER BY id),''),'sha256'),'hex')
        FROM order_customer_notifications n WHERE id IN
          (SELECT id FROM phase2_commercial_ids WHERE kind='order_customer_notifications')) notification`, [IDS.sourceChannelId, IDS.sourceClinicId]);
}

const APPLY_CTE = `
WITH source_conversations AS MATERIALIZED (
  SELECT id FROM conversations WHERE "channelId"=$1::uuid
),
detached_orders AS (
  UPDATE orders SET "conversationId"=NULL
   WHERE "clinicId"=$2::uuid AND "conversationId" IN (SELECT id FROM source_conversations)
   RETURNING id
),
detached_notifications AS (
  UPDATE order_customer_notifications SET "channelId"=NULL,"conversationId"=NULL
   WHERE "clinicId"=$2::uuid AND ("channelId"=$1::uuid OR "conversationId" IN (SELECT id FROM source_conversations))
   RETURNING id
),
detached_rules AS (
  UPDATE operational_alert_rules SET "channelId"=NULL
   WHERE "clinicId"=$2::uuid AND "channelId"=$1::uuid RETURNING id
),
moved_templates AS (
  UPDATE whatsapp_templates SET "clinicId"=$3::uuid,"externalTenantId"=$6
   WHERE "channelId"=$1::uuid RETURNING id
),
moved_conversations AS (
  UPDATE conversations c SET "clinicId"=$3::uuid,"contactId"=m."targetId",
         "assignedSellerUserId"=NULL,"deletedByUserId"=NULL
    FROM phase2_contact_map m WHERE c."channelId"=$1::uuid AND m."sourceId"=c."contactId" RETURNING c.id
),
moved_messages AS (
  UPDATE messages SET "clinicId"=$3::uuid WHERE "channelId"=$1::uuid RETURNING id
),
moved_events AS (
  UPDATE conversation_events SET "clinicId"=$3::uuid
   WHERE "conversationId" IN (SELECT id FROM source_conversations) RETURNING id
),
moved_handoffs AS (
  UPDATE handoff_requests h SET "clinicId"=$3::uuid,"contactId"=m."targetId",
         "assignedTo"=CASE WHEN lower(h.status) IN ('assigned','in_progress') AND h."assignedTo" IS NOT NULL THEN $7::uuid ELSE NULL END
    FROM phase2_contact_map m
   WHERE h."conversationId" IN (SELECT id FROM source_conversations) AND m."sourceId"=h."contactId" RETURNING h.id
),
moved_agenda AS (
  UPDATE agenda_items a SET "clinicId"=$3::uuid,"contactId"=m."targetId","assignedUserId"=NULL
    FROM phase2_contact_map m
   WHERE a."conversationId" IN (SELECT id FROM source_conversations) AND m."sourceId"=a."contactId" RETURNING a.id
),
moved_leads AS (
  UPDATE leads l SET "clinicId"=$3::uuid,"contactId"=m."targetId",
         "assignedTo"=CASE WHEN l."assignedTo" IS NULL THEN NULL ELSE $7::uuid END
    FROM phase2_contact_map m WHERE l."channelId"=$1::uuid AND m."sourceId"=l."contactId" RETURNING l.id
),
moved_appointments AS (
  UPDATE appointments a SET "clinicId"=$3::uuid,"contactId"=m."targetId"
    FROM phase2_contact_map m WHERE a."channelId"=$1::uuid AND m."sourceId"=a."contactId" RETURNING a.id
),
moved_jobs AS (
  UPDATE jobs SET "clinicId"=$3::uuid WHERE "channelId"=$1::uuid RETURNING id
),
moved_canary AS (
  UPDATE whatsapp_template_canary_attempts SET "clinicId"=$3::uuid WHERE "channelId"=$1::uuid RETURNING id
),
moved_onboarding AS (
  UPDATE channel_onboarding_sessions SET "clinicId"=$3::uuid,"externalTenantId"=$6,"createdByUserId"=NULL
   WHERE "channelId"=$1::uuid RETURNING id
),
moved_channels AS (
  UPDATE channels SET "clinicId"=CASE WHEN id=$1::uuid THEN $3::uuid ELSE "clinicId" END,
         status=CASE WHEN id=$1::uuid THEN 'active' ELSE 'inactive' END
   WHERE id IN ($1::uuid,$4::uuid) AND (id<>$1::uuid OR "phoneNumberId"=$5::text)
   RETURNING id,status,"clinicId"
)
SELECT
 (SELECT count(*)::int FROM detached_orders) "detachedOrders",
 (SELECT count(*)::int FROM detached_notifications) "detachedNotifications",
 (SELECT count(*)::int FROM detached_rules) "detachedRules",
 (SELECT count(*)::int FROM moved_templates) "templates",
 (SELECT count(*)::int FROM moved_conversations) conversations,
 (SELECT count(*)::int FROM moved_messages) messages,
 (SELECT count(*)::int FROM moved_events) events,
 (SELECT count(*)::int FROM moved_handoffs) handoffs,
 (SELECT count(*)::int FROM moved_agenda) agenda,
 (SELECT count(*)::int FROM moved_leads) leads,
 (SELECT count(*)::int FROM moved_appointments) appointments,
 (SELECT count(*)::int FROM moved_jobs) jobs,
 (SELECT count(*)::int FROM moved_canary) canary,
 (SELECT count(*)::int FROM moved_onboarding) onboarding,
 (SELECT count(*)::int FROM moved_channels) channels`;

async function executeApplyTransaction(client, manifest, execution) {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  let finished = false;
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opturon:whatsapp-ownership:' || $1,0))", [IDS.phoneNumberId]);
    await client.query('SELECT id FROM clinics WHERE id IN ($1::uuid,$2::uuid) ORDER BY id FOR UPDATE', [IDS.sourceClinicId, IDS.targetClinicId]);
    await client.query('SELECT id FROM channels WHERE id IN ($1::uuid,$2::uuid) ORDER BY id FOR UPDATE', [IDS.sourceChannelId, IDS.legacyChannelId]);
    const databaseIdentity = await one(client, `SELECT encode(digest(current_database() || ':' || inet_server_addr()::text
      || ':' || inet_server_port()::text,'sha256'),'hex') identifier`);
    if (!manifest.database || databaseIdentity.identifier !== manifest.database.identifierSha256) throw new Error('database_identity_mismatch');

    const safety = await collectSafetyState(client);
    const blockers = safetyBlockers(safety);
    if (blockers.length) throw new Error(`active_work_blocker:${blockers.join(',')}`);
    const channel = await one(client, `SELECT id,"clinicId","wabaId","phoneNumberId",status,
      encode(digest(COALESCE("accessToken",''),'sha256'),'hex') "credentialFingerprint"
      FROM channels WHERE id=$1::uuid`, [IDS.sourceChannelId]);
    if (!channel || channel.clinicId !== IDS.sourceClinicId || channel.wabaId !== IDS.wabaId
      || channel.phoneNumberId !== IDS.phoneNumberId || channel.status !== 'active') throw new Error('source_channel_precondition_changed');
    if (channel.credentialFingerprint !== manifest.credentialFingerprint) throw new Error('credential_fingerprint_drift');
    const currentCounts = await collectPreApplyCounts(client);
    if (sha256(currentCounts) !== sha256(manifest.preApplyCounts)) throw new Error('pre_apply_manifest_count_drift');

    await client.query('CREATE TEMP TABLE phase2_contact_map ("sourceId" uuid PRIMARY KEY,"targetId" uuid UNIQUE NOT NULL,kind text NOT NULL) ON COMMIT DROP');
    for (const mapping of manifest.contactMapping) {
      await client.query('INSERT INTO phase2_contact_map("sourceId","targetId",kind) VALUES($1::uuid,$2::uuid,$3)', [mapping.sourceId, mapping.targetId, mapping.kind]);
    }
    const mapCount = await one(client, 'SELECT count(*)::int n FROM phase2_contact_map');
    if (Number(mapCount.n) !== 77) throw new Error('contact_map_count_mismatch');
    await client.query('CREATE TEMP TABLE phase2_commercial_ids (kind text NOT NULL,id uuid NOT NULL,PRIMARY KEY(kind,id)) ON COMMIT DROP');
    for (const kind of ['orders', 'invoices', 'payments', 'order_items', 'payment_allocations',
      'inventory_lot_allocations', 'order_customer_notifications']) {
      for (const id of ((manifest.tableFingerprints[kind] || {}).ids || [])) {
        await client.query('INSERT INTO phase2_commercial_ids(kind,id) VALUES($1,$2::uuid)', [kind, id]);
      }
    }
    const invariantPre = await collectInvariantFingerprints(client);

    const clones = await client.query(`INSERT INTO contacts
      (id,"clinicId","waId",phone,"whatsappPhone",name,"profileImageUrl","optedOut",metadata,status)
      SELECT m."targetId",$1::uuid,c."waId",c.phone,c."whatsappPhone",c.name,c."profileImageUrl",c."optedOut",'{}'::jsonb,'active'
        FROM phase2_contact_map m JOIN contacts c ON c.id=m."sourceId"
       WHERE m.kind='MINIMAL_CLONE' RETURNING id`, [IDS.targetClinicId]);
    if (clones.rowCount !== 76) throw new Error(`clone_count_mismatch:${clones.rowCount}`);
    await client.query(`UPDATE contacts target SET "optedOut"=(target."optedOut" OR source."optedOut")
      FROM contacts source WHERE target.id=$1::uuid AND source.id=$2::uuid
        AND target."optedOut" IS DISTINCT FROM (target."optedOut" OR source."optedOut")`,
    [IDS.collisionTargetId, IDS.collisionSourceId]);

    const target = await one(client, 'SELECT "externalTenantId" FROM clinics WHERE id=$1::uuid', [IDS.targetClinicId]);
    const primary = await one(client, `SELECT s.id FROM clinics c JOIN staff_users s
      ON s.id=NULLIF(c.settings -> 'portal' ->> 'primaryPortalUserId','')::uuid
      WHERE c.id=$1::uuid AND s."clinicId"=c.id AND s.active=true`, [IDS.targetClinicId]);
    if (!target || !target.externalTenantId || !primary) throw new Error('target_identity_or_staff_missing');
    if (primary.id !== manifest.targetPrimaryStaffId) throw new Error('target_primary_staff_drift');
    const result = (await client.query(APPLY_CTE, [IDS.sourceChannelId, IDS.sourceClinicId, IDS.targetClinicId,
      IDS.legacyChannelId, IDS.phoneNumberId, target.externalTenantId, primary.id])).rows[0];

    const final = await one(client, `SELECT
      (SELECT count(*)::int FROM conversations WHERE "channelId"=$1::uuid AND "clinicId"=$2::uuid) conversations,
      (SELECT count(*)::int FROM conversation_messages cm JOIN conversations c ON c.id=cm."conversationId" WHERE c."channelId"=$1::uuid AND c."clinicId"=$2::uuid) "conversationMessages",
      (SELECT count(*)::int FROM messages WHERE "channelId"=$1::uuid AND "clinicId"=$2::uuid) messages,
      (SELECT count(*)::int FROM conversation_events e JOIN conversations c ON c.id=e."conversationId" WHERE c."channelId"=$1::uuid AND e."clinicId"=$2::uuid) events,
      (SELECT count(*)::int FROM handoff_requests h JOIN conversations c ON c.id=h."conversationId" WHERE c."channelId"=$1::uuid AND h."clinicId"=$2::uuid) handoffs,
      (SELECT count(*)::int FROM leads WHERE "channelId"=$1::uuid AND "clinicId"=$2::uuid) leads,
      (SELECT count(*)::int FROM contacts c JOIN phase2_contact_map m ON m."targetId"=c.id WHERE c."clinicId"=$2::uuid) contacts,
      (SELECT count(*)::int FROM orders WHERE "clinicId"=$3::uuid AND id IN (SELECT id FROM phase2_commercial_ids WHERE kind='orders')) orders,
      (SELECT count(*)::int FROM invoices WHERE "clinicId"=$3::uuid AND id IN (SELECT id FROM phase2_commercial_ids WHERE kind='invoices')) invoices,
      (SELECT count(*)::int FROM payments WHERE "clinicId"=$3::uuid AND id IN (SELECT id FROM phase2_commercial_ids WHERE kind='payments')) payments,
      (SELECT count(*)::int FROM order_items WHERE id IN (SELECT id FROM phase2_commercial_ids WHERE kind='order_items')) "orderItems",
      (SELECT count(*)::int FROM payment_allocations WHERE "clinicId"=$3::uuid AND id IN
        (SELECT id FROM phase2_commercial_ids WHERE kind='payment_allocations')) "paymentAllocations",
      (SELECT count(*)::int FROM inventory_lot_allocations WHERE "tenantId"=$3::uuid AND id IN
        (SELECT id FROM phase2_commercial_ids WHERE kind='inventory_lot_allocations')) "inventoryAllocations",
      (SELECT count(*)::int FROM channels WHERE id=$1::uuid AND "clinicId"=$2::uuid AND status='active' AND "wabaId"=$4 AND "phoneNumberId"=$5) canonical,
      (SELECT count(*)::int FROM channels WHERE id=$6::uuid AND "clinicId"=$2::uuid AND status='inactive') legacy,
      (SELECT count(*)::int FROM (SELECT 1 FROM contacts WHERE "clinicId"=$2::uuid
        AND NULLIF(regexp_replace(COALESCE("waId","whatsappPhone",phone,''),'\\D','','g'),'') IS NOT NULL
        GROUP BY regexp_replace(COALESCE("waId","whatsappPhone",phone,''),'\\D','','g') HAVING count(*)>1) duplicates) "duplicatePhoneGroup"`,
    [IDS.sourceChannelId, IDS.targetClinicId, IDS.sourceClinicId, IDS.wabaId, IDS.phoneNumberId, IDS.legacyChannelId]);
    const expected = { conversations: 77, conversationMessages: 1804, messages: 43, events: 117, handoffs: 11,
      leads: 23, contacts: 77, orders: 37, invoices: 16, payments: 9, orderItems: 38,
      paymentAllocations: 1, inventoryAllocations: 3, canonical: 1, legacy: 1 };
    for (const [key, value] of Object.entries(expected)) if (Number(final[key]) !== value) throw new Error(`post_assert_${key}:${final[key]}!=${value}`);
    if (Number(final.duplicatePhoneGroup) !== 0) throw new Error('post_assert_duplicate_target_phone');
    const postCredential = await one(client, `SELECT encode(digest(COALESCE("accessToken",''),'sha256'),'hex') fingerprint FROM channels WHERE id=$1::uuid`, [IDS.sourceChannelId]);
    if (postCredential.fingerprint !== manifest.credentialFingerprint) throw new Error('post_assert_credential_changed');
    const invariantPost = await collectInvariantFingerprints(client);
    for (const key of Object.keys(invariantPre)) if (invariantPre[key] !== invariantPost[key]) throw new Error(`post_assert_${key}_changed`);

    if (execution === 'COMMIT') await client.query('COMMIT');
    else await client.query('ROLLBACK');
    finished = true;
    return { execution, result, assertions: final, immutableFingerprintsUnchanged: true, credentialFingerprintUnchanged: true };
  } finally {
    if (!finished) await client.query('ROLLBACK').catch(() => {});
  }
}

module.exports = {
  IDS, CONFIRMATION_PHRASE, WORKER_CONFIRMATION, TERMINAL_JOBS, APPROVED_PRE_APPLY_COUNTS, APPLY_CTE,
  stable, sha256, assertApplyGate, verifyWorkerPause, buildContactMapping, collectSafetyState, safetyBlockers,
  collectPreApplyCounts, collectInvariantFingerprints, executeApplyTransaction
};
