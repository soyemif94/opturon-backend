const { withTransaction } = require('../db/client');
const eventRepository = require('../repositories/operational-alert-events.repository');
const ruleRepository = require('../repositories/operational-alert-rules.repository');
const recipientRepository = require('../repositories/operational-alert-recipients.repository');
const instanceRepository = require('../repositories/operational-alert-instances.repository');
const deliveryRepository = require('../repositories/operational-alert-deliveries.repository');
const { getClinicBusinessProfileById } = require('../repositories/tenant.repository');
const { validateOperationalAlertEvent } = require('../operational-alerts/operational-alert-contracts');
const {
  EVALUATION_OUTCOMES,
  evaluateOperationalAlertCondition
} = require('../operational-alerts/operational-alert-registry');
const {
  buildOperationalAlertOccurrenceKey,
  buildOperationalAlertDeliveryIdempotencyKey
} = require('../operational-alerts/operational-alert-idempotency');
const { isOperationalAlertsEnabled } = require('../operational-alerts/internal-operational-alert-authority');
const { logInfo, logWarn } = require('../utils/logger');

const MAX_EVENT_ATTEMPTS = 5;

const DEFAULT_DEPENDENCIES = Object.freeze({
  withTransaction,
  claimEvents: eventRepository.claimOperationalAlertEvents,
  findClaimedEvent: eventRepository.findClaimedOperationalAlertEvent,
  updateEventStatus: eventRepository.updateOperationalAlertEventStatus,
  listRulesForEvent: ruleRepository.listOperationalAlertRulesForEvent,
  listRuleRecipients: ruleRepository.listOperationalAlertRuleRecipients,
  findRecipient: recipientRepository.findOperationalAlertRecipientById,
  insertInstance: instanceRepository.insertOperationalAlertInstance,
  aggregateInstance: instanceRepository.aggregateOperationalAlertInstanceStatus,
  insertDelivery: deliveryRepository.insertOperationalAlertDelivery,
  getClinicById: getClinicBusinessProfileById
});

function safeId(value) {
  return String(value || '').slice(0, 8) || null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildRuleSnapshot(rule) {
  return {
    id: rule.id,
    configVersion: rule.configVersion,
    eventType: rule.eventType,
    eventVersion: rule.eventVersion,
    triggerMode: rule.triggerMode,
    conditions: clone(rule.conditions || {}),
    deliveryPolicy: clone(rule.deliveryPolicy || {}),
    channelId: rule.channelId || null,
    templateKey: rule.templateKey || null,
    templateLanguage: rule.templateLanguage || null,
    formatterKey: rule.formatterKey,
    formatterVersion: rule.formatterVersion
  };
}

function buildInstanceSnapshot(rule, event, evaluation) {
  return {
    schemaVersion: 1,
    rule: buildRuleSnapshot(rule),
    event: {
      id: event.id,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      entityType: event.entityType,
      entityId: event.entityId,
      occurredAt: new Date(event.occurredAt).toISOString(),
      deduplicationKey: event.deduplicationKey,
      material: clone(evaluation.material || {})
    },
    evaluation: {
      outcome: evaluation.outcome,
      reason: evaluation.reason
    }
  };
}

function buildRecipientSnapshot(recipient) {
  return {
    recipientId: recipient.id,
    name: recipient.name,
    phoneE164: recipient.phoneE164,
    roleLabel: recipient.roleLabel || null,
    version: recipient.version
  };
}

function computeExpiry(event, deliveryPolicy) {
  const maxAgeSeconds = Number(deliveryPolicy && deliveryPolicy.maxAgeSeconds);
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1) return null;
  return new Date(new Date(event.occurredAt).getTime() + maxAgeSeconds * 1000).toISOString();
}

