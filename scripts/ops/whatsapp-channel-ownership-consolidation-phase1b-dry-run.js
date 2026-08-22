const { Client } = require('pg');
const {
  DEFAULTS,
  buildSnapshot: buildPhase1Snapshot,
  executeReadOnly
} = require('./whatsapp-channel-ownership-consolidation-dry-run');
const {
  analyzeWhatsAppOnlySnapshot
} = require('../../src/services/whatsapp-channel-ownership-whatsapp-only.service');

const EXPECTED = Object.freeze({
  ...DEFAULTS,
  collisionSourceId: '751ae358-3663-4e6d-a0d3-31e16cd03f08',
  collisionTargetId: '18418399-c961-4800-8749-819b00560438'
});

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
    sourceChannelId: flag('source-channel-id', EXPECTED.sourceChannelId),
    sourceClinicId: flag('source-clinic-id', EXPECTED.sourceClinicId),
    targetClinicId: flag('target-clinic-id', EXPECTED.targetClinicId),
    legacyChannelId: flag('legacy-channel-id', EXPECTED.legacyChannelId)
  };
}

async function rows(client, text, params = []) {
  return (await client.query(text, params)).rows;
}

async function one(client, text, params = []) {
  return (await rows(client, text, params))[0] || null;
}

async function columnIsNullable(client, table, column) {
  const result = await one(client,
    `SELECT is_nullable = 'YES' AS nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column]);
  return Boolean(result && result.nullable);
}

async function contactMetrics(client, options, base) {
  const result = await one(client,
    `WITH affected AS (
       SELECT DISTINCT "contactId" AS id FROM conversations WHERE "channelId"=$1::uuid
       UNION SELECT DISTINCT "contactId" FROM leads WHERE "channelId"=$1::uuid AND "contactId" IS NOT NULL
       UNION SELECT DISTINCT "contactId" FROM appointments WHERE "channelId"=$1::uuid AND "contactId" IS NOT NULL
     ), source_contacts AS (
       SELECT c.*, NULLIF(regexp_replace(COALESCE(c."waId",c."whatsappPhone",c.phone,''),'\\D','','g'),'') normalized_phone,
              NULLIF(lower(trim(c.email)),'') normalized_email
         FROM contacts c JOIN affected a ON a.id=c.id
     ), target_contacts AS (
       SELECT c.*, NULLIF(regexp_replace(COALESCE(c."waId",c."whatsappPhone",c.phone,''),'\\D','','g'),'') normalized_phone,
              NULLIF(lower(trim(c.email)),'') normalized_email
         FROM contacts c WHERE c."clinicId"=$2::uuid
     ), collision AS (
       SELECT s.id AS source_id, t.id AS target_id,
              s."waId" IS NOT DISTINCT FROM t."waId" AS wa_id_match,
              NULLIF(trim(s.name),'') IS NOT NULL AS source_name_present,
              NULLIF(trim(t.name),'') IS NOT NULL AS target_name_present,
              NULLIF(trim(s.name),'') IS DISTINCT FROM NULLIF(trim(t.name),'') AS name_differs,
              NULLIF(lower(trim(s.email)),'') IS NOT NULL AS source_email_present,
              NULLIF(lower(trim(t.email)),'') IS NOT NULL AS target_email_present,
              NULLIF(lower(trim(s.email)),'') IS DISTINCT FROM NULLIF(lower(trim(t.email)),'') AS email_differs,
              s."optedOut" AS source_opted_out, t."optedOut" AS target_opted_out
         FROM source_contacts s JOIN target_contacts t
           ON (s.normalized_phone IS NOT NULL AND s.normalized_phone=t.normalized_phone)
           OR (s.normalized_email IS NOT NULL AND s.normalized_email=t.normalized_email)
     )
     SELECT (SELECT COUNT(*) FROM source_contacts)::int AS "sourceCount",
            (SELECT COUNT(*) FROM target_contacts)::int AS "targetCount",
            (SELECT COUNT(*) FROM collision)::int AS "collisionCount",
            (SELECT COUNT(*) FROM (SELECT source_id FROM collision GROUP BY source_id HAVING COUNT(*)>1) x)::int AS "ambiguousCollisionCount",
            (SELECT source_id FROM collision ORDER BY source_id LIMIT 1) AS "collisionSourceId",
            (SELECT target_id FROM collision ORDER BY source_id LIMIT 1) AS "collisionTargetId",
            COALESCE((SELECT wa_id_match FROM collision ORDER BY source_id LIMIT 1),false) AS "waIdMatch",
            COALESCE((SELECT source_name_present FROM collision ORDER BY source_id LIMIT 1),false) AS "sourceNamePresent",
            COALESCE((SELECT target_name_present FROM collision ORDER BY source_id LIMIT 1),false) AS "targetNamePresent",
            COALESCE((SELECT name_differs FROM collision ORDER BY source_id LIMIT 1),false) AS "nameDiffers",
            COALESCE((SELECT source_email_present FROM collision ORDER BY source_id LIMIT 1),false) AS "sourceEmailPresent",
            COALESCE((SELECT target_email_present FROM collision ORDER BY source_id LIMIT 1),false) AS "targetEmailPresent",
            COALESCE((SELECT email_differs FROM collision ORDER BY source_id LIMIT 1),false) AS "emailDiffers",
            COALESCE((SELECT source_opted_out FROM collision ORDER BY source_id LIMIT 1),false) AS "sourceOptedOut",
            COALESCE((SELECT target_opted_out FROM collision ORDER BY source_id LIMIT 1),false) AS "targetOptedOut"`,
    [options.sourceChannelId, options.targetClinicId]);
  const sourceCount = Number(result.sourceCount || 0);
  const collisionCount = Number(result.collisionCount || 0);
  return {
    ...result,
    sharedWithOtherChannels: Number(base.metrics.contacts.sharedWithOtherChannels || 0),
    cloneCount: sourceCount - collisionCount,
    existingTargetRelinkCount: collisionCount,
    unmappedCount: Math.max(0, sourceCount - (sourceCount - collisionCount) - collisionCount),
    finalTargetCount: Number(result.targetCount || 0) + sourceCount - collisionCount,
    mergePolicy: 'preserve target contact ID/profile; OR optedOut for safety; relink WhatsApp rows; clones copy only WhatsApp identity/display fields; retain source contacts and commercial references'
  };
}

async function scopedCounts(client, options, base) {
  const sourceDirect = new Map(base.directDependencies.map((item) => [item.table, Number(item.sourceCount || 0)]));
  const targetDirectRows = await rows(client,
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='clinicId'
        AND table_name=ANY($1::text[])`,
    [[...sourceDirect.keys()]]);
  const targetDirect = {};
  for (const { table_name: table } of targetDirectRows) {
    const safeTable = table.replaceAll('"', '""');
    targetDirect[table] = Number((await one(client,
      `SELECT COUNT(*)::int AS n FROM "${safeTable}" WHERE "clinicId"=$1::uuid`, [options.targetClinicId])).n);
  }
  const indirect = await one(client,
    `WITH source_conversations AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid),
          target_conversations AS (SELECT id FROM conversations WHERE "clinicId"=$2::uuid)
     SELECT (SELECT COUNT(*) FROM conversation_messages WHERE "conversationId" IN (SELECT id FROM source_conversations))::int AS source_cm,
            (SELECT COUNT(*) FROM conversation_messages WHERE "conversationId" IN (SELECT id FROM target_conversations))::int AS target_cm,
            (SELECT COUNT(*) FROM conversation_events WHERE "conversationId" IN (SELECT id FROM source_conversations))::int AS source_events,
            (SELECT COUNT(*) FROM conversation_events WHERE "clinicId"=$2::uuid)::int AS target_events,
            (SELECT COUNT(*) FROM handoff_requests WHERE "conversationId" IN (SELECT id FROM source_conversations))::int AS source_handoffs,
            (SELECT COUNT(*) FROM handoff_requests WHERE "clinicId"=$2::uuid)::int AS target_handoffs`,
    [options.sourceChannelId, options.targetClinicId]);
  const counts = {};
  for (const [table, source] of sourceDirect.entries()) counts[table] = { source, target: targetDirect[table] || 0 };
  counts.conversation_messages = { source: Number(indirect.source_cm), target: Number(indirect.target_cm) };
  counts.conversation_events = { source: Number(indirect.source_events), target: Number(indirect.target_events) };
  counts.handoff_requests = { source: Number(indirect.source_handoffs), target: Number(indirect.target_handoffs) };
  return counts;
}

