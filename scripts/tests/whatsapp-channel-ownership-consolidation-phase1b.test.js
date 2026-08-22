const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/phase1b_test';
const {
  CLASSIFICATION,
  analyzeWhatsAppOnlySnapshot
} = require('../../src/services/whatsapp-channel-ownership-whatsapp-only.service');
const { extractMetaInboundMessages } = require('../../src/webhooks/meta.webhook');
const { reconcileOrderCustomerNotificationStatuses } = require('../../src/services/order-customer-notification-status.service');
if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = originalDatabaseUrl;

const IDS = Object.freeze({
  sourceChannel: 'source-channel',
  sourceClinic: 'source-clinic',
  targetClinic: 'target-clinic',
  legacyChannel: 'legacy-channel',
  collisionSource: 'source-contact',
  collisionTarget: 'target-contact'
});

const directTables = [
  'appointments', 'channel_onboarding_sessions', 'conversations', 'jobs', 'leads', 'messages',
  'operational_alert_deliveries', 'operational_alert_rules', 'order_customer_notifications',
  'whatsapp_template_canary_attempts', 'whatsapp_templates'
];

const transitiveKeys = [
  'agenda_items:conversationId', 'appointments:conversationId', 'conversation_events:conversationId',
  'conversation_messages:conversationId', 'handoff_requests:conversationId', 'leads:conversationId',
  'messages:conversationId', 'order_customer_notifications:conversationId', 'orders:conversationId',
  'agenda_items:contactId', 'appointments:contactId', 'conversations:contactId', 'handoff_requests:contactId',
  'invoices:contactId', 'leads:contactId', 'order_customer_notifications:contactId', 'orders:contactId',
  'payments:contactId', 'order_customer_notifications:orderId', 'order_items:orderId',
  'operational_alert_rule_recipients:ruleId', 'handoff_requests:leadId'
];

function fixture(overrides = {}) {
  const directDependencies = directTables.map((table) => ({ table, sourceCount: table === 'conversations' ? 2 : 0 }));
  const transitiveDependencies = transitiveKeys.map((key) => {
    const [table, via] = key.split(':');
    return { table, via, sourceCount: 1 };
  });
  const base = {
    source: { id: IDS.sourceChannel, clinicId: IDS.sourceClinic, provider: 'whatsapp_cloud', status: 'active', accountScope: 'opturon_admin', wabaId: 'waba', phoneNumberId: 'phone' },
    target: { clinicId: IDS.targetClinic, accountScope: 'client' },
    legacy: { id: IDS.legacyChannel, clinicId: IDS.targetClinic },
    directDependencies,
    transitiveDependencies,
    metrics: { thirdChannelCount: 0 }
  };
  const policyMetrics = {
    contacts: {
      sourceCount: 2, targetCount: 1, collisionCount: 1, ambiguousCollisionCount: 0,
      collisionSourceId: IDS.collisionSource, collisionTargetId: IDS.collisionTarget,
      cloneCount: 1, existingTargetRelinkCount: 1, keepSourceCount: 2, finalTargetCount: 2,
      sharedWithOtherChannels: 0, unmappedCount: 0
    },
    counts: {}, agenda: {}, providerIdentity: { providerMessageCollisions: 0, wamidCollisions: 0 },
    jobs: { byStatus: [{ status: 'done', count: 2 }], activeLeaseCount: 0 },
    notifications: { sourceCount: 1, byStatus: [{ status: 'read', count: 1 }] },
    orders: { conversationDetachCount: 1 },
    alertRule: { sourceCount: 1, provenSourceCommercialRule: true, activeLeaseCount: 0 },
    schema: {
      orderNotificationChannelNullable: true, orderNotificationConversationNullable: true,
      orderConversationNullable: true, alertRuleChannelNullable: true,
      phoneUniqueConstraintPresent: true, atomicMultiCteRequired: true
    },
    commercial: { tables: [], unexpectedDependencyCount: 0 },
    canary: { activeCount: 0 }, conversations: { parallelActivePairs: 0 }, templates: { collisionCount: 0 }
  };
  return {
    expectedSourceChannelId: IDS.sourceChannel,
    expectedSourceClinicId: IDS.sourceClinic,
    expectedTargetClinicId: IDS.targetClinic,
    expectedLegacyChannelId: IDS.legacyChannel,
    expectedCollisionSourceId: IDS.collisionSource,
    expectedCollisionTargetId: IDS.collisionTarget,
    base: { ...base, ...(overrides.base || {}) },
    policyMetrics: { ...policyMetrics, ...(overrides.policyMetrics || {}) }
  };
}

