const { Client } = require('pg');
const { analyzeConsolidationSnapshot } = require('../../src/services/whatsapp-channel-ownership-consolidation.service');

const DEFAULTS = Object.freeze({
  sourceChannelId: '7f86db7a-0b3f-4aeb-9546-d0f2f921456a',
  sourceClinicId: '8e117b14-7c5c-44fb-a4a4-ac86eb6c5074',
  targetClinicId: 'a335961a-75c3-443b-a35f-5cc8dd243b1d',
  legacyChannelId: 'b3ef8ab5-4610-4571-a91b-e34d10b98dfa'
});

const STRATEGIES = Object.freeze({
  appointments: 'move_clinic_with_conversation_contact_lead_slot_validation',
  channel_onboarding_sessions: 'move_completed_metadata_without_secret_output',
  conversations: 'move_clinic_preserve_channel_and_contact_mapping',
  jobs: 'move_terminal_jobs_after_quiescence',
  leads: 'move_clinic_with_conversation_contact_mapping',
  messages: 'move_clinic_preserve_provider_id',
  operational_alert_deliveries: 'move_alert_delivery_graph',
  operational_alert_rules: 'move_alert_rule_graph',
  order_customer_notifications: 'move_with_order_closure',
  whatsapp_template_canary_attempts: 'move_canary_history_after_quiescence',
  whatsapp_templates: 'move_preserve_channel_waba_scope'
});

const TRANSITIVE_BUSINESS_TABLES = new Set([
  'orders',
  'order_items',
  'invoices',
  'payments',
  'payment_allocations',
  'inventory_lot_allocations'
]);

function flag(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => String(item).startsWith(prefix));
  return found ? String(found).slice(prefix.length).trim() : fallback;
}

function parseOptions() {
  const mode = flag('mode', 'DRY_RUN').toUpperCase();
  if (mode !== 'DRY_RUN') throw new Error('Only --mode=DRY_RUN is supported. This command has no write mode.');
  return {
    mode,
    sourceChannelId: flag('source-channel-id', DEFAULTS.sourceChannelId),
    sourceClinicId: flag('source-clinic-id', DEFAULTS.sourceClinicId),
    targetClinicId: flag('target-clinic-id', DEFAULTS.targetClinicId),
    legacyChannelId: flag('legacy-channel-id', DEFAULTS.legacyChannelId)
  };
}

async function rows(client, text, params = []) {
  return (await client.query(text, params)).rows;
}

async function one(client, text, params = []) {
  return (await rows(client, text, params))[0] || null;
}

async function channelContext(client, channelId) {
  return one(client,
    `SELECT ch.id, ch."clinicId", c."externalTenantId" AS "workspaceId",
            COALESCE(c.settings -> 'portal' ->> 'accountScope', c.settings ->> 'accountScope', 'client') AS "accountScope",
            ch.provider, ch.status, ch."wabaId", ch."phoneNumberId", ch."connectionSource",
            ch."createdAt", ch."updatedAt"
       FROM channels ch JOIN clinics c ON c.id = ch."clinicId"
      WHERE ch.id = $1::uuid`,
    [channelId]
  );
}

async function dependencyCatalog(client, sourceChannelId, legacyChannelId) {
  const columns = await rows(client,
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'channelId' ORDER BY table_name`
  );
  const dependencies = [];
  for (const { table_name: table } of columns) {
    const counts = await one(client,
      `SELECT COUNT(*) FILTER (WHERE "channelId" = $1::uuid)::int AS "sourceCount",
              COUNT(*) FILTER (WHERE "channelId" = $2::uuid)::int AS "legacyCount"
         FROM "${table.replaceAll('"', '""')}"`,
      [sourceChannelId, legacyChannelId]
    );
    dependencies.push({ table, ...counts, strategy: STRATEGIES[table] || 'unclassified' });
  }
  return dependencies;
}

async function relationColumns(client, columnName) {
  return rows(client,
    `SELECT c.table_name AS table,
            EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema='public' AND x.table_name=c.table_name AND x.column_name='clinicId') AS "hasClinicId",
            EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema='public' AND x.table_name=c.table_name AND x.column_name='channelId') AS "hasChannelId"
       FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.column_name=$1
      ORDER BY c.table_name`, [columnName]);
}

