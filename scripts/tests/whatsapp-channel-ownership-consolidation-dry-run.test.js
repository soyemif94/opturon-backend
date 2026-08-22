const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyzeConsolidationSnapshot } = require('../../src/services/whatsapp-channel-ownership-consolidation.service');
const { executeReadOnly } = require('../ops/whatsapp-channel-ownership-consolidation-dry-run');

const IDS = Object.freeze({
  sourceChannel: 'source-channel',
  sourceClinic: 'source-clinic',
  targetClinic: 'target-clinic',
  legacyChannel: 'legacy-channel'
});

function fixture(overrides = {}) {
  const base = {
    expectedSourceChannelId: IDS.sourceChannel,
    expectedSourceClinicId: IDS.sourceClinic,
    expectedTargetClinicId: IDS.targetClinic,
    expectedLegacyChannelId: IDS.legacyChannel,
    source: { id: IDS.sourceChannel, clinicId: IDS.sourceClinic, provider: 'whatsapp_cloud', status: 'active', accountScope: 'opturon_admin', phoneNumberId: 'phone-real', wabaId: 'waba-real' },
    target: { clinicId: IDS.targetClinic, accountScope: 'client' },
    legacy: { id: IDS.legacyChannel, clinicId: IDS.targetClinic, status: 'active' },
    directDependencies: [{ table: 'conversations', sourceCount: 2, legacyCount: 1, strategy: 'move_clinic_preserve_channel_and_contact_mapping' }],
    transitiveDependencies: [{ table: 'conversation_messages', via: 'conversationId', sourceCount: 3, hasClinicId: false, strategy: 'preserve_parent_fk_no_direct_tenant_column' }],
    catalog: { foreignKeys: [], uniqueIndexes: [], triggers: [] },
    metrics: {
      thirdChannelCount: 0,
      contacts: { sourceCount: 2, targetCount: 0, collisionCount: 0, ambiguousCollisionCount: 0, sharedWithOtherChannels: 0 },
      conversations: { sourceCount: 2, targetCount: 1, parallelActivePairs: 0 },
      messages: { sourceCount: 2, targetCount: 0, conversationMessageCount: 3, providerMessageCollisions: 0, waMessageCollisions: 0 },
      leads: { sourceCount: 1, targetCount: 0, collisionCount: 0 },
      jobs: { sourceCount: 1, targetCount: 0, byStatus: [{ status: 'done', count: 1 }] },
      templates: { sourceCount: 1, targetCount: 0, semanticCollisions: 0 },
      appointments: { sourceCount: 1, targetCount: 0, collisionCount: 0 },
      alerts: { sourceCount: 1, targetCount: 0, collisionCount: 0 },
      orderNotifications: { sourceCount: 0, targetCount: 0, collisionCount: 0 },
      canary: { sourceCount: 0, targetCount: 0, collisionCount: 0, activeCount: 0 }
    }
  };
  return { ...base, ...overrides, metrics: { ...base.metrics, ...(overrides.metrics || {}) } };
}

function expectBlocker(name, snapshot) {
  const report = analyzeConsolidationSnapshot(snapshot);
  assert.strictEqual(report.readyForMigration, false, name);
  assert(report.blockers.includes(name), `${name} should be reported`);
}

const clean = analyzeConsolidationSnapshot(fixture());
assert.strictEqual(clean.readyForMigration, true, 'no-collision fixture should be ready');

const duplicateContact = analyzeConsolidationSnapshot(fixture({ metrics: { contacts: { sourceCount: 2, targetCount: 1, collisionCount: 1, ambiguousCollisionCount: 0, sharedWithOtherChannels: 0 } } }));
assert.strictEqual(duplicateContact.readyForMigration, true, 'one exact contact match has a deterministic merge strategy');
assert.strictEqual(duplicateContact.domains.find((item) => item.name === 'contacts').strategy, 'merge_unique_identity_into_existing_target_contact');

expectBlocker('ambiguous_contact_collision', fixture({ metrics: { contacts: { sourceCount: 2, targetCount: 2, collisionCount: 1, ambiguousCollisionCount: 1, sharedWithOtherChannels: 0 } } }));
expectBlocker('parallel_active_conversation_collision', fixture({ metrics: { conversations: { sourceCount: 2, targetCount: 2, parallelActivePairs: 1 } } }));
expectBlocker('provider_message_id_collision', fixture({ metrics: { messages: { sourceCount: 2, targetCount: 1, conversationMessageCount: 3, providerMessageCollisions: 1, waMessageCollisions: 0 } } }));
expectBlocker('wamid_collision', fixture({ metrics: { messages: { sourceCount: 2, targetCount: 1, conversationMessageCount: 3, providerMessageCollisions: 0, waMessageCollisions: 1 } } }));
expectBlocker('template_definition_review_required', fixture({ metrics: { templates: { sourceCount: 1, targetCount: 1, semanticCollisions: 1 } } }));
expectBlocker('active_jobs_require_quiescence', fixture({ metrics: { jobs: { sourceCount: 2, targetCount: 0, byStatus: [{ status: 'done', count: 1 }, { status: 'pending', count: 1 }] } } }));
expectBlocker('third_tenant_phone_number_conflict', fixture({ metrics: { thirdChannelCount: 1 } }));
expectBlocker('immutable_order_notification_tenant_identity_requires_strategy', fixture({
  metrics: { orderNotifications: { sourceCount: 1, targetCount: 0, collisionCount: 0 } }
}));

const businessClosure = analyzeConsolidationSnapshot(fixture({
  transitiveDependencies: [{ table: 'orders', via: 'conversationId', sourceCount: 1, requiresDecision: true }]
}));
assert.strictEqual(businessClosure.readyForMigration, false);
assert(businessClosure.blockers.includes('unresolved_transitive_business_dependencies:orders'));

const duplicateLead = analyzeConsolidationSnapshot(fixture({ metrics: { leads: { sourceCount: 2, targetCount: 1, collisionCount: 1 } } }));
assert.strictEqual(duplicateLead.domains.find((item) => item.name === 'leads').strategy, 'preserve lead id; update clinicId with conversation/contact mapping');

const inactiveLegacy = analyzeConsolidationSnapshot(fixture({
  legacy: { id: IDS.legacyChannel, clinicId: IDS.targetClinic, status: 'inactive' }
}));
assert.strictEqual(inactiveLegacy.readyForMigration, true, 'an already inactive legacy channel is idempotently acceptable');

const first = analyzeConsolidationSnapshot(fixture());
const second = analyzeConsolidationSnapshot(fixture());
assert.deepStrictEqual(first, second, 'dry-run analysis must be idempotent');

(async () => {
  const calls = [];
  const fakeClient = { query: async (sql) => { calls.push(sql); return { rows: [] }; } };
  await assert.rejects(() => executeReadOnly(fakeClient, async () => { throw new Error('fixture failure'); }), /fixture failure/);
  assert.match(calls[0], /READ ONLY/);
  assert.strictEqual(calls.at(-1), 'ROLLBACK', 'failure must rollback');

  const cli = fs.readFileSync(path.resolve(__dirname, '../ops/whatsapp-channel-ownership-consolidation-dry-run.js'), 'utf8');
  assert.match(cli, /Only --mode=DRY_RUN is supported/);
  assert.doesNotMatch(cli, /client\.query\(\s*[`'"]\s*(UPDATE|INSERT|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  console.log('whatsapp channel ownership consolidation dry-run tests: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