function expectBlocker(blocker, snapshot) {
  const report = analyzeWhatsAppOnlySnapshot(snapshot);
  assert.strictEqual(report.readyForWhatsAppOnlyMigration, false, blocker);
  assert(report.blockers.includes(blocker), `${blocker} should be reported`);
}

const clean = analyzeWhatsAppOnlySnapshot(fixture());
assert.strictEqual(clean.readyForWhatsAppOnlyMigration, true);
assert.strictEqual(clean.directDependencies.length, 11);
assert.strictEqual(clean.transitiveDependencies.length, 22);
assert.strictEqual(clean.directDependencies.find((item) => item.table === 'jobs').classification, CLASSIFICATION.MOVE);
assert.strictEqual(clean.directDependencies.find((item) => item.table === 'order_customer_notifications').classification, CLASSIFICATION.DETACH);
assert.strictEqual(clean.transitiveDependencies.find((item) => item.table === 'orders' && item.via === 'contactId').classification, CLASSIFICATION.KEEP);
assert.strictEqual(clean.transitiveDependencies.find((item) => item.table === 'orders' && item.via === 'conversationId').classification, CLASSIFICATION.DETACH);

expectBlocker('non_terminal_or_leased_jobs', fixture({
  policyMetrics: { jobs: { byStatus: [{ status: 'queued', count: 1 }], activeLeaseCount: 0 } }
}));
expectBlocker('non_terminal_order_notification', fixture({
  policyMetrics: { notifications: { sourceCount: 1, byStatus: [{ status: 'failed_retryable', count: 1 }] } }
}));
expectBlocker('unexpected_commercial_dependency', fixture({
  policyMetrics: { commercial: { tables: [], unexpectedDependencyCount: 1 } }
}));
expectBlocker('provider_message_id_collision', fixture({
  policyMetrics: { providerIdentity: { providerMessageCollisions: 1, wamidCollisions: 0 } }
}));