async function transitiveDependencyCatalog(client, sourceChannelId) {
  const sourceConversationRows = await rows(client, `SELECT id FROM conversations WHERE "channelId"=$1::uuid`, [sourceChannelId]);
  const conversationIds = sourceConversationRows.map((item) => item.id);
  const contactRows = await rows(client,
    `SELECT DISTINCT "contactId" AS id FROM conversations WHERE "channelId"=$1::uuid
     UNION SELECT DISTINCT "contactId" FROM leads WHERE "channelId"=$1::uuid AND "contactId" IS NOT NULL
     UNION SELECT DISTINCT "contactId" FROM appointments WHERE "channelId"=$1::uuid AND "contactId" IS NOT NULL`,
    [sourceChannelId]);
  const contactIds = contactRows.map((item) => item.id);
  const orderRows = await rows(client, `SELECT DISTINCT "orderId" AS id FROM order_customer_notifications WHERE "channelId"=$1::uuid`, [sourceChannelId]);
  const ruleRows = await rows(client, `SELECT id FROM operational_alert_rules WHERE "channelId"=$1::uuid`, [sourceChannelId]);
  const leadRows = await rows(client, `SELECT id FROM leads WHERE "channelId"=$1::uuid`, [sourceChannelId]);
  const scopes = [
    { via: 'conversationId', ids: conversationIds },
    { via: 'contactId', ids: contactIds },
    { via: 'orderId', ids: orderRows.map((item) => item.id) },
    { via: 'ruleId', ids: ruleRows.map((item) => item.id) },
    { via: 'leadId', ids: leadRows.map((item) => item.id) }
  ];
  const dependencies = [];
  for (const scope of scopes) {
    if (scope.ids.length === 0) continue;
    const relations = await relationColumns(client, scope.via);
    for (const relation of relations) {
      const result = await one(client,
        `SELECT COUNT(*)::int AS count FROM "${relation.table.replaceAll('"', '""')}" WHERE "${scope.via}"=ANY($1::uuid[])`,
        [scope.ids]);
      if (!Number(result.count)) continue;
      dependencies.push({
        table: relation.table,
        via: scope.via,
        sourceCount: Number(result.count),
        hasClinicId: relation.hasClinicId,
        hasChannelId: relation.hasChannelId,
        strategy: TRANSITIVE_BUSINESS_TABLES.has(relation.table)
          ? 'requires_explicit_business_history_ownership_decision_and_recursive_closure'
          : relation.hasClinicId ? 'update_clinic_id_with_parent_closure' : 'preserve_parent_fk_no_direct_tenant_column',
        requiresDecision: TRANSITIVE_BUSINESS_TABLES.has(relation.table)
      });
    }
  }
  return dependencies;
}

async function catalog(client) {
  const foreignKeys = await rows(client,
    `SELECT source.relname AS "sourceTable", target.relname AS "targetTable", con.conname AS name,
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class source ON source.oid = con.conrelid
       JOIN pg_class target ON target.oid = con.confrelid
       JOIN pg_namespace ns ON ns.oid = source.relnamespace
      WHERE ns.nspname = 'public' AND con.contype = 'f'
        AND (source.relname IN ('channels','contacts','conversations','messages','conversation_messages','leads','jobs','appointments','whatsapp_templates','operational_alert_rules','operational_alert_deliveries','operational_alert_recipients','operational_alert_rule_recipients','order_customer_notifications','orders','webhook_events','inbound_failures','whatsapp_template_canary_attempts','channel_onboarding_sessions')
          OR target.relname IN ('channels','contacts','conversations','leads','orders','operational_alert_rules','operational_alert_recipients'))
      ORDER BY source.relname, con.conname`
  );
  const uniqueIndexes = await rows(client,
    `SELECT tablename AS table, indexname AS name, indexdef AS definition
       FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
        AND tablename IN ('channels','contacts','conversations','messages','conversation_messages','leads','jobs','appointments','whatsapp_templates','operational_alert_rules','operational_alert_deliveries','operational_alert_recipients','operational_alert_rule_recipients','order_customer_notifications','orders','whatsapp_template_canary_attempts')
      ORDER BY tablename, indexname`
  );
  const triggers = await rows(client,
    `SELECT event_object_table AS table, trigger_name AS name, event_manipulation AS event,
            action_statement AS action
       FROM information_schema.triggers
      WHERE event_object_schema = 'public'
        AND event_object_table IN ('channels','contacts','conversations','messages','conversation_messages','leads','jobs','appointments','whatsapp_templates','operational_alert_rules','operational_alert_deliveries','operational_alert_recipients','operational_alert_rule_recipients','order_customer_notifications','orders','whatsapp_template_canary_attempts')
      ORDER BY event_object_table, trigger_name`
  );
  return { foreignKeys, uniqueIndexes, triggers };
}

