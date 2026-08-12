const candidateRepository = require('../repositories/inventory-expiry-alerts.repository');
const {
  assertOperationalAlertRuleConfig
} = require('../operational-alerts/operational-alert-registry');
const {
  INVENTORY_EXPIRY_EVENT_TYPE,
  INVENTORY_EXPIRY_EVENT_VERSION,
  buildInventoryExpiryEvaluationContext,
  buildInventoryExpiryDigest
} = require('../operational-alerts/inventory-lot-expiry-alert');
const { contractError } = require('../operational-alerts/operational-alert-validation');
const { logInfo, logWarn } = require('../utils/logger');

function safeId(value) {
  return String(value || '').slice(0, 8) || null;
}

function createInventoryExpiryAlertProducer(overrides = {}) {
  const dependencies = {
    listCandidates: candidateRepository.listInventoryExpiryAlertCandidates,
    logInfo,
    logWarn,
    clock: () => Date.now(),
    ...overrides
  };

  return async function evaluateInventoryExpiryAlert({ rule, clinic, now }) {
    if (!rule || rule.enabled !== true) {
      return { events: [], nextEvaluationAt: null, outcome: 'rule_disabled' };
    }
    if (!clinic || String(clinic.id || '') !== String(rule.clinicId || '')) {
      throw contractError('inventory_expiry_evaluation_tenant_mismatch');
    }
    const config = assertOperationalAlertRuleConfig(rule);
    if (
      config.eventType !== INVENTORY_EXPIRY_EVENT_TYPE ||
      config.eventVersion !== INVENTORY_EXPIRY_EVENT_VERSION ||
      config.triggerMode !== 'scheduled'
    ) {
      throw contractError('inventory_expiry_evaluation_rule_contract_mismatch');
    }

    const startedAt = dependencies.clock();
    const context = buildInventoryExpiryEvaluationContext({ rule: config, clinic, now });
    const logContext = {
      clinicId: safeId(rule.clinicId),
      ruleId: safeId(rule.id),
      configVersion: Number(rule.configVersion),
      threshold: context.daysBefore,
      localDate: context.localDate
    };
    dependencies.logInfo('inventory_expiry_evaluation_started', logContext);

    try {
      const candidates = await dependencies.listCandidates({
        clinicId: rule.clinicId,
        rangeStartDate: context.rangeStartDate,
        rangeEndDate: context.rangeEndDate,
        quantityBasis: context.quantityBasis,
        minimumAvailableQuantity: context.minimumAvailableQuantity
      });
      const event = buildInventoryExpiryDigest({ rule, context, candidates });
      const durationMs = Math.max(0, dependencies.clock() - startedAt);
      if (!event) {
        dependencies.logInfo('inventory_expiry_evaluation_no_match', {
          ...logContext,
          candidateCount: Number(candidates && candidates.totalLots || 0),
          digestCount: 0,
          durationMs
        });
        return {
          events: [],
          nextEvaluationAt: context.nextEvaluationAt,
          outcome: 'no_match',
          metrics: { candidateCount: Number(candidates && candidates.totalLots || 0), digestCount: 0 }
        };
      }

      return {
        events: [event],
        nextEvaluationAt: context.nextEvaluationAt,
        outcome: 'digest_ready',
        metrics: {
          candidateCount: Number(candidates.totalLots || 0),
          digestCount: event.payload.items.length,
          durationMs
        }
      };
    } catch (error) {
      dependencies.logWarn('inventory_expiry_evaluation_failed', {
        ...logContext,
        candidateCount: 0,
        digestCount: 0,
        durationMs: Math.max(0, dependencies.clock() - startedAt),
        resultCode: String(error && error.code || 'inventory_expiry_evaluation_failed').slice(0, 100)
      });
      throw error;
    }
  };
}

const evaluateInventoryExpiryAlert = createInventoryExpiryAlertProducer();

module.exports = {
  createInventoryExpiryAlertProducer,
  evaluateInventoryExpiryAlert
};
