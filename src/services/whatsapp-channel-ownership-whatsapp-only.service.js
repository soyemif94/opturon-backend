const CLASSIFICATION = Object.freeze({
  MOVE: 'A_MOVE_RELINK',
  CLONE: 'B_CLONE',
  KEEP: 'C_KEEP_SOURCE',
  DETACH: 'D_DETACH_HISTORICAL_REFERENCE',
  BLOCKER: 'E_BLOCKER'
});

const TERMINAL_JOB_STATUSES = new Set(['done', 'failed', 'completed', 'cancelled', 'canceled', 'dead']);
const TERMINAL_NOTIFICATION_STATUSES = new Set([
  'sent', 'delivered', 'read', 'failed_permanent', 'unknown_delivery', 'skipped_no_contact'
]);

const DIRECT_POLICY = Object.freeze({
  appointments: [CLASSIFICATION.MOVE, 'Relink the WhatsApp-derived appointment and its target contact mapping.'],
  channel_onboarding_sessions: [CLASSIFICATION.MOVE, 'Relink non-secret onboarding metadata when present.'],
  conversations: [CLASSIFICATION.MOVE, 'Preserve conversation IDs and relink tenant/contact ownership.'],
  jobs: [CLASSIFICATION.MOVE, 'Relink terminal WhatsApp audit jobs; never change status or reactivate them.'],
  leads: [CLASSIFICATION.MOVE, 'Relink the Inbox lead graph required by conversations and handoffs.'],
  messages: [CLASSIFICATION.MOVE, 'Preserve IDs and providerMessageId while relinking tenant ownership.'],
  operational_alert_deliveries: [CLASSIFICATION.DETACH, 'Keep source commercial-alert history outside target routing.'],
  operational_alert_rules: [CLASSIFICATION.DETACH, 'Keep the source inventory rule and detach its nullable channel reference.'],
  order_customer_notifications: [CLASSIFICATION.DETACH, 'Keep immutable commercial history and detach nullable routing references.'],
  whatsapp_template_canary_attempts: [CLASSIFICATION.MOVE, 'Relink completed WhatsApp canary history when present.'],
  whatsapp_templates: [CLASSIFICATION.MOVE, 'Preserve the approved template ID and relink its channel/WABA scope.']
});

const TRANSITIVE_POLICY = Object.freeze({
  'agenda_items:conversationId': [CLASSIFICATION.MOVE, 'Move rows attached to a migrated conversation; contact-only rows remain source.'],
  'appointments:conversationId': [CLASSIFICATION.MOVE, 'Follows the migrated conversation.'],
  'conversation_events:conversationId': [CLASSIFICATION.MOVE, 'Preserve the event IDs and relink clinic ownership.'],
  'conversation_messages:conversationId': [CLASSIFICATION.MOVE, 'No tenant column; follows the preserved conversation ID.'],
  'handoff_requests:conversationId': [CLASSIFICATION.MOVE, 'Relink the Inbox handoff graph.'],
  'leads:conversationId': [CLASSIFICATION.MOVE, 'Relink the Inbox lead graph.'],
  'messages:conversationId': [CLASSIFICATION.MOVE, 'Relink tenant/channel while preserving provider identity.'],
  'order_customer_notifications:conversationId': [CLASSIFICATION.DETACH, 'Set the nullable historical conversation reference to NULL.'],
  'orders:conversationId': [CLASSIFICATION.DETACH, 'Keep orders source and set only the nullable operational conversation reference to NULL.'],
  'agenda_items:contactId': [CLASSIFICATION.KEEP, 'The source contact remains; rows already selected by conversation use the stronger MOVE rule.'],
  'appointments:contactId': [CLASSIFICATION.MOVE, 'Relink to the deterministic target contact mapping.'],
  'conversations:contactId': [CLASSIFICATION.MOVE, 'Relink to cloned/existing target contacts.'],
  'handoff_requests:contactId': [CLASSIFICATION.MOVE, 'Relink to cloned/existing target contacts.'],
  'invoices:contactId': [CLASSIFICATION.KEEP, 'Commercial history keeps source clinic and source contact.'],
  'leads:contactId': [CLASSIFICATION.MOVE, 'Relink to cloned/existing target contacts.'],
  'order_customer_notifications:contactId': [CLASSIFICATION.KEEP, 'The original source contact is retained for commercial history.'],
  'orders:contactId': [CLASSIFICATION.KEEP, 'Commercial history keeps source clinic and source contact.'],
  'payments:contactId': [CLASSIFICATION.KEEP, 'Commercial history keeps source clinic and source contact.'],
  'order_customer_notifications:orderId': [CLASSIFICATION.KEEP, 'Immutable notification remains attached to its original source order.'],
  'order_items:orderId': [CLASSIFICATION.KEEP, 'Commercial aggregate remains entirely source-owned.'],
  'operational_alert_rule_recipients:ruleId': [CLASSIFICATION.DETACH, 'Rule graph remains source-owned and outside WhatsApp routing.'],
  'handoff_requests:leadId': [CLASSIFICATION.MOVE, 'Follows the migrated Inbox lead graph.']
});

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusCount(rows, predicate) {
  return (rows || []).reduce((total, row) => (
    predicate(String(row.status || '').trim().toLowerCase()) ? total + number(row.count) : total
  ), 0);
}