async function metrics(client, options, source) {
  const p = [options.sourceChannelId, options.targetClinicId];
  const contacts = await one(client,
    `WITH affected AS (
       SELECT DISTINCT "contactId" AS id FROM conversations WHERE "channelId"=$1::uuid
       UNION SELECT DISTINCT "contactId" FROM appointments WHERE "channelId"=$1::uuid AND "contactId" IS NOT NULL
       UNION SELECT DISTINCT "contactId" FROM leads WHERE "channelId"=$1::uuid AND "contactId" IS NOT NULL
     ), source_contacts AS (
       SELECT c.*, NULLIF(regexp_replace(COALESCE(c."waId",c."whatsappPhone",c.phone,''),'\\D','','g'),'') normalized_phone,
              NULLIF(lower(trim(c.email)),'') normalized_email
       FROM contacts c JOIN affected a ON a.id=c.id
     ), target_contacts AS (
       SELECT c.*, NULLIF(regexp_replace(COALESCE(c."waId",c."whatsappPhone",c.phone,''),'\\D','','g'),'') normalized_phone,
              NULLIF(lower(trim(c.email)),'') normalized_email
       FROM contacts c WHERE c."clinicId"=$2::uuid
     ), collision_map AS (
       SELECT s.id source_id, COUNT(DISTINCT t.id)::int target_matches
       FROM source_contacts s JOIN target_contacts t
         ON (s.normalized_phone IS NOT NULL AND s.normalized_phone=t.normalized_phone)
         OR (s.normalized_email IS NOT NULL AND s.normalized_email=t.normalized_email)
       GROUP BY s.id
     )
     SELECT (SELECT COUNT(*) FROM source_contacts)::int AS "sourceCount",
            (SELECT COUNT(*) FROM target_contacts)::int AS "targetCount",
            (SELECT COUNT(*) FROM collision_map)::int AS "collisionCount",
            (SELECT COUNT(*) FROM collision_map WHERE target_matches>1)::int AS "ambiguousCollisionCount",
            (SELECT COUNT(*) FROM source_contacts s WHERE EXISTS(
              SELECT 1 FROM conversations cv WHERE cv."contactId"=s.id AND cv."channelId"<>$1::uuid
            ))::int AS "sharedWithOtherChannels"`, p);

  const conversations = await one(client,
    `SELECT (SELECT COUNT(*) FROM conversations WHERE "channelId"=$1::uuid)::int AS "sourceCount",
            (SELECT COUNT(*) FROM conversations WHERE "clinicId"=$2::uuid)::int AS "targetCount",
            (SELECT COUNT(*) FROM conversations s JOIN conversations t
              ON t."clinicId"=$2::uuid AND t."deletedAt" IS NULL AND s."deletedAt" IS NULL
             AND t."waFrom"=s."waFrom" AND t."waTo"=s."waTo"
             WHERE s."channelId"=$1::uuid)::int AS "parallelActivePairs"`, p);
  const messages = await one(client,
    `WITH source_conversations AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid)
     SELECT (SELECT COUNT(*) FROM messages WHERE "channelId"=$1::uuid)::int AS "sourceCount",
            (SELECT COUNT(*) FROM messages WHERE "clinicId"=$2::uuid)::int AS "targetCount",
            (SELECT COUNT(*) FROM conversation_messages WHERE "conversationId" IN (SELECT id FROM source_conversations))::int AS "conversationMessageCount",
            (SELECT COUNT(*) FROM messages s JOIN messages t ON t."clinicId"=$2::uuid
              AND s."providerMessageId" IS NOT NULL AND s."providerMessageId"=t."providerMessageId"
             WHERE s."channelId"=$1::uuid)::int AS "providerMessageCollisions",
            (SELECT COUNT(*) FROM conversation_messages s
              JOIN source_conversations sc ON sc.id=s."conversationId"
              JOIN conversation_messages t ON t."waMessageId"=s."waMessageId" AND t."waMessageId" IS NOT NULL
              JOIN conversations tc ON tc.id=t."conversationId" AND tc."clinicId"=$2::uuid)::int AS "waMessageCollisions"`, p);
  const simple = async (table, collisionSql = '0') => one(client,
    `SELECT (SELECT COUNT(*) FROM ${table} WHERE "channelId"=$1::uuid)::int AS "sourceCount",
            (SELECT COUNT(*) FROM ${table} WHERE "clinicId"=$2::uuid)::int AS "targetCount",
            (${collisionSql})::int AS "collisionCount"`, p);
  const leads = await simple('leads');
  const appointments = await simple('appointments', `SELECT COUNT(*) FROM appointments s JOIN appointments t
    ON t."clinicId"=$2::uuid AND s."startAt" IS NOT DISTINCT FROM t."startAt"
   AND NULLIF(regexp_replace(COALESCE(s."waId",''),'\\D','','g'),'')=NULLIF(regexp_replace(COALESCE(t."waId",''),'\\D','','g'),'')
   WHERE s."channelId"=$1::uuid`);
  const alerts = await simple('operational_alert_rules', `SELECT COUNT(*) FROM operational_alert_rules s JOIN operational_alert_rules t
    ON t."clinicId"=$2::uuid AND t."eventType"=s."eventType" AND t."eventVersion"=s."eventVersion" AND t."archivedAt" IS NULL
   WHERE s."channelId"=$1::uuid`);
  const orderNotifications = await simple('order_customer_notifications', `SELECT COUNT(*) FROM order_customer_notifications s JOIN order_customer_notifications t
    ON t."clinicId"=$2::uuid AND t."idempotencyKey"=s."idempotencyKey" WHERE s."channelId"=$1::uuid`);
  const templates = await one(client,
    `SELECT (SELECT COUNT(*) FROM whatsapp_templates WHERE "channelId"=$1::uuid)::int AS "sourceCount",
            (SELECT COUNT(*) FROM whatsapp_templates WHERE "clinicId"=$2::uuid)::int AS "targetCount",
            (SELECT COUNT(*) FROM whatsapp_templates s JOIN whatsapp_templates t
              ON t."clinicId"=$2::uuid AND lower(t."metaTemplateName")=lower(s."metaTemplateName") AND t.language=s.language
             WHERE s."channelId"=$1::uuid)::int AS "semanticCollisions"`, p);
  const jobStatus = await rows(client,
    `SELECT status, COUNT(*)::int AS count FROM jobs WHERE "channelId"=$1::uuid GROUP BY status ORDER BY status`,
    [options.sourceChannelId]);
  const jobs = {
    sourceCount: jobStatus.reduce((sum, item) => sum + Number(item.count), 0),
    targetCount: Number((await one(client, `SELECT COUNT(*)::int AS n FROM jobs WHERE "clinicId"=$1::uuid`, [options.targetClinicId])).n),
    byStatus: jobStatus
  };
  const canary = await simple('whatsapp_template_canary_attempts');
  canary.activeCount = Number((await one(client,
    `SELECT COUNT(*)::int AS n FROM whatsapp_template_canary_attempts
      WHERE "channelId"=$1::uuid AND LOWER(COALESCE(status,'')) IN ('pending','sending','processing')`,
    [options.sourceChannelId])).n);
  const thirdChannelCount = Number((await one(client,
    `SELECT COUNT(*)::int AS n FROM channels WHERE "phoneNumberId"=$1 AND id<>$2::uuid`,
    [source.phoneNumberId, options.sourceChannelId])).n);
  return { contacts, conversations, messages, leads, jobs, templates, appointments, alerts, orderNotifications, canary, thirdChannelCount };
}

