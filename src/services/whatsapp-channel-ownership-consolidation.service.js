const ACTIVE_JOB_STATUSES = new Set(['pending', 'queued', 'running', 'processing', 'sending', 'retry', 'failed_retryable']);

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumStatuses(rows, statuses) {
  return (rows || []).reduce((total, row) => (
    statuses.has(String(row.status || '').trim().toLowerCase()) ? total + number(row.count) : total
  ), 0);
}

function buildDomain(name, sourceCount, targetCount, collisionCount, strategy, extra = {}) {
  return {
    name,
    sourceCount: number(sourceCount),
    targetCount: number(targetCount),
    collisionCount: number(collisionCount),
    strategy,
    ...extra
  };
}

function analyzeConsolidationSnapshot(snapshot) {
  const blockers = [];
  const source = snapshot.source || {};
  const target = snapshot.target || {};
  const legacy = snapshot.legacy || {};
  const metrics = snapshot.metrics || {};

  if (source.id !== snapshot.expectedSourceChannelId) blockers.push('source_channel_mismatch');
  if (source.clinicId !== snapshot.expectedSourceClinicId) blockers.push('source_clinic_mismatch');
  if (target.clinicId !== snapshot.expectedTargetClinicId) blockers.push('target_clinic_mismatch');
  if (legacy.id !== snapshot.expectedLegacyChannelId) blockers.push('legacy_channel_mismatch');
  if (source.provider !== 'whatsapp_cloud' || String(source.status || '').toLowerCase() !== 'active') {
    blockers.push('source_channel_not_active_whatsapp');
  }
  if (source.accountScope !== 'opturon_admin') blockers.push('source_not_internal_admin_workspace');
  if (target.accountScope !== 'client') blockers.push('target_not_client_workspace');
  if (number(metrics.thirdChannelCount) > 0) blockers.push('third_tenant_phone_number_conflict');

  const contact = metrics.contacts || {};
  if (number(contact.ambiguousCollisionCount) > 0) blockers.push('ambiguous_contact_collision');
  if (number(contact.sharedWithOtherChannels) > 0) blockers.push('source_contact_shared_with_non_migrating_channel');

  const conversations = metrics.conversations || {};
  if (number(conversations.parallelActivePairs) > 0) blockers.push('parallel_active_conversation_collision');

  const messages = metrics.messages || {};
  if (number(messages.providerMessageCollisions) > 0) blockers.push('provider_message_id_collision');
  if (number(messages.waMessageCollisions) > 0) blockers.push('wamid_collision');

  const templates = metrics.templates || {};
  if (number(templates.semanticCollisions) > 0) blockers.push('template_definition_review_required');

  const jobs = metrics.jobs || {};
  const activeJobCount = sumStatuses(jobs.byStatus, ACTIVE_JOB_STATUSES);
  if (activeJobCount > 0) blockers.push('active_jobs_require_quiescence');

  const canary = metrics.canary || {};
  if (number(canary.activeCount) > 0) blockers.push('active_canary_attempts_require_quiescence');
  if (number(metrics.orderNotifications?.sourceCount) > 0) {
    blockers.push('immutable_order_notification_tenant_identity_requires_strategy');
  }

  const unknownDependencies = (snapshot.directDependencies || [])
    .filter((item) => number(item.sourceCount) > 0 && item.strategy === 'unclassified')
    .map((item) => item.table);
  if (unknownDependencies.length > 0) blockers.push(`unclassified_channel_dependencies:${unknownDependencies.join(',')}`);
  const unresolvedTransitive = [...new Set((snapshot.transitiveDependencies || [])
    .filter((item) => number(item.sourceCount) > 0 && item.requiresDecision)
    .map((item) => item.table))];
  if (unresolvedTransitive.length > 0) {
    blockers.push(`unresolved_transitive_business_dependencies:${unresolvedTransitive.join(',')}`);
  }

  const domains = [
    buildDomain('contacts', contact.sourceCount, contact.targetCount, contact.collisionCount,
      number(contact.collisionCount) ? 'merge_unique_identity_into_existing_target_contact' : 'move_contact_ownership'),
    buildDomain('conversations', conversations.sourceCount, conversations.targetCount, conversations.parallelActivePairs,
      'preserve_conversation_id_and_source_channel_id; update clinic ownership after contact mapping'),
    buildDomain('messages', messages.sourceCount, messages.targetCount, messages.providerMessageCollisions,
      'preserve ids/providerMessageId; update clinicId; conversation_messages follow conversationId', {
        conversationMessageCount: number(messages.conversationMessageCount),
        waMessageCollisions: number(messages.waMessageCollisions)
      }),
    buildDomain('leads', metrics.leads?.sourceCount, metrics.leads?.targetCount, metrics.leads?.collisionCount,
      'preserve lead id; update clinicId with conversation/contact mapping'),
    buildDomain('jobs', jobs.sourceCount, jobs.targetCount, activeJobCount,
      'preserve terminal history; require zero runnable/leased jobs before migration', { byStatus: jobs.byStatus || [] }),
    buildDomain('templates', templates.sourceCount, templates.targetCount, templates.semanticCollisions,
      'preserve source channel/WABA scope; review only semantic name-language duplicates'),
    buildDomain('appointments', metrics.appointments?.sourceCount, metrics.appointments?.targetCount,
      metrics.appointments?.collisionCount, 'preserve appointment id; migrate referenced conversation/contact/lead and validate slot ownership'),
    buildDomain('operational_alerts', metrics.alerts?.sourceCount, metrics.alerts?.targetCount,
      metrics.alerts?.collisionCount, 'move rule graph atomically; merge recipient only on exact normalized phone identity'),
    buildDomain('order_notifications', metrics.orderNotifications?.sourceCount, metrics.orderNotifications?.targetCount,
      metrics.orderNotifications?.collisionCount, 'migrate notification with its referenced order closure; preserve idempotency key'),
    buildDomain('canary', canary.sourceCount, canary.targetCount, canary.collisionCount,
      'preserve attempts and provider message ids; require no active attempt')
  ];

  return {
    mode: 'DRY_RUN',
    source,
    target,
    legacy,
    directDependencies: snapshot.directDependencies || [],
    transitiveDependencies: snapshot.transitiveDependencies || [],
    catalog: snapshot.catalog || {},
    domains,
    blockers,
    readyForMigration: blockers.length === 0,
    expectedFinal: {
      canonicalChannelId: source.id || null,
      canonicalClinicId: target.clinicId || null,
      canonicalPhoneNumberId: source.phoneNumberId || null,
      canonicalWabaId: source.wabaId || null,
      legacyChannelId: legacy.id || null,
      legacyStatus: 'inactive',
      sourceChannelIdPreserved: true,
      credentialsChanged: false
    }
  };
}

module.exports = {
  ACTIVE_JOB_STATUSES,
  analyzeConsolidationSnapshot
};