async function processClaimedOperationalAlertEvent(claimedEvent, options = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...(options.dependencies || {}) };
  const workerId = options.workerId || claimedEvent.lockedBy;
  return dependencies.withTransaction(async (client) => {
    const event = await dependencies.findClaimedEvent(
      claimedEvent.id,
      claimedEvent.clinicId,
      workerId,
      client
    );
    if (!event) return { outcome: 'not_owned', matchedRules: 0, instances: 0, deliveries: 0 };

    const contract = validateOperationalAlertEvent(event);
    if (!contract.ok) {
      const updated = await dependencies.updateEventStatus(event.id, event.clinicId, {
        status: 'failed_permanent',
        expectedLockedBy: workerId,
        lastError: contract.reason,
        errorMetadata: { reason: contract.reason, retriable: false }
      }, client);
      return { outcome: 'invalid_event', event: updated, matchedRules: 0, instances: 0, deliveries: 0 };
    }

    const clinic = await dependencies.getClinicById(event.clinicId, client);
    if (!isOperationalAlertsEnabled(clinic)) {
      const updated = await dependencies.updateEventStatus(event.id, event.clinicId, {
        status: 'processed',
        expectedLockedBy: workerId,
        errorMetadata: { reason: 'operational_alerts_feature_disabled', rulesEvaluated: 0 }
      }, client);
      return { outcome: 'feature_disabled', event: updated, matchedRules: 0, instances: 0, deliveries: 0 };
    }

    const rules = await dependencies.listRulesForEvent(event, client);
    let matchedRules = 0;
    let invalidRules = 0;
    const invalidRuleResults = [];
    let instances = 0;
    let deliveries = 0;
    for (const rule of rules) {
      const evaluation = evaluateOperationalAlertCondition(rule, event);
      if (evaluation.outcome === EVALUATION_OUTCOMES.INVALID_CONFIGURATION) {
        invalidRules += 1;
        if (invalidRuleResults.length < 100) {
          invalidRuleResults.push({ ruleId: rule.id, reason: evaluation.reason });
        }
        logWarn('operational_alert_rule_invalid', {
          eventId: safeId(event.id),
          ruleId: safeId(rule.id),
          eventType: event.eventType,
          eventVersion: event.eventVersion,
          resultCode: evaluation.reason
        });
        continue;
      }
      if (evaluation.outcome !== EVALUATION_OUTCOMES.MATCH) continue;
      matchedRules += 1;
      logInfo('operational_alert_rule_matched', {
        eventId: safeId(event.id),
        ruleId: safeId(rule.id),
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        ruleVersion: rule.configVersion
      });

      const occurrenceKey = buildOperationalAlertOccurrenceKey({
        eventDeduplicationKey: event.deduplicationKey
      });
      const insertedInstance = await dependencies.insertInstance({
        clinicId: event.clinicId,
        ruleId: rule.id,
        eventId: event.id,
        ruleVersion: rule.configVersion,
        occurrenceKey,
        evaluationWindowKey: evaluation.evaluationWindowKey || null,
        snapshotVersion: 1,
        snapshot: buildInstanceSnapshot(rule, event, evaluation),
        expiresAt: computeExpiry(event, rule.deliveryPolicy)
      }, client);
      if (insertedInstance.inserted) {
        instances += 1;
        logInfo('operational_alert_instance_created', {
          instanceId: safeId(insertedInstance.instance.id),
          eventId: safeId(event.id),
          ruleId: safeId(rule.id),
          eventType: event.eventType,
          ruleVersion: rule.configVersion
        });
      }

      const associations = await dependencies.listRuleRecipients(rule.id, event.clinicId, client);
      for (const association of associations) {
        const recipient = await dependencies.findRecipient(
          association.recipientId,
          event.clinicId,
          client
        );
        if (!recipient) continue;
        const insertedDelivery = await dependencies.insertDelivery({
          clinicId: event.clinicId,
          instanceId: insertedInstance.instance.id,
          recipientId: recipient.id,
          recipientVersion: recipient.version,
          channelId: rule.channelId,
          idempotencyKey: buildOperationalAlertDeliveryIdempotencyKey({
            instanceId: insertedInstance.instance.id,
            recipientId: recipient.id,
            version: 1
          }),
          recipientSnapshot: buildRecipientSnapshot(recipient),
          messageSnapshot: null,
          templateKey: rule.templateKey,
          templateLanguage: rule.templateLanguage,
          templateVersion: null,
          formatterKey: rule.formatterKey,
          formatterVersion: rule.formatterVersion
        }, client);
        if (insertedDelivery.inserted) {
          deliveries += 1;
          logInfo('operational_alert_delivery_created', {
            deliveryId: safeId(insertedDelivery.delivery.id),
            instanceId: safeId(insertedInstance.instance.id),
            recipientId: safeId(recipient.id),
            eventType: event.eventType,
            recipientVersion: recipient.version
          });
        }
      }
      await dependencies.aggregateInstance(insertedInstance.instance.id, event.clinicId, client);
    }

    const updated = await dependencies.updateEventStatus(event.id, event.clinicId, {
      status: 'processed',
      expectedLockedBy: workerId,
      errorMetadata: {
        reason: 'event_rules_evaluated',
        rulesEvaluated: rules.length,
        matchedRules,
        invalidRules,
        invalidRuleResults,
        targetRuleResolved: event.targetRuleId ? rules.length === 1 : null,
        instances,
        deliveries
      }
    }, client);
    return { outcome: 'processed', event: updated, matchedRules, invalidRules, instances, deliveries };
  });
}

async function processAvailableOperationalAlertEvents({
  workerId,
  limit = 10,
  dependencies = {},
  now = null
} = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const claimed = await deps.claimEvents({ workerId, limit, maxAttempts: MAX_EVENT_ATTEMPTS });
  const stats = { claimed: claimed.length, processed: 0, instances: 0, deliveries: 0, failed: 0 };
  for (const event of claimed) {
    logInfo('operational_alert_event_claimed', {
      eventId: safeId(event.id),
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      attempt: event.attemptCount,
      queueAgeMs: Math.max(0, (now ? new Date(now) : new Date()).getTime() - new Date(event.createdAt).getTime())
    });
    try {
      const result = await processClaimedOperationalAlertEvent(event, {
        workerId,
        dependencies: deps
      });
      if (result.outcome === 'processed' || result.outcome === 'feature_disabled') stats.processed += 1;
      stats.instances += result.instances || 0;
      stats.deliveries += result.deliveries || 0;
    } catch (error) {
      stats.failed += 1;
      const permanent = Number(event.attemptCount) >= MAX_EVENT_ATTEMPTS;
      await deps.updateEventStatus(event.id, event.clinicId, {
        status: permanent ? 'failed_permanent' : 'failed_retryable',
        expectedLockedBy: workerId,
        availableAt: permanent ? null : new Date(Date.now() + 2000).toISOString(),
        lastError: 'operational_alert_event_processor_failed',
        errorMetadata: {
          reason: 'operational_alert_event_processor_failed',
          errorCode: String(error && error.code || '').slice(0, 100) || null,
          retriable: !permanent
        }
      }).catch(() => null);
      logWarn('operational_alert_event_failed', {
        eventId: safeId(event.id),
        eventType: event.eventType,
        attempt: event.attemptCount,
        resultCode: permanent ? 'event_attempts_exhausted' : 'event_processor_retryable'
      });
    }
  }
  return stats;
}

module.exports = {
  MAX_EVENT_ATTEMPTS,
  buildInstanceSnapshot,
  buildRecipientSnapshot,
  processClaimedOperationalAlertEvent,
  processAvailableOperationalAlertEvents
};
