const ruleRepository = require('../repositories/operational-alert-rules.repository');
const { findClinicByExternalTenantId } = require('../repositories/tenant.repository');
const {
  getScheduledOperationalAlertEvaluator
} = require('../operational-alerts/operational-alert-scheduled-registry');
const {
  buildInventoryExpiryEvaluationContext
} = require('../operational-alerts/inventory-lot-expiry-alert');
const {
  normalizeString,
  isUuid
} = require('../operational-alerts/operational-alert-validation');

const INVENTORY_EXPIRY_EVENT_TYPE = 'inventory.lot_expiring';
const INVENTORY_EXPIRY_EVENT_VERSION = 1;

class OperationalAlertCandidatePreviewError extends Error {
  constructor(code, status = 400, details = null) {
    super(code);
    this.name = 'OperationalAlertCandidatePreviewError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, status = 400, details = null) {
  throw new OperationalAlertCandidatePreviewError(code, status, details);
}

function safeCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function buildPreviewRule(rule) {
  return {
    id: rule.id,
    configVersion: Number(rule.configVersion),
    enabled: rule.enabled === true,
    triggerMode: rule.triggerMode,
    conditions: rule.conditions || {},
    schedule: rule.schedule || {},
    deliveryPolicy: rule.deliveryPolicy || {}
  };
}

function buildUnsupportedPreview({ tenantId, rule, reason }) {
  return {
    eventType: rule.eventType,
    eventVersion: Number(rule.eventVersion),
    tenantId,
    ruleId: rule.id,
    rule: buildPreviewRule(rule),
    evaluatedRuleEnabled: false,
    evaluatedAt: null,
    localDate: null,
    candidateCount: 0,
    candidateLotIds: [],
    expectedEventCount: 0,
    expectedDigestCount: 0,
    digestItemCount: 0,
    truncated: false,
    evaluable: false,
    reason
  };
}

function createOperationalAlertCandidatePreviewService(overrides = {}) {
  const dependencies = {
    findClinic: findClinicByExternalTenantId,
    findRule: ruleRepository.findOperationalAlertRuleById,
    getEvaluator: getScheduledOperationalAlertEvaluator,
    now: () => new Date().toISOString(),
    ...overrides
  };

  async function previewRuleCandidates(tenantId, ruleId) {
    const safeTenantId = normalizeString(tenantId);
    if (!safeTenantId) fail('missing_tenant_id');
    if (!isUuid(ruleId)) fail('operational_alert_rule_id_invalid');

    const clinic = await dependencies.findClinic(safeTenantId);
    if (!clinic) fail('tenant_mapping_not_found', 404);

    const rule = await dependencies.findRule(ruleId, clinic.id);
    if (!rule) fail('operational_alert_rule_not_found', 404);
    if (rule.archivedAt) {
      return buildUnsupportedPreview({
        tenantId: safeTenantId,
        rule,
        reason: 'operational_alert_rule_archived'
      });
    }
    if (
      rule.eventType !== INVENTORY_EXPIRY_EVENT_TYPE ||
      Number(rule.eventVersion) !== INVENTORY_EXPIRY_EVENT_VERSION ||
      rule.triggerMode !== 'scheduled'
    ) {
      return buildUnsupportedPreview({
        tenantId: safeTenantId,
        rule,
        reason: 'operational_alert_candidate_preview_not_supported'
      });
    }

    const evaluator = dependencies.getEvaluator(rule.eventType, rule.eventVersion);
    if (typeof evaluator !== 'function') {
      return buildUnsupportedPreview({
        tenantId: safeTenantId,
        rule,
        reason: 'operational_alert_candidate_preview_evaluator_not_registered'
      });
    }

    const evaluatedAt = dependencies.now();
    // Preview before enabling is intentional: this clone never reaches persistence and
    // keeps eligibility, digest construction, ordering, and truncation in the live evaluator.
    const evaluatedRule = { ...rule, enabled: true };
    const result = await evaluator({
      rule: evaluatedRule,
      clinic,
      now: evaluatedAt
    });
    const context = buildInventoryExpiryEvaluationContext({
      rule: evaluatedRule,
      clinic,
      now: evaluatedAt
    });
    const events = Array.isArray(result && result.events) ? result.events : [];
    if (events.length > 1) {
      fail('operational_alert_candidate_preview_event_count_invalid', 500);
    }
    const event = events[0] || null;
    const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : null;
    const candidateCount = payload
      ? safeCount(payload.totalLots)
      : safeCount(result && result.metrics && result.metrics.candidateCount);
    const candidateLotIds = Array.isArray(payload && payload.items)
      ? payload.items.map((item) => normalizeString(item && item.lotId)).filter(Boolean)
      : [];
    // The evaluator intentionally bounds digest items. `candidateCount` remains the
    // exact repository total; the returned IDs are the same ordered subset the live
    // digest would use, and `truncated` makes omissions explicit.
    const truncated = candidateCount > candidateLotIds.length;

    return {
      eventType: rule.eventType,
      eventVersion: Number(rule.eventVersion),
      tenantId: safeTenantId,
      ruleId: rule.id,
      rule: buildPreviewRule(rule),
      evaluatedRuleEnabled: true,
      evaluatedAt: context.evaluatedAt,
      localDate: context.localDate,
      candidateCount,
      candidateLotIds,
      expectedEventCount: events.length,
      expectedDigestCount: events.length,
      digestItemCount: candidateLotIds.length,
      truncated,
      evaluable: true,
      reason: null
    };
  }

  return {
    previewRuleCandidates
  };
}

const defaultService = createOperationalAlertCandidatePreviewService();

module.exports = {
  ...defaultService,
  createOperationalAlertCandidatePreviewService,
  OperationalAlertCandidatePreviewError
};