async function buildSnapshot(client, options) {
  const source = await channelContext(client, options.sourceChannelId);
  const legacy = await channelContext(client, options.legacyChannelId);
  const target = await one(client,
    `SELECT id AS "clinicId", "externalTenantId" AS "workspaceId",
            COALESCE(settings -> 'portal' ->> 'accountScope', settings ->> 'accountScope', 'client') AS "accountScope"
       FROM clinics WHERE id=$1::uuid`, [options.targetClinicId]);
  return {
    expectedSourceChannelId: options.sourceChannelId,
    expectedSourceClinicId: options.sourceClinicId,
    expectedTargetClinicId: options.targetClinicId,
    expectedLegacyChannelId: options.legacyChannelId,
    source,
    target,
    legacy,
    directDependencies: await dependencyCatalog(client, options.sourceChannelId, options.legacyChannelId),
    transitiveDependencies: await transitiveDependencyCatalog(client, options.sourceChannelId),
    catalog: await catalog(client),
    metrics: await metrics(client, options, source || {})
  };
}

async function executeReadOnly(client, work) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const result = await work();
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

async function run(options = parseOptions()) {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    return await executeReadOnly(client, async () => analyzeConsolidationSnapshot(await buildSnapshot(client, options)));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`READY_FOR_MIGRATION=${report.readyForMigration ? 'true' : 'false'}\n`);
  }).catch((error) => {
    process.stderr.write(`DRY_RUN_FAILED=${String(error.message || error)}${error.code ? ` code=${error.code}` : ''}\n`);
    process.stderr.write('READY_FOR_MIGRATION=false\n');
    process.exitCode = 1;
  });
}

module.exports = { DEFAULTS, STRATEGIES, parseOptions, buildSnapshot, executeReadOnly, run };
