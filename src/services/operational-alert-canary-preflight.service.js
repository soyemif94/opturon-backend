const { findClinicByExternalTenantId } = require('../repositories/tenant.repository');
const observabilityRepository = require('../repositories/operational-alert-observability.repository');
const operationalAlerts = require('./portal-operational-alerts.service');
const candidatePreview = require('./operational-alert-candidate-preview.service');
const { getOperationalAlertWorkerHealth } = require('./operational-alert-worker-heartbeat.service');
const { isOperationalAlertsEnabled } = require('../operational-alerts/internal-operational-alert-authority');
const {
  normalizeString,
  normalizeDateTime,
  isUuid
} = require('../operational-alerts/operational-alert-validation');

const HEALTH_VALUES = new Set(['healthy', 'stale', 'error', 'unknown']);

class OperationalAlertCanaryPreflightError extends Error {
  constructor(code, status = 400, details = null) {
    super(code);
    this.name = 'OperationalAlertCanaryPreflightError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, status = 400, details = null) {
  throw new OperationalAlertCanaryPreflightError(code, status, details);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function normalizeWorkerHealth(value) {
  const source = value && typeof value === 'object' ? value : {};
  const requestedHealth = normalizeString(source.health).toLowerCase();
  const health = HEALTH_VALUES.has(requestedHealth) ? requestedHealth : 'unknown';
  return {
    workerId: normalizeString(source.workerId) || null,
    lastPollStartedAt: normalizeDateTime(source.lastPollStartedAt),
    lastPollCompletedAt: normalizeDateTime(source.lastPollCompletedAt),
    lastSuccessfulPollAt: normalizeDateTime(source.lastSuccessfulPollAt),
    lastError: normalizeString(source.lastError) || null,
    updatedAt: normalizeDateTime(source.updatedAt),
    health
  };
}

function normalizeBacklog(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    pending: nonNegativeInteger(source.pending),
    processing: nonNegativeInteger(source.processing),
    retryable: nonNegativeInteger(source.retryable),
    unknownDelivery: nonNegativeInteger(source.unknownDelivery)
  };
}

function configuredMaxAttempts(rule) {
  const value = Number(rule && rule.deliveryPolicy && rule.deliveryPolicy.maxAttempts);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function addReason(reasons, code, detail = null) {
  if (reasons.some((reason) => reason.code === code)) return;
  reasons.push({ code, ...(detail ? { detail } : {}) });
}

function normalizeReadiness(value) {
  const readiness = value && typeof value === 'object' ? value : {};
  return {
    ready: readiness.ready === true,
    blockers: Array.isArray(readiness.blockers) ? readiness.blockers : [],
    checks: readiness.checks && typeof readiness.checks === 'object' ? readiness.checks : {}
  };
}

function normalizeCandidatePreview(value) {
  const preview = value && typeof value === 'object' ? value : {};
  return {
    eventType: normalizeString(preview.eventType) || null,
    eventVersion: Number.isInteger(Number(preview.eventVersion)) ? Number(preview.eventVersion) : null,
    rule: preview.rule && typeof preview.rule === 'object' ? preview.rule : {},
    evaluable: preview.evaluable === true,
    candidateCount: nonNegativeInteger(preview.candidateCount),
    candidateLotIds: Array.isArray(preview.candidateLotIds)
      ? preview.candidateLotIds.map((value) => normalizeString(value)).filter(Boolean)
      : [],
    expectedEventCount: nonNegativeInteger(preview.expectedEventCount),
    expectedDigestCount: nonNegativeInteger(preview.expectedDigestCount),
    digestItemCount: nonNegativeInteger(preview.digestItemCount),
    truncated: preview.truncated === true,
    localDate: normalizeString(preview.localDate) || null,
    evaluatedAt: normalizeDateTime(preview.evaluatedAt),
    reason: normalizeString(preview.reason) || null
  };
}

function createOperationalAlertCanaryPreflightService(overrides = {}) {
  const dependencies = {
    findClinic: findClinicByExternalTenantId,
    getDeliveryBacklog: observabilityRepository.getOperationalAlertDeliveryBacklog,
    countEnabledRules: observabilityRepository.countEnabledOperationalAlertRules,
    getRuleReadiness: operationalAlerts.getRuleReadiness,
    previewRuleCandidates: candidatePreview.previewRuleCandidates,
    // No heartbeat row resolves to `unknown` in the durable health service,
    // so the default remains fail-closed even before a worker has started.
    getWorkerHealth: getOperationalAlertWorkerHealth,
    isOperationalAlertsEnabled,
    now: () => new Date().toISOString(),
    ...overrides
  };

  async function requireClinic(tenantId) {
    const safeTenantId = normalizeString(tenantId);
    if (!safeTenantId) fail('missing_tenant_id');
    const clinic = await dependencies.findClinic(safeTenantId);
    if (!clinic) fail('tenant_mapping_not_found', 404);
    return { tenantId: safeTenantId, clinic };
  }

  async function getTenantObservability(tenantId) {
    const context = await requireClinic(tenantId);
    const observedAt = dependencies.now();
    const [backlog, worker] = await Promise.all([
      dependencies.getDeliveryBacklog(context.clinic.id),
      dependencies.getWorkerHealth({ now: observedAt })
    ]);
    return {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      worker: normalizeWorkerHealth(worker),
      backlog: normalizeBacklog(backlog)
    };
  }

  async function getCanaryPreflight(tenantId, ruleId) {
    const safeRuleId = normalizeString(ruleId);
    if (!isUuid(safeRuleId)) fail('operational_alert_rule_id_invalid');
    const context = await requireClinic(tenantId);
    const evaluatedAt = dependencies.now();
    const [enabledRuleCount, backlogInput, readinessInput, candidateInput, workerInput] = await Promise.all([
      dependencies.countEnabledRules(context.clinic.id),
      dependencies.getDeliveryBacklog(context.clinic.id),
      dependencies.getRuleReadiness(context.tenantId, safeRuleId),
      dependencies.previewRuleCandidates(context.tenantId, safeRuleId),
      dependencies.getWorkerHealth({ now: evaluatedAt })
    ]);

    const readiness = normalizeReadiness(readinessInput);
    const candidatePreviewResult = normalizeCandidatePreview(candidateInput);
    const backlog = normalizeBacklog(backlogInput);
    const worker = normalizeWorkerHealth(workerInput);
    const operationalAlertsEnabled = dependencies.isOperationalAlertsEnabled(context.clinic) === true;
    const recipientCount = nonNegativeInteger(readiness.checks.recipientCount);
    const maxAttempts = configuredMaxAttempts(candidatePreviewResult.rule);
    const reasons = [];

    if (!operationalAlertsEnabled) {
      addReason(reasons, 'OPERATIONAL_ALERTS_DISABLED');
    }
    if (nonNegativeInteger(enabledRuleCount) !== 1) {
      addReason(reasons, 'ENABLED_RULE_COUNT_NOT_ONE', String(nonNegativeInteger(enabledRuleCount)));
    }
    if (candidatePreviewResult.rule.enabled !== true) {
      addReason(reasons, 'CANARY_RULE_DISABLED');
    }
    if (recipientCount !== 1) {
      addReason(reasons, 'RECIPIENT_COUNT_NOT_ONE', String(recipientCount));
    }
    if (readiness.checks.recipientsReady !== true) {
      addReason(reasons, 'RECIPIENTS_NOT_READY');
    }
    if (readiness.checks.channelReady !== true) {
      addReason(reasons, 'CHANNEL_NOT_READY');
    }
    if (readiness.checks.templateReady !== true) {
      addReason(reasons, 'TEMPLATE_NOT_READY');
    }
    if (readiness.ready !== true) {
      addReason(reasons, 'RULE_NOT_READY');
      for (const blocker of readiness.blockers) {
        const code = normalizeString(blocker && blocker.code);
        if (code) addReason(reasons, `RULE_BLOCKER_${code}`, normalizeString(blocker.detail) || null);
      }
    }
    if (candidatePreviewResult.evaluable !== true) {
      addReason(reasons, 'CANDIDATE_PREVIEW_UNAVAILABLE', candidatePreviewResult.reason);
    }
    if (candidatePreviewResult.candidateCount !== 1) {
      addReason(reasons, 'CANDIDATE_COUNT_NOT_ONE', String(candidatePreviewResult.candidateCount));
    }
    if (
      candidatePreviewResult.expectedEventCount !== 1 ||
      candidatePreviewResult.expectedDigestCount !== 1 ||
      candidatePreviewResult.digestItemCount !== 1 ||
      candidatePreviewResult.truncated === true
    ) {
      addReason(reasons, 'CANDIDATE_DIGEST_NOT_SINGLE');
    }
    if (maxAttempts !== 1) {
      addReason(reasons, 'DELIVERY_POLICY_MAX_ATTEMPTS_NOT_ONE', String(maxAttempts || 0));
    }
    if (worker.health !== 'healthy') {
      addReason(reasons, 'WORKER_NOT_HEALTHY', worker.health);
    }
    if (backlog.pending !== 0) addReason(reasons, 'DELIVERY_BACKLOG_PENDING', String(backlog.pending));
    if (backlog.processing !== 0) addReason(reasons, 'DELIVERY_BACKLOG_PROCESSING', String(backlog.processing));
    if (backlog.retryable !== 0) addReason(reasons, 'DELIVERY_BACKLOG_RETRYABLE', String(backlog.retryable));
    if (backlog.unknownDelivery !== 0) {
      addReason(reasons, 'DELIVERY_BACKLOG_UNKNOWN_DELIVERY', String(backlog.unknownDelivery));
    }

    return {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      ruleId: safeRuleId,
      evaluatedAt,
      operationalAlertsEnabled,
      enabledRules: { count: nonNegativeInteger(enabledRuleCount) },
      recipients: {
        count: recipientCount,
        ready: readiness.checks.recipientsReady === true
      },
      template: { ready: readiness.checks.templateReady === true },
      channel: { ready: readiness.checks.channelReady === true },
      deliveryPolicy: { maxAttempts },
      readiness,
      candidatePreview: candidatePreviewResult,
      worker,
      backlog,
      canarySafe: reasons.length === 0,
      reasons
    };
  }

  return {
    getTenantObservability,
    getCanaryPreflight
  };
}

const defaultService = createOperationalAlertCanaryPreflightService();

module.exports = {
  ...defaultService,
  createOperationalAlertCanaryPreflightService,
  OperationalAlertCanaryPreflightError,
  __private__: {
    normalizeWorkerHealth,
    normalizeBacklog,
    configuredMaxAttempts,
    normalizeCandidatePreview
  }
};
