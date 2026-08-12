const ruleRepository = require('../repositories/operational-alert-rules.repository');
const eventRepository = require('../repositories/operational-alert-events.repository');
const { withTransaction } = require('../db/client');
const { getClinicBusinessProfileById } = require('../repositories/tenant.repository');
const { isOperationalAlertsEnabled } = require('../operational-alerts/internal-operational-alert-authority');
const {
  getScheduledOperationalAlertEvaluator
} = require('../operational-alerts/operational-alert-scheduled-registry');
const { logInfo, logWarn } = require('../utils/logger');
const { contractError } = require('../operational-alerts/operational-alert-validation');

const DEFAULT_DEPENDENCIES = Object.freeze({
  claimRules: ruleRepository.claimScheduledOperationalAlertRules,
  findClaimedRule: ruleRepository.findClaimedScheduledOperationalAlertRule,
  finishRule: ruleRepository.finishScheduledOperationalAlertRule,
  insertEvent: eventRepository.insertOperationalAlertEvent,
  withTransaction,
  getClinicById: getClinicBusinessProfileById,
  getEvaluator: getScheduledOperationalAlertEvaluator
});

function safeId(value) {
  return String(value || '').slice(0, 8) || null;
}

function assertClaimStillMatches(current, claimed, now) {
  const dueAt = current && current.nextEvaluationAt ? new Date(current.nextEvaluationAt).getTime() : NaN;
  if (
    !current || current.enabled !== true || current.archivedAt || current.triggerMode !== 'scheduled' ||
    String(current.id) !== String(claimed.id) || String(current.clinicId) !== String(claimed.clinicId) ||
    current.eventType !== claimed.eventType || Number(current.eventVersion) !== Number(claimed.eventVersion) ||
    Number(current.configVersion) !== Number(claimed.configVersion) ||
    !Number.isFinite(dueAt) || dueAt > now.getTime()
  ) {
    throw contractError('operational_alert_scheduled_rule_changed');
  }
}

async function completeScheduledEvaluation({ rule, workerId, now, result, dependencies }) {
  return dependencies.withTransaction(async (client) => {
    const current = await dependencies.findClaimedRule(rule.id, rule.clinicId, workerId, client);
    if (!current) return { outcome: 'lease_lost', inserted: 0, deduplicated: 0 };
    assertClaimStillMatches(current, rule, now);

    const events = result && Array.isArray(result.events) ? result.events : [];
    if (rule.eventType === 'inventory.lot_expiring' && events.length > 1) {
      throw contractError('inventory_expiry_digest_event_count_invalid');
    }
    let inserted = 0;
    let deduplicated = 0;
    for (const event of events) {
      const stored = await dependencies.insertEvent({
        ...event,
        clinicId: current.clinicId,
        eventType: current.eventType,
        eventVersion: current.eventVersion,
        targetRuleId: current.id,
        source: 'operational_alert_scheduled_evaluator'
      }, client);
      if (stored.inserted) inserted += 1;
      else deduplicated += 1;
    }
    const finished = await dependencies.finishRule(current.id, current.clinicId, {
      workerId,
      nextEvaluationAt: result && result.nextEvaluationAt ? result.nextEvaluationAt : null,
      triggered: events.length > 0
    }, client);
    if (!finished) throw contractError('operational_alert_scheduled_rule_finish_failed');
    return { outcome: 'completed', inserted, deduplicated };
  });
}

