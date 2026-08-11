const ruleRepository = require('../repositories/operational-alert-rules.repository');
const eventRepository = require('../repositories/operational-alert-events.repository');
const { getClinicBusinessProfileById } = require('../repositories/tenant.repository');
const { isOperationalAlertsEnabled } = require('../operational-alerts/internal-operational-alert-authority');
const {
  getScheduledOperationalAlertEvaluator
} = require('../operational-alerts/operational-alert-scheduled-registry');
const { logInfo, logWarn } = require('../utils/logger');

const DEFAULT_DEPENDENCIES = Object.freeze({
  claimRules: ruleRepository.claimScheduledOperationalAlertRules,
  finishRule: ruleRepository.finishScheduledOperationalAlertRule,
  insertEvent: eventRepository.insertOperationalAlertEvent,
  getClinicById: getClinicBusinessProfileById,
  getEvaluator: getScheduledOperationalAlertEvaluator
});

function safeId(value) {
  return String(value || '').slice(0, 8) || null;
}

async function processScheduledOperationalAlertRule(rule, options = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...(options.dependencies || {}) };
  const workerId = options.workerId || rule.schedulerLockedBy;
  const now = options.now ? new Date(options.now) : new Date();
  const clinic = await dependencies.getClinicById(rule.clinicId);
  if (!isOperationalAlertsEnabled(clinic)) {
    await dependencies.finishRule(rule.id, rule.clinicId, {
      workerId,
      nextEvaluationAt: null,
      triggered: false
    });
    logInfo('operational_alert_scheduled_scan', {
      ruleId: safeId(rule.id),
      eventType: rule.eventType,
      eventVersion: rule.eventVersion,
      resultCode: 'feature_disabled'
    });
    return { outcome: 'feature_disabled', events: 0 };
  }

  const evaluator = dependencies.getEvaluator(rule.eventType, rule.eventVersion);
  if (typeof evaluator !== 'function') {
    await dependencies.finishRule(rule.id, rule.clinicId, {
      workerId,
      nextEvaluationAt: null,
      triggered: false
    });
    logInfo('operational_alert_scheduled_scan', {
      ruleId: safeId(rule.id),
      eventType: rule.eventType,
      eventVersion: rule.eventVersion,
      resultCode: 'evaluator_not_registered'
    });
    return { outcome: 'evaluator_not_registered', events: 0 };
  }

  const result = await evaluator({ rule, clinic, now: now.toISOString() });
  const events = result && Array.isArray(result.events) ? result.events : [];
  let inserted = 0;
  for (const event of events) {
    const stored = await dependencies.insertEvent({
      ...event,
      clinicId: rule.clinicId,
      eventType: rule.eventType,
      eventVersion: rule.eventVersion,
      targetRuleId: rule.id,
      source: 'operational_alert_scheduled_evaluator'
    });
    if (stored.inserted) inserted += 1;
  }
  await dependencies.finishRule(rule.id, rule.clinicId, {
    workerId,
    nextEvaluationAt: result && result.nextEvaluationAt ? result.nextEvaluationAt : null,
    triggered: inserted > 0
  });
  return { outcome: 'evaluated', events: inserted };
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
    }
  }
  if (stats.claimed || stats.failed) {
    logInfo('operational_alert_scheduled_scan', { workerId, ...stats });
  }
  return stats;
}

module.exports = {
  processScheduledOperationalAlertRule,
  runOperationalAlertScheduledSweep
};
