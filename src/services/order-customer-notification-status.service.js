const {
  findChannelByPhoneNumberId,
  findWhatsAppChannelByPhoneNumberIdIncludingInactive
} = require('../repositories/tenant.repository');
const {
  reconcileOrderCustomerNotificationDeliveryStatus
} = require('../repositories/order-customer-notifications.repository');
const { extractWhatsAppStatusEvents } = require('../webhooks/meta.webhook');

function sanitizeText(value, maxLength = 500) {
  const safe = String(value || '').replace(/\s+/g, ' ').trim();
  if (!safe) return null;
  return safe
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]')
    .slice(0, maxLength);
}

function normalizeOccurredAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && String(value).trim().match(/^\d+$/)
    ? new Date(numeric * 1000)
    : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sanitizeFailedStatusMetadata(event) {
  const errors = (Array.isArray(event && event.errors) ? event.errors : [])
    .slice(0, 5)
    .map((error) => {
      const rawCode = error && error.code;
      return {
        code: rawCode !== null && rawCode !== undefined && rawCode !== '' && Number.isFinite(Number(rawCode))
          ? Number(rawCode)
          : null,
        title: sanitizeText(error && error.title, 200),
        message: sanitizeText(error && error.message, 500),
        details: sanitizeText(error && error.error_data && error.error_data.details, 500)
      };
    });

  return {
    reason: 'whatsapp_delivery_failed',
    retriable: false,
    providerStatus: 'failed',
    errors
  };
}

async function reconcileOrderCustomerNotificationStatuses(payload, options = {}) {
  const dependencies = {
    findChannelByPhoneNumberId:
      findWhatsAppChannelByPhoneNumberIdIncludingInactive || findChannelByPhoneNumberId,
    reconcileStatus: reconcileOrderCustomerNotificationDeliveryStatus,
    ...(options.dependencies || {})
  };
  const events = extractWhatsAppStatusEvents(payload);
  const stats = { observed: events.length, matched: 0, ignored: 0 };

  for (const event of events) {
    if (!['sent', 'delivered', 'read', 'failed'].includes(event.status)) {
      stats.ignored += 1;
      continue;
    }
    const channel = event.phoneNumberId
      ? await dependencies.findChannelByPhoneNumberId(event.phoneNumberId)
      : null;
    if (!channel) {
      stats.ignored += 1;
      continue;
    }

    const notification = await dependencies.reconcileStatus({
      clinicId: channel.clinicId,
      channelId: channel.id,
      providerMessageId: event.providerMessageId,
      status: event.status,
      occurredAt: normalizeOccurredAt(event.timestamp),
      failureMetadata: event.status === 'failed' ? sanitizeFailedStatusMetadata(event) : null
    });
    if (notification) stats.matched += 1;
    else stats.ignored += 1;
  }

  return stats;
}

module.exports = {
  normalizeOccurredAt,
  sanitizeFailedStatusMetadata,
  reconcileOrderCustomerNotificationStatuses
};