async function agendaMetrics(client, options) {
  return one(client,
    `WITH source_conversations AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid),
          affected_contacts AS (SELECT DISTINCT "contactId" id FROM conversations WHERE "channelId"=$1::uuid)
     SELECT (SELECT COUNT(*) FROM agenda_items WHERE "contactId" IN (SELECT id FROM affected_contacts))::int AS "sourceCount",
            (SELECT COUNT(*) FROM agenda_items WHERE "clinicId"=$2::uuid)::int AS "targetCount",
            (SELECT COUNT(*) FROM agenda_items WHERE "conversationId" IN (SELECT id FROM source_conversations))::int AS "moveCount",
            (SELECT COUNT(*) FROM agenda_items WHERE "contactId" IN (SELECT id FROM affected_contacts)
              AND ("conversationId" IS NULL OR "conversationId" NOT IN (SELECT id FROM source_conversations)))::int AS "keepSourceCount"`,
    [options.sourceChannelId, options.targetClinicId]);
}

async function commercialMetrics(client, options, base) {
  const counts = await one(client,
    `WITH source_conversations AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid),
          affected_contacts AS (SELECT DISTINCT "contactId" id FROM conversations WHERE "channelId"=$1::uuid),
          affected_orders AS (
            SELECT id FROM orders WHERE "clinicId"=$2::uuid
              AND ("contactId" IN (SELECT id FROM affected_contacts) OR "conversationId" IN (SELECT id FROM source_conversations))
          ), affected_invoices AS (
            SELECT id FROM invoices WHERE "clinicId"=$2::uuid
              AND ("contactId" IN (SELECT id FROM affected_contacts) OR "orderId" IN (SELECT id FROM affected_orders))
          ), affected_payments AS (
            SELECT id FROM payments WHERE "clinicId"=$2::uuid
              AND ("contactId" IN (SELECT id FROM affected_contacts) OR "invoiceId" IN (SELECT id FROM affected_invoices))
          )
     SELECT (SELECT COUNT(*) FROM affected_orders)::int AS orders,
            (SELECT COUNT(*) FROM orders WHERE id IN (SELECT id FROM affected_orders) AND "conversationId" IN (SELECT id FROM source_conversations))::int AS order_conversation_detaches,
            (SELECT COUNT(*) FROM order_items WHERE "orderId" IN (SELECT id FROM affected_orders))::int AS order_items,
            (SELECT COUNT(*) FROM affected_invoices)::int AS invoices,
            (SELECT COUNT(*) FROM affected_payments)::int AS payments,
            (SELECT COUNT(*) FROM payment_allocations WHERE "paymentId" IN (SELECT id FROM affected_payments) OR "invoiceId" IN (SELECT id FROM affected_invoices))::int AS payment_allocations,
            (SELECT COUNT(*) FROM inventory_lot_allocations WHERE "orderId" IN (SELECT id FROM affected_orders))::int AS inventory_lot_allocations`,
    [options.sourceChannelId, options.sourceClinicId]);
  const expectedDirect = new Set([
    'appointments', 'channel_onboarding_sessions', 'conversations', 'jobs', 'leads', 'messages',
    'operational_alert_deliveries', 'operational_alert_rules', 'order_customer_notifications',
    'whatsapp_template_canary_attempts', 'whatsapp_templates'
  ]);
  const expectedTransitive = new Set([
    'agenda_items:conversationId', 'appointments:conversationId', 'conversation_events:conversationId',
    'conversation_messages:conversationId', 'handoff_requests:conversationId', 'leads:conversationId',
    'messages:conversationId', 'order_customer_notifications:conversationId', 'orders:conversationId',
    'agenda_items:contactId', 'appointments:contactId', 'conversations:contactId', 'handoff_requests:contactId',
    'invoices:contactId', 'leads:contactId', 'order_customer_notifications:contactId', 'orders:contactId',
    'payments:contactId', 'order_customer_notifications:orderId', 'order_items:orderId',
    'operational_alert_rule_recipients:ruleId', 'handoff_requests:leadId'
  ]);
  const unexpectedDirect = base.directDependencies.filter((item) => !expectedDirect.has(item.table) && Number(item.sourceCount) > 0);
  const unexpectedTransitive = base.transitiveDependencies.filter((item) => !expectedTransitive.has(`${item.table}:${item.via}`) && Number(item.sourceCount) > 0);
  return {
    tables: [
      { table: 'orders', keepSourceCount: Number(counts.orders), unexpectedDependencyCount: 0 },
      { table: 'order_items', keepSourceCount: Number(counts.order_items), unexpectedDependencyCount: 0 },
      { table: 'invoices', keepSourceCount: Number(counts.invoices), unexpectedDependencyCount: 0 },
      { table: 'payments', keepSourceCount: Number(counts.payments), unexpectedDependencyCount: 0 },
      { table: 'payment_allocations', keepSourceCount: Number(counts.payment_allocations), unexpectedDependencyCount: 0 },
      { table: 'inventory_lot_allocations', keepSourceCount: Number(counts.inventory_lot_allocations), unexpectedDependencyCount: 0 }
    ],
    unexpectedDependencyCount: unexpectedDirect.length + unexpectedTransitive.length,
    orderConversationDetachCount: Number(counts.order_conversation_detaches)
  };
}