async function processScheduledOperationalAlertRule(rule, options = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...(options.dependencies || {}) };
  const workerId = options.workerId || rule.schedulerLockedBy;
  const now = options.now ? new Date(options.now) : new Date();
  const clinic = await dependencies.getClinicById(rule.clinicId);
  if (!isOperationalAlertsEnabled(clinic)) {
    const completion = await completeScheduledEvaluation({
      rule,
      workerId,
      now,
      result: { events: [], nextEvaluationAt: null },
      dependencies
    });
    logInfo('operational_alert_scheduled_scan', {
      ruleId: safeId(rule.id),
      eventType: rule.eventType,
      eventVersion: rule.eventVersion,
      resultCode: 'feature_disabled'
    });
    return { outcome: completion.outcome === 'lease_lost' ? 'lease_lost' : 'feature_disabled', events: 0 };
  }

  const evaluator = dependencies.getEvaluator(rule.eventType, rule.eventVersion);
  if (typeof evaluator !== 'function') {
    const completion = await completeScheduledEvaluation({
      rule,
      workerId,
      now,
      result: { events: [], nextEvaluationAt: null },
      dependencies
    });
    logInfo('operational_alert_scheduled_scan', {
      ruleId: safeId(rule.id),
      eventType: rule.eventType,
      eventVersion: rule.eventVersion,
      resultCode: 'evaluator_not_registered'
    });
    return { outcome: completion.outcome === 'lease_lost' ? 'lease_lost' : 'evaluator_not_registered', events: 0 };
  }

  const result = await evaluator({ rule, clinic, now: now.toISOString() });
  const completion = await completeScheduledEvaluation({
    rule,
    workerId,
    now,
    result,
    dependencies
  });
  if (rule.eventType === 'inventory.lot_expiring' && completion.outcome === 'completed') {
    const metrics = result && result.metrics ? result.metrics : {};
    const logMeta = {
      clinicId: safeId(rule.clinicId),
      ruleId: safeId(rule.id),
      configVersion: Number(rule.configVersion),
      threshold: Number(rule.conditions && rule.conditions.daysBefore),
      candidateCount: Number(metrics.candidateCount || 0),
      digestCount: Number(metrics.digestCount || 0),
      localDate: result && result.events && result.events[0]
        ? result.events[0].payload.localDate
        : null,
      durationMs: Number(metrics.durationMs || 0)
    };
    if (completion.inserted > 0) logInfo('inventory_expiry_digest_created', logMeta);
    if (completion.deduplicated > 0) logInfo('inventory_expiry_event_deduplicated', logMeta);
  }
  return {
    outcome: completion.outcome === 'lease_lost' ? 'lease_lost' : 'evaluated',
    events: completion.inserted,
    deduplicated: completion.deduplicated
  };
}

async function runOperationalAlertScheduledSweep({
  workerId,
  limit = 5,
  dependencies = {},
  now = null
} = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const rules = await deps.claimRules({ workerId, limit });
  const stats = { claimed: rules.length, evaluated: 0, events: 0, missingEvaluator: 0, failed: 0 };
  for (const rule of rules) {
    try {
      const result = await processScheduledOperationalAlertRule(rule, {
        workerId,
        dependencies: deps,
        now
      });
      if (result.outcome === 'evaluated') stats.evaluated += 1;
      if (result.outcome === 'evaluator_not_registered') stats.missingEvaluator += 1;
      stats.events += result.events || 0;
    } catch (error) {
      stats.failed += 1;
      const retryAt = new Date((now ? new Date(now) : new Date()).getTime() + 60000).toISOString();
      await deps.finishRule(rule.id, rule.clinicId, {
        workerId,
        nextEvaluationAt: retryAt,
        triggered: false
      }).catch(() => null);
      logWarn('operational_alert_scheduled_scan_failed', {
        ruleId: safeId(rule.id),
        eventType: rule.eventType,
        eventVersion: rule.eventVersion,
        resultCode: 'scheduled_evaluator_failed'
      });
      if (rule.eventType === 'inventory.lot_expiring') {
        logWarn('inventory_expiry_evaluation_failed', {
          clinicId: safeId(rule.clinicId),
          ruleId: safeId(rule.id),
          configVersion: Number(rule.configVersion),
          threshold: Number(rule.conditions && rule.conditions.daysBefore),
          candidateCount: 0,
          digestCount: 0,
          localDate: null,
          durationMs: 0,
          resultCode: String(error && error.code || 'scheduled_evaluator_failed').slice(0, 100)
        });
      }
    }
  }
  if (stats.claimed || stats.failed) {
    logInfo('operational_alert_scheduled_scan', { workerId, ...stats });
  }
  return stats;
}

module.exports = {
  completeScheduledEvaluation,
  processScheduledOperationalAlertRule,
  runOperationalAlertScheduledSweep
};
