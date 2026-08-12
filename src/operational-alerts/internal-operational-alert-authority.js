const { normalizeString, isPlainObject } = require('./operational-alert-validation');
const { OPERATIONAL_ALERT_TEMPLATE_CONTRACT } = require('./operational-alert-formatter');
const { evaluateWhatsAppTemplateSyncFreshness } = require('../whatsapp/whatsapp-template-domain');

function parseSettings(value) {
  if (isPlainObject(value)) return value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isOperationalAlertsEnabled(clinic) {
  return parseSettings(clinic && clinic.settings).operationalAlertsEnabled === true;
}

function denied(resultCode, reason, status = 'skipped') {
  return { allowed: false, status, resultCode, reason };
}

function hasLiveLease(delivery, workerId, now) {
  const leaseExpiry = new Date(delivery && delivery.leaseExpiresAt).getTime();
  return Boolean(
    delivery &&
    delivery.status === 'sending' &&
    normalizeString(delivery.lockedBy) === normalizeString(workerId) &&
    Number.isFinite(leaseExpiry) &&
    leaseExpiry > now.getTime()
  );
}

function evaluateInternalOperationalAlertAuthority(input) {
  const now = input && input.now ? new Date(input.now) : new Date();
  const clinic = input && input.clinic;
  const currentRule = input && input.currentRule;
  const ruleSnapshot = input && input.ruleSnapshot;
  const delivery = input && input.delivery;
  const recipient = input && input.recipient;
  const recipientSnapshot = delivery && delivery.recipientSnapshot;
  const staff = input && input.staff;
  const channel = input && input.channel;
  const template = input && input.template;
  const clinicId = normalizeString(delivery && delivery.clinicId);

  if (!clinic || normalizeString(clinic.id) !== clinicId) {
    return denied('clinic_scope_invalid', 'clinic_not_found_in_delivery_tenant', 'failed_permanent');
  }
  if (!isOperationalAlertsEnabled(clinic)) {
    return denied('feature_disabled', 'operational_alerts_feature_disabled');
  }
  if (!hasLiveLease(delivery, input && input.workerId, now)) {
    return denied('delivery_lease_not_owned', 'delivery_lease_missing_expired_or_not_owned', 'failed_permanent');
  }
  if (
    !currentRule || normalizeString(currentRule.clinicId) !== clinicId ||
    normalizeString(currentRule.id) !== normalizeString(ruleSnapshot && ruleSnapshot.id)
  ) {
    return denied('rule_scope_invalid', 'rule_not_found_in_delivery_tenant', 'failed_permanent');
  }
  if (currentRule.enabled !== true || currentRule.archivedAt) {
    return denied('rule_not_active', 'rule_disabled_or_archived');
  }
  if (!recipient || normalizeString(recipient.clinicId) !== clinicId) {
    return denied('recipient_scope_invalid', 'recipient_not_found_in_delivery_tenant', 'failed_permanent');
  }
  if (recipient.active !== true) return denied('recipient_inactive', 'recipient_not_active');
  if (recipient.consentStatus !== 'granted') {
    return denied(
      recipient.consentStatus === 'revoked' ? 'recipient_consent_revoked' : 'recipient_consent_missing',
      'recipient_consent_not_granted'
    );
  }
  if (!/^\+[1-9][0-9]{7,14}$/.test(normalizeString(recipient.phoneE164))) {
    return denied('recipient_phone_invalid', 'recipient_phone_is_not_e164', 'failed_permanent');
  }
  if (
    Number(recipient.version) !== Number(delivery.recipientVersion) ||
    normalizeString(recipient.phoneE164) !== normalizeString(recipientSnapshot && recipientSnapshot.phoneE164)
  ) {
    return denied('recipient_changed_before_send', 'recipient_version_or_phone_changed', 'failed_permanent');
  }
  if (recipient.staffUserId) {
    if (
      !staff || normalizeString(staff.id) !== normalizeString(recipient.staffUserId) ||
      normalizeString(staff.clinicId) !== clinicId || staff.active !== true
    ) {
      return denied('staff_inactive', 'linked_staff_missing_inactive_or_cross_tenant');
    }
  }

  const expectedChannelId = normalizeString(ruleSnapshot && ruleSnapshot.channelId);
  if (!expectedChannelId || normalizeString(delivery.channelId) !== expectedChannelId) {
    return denied('channel_not_configured', 'rule_snapshot_has_no_explicit_channel', 'failed_permanent');
  }
  if (!channel || normalizeString(channel.id) !== expectedChannelId || normalizeString(channel.clinicId) !== clinicId) {
    return denied('channel_scope_invalid', 'channel_missing_or_cross_tenant', 'failed_permanent');
  }
  if (
    normalizeString(channel.provider).toLowerCase() !== 'whatsapp_cloud' ||
    normalizeString(channel.status).toLowerCase() !== 'active' ||
    !normalizeString(channel.phoneNumberId) ||
    !normalizeString(channel.accessToken) ||
    !normalizeString(channel.wabaId)
  ) {
    return denied('channel_not_active', 'whatsapp_channel_inactive_or_incomplete');
  }

  const templateKey = normalizeString(ruleSnapshot && ruleSnapshot.templateKey);
  const templateLanguage = normalizeString(ruleSnapshot && ruleSnapshot.templateLanguage);
  if (!templateKey || !templateLanguage) {
    return denied('template_not_configured', 'rule_snapshot_template_identity_missing');
  }
  if (!template) return denied('template_not_configured', 'template_candidate_not_found');
  if (
    normalizeString(template.clinicId) !== clinicId ||
    normalizeString(template.channelId) !== expectedChannelId ||
    normalizeString(template.wabaId) !== normalizeString(channel.wabaId) ||
    normalizeString(template.templateKey) !== templateKey ||
    normalizeString(template.language) !== templateLanguage
  ) {
    return denied('template_scope_mismatch', 'template_channel_or_waba_scope_mismatch', 'failed_permanent');
  }
  if (normalizeString(template.status).toLowerCase() !== 'approved') {
    return denied('template_not_approved', 'template_status_not_approved');
  }
  if (normalizeString(template.category).toUpperCase() !== 'UTILITY') {
    return denied('template_contract_invalid', 'template_category_not_utility', 'failed_permanent');
  }
  if (
    !normalizeString(template.metaTemplateName) ||
    !isPlainObject(template.metadata) ||
    template.metadata.operationalAlertContract !== OPERATIONAL_ALERT_TEMPLATE_CONTRACT
  ) {
    return denied('template_contract_invalid', 'template_contract_metadata_invalid', 'failed_permanent');
  }
  if (!evaluateWhatsAppTemplateSyncFreshness(template.lastSyncedAt, { now }).fresh) {
    return denied('template_sync_stale', 'template_metadata_must_be_synchronized_again');
  }

  return {
    allowed: true,
    status: 'sending',
    resultCode: 'internal_operational_alert_authorized',
    reason: 'all_operational_alert_authority_guards_passed'
  };
}

const INTERNAL_OPERATIONAL_ALERT_AUTHORITY = Object.freeze({
  evaluate: evaluateInternalOperationalAlertAuthority,
  isEnabled: isOperationalAlertsEnabled
});

module.exports = {
  INTERNAL_OPERATIONAL_ALERT_AUTHORITY,
  isOperationalAlertsEnabled,
  evaluateInternalOperationalAlertAuthority
};