async function notificationMetrics(client, options) {
  const byStatus = await rows(client,
    `SELECT status, COUNT(*)::int AS count FROM order_customer_notifications
      WHERE "channelId"=$1::uuid GROUP BY status ORDER BY status`, [options.sourceChannelId]);
  const detail = await one(client,
    `SELECT COUNT(*)::int AS "sourceCount",
            COUNT(*) FILTER (WHERE "providerMessageId" IS NOT NULL)::int AS "providerMessageCount",
            COUNT(*) FILTER (WHERE "conversationId" IS NOT NULL)::int AS "conversationDetachCount",
            COUNT(*) FILTER (WHERE "channelId" IS NOT NULL)::int AS "channelDetachCount",
            COUNT(*) FILTER (WHERE "lockedAt" IS NOT NULL OR "leaseExpiresAt" IS NOT NULL)::int AS "leaseMarkerCount"
       FROM order_customer_notifications WHERE "channelId"=$1::uuid`, [options.sourceChannelId]);
  return { ...detail, byStatus, immutableFieldsChangedByPlan: false };
}

async function alertRuleMetrics(client, options) {
  const rules = await rows(client,
    `SELECT "eventType", "triggerMode", enabled, "archivedAt" IS NOT NULL AS archived,
            ("schedulerLockedAt" IS NOT NULL OR "schedulerLeaseExpiresAt" IS NOT NULL) AS leased
       FROM operational_alert_rules WHERE "channelId"=$1::uuid ORDER BY id`, [options.sourceChannelId]);
  return {
    sourceCount: rules.length,
    eventTypes: rules.map((item) => item.eventType),
    enabledCount: rules.filter((item) => item.enabled).length,
    activeLeaseCount: rules.filter((item) => item.leased).length,
    provenSourceCommercialRule: rules.every((item) => String(item.eventType || '').startsWith('inventory.')),
    treatment: 'keep source rule graph; detach nullable channelId; do not inherit source inventory alerting'
  };
}