async function proveImmediateCompositeFkTransition() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clinics (id text PRIMARY KEY);
    CREATE TABLE channels (
      id text PRIMARY KEY,
      "clinicId" text NOT NULL REFERENCES clinics(id),
      UNIQUE(id, "clinicId")
    );
    CREATE TABLE whatsapp_templates (
      id text PRIMARY KEY,
      "clinicId" text NOT NULL,
      "channelId" text NOT NULL,
      CONSTRAINT template_channel_tenant FOREIGN KEY ("channelId", "clinicId")
        REFERENCES channels(id, "clinicId") NOT DEFERRABLE
    );
    INSERT INTO clinics(id) VALUES ('source'), ('target');
    INSERT INTO channels(id, "clinicId") VALUES ('canonical', 'source');
    INSERT INTO whatsapp_templates(id, "clinicId", "channelId") VALUES ('template', 'source', 'canonical');
  `);
  await db.exec(`
    WITH moved_template AS (
      UPDATE whatsapp_templates SET "clinicId"='target'
       WHERE id='template' RETURNING id
    )
    UPDATE channels SET "clinicId"='target'
     WHERE id='canonical' AND EXISTS (SELECT 1 FROM moved_template);
  `);
  const result = await db.query(`
    SELECT c."clinicId" channel_clinic, t."clinicId" template_clinic
      FROM channels c JOIN whatsapp_templates t ON t."channelId"=c.id
     WHERE c.id='canonical'
  `);
  assert.deepStrictEqual(result.rows[0], { channel_clinic: 'target', template_clinic: 'target' });
  await db.close();
}

function whatsappPayload(phoneNumberId, value) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: phoneNumberId },
      ...value
    } }] }]
  };
}

async function proveWebhookTargetRoutingContract() {
  const targetChannel = { id: IDS.sourceChannel, clinicId: IDS.targetClinic };
  const inbound = extractMetaInboundMessages(whatsappPayload('phone', {
    contacts: [{ wa_id: '5491100000000', profile: { name: 'Contact' } }],
    messages: [{ id: 'wamid.inbound', from: '5491100000000', type: 'text', text: { body: 'hello' } }]
  }));
  assert.strictEqual(inbound.length, 1);
  assert.strictEqual(inbound[0].phoneNumberId, 'phone');

  for (const status of ['sent', 'delivered', 'read', 'failed']) {
    const calls = [];
    const result = await reconcileOrderCustomerNotificationStatuses(whatsappPayload('phone', {
      statuses: [{ id: `wamid.${status}`, status, timestamp: '1700000000' }]
    }), { dependencies: {
      findChannelByPhoneNumberId: async () => targetChannel,
      reconcileStatus: async (input) => { calls.push(input); return { id: 'notification' }; },
      reconcileOperationalStatus: async () => null,
      reconcileCanaryStatus: async () => null,
      aggregateOperationalInstance: async () => null
    } });
    assert.strictEqual(result.matched, 1);
    assert.strictEqual(calls[0].clinicId, IDS.targetClinic);
    assert.strictEqual(calls[0].channelId, IDS.sourceChannel);
  }

  let canaryCalls = 0;
  const templateDelivery = await reconcileOrderCustomerNotificationStatuses(whatsappPayload('phone', {
    statuses: [{ id: 'wamid.template', status: 'delivered', timestamp: '1700000000' }]
  }), { dependencies: {
    findChannelByPhoneNumberId: async () => targetChannel,
    reconcileStatus: async () => null,
    reconcileOperationalStatus: async () => null,
    reconcileCanaryStatus: async (input) => { canaryCalls += 1; assert.strictEqual(input.clinicId, IDS.targetClinic); return { id: 'canary' }; },
    aggregateOperationalInstance: async () => null
  } });
  assert.strictEqual(templateDelivery.canaryMatched, 1);
  assert.strictEqual(canaryCalls, 1);

  const unknown = await reconcileOrderCustomerNotificationStatuses(whatsappPayload('phone', {
    statuses: [{ id: 'wamid.unknown', status: 'read', timestamp: '1700000000' }]
  }), { dependencies: {
    findChannelByPhoneNumberId: async () => targetChannel,
    reconcileStatus: async () => null,
    reconcileOperationalStatus: async () => null,
    reconcileCanaryStatus: async () => null,
    aggregateOperationalInstance: async () => null
  } });
  assert.strictEqual(unknown.matched, 0);
  assert.strictEqual(unknown.ignored, 1);
}

(async () => {
  await proveImmediateCompositeFkTransition();
  await proveWebhookTargetRoutingContract();
  const cli = fs.readFileSync(path.resolve(__dirname, '../ops/whatsapp-channel-ownership-consolidation-phase1b-dry-run.js'), 'utf8');
  assert.match(cli, /Only --mode=DRY_RUN is supported/);
  assert.match(cli, /executeReadOnly/);
  assert.doesNotMatch(cli, /client\.query\(\s*[`'"]\s*(UPDATE|INSERT|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  const tenantRepository = fs.readFileSync(path.resolve(__dirname, '../../src/repositories/tenant.repository.js'), 'utf8');
  assert.match(tenantRepository, /WHERE "phoneNumberId" = \$1[\s\S]*provider = 'whatsapp_cloud'[\s\S]*LOWER\(COALESCE\(status, ''\)\) = 'active'/);
  console.log('whatsapp channel ownership consolidation Phase1B tests: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