function classifyDependencies(rows, policy, keyOf) {
  return (rows || []).map((row) => {
    const key = keyOf(row);
    const decision = policy[key] || [CLASSIFICATION.BLOCKER, 'Dependency is outside the approved manifest.'];
    return { ...row, classification: decision[0], rationale: decision[1] };
  });
}

function whatsappDomainRows(snapshot) {
  const m = snapshot.policyMetrics || {};
  const count = (name, field) => number(m.counts && m.counts[name] && m.counts[name][field]);
  const row = (table, sourceCount, targetCount, moveCount, cloneCount, keepSourceCount, collisionCount, finalTargetCount) => ({
    table, sourceCount, targetCount, moveCount, cloneCount, keepSourceCount, collisionCount, finalTargetCount
  });
  const contacts = m.contacts || {};
  const agenda = m.agenda || {};
  return [
    row('contacts', contacts.sourceCount, contacts.targetCount, contacts.existingTargetRelinkCount,
      contacts.cloneCount, contacts.sourceCount, contacts.collisionCount, contacts.finalTargetCount),
    row('conversations', count('conversations', 'source'), count('conversations', 'target'), count('conversations', 'source'), 0, 0, 0,
      count('conversations', 'source') + count('conversations', 'target')),
    row('conversation_messages', count('conversation_messages', 'source'), count('conversation_messages', 'target'), count('conversation_messages', 'source'), 0, 0,
      number(m.providerIdentity && m.providerIdentity.wamidCollisions), count('conversation_messages', 'source') + count('conversation_messages', 'target')),
    row('messages', count('messages', 'source'), count('messages', 'target'), count('messages', 'source'), 0, 0,
      number(m.providerIdentity && m.providerIdentity.providerMessageCollisions), count('messages', 'source') + count('messages', 'target')),
    row('conversation_events', count('conversation_events', 'source'), count('conversation_events', 'target'), count('conversation_events', 'source'), 0, 0, 0,
      count('conversation_events', 'source') + count('conversation_events', 'target')),
    row('handoff_requests', count('handoff_requests', 'source'), count('handoff_requests', 'target'), count('handoff_requests', 'source'), 0, 0, 0,
      count('handoff_requests', 'source') + count('handoff_requests', 'target')),
    row('agenda_items', agenda.sourceCount, agenda.targetCount, agenda.moveCount, 0, agenda.keepSourceCount, 0,
      number(agenda.targetCount) + number(agenda.moveCount)),
    row('leads', count('leads', 'source'), count('leads', 'target'), count('leads', 'source'), 0, 0, 0,
      count('leads', 'source') + count('leads', 'target')),
    row('appointments', count('appointments', 'source'), count('appointments', 'target'), count('appointments', 'source'), 0, 0,
      number(m.appointments && m.appointments.collisionCount), count('appointments', 'source') + count('appointments', 'target')),
    row('jobs', count('jobs', 'source'), count('jobs', 'target'), count('jobs', 'source'), 0, 0, 0,
      count('jobs', 'source') + count('jobs', 'target')),
    row('whatsapp_templates', count('whatsapp_templates', 'source'), count('whatsapp_templates', 'target'), count('whatsapp_templates', 'source'), 0, 0,
      number(m.templates && m.templates.collisionCount), count('whatsapp_templates', 'source') + count('whatsapp_templates', 'target')),
    row('operational_alert_rules', count('operational_alert_rules', 'source'), count('operational_alert_rules', 'target'), 0, 0,
      count('operational_alert_rules', 'source'), 0, count('operational_alert_rules', 'target')),
    row('order_customer_notifications', count('order_customer_notifications', 'source'), count('order_customer_notifications', 'target'), 0, 0,
      count('order_customer_notifications', 'source'), 0, count('order_customer_notifications', 'target')),
    row('whatsapp_template_canary_attempts', count('whatsapp_template_canary_attempts', 'source'), count('whatsapp_template_canary_attempts', 'target'),
      count('whatsapp_template_canary_attempts', 'source'), 0, 0, 0,
      count('whatsapp_template_canary_attempts', 'source') + count('whatsapp_template_canary_attempts', 'target'))
  ];
}