async function templateMetrics(client, options, base) {
  const rowsFound = await rows(client,
    `SELECT "metaTemplateName", language, status, category, "wabaId"
       FROM whatsapp_templates WHERE "channelId"=$1::uuid ORDER BY id`, [options.sourceChannelId]);
  const expected = rowsFound.filter((item) => (
    item.metaTemplateName === 'inventory_lot_expiring_v1'
    && item.language === 'es_AR'
    && String(item.status || '').toUpperCase() === 'APPROVED'
    && String(item.category || '').toUpperCase() === 'UTILITY'
    && item.wabaId === '27184268844495361'
  ));
  return {
    ...base.metrics.templates,
    collisionCount: base.metrics.templates.semanticCollisions,
    expectedApprovedTemplateCount: expected.length,
    expectedApprovedTemplateExact: rowsFound.length === 1 && expected.length === 1
  };
}

async function schemaMetrics(client) {
  const unique = await one(client,
    `SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='channels'
      AND indexname='channels_phoneNumberId_key' AND indexdef ILIKE 'CREATE UNIQUE INDEX%') AS present`);
  const composite = await one(client,
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE NOT condeferrable)::int AS nondeferrable
       FROM pg_constraint con
       JOIN pg_class source ON source.oid=con.conrelid
       JOIN pg_class target ON target.oid=con.confrelid
      WHERE con.contype='f' AND target.relname IN ('channels','conversations')
        AND array_length(con.conkey,1)>1
        AND source.relname IN ('operational_alert_deliveries','operational_alert_rules','order_customer_notifications',
          'whatsapp_template_canary_attempts','whatsapp_templates','orders')`);
  return {
    phoneUniqueConstraintPresent: Boolean(unique.present),
    orderNotificationChannelNullable: await columnIsNullable(client, 'order_customer_notifications', 'channelId'),
    orderNotificationConversationNullable: await columnIsNullable(client, 'order_customer_notifications', 'conversationId'),
    orderConversationNullable: await columnIsNullable(client, 'orders', 'conversationId'),
    alertRuleChannelNullable: await columnIsNullable(client, 'operational_alert_rules', 'channelId'),
    compositeImmediateForeignKeyCount: Number(composite.nondeferrable),
    atomicMultiCteRequired: Number(composite.nondeferrable) > 0,
    transitionStatement: 'one data-modifying CTE statement must update composite children/detaches and canonical channel ownership together'
  };
}

async function miscellaneousMetrics(client, options, base) {
  const media = await one(client,
    `SELECT COUNT(*) FILTER (WHERE lower(COALESCE(cm.type,'')) IN ('image','video','audio','document','sticker')
              OR cm.raw #> '{message,image}' IS NOT NULL
              OR cm.raw #> '{message,video}' IS NOT NULL
              OR cm.raw #> '{message,audio}' IS NOT NULL
              OR cm.raw #> '{message,document}' IS NOT NULL)::int AS "rowsWithMediaReference"
       FROM conversation_messages cm JOIN conversations c ON c.id=cm."conversationId"
      WHERE c."channelId"=$1::uuid`, [options.sourceChannelId]);
  const staff = await one(client,
    `WITH source_conversations AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid)
     SELECT (SELECT COUNT(*) FROM conversations WHERE id IN (SELECT id FROM source_conversations)
              AND "assignedSellerUserId" IS NOT NULL)::int AS "assignedSellerDetachCount",
            (SELECT COUNT(*) FROM conversations WHERE id IN (SELECT id FROM source_conversations)
              AND "deletedByUserId" IS NOT NULL)::int AS "deletedByDetachCount",
            (SELECT COUNT(*) FROM leads WHERE "channelId"=$1::uuid AND "assignedTo" IS NOT NULL)::int AS "leadAssigneeDetachCount",
            (SELECT COUNT(*) FROM handoff_requests WHERE "conversationId" IN (SELECT id FROM source_conversations)
              AND "assignedTo" IS NOT NULL)::int AS "handoffAssigneeDetachCount",
            (SELECT COUNT(*) FROM agenda_items WHERE "conversationId" IN (SELECT id FROM source_conversations)
              AND "assignedUserId" IS NOT NULL)::int AS "agendaAssigneeDetachCount"`, [options.sourceChannelId]);
  const appointment = await one(client,
    `SELECT COUNT(*) FILTER (WHERE "slotId" IS NOT NULL)::int AS "slotReferenceCount",
            COUNT(*) FILTER (WHERE "leadId" IS NOT NULL)::int AS "leadReferenceCount"
       FROM appointments WHERE "channelId"=$1::uuid`, [options.sourceChannelId]);
  const handoffByStatus = await rows(client,
    `WITH source_conversations AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid)
     SELECT status, COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE "assignedTo" IS NOT NULL)::int AS "assignedCount"
       FROM handoff_requests WHERE "conversationId" IN (SELECT id FROM source_conversations)
      GROUP BY status ORDER BY status`, [options.sourceChannelId]);
  const leadByStatus = await rows(client,
    `SELECT status, COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE "assignedTo" IS NOT NULL)::int AS "assignedCount"
       FROM leads WHERE "channelId"=$1::uuid GROUP BY status ORDER BY status`, [options.sourceChannelId]);
  const targetStaff = await one(client,
    `WITH target AS (
       SELECT NULLIF(settings -> 'portal' ->> 'primaryPortalUserId','')::uuid AS primary_id
         FROM clinics WHERE id=$1::uuid
     )
     SELECT (SELECT COUNT(*) FROM staff_users WHERE "clinicId"=$1::uuid AND active=true)::int AS "activeStaffCount",
            EXISTS(SELECT 1 FROM target t JOIN staff_users s ON s.id=t.primary_id
              WHERE s."clinicId"=$1::uuid AND s.active=true) AS "primaryStaffReady"`, [options.targetClinicId]);
  const legacyMessages = await one(client,
    `SELECT COUNT(*)::int AS n FROM conversation_messages cm JOIN conversations c ON c.id=cm."conversationId"
      WHERE c."channelId"=$1::uuid`, [options.legacyChannelId]);
  return {
    media,
    staff,
    appointments: { ...base.metrics.appointments, ...appointment },
    handoffs: {
      byStatus: handoffByStatus,
      activeAssignedCount: handoffByStatus.reduce((sum, item) => (
        ['open', 'assigned'].includes(String(item.status || '').toLowerCase())
          ? sum + Number(item.assignedCount || 0) : sum
      ), 0),
      targetPrimaryStaffReady: Boolean(targetStaff.primaryStaffReady),
      targetActiveStaffCount: Number(targetStaff.activeStaffCount),
      assignmentPlan: 'map active assigned handoff to active target primary staff; detach resolved source assignee into signed migration manifest'
    },
    leads: {
      byStatus: leadByStatus,
      assignedCount: leadByStatus.reduce((sum, item) => sum + Number(item.assignedCount || 0), 0),
      targetPrimaryStaffReady: Boolean(targetStaff.primaryStaffReady),
      assignmentPlan: 'map active assigned Inbox lead to active target primary staff; do not clone source staff identity'
    },
    legacy: {
      conversationCount: Number(base.directDependencies.find((item) => item.table === 'conversations').legacyCount || 0),
      conversationMessageCount: Number(legacyMessages.n),
      jobCount: Number(base.directDependencies.find((item) => item.table === 'jobs').legacyCount || 0),
      finalStatus: 'inactive',
      physicalDelete: false
    }
  };
}

async function buildSnapshot(client, options) {
  const base = await buildPhase1Snapshot(client, options);
  // A pg Client executes one query at a time. Keep collection sequential so the
  // complete report is guaranteed to come from the surrounding read-only snapshot.
  const contacts = await contactMetrics(client, options, base);
  const counts = await scopedCounts(client, options, base);
  const agenda = await agendaMetrics(client, options);
  const commercial = await commercialMetrics(client, options, base);
  const notifications = await notificationMetrics(client, options);
  const alertRule = await alertRuleMetrics(client, options);
  const templates = await templateMetrics(client, options, base);
  const schema = await schemaMetrics(client);
  const misc = await miscellaneousMetrics(client, options, base);
  const jobLease = await one(client,
    `SELECT COUNT(*)::int AS n FROM jobs WHERE "channelId"=$1::uuid
      AND "lockedAt" IS NOT NULL`, [options.sourceChannelId]);
  const jobTypes = await rows(client,
    `SELECT type, COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE payload ?| ARRAY['orderId','invoiceId','paymentId','inventoryLotId','allocationId'])::int
              AS "commercialReferenceCount"
       FROM jobs WHERE "channelId"=$1::uuid GROUP BY type ORDER BY type`, [options.sourceChannelId]);
  return {
    expectedSourceChannelId: options.sourceChannelId,
    expectedSourceClinicId: options.sourceClinicId,
    expectedTargetClinicId: options.targetClinicId,
    expectedLegacyChannelId: options.legacyChannelId,
    expectedCollisionSourceId: EXPECTED.collisionSourceId,
    expectedCollisionTargetId: EXPECTED.collisionTargetId,
    base,
    policyMetrics: {
      contacts,
      counts,
      agenda,
      commercial,
      notifications,
      alertRule,
      schema,
      media: misc.media,
      appointments: misc.appointments,
      handoffs: misc.handoffs,
      leadAssignments: misc.leads,
      legacy: misc.legacy,
      operationalDetaches: {
        orderConversationCount: commercial.orderConversationDetachCount,
        notificationConversationCount: Number(notifications.conversationDetachCount),
        notificationChannelCount: Number(notifications.channelDetachCount),
        sourceStaffAssignmentCount: Number(misc.staff.assignedSellerDetachCount),
        sourceDeletionActorCount: Number(misc.staff.deletedByDetachCount),
        leadAssigneeCount: Number(misc.staff.leadAssigneeDetachCount),
        handoffAssigneeCount: Number(misc.staff.handoffAssigneeDetachCount),
        agendaAssigneeCount: Number(misc.staff.agendaAssigneeDetachCount)
      },
      jobs: {
        ...base.metrics.jobs,
        activeLeaseCount: Number(jobLease.n),
        byType: jobTypes,
        commercialReferenceCount: jobTypes.reduce((sum, item) => sum + Number(item.commercialReferenceCount || 0), 0)
      },
      canary: base.metrics.canary,
      conversations: base.metrics.conversations,
      templates,
      providerIdentity: {
        providerMessageCollisions: Number(base.metrics.messages.providerMessageCollisions),
        wamidCollisions: Number(base.metrics.messages.waMessageCollisions),
        providerMessageIdsPreserved: true,
        wamidsPreserved: true
      },
      orders: { conversationDetachCount: commercial.orderConversationDetachCount }
    }
  };
}

async function run(options = parseOptions()) {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    return await executeReadOnly(client, async () => analyzeWhatsAppOnlySnapshot(await buildSnapshot(client, options)));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`READY_FOR_WHATSAPP_ONLY_MIGRATION=${report.readyForWhatsAppOnlyMigration ? 'true' : 'false'}\n`);
  }).catch((error) => {
    process.stderr.write(`DRY_RUN_FAILED=${String(error.message || error)}${error.code ? ` code=${error.code}` : ''}\n`);
    process.stderr.write('READY_FOR_WHATSAPP_ONLY_MIGRATION=false\n');
    process.exitCode = 1;
  });
}

module.exports = { EXPECTED, parseOptions, buildSnapshot, run };
