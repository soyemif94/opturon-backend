const operationalAlerts = require('../services/portal-operational-alerts.service');
const { logError } = require('../utils/logger');

function tenantId(req) {
  return String(req.activeTenantId || req.params.tenantId || '').trim();
}

function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
}

function parseOptionalBoolean(value) {
  if (value === undefined) return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return null;
}

function sendError(req, res, error) {
  const status = Number(error && error.status) || 500;
  const code = status < 500 && error && error.code
    ? error.code
    : 'portal_operational_alerts_request_failed';
  if (status >= 500) {
    logError('portal_operational_alerts_request_failed', {
      method: req.method,
      path: req.path,
      code: error && error.code ? String(error.code).slice(0, 120) : null
    });
  }
  return res.status(status).json({
    success: false,
    error: code,
    ...(status < 500 && error && error.details ? { details: error.details } : {})
  });
}

async function respond(req, res, work, status = 200) {
  noStore(res);
  try {
    const data = await work();
    return res.status(status).json({ success: true, data });
  } catch (error) {
    return sendError(req, res, error);
  }
}

function getOperationalAlertEventTypes(req, res) {
  return respond(req, res, () => operationalAlerts.getEventTypes(tenantId(req)));
}

function getOperationalAlertSettings(req, res) {
  return respond(req, res, () => operationalAlerts.getSettings(tenantId(req)));
}

function getOperationalAlertRecipients(req, res) {
  return respond(req, res, () => operationalAlerts.listRecipients(tenantId(req), {
    limit: req.query.limit
  }));
}

function getOperationalAlertRecipient(req, res) {
  return respond(req, res, () => operationalAlerts.getRecipient(
    tenantId(req),
    req.params.recipientId
  ));
}

function postOperationalAlertRecipient(req, res) {
  return respond(req, res, () => operationalAlerts.createRecipient(
    tenantId(req),
    req.body,
    req.operationalAlertsActor
  ), 201);
}

function patchOperationalAlertRecipient(req, res) {
  return respond(req, res, () => operationalAlerts.updateRecipient(
    tenantId(req),
    req.params.recipientId,
    req.body,
    req.operationalAlertsActor
  ));
}

function postOperationalAlertRecipientDisable(req, res) {
  return respond(req, res, () => operationalAlerts.disableRecipient(
    tenantId(req),
    req.params.recipientId,
    req.body,
    req.operationalAlertsActor
  ));
}

function postOperationalAlertRecipientConsent(req, res) {
  return respond(req, res, () => operationalAlerts.updateRecipientConsent(
    tenantId(req),
    req.params.recipientId,
    req.body,
    req.operationalAlertsActor
  ));
}

function getOperationalAlertRules(req, res) {
  const enabled = parseOptionalBoolean(req.query.enabled);
  const includeArchived = parseOptionalBoolean(req.query.includeArchived);
  if (enabled === null || includeArchived === null) {
    noStore(res);
    return res.status(400).json({ success: false, error: 'operational_alert_rule_filters_invalid' });
  }
  return respond(req, res, () => operationalAlerts.listRules(tenantId(req), {
    limit: req.query.limit,
    eventType: req.query.eventType,
    enabled,
    includeArchived
  }));
}

function getOperationalAlertRule(req, res) {
  return respond(req, res, () => operationalAlerts.getRule(tenantId(req), req.params.ruleId));
}

function postOperationalAlertRule(req, res) {
  return respond(req, res, () => operationalAlerts.createRule(
    tenantId(req),
    req.body,
    req.operationalAlertsActor
  ), 201);
}

function patchOperationalAlertRule(req, res) {
  return respond(req, res, () => operationalAlerts.updateRule(
    tenantId(req),
    req.params.ruleId,
    req.body,
    req.operationalAlertsActor
  ));
}

function putOperationalAlertRuleRecipients(req, res) {
  return respond(req, res, () => operationalAlerts.replaceRuleRecipients(
    tenantId(req),
    req.params.ruleId,
    req.body,
    req.operationalAlertsActor
  ));
}

function getOperationalAlertRuleReadiness(req, res) {
  return respond(req, res, () => operationalAlerts.getRuleReadiness(
    tenantId(req),
    req.params.ruleId
  ));
}

function postOperationalAlertRuleEnable(req, res) {
  return respond(req, res, () => operationalAlerts.enableRule(
    tenantId(req),
    req.params.ruleId,
    req.body,
    req.operationalAlertsActor
  ));
}

function postOperationalAlertRuleDisable(req, res) {
  return respond(req, res, () => operationalAlerts.disableRule(
    tenantId(req),
    req.params.ruleId,
    req.body,
    req.operationalAlertsActor
  ));
}

function postOperationalAlertRulePreview(req, res) {
  return respond(req, res, () => operationalAlerts.previewRule(
    tenantId(req),
    req.params.ruleId,
    req.body
  ));
}

function getOperationalAlertHistory(req, res) {
  return respond(req, res, () => operationalAlerts.getHistory(tenantId(req), req.query));
}

function getOperationalAlertHistoryDetail(req, res) {
  return respond(req, res, () => operationalAlerts.getHistoryDetail(
    tenantId(req),
    req.params.instanceId
  ));
}

module.exports = {
  getOperationalAlertEventTypes,
  getOperationalAlertSettings,
  getOperationalAlertRecipients,
  getOperationalAlertRecipient,
  postOperationalAlertRecipient,
  patchOperationalAlertRecipient,
  postOperationalAlertRecipientDisable,
  postOperationalAlertRecipientConsent,
  getOperationalAlertRules,
  getOperationalAlertRule,
  postOperationalAlertRule,
  patchOperationalAlertRule,
  putOperationalAlertRuleRecipients,
  getOperationalAlertRuleReadiness,
  postOperationalAlertRuleEnable,
  postOperationalAlertRuleDisable,
  postOperationalAlertRulePreview,
  getOperationalAlertHistory,
  getOperationalAlertHistoryDetail
};