function analyzeWhatsAppOnlySnapshot(snapshot) {
  const blockers = [];
  const m = snapshot.policyMetrics || {};
  const base = snapshot.base || {};
  const direct = classifyDependencies(base.directDependencies, DIRECT_POLICY, (row) => row.table);
  const transitive = classifyDependencies(base.transitiveDependencies, TRANSITIVE_POLICY, (row) => `${row.table}:${row.via}`);

  if (!base.source || base.source.id !== snapshot.expectedSourceChannelId) blockers.push('source_channel_mismatch');
  if (!base.source || base.source.clinicId !== snapshot.expectedSourceClinicId) blockers.push('source_clinic_mismatch');
  if (!base.target || base.target.clinicId !== snapshot.expectedTargetClinicId) blockers.push('target_clinic_mismatch');
  if (!base.legacy || base.legacy.id !== snapshot.expectedLegacyChannelId || base.legacy.clinicId !== snapshot.expectedTargetClinicId) {
    blockers.push('legacy_channel_scope_mismatch');
  }
  if (!base.source || base.source.provider !== 'whatsapp_cloud' || String(base.source.status).toLowerCase() !== 'active') {
    blockers.push('source_channel_not_active_whatsapp');
  }
  if (base.source && base.source.accountScope !== 'opturon_admin') blockers.push('source_not_internal_admin_workspace');
  if (base.target && base.target.accountScope !== 'client') blockers.push('target_not_client_workspace');
  if (number(base.metrics && base.metrics.thirdChannelCount) > 0) blockers.push('third_phone_owner_conflict');
  if (direct.length !== 11 || direct.some((item) => item.classification === CLASSIFICATION.BLOCKER)) blockers.push('direct_dependency_manifest_changed');
  if (transitive.length !== 22 || transitive.some((item) => item.classification === CLASSIFICATION.BLOCKER)) blockers.push('transitive_dependency_manifest_changed');

  const contacts = m.contacts || {};
  if (number(contacts.collisionCount) !== 1 || number(contacts.ambiguousCollisionCount) > 0) blockers.push('contact_collision_manifest_changed');
  if (contacts.collisionSourceId !== snapshot.expectedCollisionSourceId || contacts.collisionTargetId !== snapshot.expectedCollisionTargetId) {
    blockers.push('contact_collision_identity_changed');
  }
  if (number(contacts.sharedWithOtherChannels) > 0 || number(contacts.unmappedCount) > 0) blockers.push('contact_mapping_not_total');
  if (number(m.providerIdentity && m.providerIdentity.providerMessageCollisions) > 0) blockers.push('provider_message_id_collision');
  if (number(m.providerIdentity && m.providerIdentity.wamidCollisions) > 0) blockers.push('wamid_collision');

  const activeJobs = statusCount(m.jobs && m.jobs.byStatus, (status) => !TERMINAL_JOB_STATUSES.has(status));
  if (activeJobs > 0 || number(m.jobs && m.jobs.activeLeaseCount) > 0) blockers.push('non_terminal_or_leased_jobs');
  if (number(m.jobs && m.jobs.commercialReferenceCount) > 0) blockers.push('terminal_jobs_reference_source_commercial_domain');
  const nonTerminalNotifications = statusCount(m.notifications && m.notifications.byStatus,
    (status) => !TERMINAL_NOTIFICATION_STATUSES.has(status));
  if (nonTerminalNotifications > 0) blockers.push('non_terminal_order_notification');
  if (number(m.notifications && m.notifications.sourceCount) > 0
    && (!m.schema || !m.schema.orderNotificationChannelNullable || !m.schema.orderNotificationConversationNullable)) {
    blockers.push('immutable_notification_not_detachable');
  }
  if (number(m.orders && m.orders.conversationDetachCount) > 0 && (!m.schema || !m.schema.orderConversationNullable)) {
    blockers.push('source_orders_not_detachable_from_conversation');
  }
  if (number(m.alertRule && m.alertRule.sourceCount) > 0) {
    if (!m.schema || !m.schema.alertRuleChannelNullable) blockers.push('source_alert_rule_channel_not_detachable');
    if (!m.alertRule.provenSourceCommercialRule) blockers.push('alert_rule_ownership_not_proven_source');
    if (number(m.alertRule.activeLeaseCount) > 0) blockers.push('active_alert_rule_lease');
  }
  if (!m.schema || !m.schema.phoneUniqueConstraintPresent) blockers.push('phone_unique_constraint_missing');
  if (!m.schema || !m.schema.atomicMultiCteRequired) blockers.push('atomic_fk_transition_plan_missing');
  if (number(m.commercial && m.commercial.unexpectedDependencyCount) > 0) blockers.push('unexpected_commercial_dependency');
  if (number(m.canary && m.canary.activeCount) > 0) blockers.push('active_canary_attempt');
  if (number(m.conversations && m.conversations.parallelActivePairs) > 0) blockers.push('parallel_active_conversation_collision');
  if (number(m.handoffs && m.handoffs.activeAssignedCount) > 0
    && !(m.handoffs && m.handoffs.targetPrimaryStaffReady)) blockers.push('active_handoff_requires_target_staff_mapping');
  if (number(m.leadAssignments && m.leadAssignments.assignedCount) > 0
    && !(m.leadAssignments && m.leadAssignments.targetPrimaryStaffReady)) blockers.push('assigned_lead_requires_target_staff_mapping');
  if (number(m.templates && m.templates.collisionCount) > 0) blockers.push('template_collision');
  if (m.templates && m.templates.expectedApprovedTemplateExact === false) blockers.push('approved_template_identity_changed');

  return {
    mode: 'DRY_RUN',
    policy: 'WHATSAPP_ONLY_CLONE_RELINK',
    directDependencies: direct,
    transitiveDependencies: transitive,
    whatsappDomain: whatsappDomainRows(snapshot),
    commercialDomain: (m.commercial && m.commercial.tables) || [],
    contacts,
    providerIdentity: m.providerIdentity || {},
    media: m.media || {},
    handoffs: m.handoffs || {},
    leadAssignments: m.leadAssignments || {},
    jobs: m.jobs || {},
    templates: m.templates || {},
    notifications: m.notifications || {},
    alertRule: m.alertRule || {},
    legacy: m.legacy || {},
    operationalDetaches: m.operationalDetaches || {},
    schema: m.schema || {},
    blockers,
    finalChannelId: base.source ? base.source.id : null,
    finalClinicId: base.target ? base.target.clinicId : null,
    finalWabaId: base.source ? base.source.wabaId : null,
    finalPhoneNumberId: base.source ? base.source.phoneNumberId : null,
    readyForWhatsAppOnlyMigration: blockers.length === 0
  };
}

module.exports = {
  CLASSIFICATION,
  DIRECT_POLICY,
  TRANSITIVE_POLICY,
  TERMINAL_JOB_STATUSES,
  TERMINAL_NOTIFICATION_STATUSES,
  analyzeWhatsAppOnlySnapshot
};
