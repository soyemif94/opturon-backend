const { resolvePortalTenantContext } = require('./portal-context.service');
const { createAutomation, listAutomationsByClinicId } = require('../repositories/automations.repository');

const ALLOWED_TRIGGERS = new Set(['message_received', 'keyword', 'off_hours', 'new_contact']);
const ALLOWED_ACTIONS = new Set(['send_message', 'assign_human', 'tag_contact']);

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

function normalizeTrigger(payload) {
  const type = normalizeString(payload && payload.type).toLowerCase();
  return {
    type,
    keyword: normalizeString(payload && payload.keyword) || null
  };
}

function normalizeConditions(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }

  const normalized = { ...payload };

  if (normalized.priority !== undefined && normalized.priority !== null && normalized.priority !== '') {
    const parsedPriority = Number(normalized.priority);
    normalized.priority = Number.isFinite(parsedPriority) ? parsedPriority : undefined;
  }

  if (Array.isArray(normalized.exactKeywords)) {
    normalized.exactKeywords = normalized.exactKeywords.map((item) => normalizeString(item)).filter(Boolean);
  }

  if (Array.isArray(normalized.containsKeywords)) {
    normalized.containsKeywords = normalized.containsKeywords.map((item) => normalizeString(item)).filter(Boolean);
  }

  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

function normalizeActions(payload) {
  const items = Array.isArray(payload) ? payload : [];
  return items
    .map((item) => ({
      type: normalizeString(item && item.type).toLowerCase(),
      message: normalizeString(item && item.message) || null,
      tag: normalizeString(item && item.tag) || null
    }))
    .filter((item) => item.type);
}

function validateAutomationPayload(input) {
  if (!input.name) return 'missing_automation_name';
  if (!ALLOWED_TRIGGERS.has(input.trigger.type)) return 'invalid_automation_trigger';
  if (input.trigger.type === 'keyword' && !input.trigger.keyword) return 'missing_automation_keyword';
  if (!Array.isArray(input.actions) || input.actions.length === 0) return 'missing_automation_actions';

  for (const action of input.actions) {
    if (!ALLOWED_ACTIONS.has(action.type)) return 'invalid_automation_action';
    if (action.type === 'send_message' && !action.message) return 'missing_automation_message';
    if (action.type === 'tag_contact' && !action.tag) return 'missing_automation_tag';
  }

  return null;
}

async function listPortalAutomations(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const automations = await listAutomationsByClinicId(context.clinic.id);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    automations
  };
}

async function createPortalAutomation(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const input = {
    name: normalizeString(payload && payload.name),
    trigger: normalizeTrigger(payload && payload.trigger),
    conditions: normalizeConditions(payload && payload.conditions),
    actions: normalizeActions(payload && payload.actions),
    enabled: payload && payload.enabled !== false
  };

  const reason = validateAutomationPayload(input);
  if (reason) {
    return buildReason(reason, null, { tenantId: context.tenantId });
  }

  const automation = await createAutomation({
    clinicId: context.clinic.id,
    externalTenantId: context.tenantId,
    ...input
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    automation
  };
}

module.exports = {
  ALLOWED_TRIGGERS: Array.from(ALLOWED_TRIGGERS),
  ALLOWED_ACTIONS: Array.from(ALLOWED_ACTIONS),
  listPortalAutomations,
  createPortalAutomation
};
