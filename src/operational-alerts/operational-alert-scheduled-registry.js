const SCHEDULED_EVALUATORS = new Map();

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
