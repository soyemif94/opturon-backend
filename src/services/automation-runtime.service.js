const { DateTime } = require('luxon');
const { listAutomationsByClinicId } = require('../repositories/automations.repository');

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractBusinessHoursWindow(clinic) {
  const openingHours = String(clinic?.settings?.businessProfile?.openingHours || '').trim();
  if (!openingHours) return null;

  const matches = openingHours.match(/(\d{1,2}:\d{2})/g);
  if (!matches || matches.length < 2) return null;

  return {
    start: matches[0],
    end: matches[1],
    raw: openingHours
  };
}

function isOutsideBusinessHours(clinic) {
  const window = extractBusinessHoursWindow(clinic);
  if (!window) return false;

  const timezone = clinic?.timezone || 'America/Argentina/Buenos_Aires';
  const now = DateTime.now().setZone(timezone);
  const [startHour, startMinute] = window.start.split(':').map((value) => Number(value));
  const [endHour, endMinute] = window.end.split(':').map((value) => Number(value));

  if (!Number.isFinite(startHour) || !Number.isFinite(startMinute) || !Number.isFinite(endHour) || !Number.isFinite(endMinute)) {
    return false;
  }

  const currentMinutes = now.hour * 60 + now.minute;
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;

  const raw = normalizeText(window.raw);
  const weekday = now.weekday;
  const weekdaysOnly = raw.includes('lun') || raw.includes('vie');
  if (weekdaysOnly && (weekday === 6 || weekday === 7)) {
    return true;
  }

  return currentMinutes < startMinutes || currentMinutes > endMinutes;
}

function buildContextPatchFromActions(actions, currentContext) {
  const patch = {};
  const safeContext = currentContext && typeof currentContext === 'object' ? currentContext : {};

  actions.forEach((action) => {
    if (!action || !action.type) return;

    if (action.type === 'assign_human') {
      patch.portalAssignedTo = safeContext.portalAssignedTo || 'Equipo';
      patch.portalAssignedToUserId = safeContext.portalAssignedToUserId || null;
      patch.portalPriority = 'hot';
    }

    if (action.type === 'tag_contact' && action.tag) {
      const currentTags = Array.isArray(safeContext.portalTags) ? safeContext.portalTags : [];
      const nextTags = new Set(
        [...currentTags, String(action.tag || '').trim()]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      );
      patch.portalTags = Array.from(nextTags);
    }
  });

  return Object.keys(patch).length ? patch : null;
}

function matchesAutomationTrigger(automation, inboundText, clinic, isNewContact) {
  const triggerType = String(automation?.trigger?.type || '').trim().toLowerCase();
  const normalizedInbound = normalizeText(inboundText);

  if (!triggerType) return false;
  if (triggerType === 'message_received') return Boolean(normalizedInbound);
  if (triggerType === 'new_contact') return isNewContact;
  if (triggerType === 'off_hours') return Boolean(normalizedInbound) && isOutsideBusinessHours(clinic);
  if (triggerType === 'keyword') {
    const keyword = normalizeText(automation?.trigger?.keyword);
    return Boolean(keyword) && normalizedInbound.includes(keyword);
  }
  return false;
}

async function resolveAutomationReplyForInbound({ clinic, conversation, inboundText, recentMessages = [] }) {
  if (!clinic?.id || !conversation?.id) {
    return { matched: [], contextPatch: null, replyText: null };
  }

  const automations = await listAutomationsByClinicId(clinic.id);
  const enabledAutomations = automations.filter((automation) => automation && automation.enabled);
  if (!enabledAutomations.length) {
    return { matched: [], contextPatch: null, replyText: null };
  }

  const isNewContact =
    Array.isArray(recentMessages) &&
    recentMessages.filter((message) => String(message.direction || '').toLowerCase() === 'inbound').length === 1 &&
    recentMessages.length === 1;

  const matched = enabledAutomations.filter((automation) =>
    matchesAutomationTrigger(automation, inboundText, clinic, isNewContact)
  );

  if (!matched.length) {
    return { matched: [], contextPatch: null, replyText: null };
  }

  const contextPatch = matched.reduce((acc, automation) => {
    const nextPatch = buildContextPatchFromActions(automation.actions || [], conversation.context || {});
    if (!nextPatch) return acc;

    const merged = { ...(acc || {}), ...nextPatch };
    if (Array.isArray(acc?.portalTags) || Array.isArray(nextPatch.portalTags)) {
      merged.portalTags = Array.from(
        new Set([...(Array.isArray(acc?.portalTags) ? acc.portalTags : []), ...(Array.isArray(nextPatch.portalTags) ? nextPatch.portalTags : [])])
      );
    }
    return merged;
  }, null);

  let replyText = null;
  for (const automation of matched) {
    const sendMessageAction = Array.isArray(automation.actions)
      ? automation.actions.find((action) => action && action.type === 'send_message' && String(action.message || '').trim())
      : null;
    if (sendMessageAction) {
      replyText = String(sendMessageAction.message || '').trim();
      break;
    }
  }

  return {
    matched,
    contextPatch,
    replyText
  };
}

module.exports = {
  resolveAutomationReplyForInbound
};
