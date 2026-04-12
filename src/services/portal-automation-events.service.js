const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  listAutomationActionEventsByClinicAndTemplate,
  getAutomationActionEventSummaryByClinicAndTemplate
} = require('../repositories/automation-action-events.repository');
const { findAutomationTemplateByKey } = require('../repositories/automation-templates.repository');

function normalizeString(value) {
  return String(value || '').trim();
}

function buildReason(reason, detail = null, extra = null) {
  return {
    ok: false,
    reason,
    detail,
    ...(extra || {})
  };
}

async function getPortalAutomationActionMetrics(tenantId, templateKey, options = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeTemplateKey = normalizeString(templateKey);
  if (!safeTemplateKey) {
    return buildReason('missing_automation_template_key', null, { tenantId: context.tenantId });
  }

  const template = await findAutomationTemplateByKey(safeTemplateKey);
  if (!template) {
    return buildReason('automation_template_not_found', null, { tenantId: context.tenantId });
  }

  const [summary, events] = await Promise.all([
    getAutomationActionEventSummaryByClinicAndTemplate(context.clinic.id, safeTemplateKey),
    listAutomationActionEventsByClinicAndTemplate(context.clinic.id, safeTemplateKey, {
      limit: options.limit
    })
  ]);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    template,
    summary,
    events
  };
}

module.exports = {
  getPortalAutomationActionMetrics
};
