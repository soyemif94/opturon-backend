const { loadEntitlements } = require('./bot-entitlement-guard');
const { canBotRespond } = require('./effective-entitlements');
const { findAiProvisioning, getAiUsageSummary } = require('../repositories/ai-provisioning.repository');

function isModernAssistantAuthorityEligible({ entitlements, clinicId, channel, provisioning, usage } = {}) {
  return Boolean(
    clinicId &&
    canBotRespond(entitlements, channel, clinicId) &&
    provisioning && provisioning.status === 'ready' &&
    usage && usage.quotaAvailable === true
  );
}

async function isModernAssistantAuthorityReady(clinicId, channel, dependencies = {}) {
  const load = dependencies.loadEntitlements || loadEntitlements;
  const findProvisioning = dependencies.findAiProvisioning || findAiProvisioning;
  const getUsage = dependencies.getAiUsageSummary || getAiUsageSummary;
  try {
    const entitlements = await load(clinicId);
    if (!canBotRespond(entitlements, channel, clinicId)) return false;

    const provisioning = await findProvisioning(clinicId);
    if (!provisioning || provisioning.status !== 'ready') return false;

    const usage = await getUsage(clinicId, provisioning);
    return isModernAssistantAuthorityEligible({ entitlements, clinicId, channel, provisioning, usage });
  } catch {
    // Missing schemas or unavailable quota state leave historical automation
    // compatibility in place; the normal bot entitlement gate still applies.
    return false;
  }
}

module.exports = { isModernAssistantAuthorityEligible, isModernAssistantAuthorityReady };
