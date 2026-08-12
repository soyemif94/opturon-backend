const {
  evaluateInventoryExpiryAlert
} = require('../services/inventory-expiry-alert-producer.service');

const SCHEDULED_EVALUATORS = new Map([
  ['inventory.lot_expiring@1', evaluateInventoryExpiryAlert]
]);

function getScheduledOperationalAlertEvaluator(eventType, eventVersion) {
  return SCHEDULED_EVALUATORS.get(`${String(eventType || '').trim()}@${Number(eventVersion)}`) || null;
}

function listScheduledOperationalAlertEvaluators() {
  return Array.from(SCHEDULED_EVALUATORS.keys()).sort();
}

module.exports = {
  getScheduledOperationalAlertEvaluator,
  listScheduledOperationalAlertEvaluators
};
