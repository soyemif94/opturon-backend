const { findOrderById } = require('../repositories/orders.repository');
const notificationRepository = require('../repositories/order-customer-notifications.repository');
const { findContactByIdAndClinicId } = require('../repositories/contact.repository');
const {
  getClinicBusinessProfileById,
  listWhatsAppChannelsByClinicId
} = require('../repositories/tenant.repository');
const conversationRepo = require('../conversations/conversation.repo');
const {
  findApprovedUtilityOrderSummaryTemplate
} = require('../repositories/whatsapp-templates.repository');
const { sendChannelScopedMessage } = require('../whatsapp/whatsapp.service');
const { normalizeWhatsAppTo } = require('../whatsapp/normalize-phone');
const { buildTenantPolicyFromSettings } = require('./tenant-policy.service');
const { evaluateCustomerServiceWindow } = require('./whatsapp-customer-service-window.service');
const { formatOrderCustomerSummary } = require('./order-customer-summary-formatter.service');
const { logInfo, logWarn } = require('../utils/logger');

const ORDER_SUMMARY_TEMPLATE_KEY = 'order_summary';
const DEFAULT_TEMPLATE_LANGUAGE = 'es_AR';
const MAX_ATTEMPTS = 5;
const RETRYABLE_GRAPH_STATUSES = new Set([429, 500, 502, 503, 504]);
const PERMANENT_GRAPH_STATUSES = new Set([400, 401, 403]);

const DEFAULT_DEPENDENCIES = Object.freeze({
  claimNotifications: notificationRepository.claimOrderCustomerNotifications,
  updateRouting: notificationRepository.updateOrderCustomerNotificationRouting,
  markGraphRequestStarted: notificationRepository.markOrderCustomerNotificationGraphRequestStarted,
  updateStatus: notificationRepository.updateOrderCustomerNotificationStatus,
  mergeMetadata: notificationRepository.mergeOrderCustomerNotificationMetadata,
  listInboxRecovery: notificationRepository.listOrderCustomerNotificationsNeedingInboxRecovery,
  findOrderById,
  findContactByIdAndClinicId,
  getClinicById: getClinicBusinessProfileById,
  listWhatsAppChannelsByClinicId,
  getConversationByIdAndClinicId: conversationRepo.getConversationByIdAndClinicId,
  listConversationsByContactIdAndClinicId: conversationRepo.listConversationsByContactIdAndClinicId,
  findLastInboundAtForConversationScope: conversationRepo.findLastInboundAtForConversationScope,
  findApprovedUtilityOrderSummaryTemplate,
  sendChannelScopedMessage,
  insertOutboundMessage: conversationRepo.insertOutboundMessage
});

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeText(value, maxLength = 500) {
  const safe = String(value || '').replace(/\s+/g, ' ').trim();
  return safe ? safe.slice(0, maxLength) : null;
}

function sanitizeDiagnosticText(value) {
  const safe = normalizeText(value, 1000);
  if (!safe) return null;
  return safe
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url-redacted]')
    .slice(0, 500);
}

function getOrderCustomerNotificationConfig(clinic) {
  const settings = parseObject(clinic && clinic.settings);
  const config = settings.orderCustomerNotification && typeof settings.orderCustomerNotification === 'object'
    ? settings.orderCustomerNotification
    : {};
  return {
    enabled: settings.orderCustomerNotificationEnabled === true,
    templateLanguage: normalizeText(config.templateLanguage, 35) || DEFAULT_TEMPLATE_LANGUAGE,
    settings
  };
}

function isOrderCustomerNotificationEnabled(clinic) {
  return getOrderCustomerNotificationConfig(clinic).enabled;
}

function hasValidNotificationSnapshotIdentity(notification) {
  const snapshot = parseObject(notification && notification.snapshot);
  return Boolean(
    notification &&
    notification.notificationType === ORDER_SUMMARY_TEMPLATE_KEY &&
    Number(snapshot.schemaVersion) === 1 &&
    snapshot.notificationType === ORDER_SUMMARY_TEMPLATE_KEY &&
    notification.clinicId &&
    notification.orderId &&
    notification.contactId &&
    String(snapshot.clinicId || '') === String(notification.clinicId) &&
    String(snapshot.orderId || '') === String(notification.orderId) &&
    String(snapshot.contactId || '') === String(notification.contactId) &&
    Number(snapshot.finalizationVersion || 0) === Number(notification.finalizationVersion || 0)
  );
}

function evaluateTenantNotificationPolicy(clinic) {
  const config = getOrderCustomerNotificationConfig(clinic);
  if (!config.enabled) {
    return {
      allowed: false,
      status: 'failed_permanent',
      resultCode: 'skipped_feature_disabled',
      reason: 'feature_flag_disabled',
      config
    };
  }

  const policy = buildTenantPolicyFromSettings(config.settings);
  if (policy.enabledModules.orders !== true || policy.enabledModules.inbox !== true) {
    return {
      allowed: false,
      status: 'failed_permanent',
      resultCode: 'skipped_policy',
      reason: 'orders_or_inbox_module_disabled',
      config,
      policy
    };
  }
  const enabledCapabilities = new Set(Array.isArray(policy.capabilities) ? policy.capabilities : []);
  if (
    Number(policy.policyVersion || 0) >= 1 &&
    (!enabledCapabilities.has('orders') || !enabledCapabilities.has('inbox'))
  ) {
    return {
      allowed: false,
      status: 'failed_permanent',
      resultCode: 'skipped_policy',
      reason: 'orders_or_inbox_capability_disabled',
      config,
      policy
    };
  }

  return { allowed: true, reason: 'tenant_policy_allows_transactional_notification', config, policy };
}

function normalizeRecipient(contact) {
  const candidates = [contact && contact.waId, contact && contact.whatsappPhone, contact && contact.phone];
  for (const candidate of candidates) {
    const digits = normalizeWhatsAppTo(candidate);
    if (/^\d{8,15}$/.test(digits)) return digits;
  }
  return null;
}

function isValidWhatsAppChannel(channel, clinicId) {
  return Boolean(
    channel &&
    String(channel.clinicId || '') === String(clinicId || '') &&
    String(channel.provider || '').trim().toLowerCase() === 'whatsapp_cloud' &&
    String(channel.status || '').trim().toLowerCase() === 'active' &&
    normalizeText(channel.phoneNumberId, 200) &&
    normalizeText(channel.accessToken, 10000)
  );
}

function conversationMatchesRoute(conversation, channel, contact) {
  if (!conversation || !channel || !contact) return false;
  const recipient = normalizeRecipient(contact);
  const conversationRecipient = normalizeWhatsAppTo(conversation.waFrom);
  const conversationDestination = normalizeWhatsAppTo(conversation.waTo);
  const channelDestinations = [channel.displayPhoneNumber, channel.phoneNumberId, channel.externalId]
    .map(normalizeWhatsAppTo)
    .filter(Boolean);

  return Boolean(
    recipient &&
    conversationRecipient === recipient &&
    conversationDestination &&
    channelDestinations.includes(conversationDestination)
  );
}

async function resolveNotificationRoute({ notification, contact, dependencies }) {
  const clinicId = notification.clinicId;
  const channels = (await dependencies.listWhatsAppChannelsByClinicId(clinicId))
    .filter((channel) => isValidWhatsAppChannel(channel, clinicId));
  const channelsById = new Map(channels.map((channel) => [String(channel.id), channel]));
  const snapshotConversationId = normalizeText(
    notification.conversationId || (notification.snapshot && notification.snapshot.conversationId),
    100
  );

  if (snapshotConversationId) {
    const conversation = await dependencies.getConversationByIdAndClinicId(snapshotConversationId, clinicId);
    const channel = conversation ? channelsById.get(String(conversation.channelId)) : null;
    if (
      conversation &&
      channel &&
      String(conversation.contactId) === String(contact.id) &&
      conversationMatchesRoute(conversation, channel, contact)
    ) {
      return { ok: true, source: 'snapshot_conversation', conversation, channel };
    }
  }

  const conversations = await dependencies.listConversationsByContactIdAndClinicId(contact.id, clinicId);
  const validConversations = conversations.filter((conversation) => {
    const channel = channelsById.get(String(conversation.channelId));
    return channel && conversationMatchesRoute(conversation, channel, contact);
  });
  if (validConversations.length === 1) {
    const conversation = validConversations[0];
    return {
      ok: true,
      source: 'contact_whatsapp_conversation',
      conversation,
      channel: channelsById.get(String(conversation.channelId))
    };
  }
  if (validConversations.length > 1) {
    return {
      ok: false,
      status: 'failed_permanent',
      resultCode: 'skipped_ambiguous_channel',
      reason: 'multiple_contact_whatsapp_conversations'
    };
  }
  if (channels.length === 0) {
    return {
      ok: false,
      status: 'failed_permanent',
      resultCode: 'skipped_no_whatsapp_channel',
      reason: 'no_active_configured_whatsapp_channel'
    };
  }
  if (channels.length > 1) {
    return {
      ok: false,
      status: 'failed_permanent',
      resultCode: 'skipped_ambiguous_channel',
      reason: 'multiple_active_whatsapp_channels'
    };
  }

  return {
    ok: false,
    status: 'failed_permanent',
    resultCode: 'skipped_no_conversation',
    reason: 'no_safe_outbound_only_conversation_primitive',
    channelId: channels[0].id
  };
}

function extractTemplateComponents(definition) {
  const safe = parseObject(definition);
  if (Array.isArray(safe.components)) return safe.components;
  if (safe.blueprint && Array.isArray(safe.blueprint.components)) return safe.blueprint.components;
  return [];
}

function buildOrderSummaryTemplateSend(template, renderedText) {
  if (!template || normalizeText(template.templateKey) !== ORDER_SUMMARY_TEMPLATE_KEY) return null;
  if (String(template.category || '').trim().toUpperCase() !== 'UTILITY') return null;
  if (String(template.status || '').trim().toLowerCase() !== 'approved') return null;
  if (parseObject(template.metadata).orderSummaryContract !== 'full_text_body_parameter_v1') return null;

  const body = extractTemplateComponents(template.definition)
    .find((component) => String(component && component.type || '').trim().toUpperCase() === 'BODY');
  const bodyText = String(body && body.text || '');
  const placeholders = bodyText.match(/\{\{\d+\}\}/g) || [];
  if (placeholders.length !== 1 || placeholders[0] !== '{{1}}') return null;

  return {
    templateName: normalizeText(template.metaTemplateName, 200),
    languageCode: normalizeText(template.language, 35) || DEFAULT_TEMPLATE_LANGUAGE,
    components: [{
      type: 'body',
      parameters: [{ type: 'text', text: renderedText }]
    }]
  };
}

function buildFailureMetadata(error, extra = {}) {
  const graphStatus = error && error.graphStatus;
  const graphErrorCode = error && error.graphErrorCode;
  const graphErrorSubcode = error && error.graphErrorSubcode;
  return {
    ...extra,
    graphStatus: graphStatus !== null && graphStatus !== undefined && graphStatus !== '' && Number.isFinite(Number(graphStatus))
      ? Number(graphStatus)
      : null,
    graphErrorCode: graphErrorCode !== null && graphErrorCode !== undefined && graphErrorCode !== '' && Number.isFinite(Number(graphErrorCode))
      ? Number(graphErrorCode)
      : null,
    graphErrorSubcode: graphErrorSubcode !== null && graphErrorSubcode !== undefined && graphErrorSubcode !== '' && Number.isFinite(Number(graphErrorSubcode))
      ? Number(graphErrorSubcode)
      : null,
    graphErrorMessage: sanitizeDiagnosticText(error && error.graphErrorMessage),
    errorCode: normalizeText(error && error.code, 100),
    errorMessage: sanitizeDiagnosticText(error && error.message),
    fbtraceId: normalizeText(error && error.fbtrace_id, 200)
  };
}

function classifySendFailure(error, attemptCount, now = new Date()) {
  const rawGraphStatus = error && error.graphStatus;
  const graphStatus = rawGraphStatus !== null && rawGraphStatus !== undefined && rawGraphStatus !== ''
    ? Number(rawGraphStatus)
    : Number.NaN;
  if (RETRYABLE_GRAPH_STATUSES.has(graphStatus)) {
    if (Number(attemptCount || 0) >= MAX_ATTEMPTS) {
      return { status: 'failed_permanent', reason: 'retry_attempts_exhausted', availableAt: null };
    }
    const backoffSeconds = Math.min(300, Math.pow(2, Math.max(1, Number(attemptCount || 1))));
    return {
      status: 'failed_retryable',
      reason: `graph_${graphStatus}_retryable`,
      availableAt: new Date(new Date(now).getTime() + backoffSeconds * 1000).toISOString()
    };
  }

  if (PERMANENT_GRAPH_STATUSES.has(graphStatus) || Number.isFinite(graphStatus)) {
    return {
      status: 'failed_permanent',
      reason: graphStatus === 401 || graphStatus === 403 ? 'whatsapp_channel_configuration_rejected' : `graph_${graphStatus}_permanent`,
      availableAt: null
    };
  }

  const code = String(error && error.code || '').trim().toUpperCase();
  if (code.startsWith('CHANNEL_') || code === 'INVALID_RECIPIENT') {
    return { status: 'failed_permanent', reason: 'local_channel_configuration_error', availableAt: null };
  }

  return { status: 'unknown_delivery', reason: 'network_or_timeout_delivery_ambiguous', availableAt: null };
}

async function persistNotificationInboxMessage({ notification, conversation, channel, recipient, renderedText, dependencies }) {
  const result = await dependencies.insertOutboundMessage({
    clinicId: notification.clinicId,
    channelId: channel.id,
    conversationId: conversation.id,
    waMessageId: notification.providerMessageId,
    from: channel.phoneNumberId || null,
    to: recipient,
    type: 'text',
    text: renderedText,
    raw: {
      transactionalNotification: {
        notificationType: 'order_summary',
        orderId: notification.orderId,
        finalizationVersion: notification.finalizationVersion,
        orderCustomerNotificationId: notification.id,
        idempotencyKey: notification.idempotencyKey,
        clinicId: notification.clinicId,
        channelId: channel.id
      }
    }
  });

  if (!result || !result.row || String(result.row.conversationId) !== String(conversation.id)) {
    throw new Error('order_summary_inbox_idempotency_scope_mismatch');
  }
  return result;
}

async function finishNotification(notification, patch, dependencies) {
  return dependencies.updateStatus(
    notification.id,
    notification.clinicId,
    {
      ...patch,
      expectedLockedBy: notification.lockedBy || null
    }
  );
}

async function processOrderCustomerNotification(notification, options = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...(options.dependencies || {}) };
  const now = options.now ? new Date(options.now) : new Date();
  let graphRequestStarted = false;
  let graphSuccessMessageId = null;

  try {
    if (!hasValidNotificationSnapshotIdentity(notification)) {
      const updated = await finishNotification(notification, {
        status: 'failed_permanent',
        resultCode: 'invalid_notification_snapshot',
        lastError: 'notification_snapshot_identity_mismatch',
        errorMetadata: { reason: 'notification_snapshot_identity_mismatch', retriable: false }
      }, dependencies);
      return { outcome: 'failed_permanent', reason: 'notification_snapshot_identity_mismatch', notification: updated };
    }

    const order = await dependencies.findOrderById(notification.orderId, notification.clinicId);
    if (
      !order ||
      String(order.status || '').trim().toLowerCase() !== 'confirmed' ||
      !order.finalizedAt ||
      Number(order.finalizationVersion || 0) !== Number(notification.finalizationVersion || 0)
    ) {
      const updated = await finishNotification(notification, {
        status: 'failed_permanent',
        resultCode: 'skipped_order_not_finalized',
        lastError: 'order_not_currently_finalized',
        errorMetadata: { reason: 'order_not_currently_finalized', retriable: false }
      }, dependencies);
      return { outcome: 'skipped', reason: 'order_not_currently_finalized', notification: updated };
    }

    const clinic = await dependencies.getClinicById(notification.clinicId);
    const policy = evaluateTenantNotificationPolicy(clinic);
    if (!policy.allowed) {
      const updated = await finishNotification(notification, {
        status: policy.status,
        resultCode: policy.resultCode,
        lastError: policy.reason,
        errorMetadata: { reason: policy.reason, retriable: false }
      }, dependencies);
      return { outcome: 'skipped', reason: policy.reason, notification: updated };
    }

    const contact = notification.contactId
      ? await dependencies.findContactByIdAndClinicId(notification.contactId, notification.clinicId)
      : null;
    if (!contact) {
      const updated = await finishNotification(notification, {
        status: 'skipped_no_contact',
        resultCode: 'skipped_contact_missing',
        lastError: 'contact_not_found_in_tenant',
        errorMetadata: { reason: 'contact_not_found_in_tenant', retriable: false }
      }, dependencies);
      return { outcome: 'skipped', reason: 'contact_not_found_in_tenant', notification: updated };
    }
    const contactStatus = String(contact.status || 'active').trim().toLowerCase();
    if (contact.deletedAt || contact.archivedAt || ['deleted', 'archived'].includes(contactStatus)) {
      const updated = await finishNotification(notification, {
        status: 'skipped_no_contact',
        resultCode: 'skipped_contact_unavailable',
        lastError: 'contact_archived_or_deleted',
        errorMetadata: { reason: 'contact_archived_or_deleted', retriable: false }
      }, dependencies);
      return { outcome: 'skipped', reason: 'contact_archived_or_deleted', notification: updated };
    }
    if (contact.optedOut === true) {
      const updated = await finishNotification(notification, {
        status: 'skipped_no_contact',
        resultCode: 'skipped_opted_out',
        lastError: 'contact_opted_out',
        errorMetadata: { reason: 'contact_opted_out', retriable: false }
      }, dependencies);
      return { outcome: 'skipped', reason: 'contact_opted_out', notification: updated };
    }
    const recipient = normalizeRecipient(contact);
    if (!recipient) {
      const updated = await finishNotification(notification, {
        status: 'skipped_no_contact',
        resultCode: 'skipped_invalid_phone',
        lastError: 'contact_whatsapp_phone_invalid',
        errorMetadata: { reason: 'contact_whatsapp_phone_invalid', retriable: false }
      }, dependencies);
      return { outcome: 'skipped', reason: 'contact_whatsapp_phone_invalid', notification: updated };
    }

    const route = await resolveNotificationRoute({ notification, contact, dependencies });
    if (!route.ok) {
      const updated = await finishNotification(notification, {
        status: route.status,
        resultCode: route.resultCode,
        lastError: route.reason,
        errorMetadata: { reason: route.reason, retriable: false }
      }, dependencies);
      return { outcome: 'skipped', reason: route.reason, notification: updated };
    }

    const routedNotification = await dependencies.updateRouting(
      notification.id,
      notification.clinicId,
      {
        conversationId: route.conversation.id,
        channelId: route.channel.id,
        lockedBy: notification.lockedBy
      }
    );
    if (!routedNotification) {
      return { outcome: 'not_owned', reason: 'notification_lease_not_owned' };
    }
    notification = routedNotification;

    const lastInboundAt = await dependencies.findLastInboundAtForConversationScope({
      conversationId: route.conversation.id,
      clinicId: notification.clinicId,
      channelId: route.channel.id,
      contactId: contact.id
    });
    const window = evaluateCustomerServiceWindow({ lastInboundAt, now });
    const formatted = formatOrderCustomerSummary({
      snapshot: notification.snapshot,
      customerName: contact.name,
      settings: policy.config.settings
    });

    let sendMode = 'freeform';
    let template = null;
    let sendPayload = { to: recipient, text: formatted.text };
    if (!window.allowed) {
      template = route.channel.wabaId
        ? await dependencies.findApprovedUtilityOrderSummaryTemplate({
            clinicId: notification.clinicId,
            channelId: route.channel.id,
            wabaId: route.channel.wabaId,
            language: policy.config.templateLanguage
          })
        : null;
      const templateSend = buildOrderSummaryTemplateSend(template, formatted.text);
      if (!templateSend || !templateSend.templateName) {
        const updated = await finishNotification(notification, {
          status: 'failed_permanent',
          resultCode: 'skipped_not_configured',
          lastError: 'approved_order_summary_utility_template_not_configured',
          errorMetadata: {
            reason: 'approved_order_summary_utility_template_not_configured',
            window,
            templateLanguage: policy.config.templateLanguage,
            retriable: false
          }
        }, dependencies);
        return { outcome: 'skipped', reason: 'approved_order_summary_utility_template_not_configured', notification: updated };
      }
      sendMode = 'utility_template';
      sendPayload = { to: recipient, ...templateSend };
    }

    notification = await finishNotification(notification, {
      status: 'sending',
      errorMetadata: {
        routeSource: route.source,
        sendMode,
        renderedText: formatted.text,
        formatter: formatted.metadata,
        customerServiceWindow: window,
        recipient,
        templateId: template && template.id ? template.id : null,
        templateName: template && template.metaTemplateName ? template.metaTemplateName : null,
        templateLanguage: template && template.language ? template.language : null
      }
    }, dependencies);
    if (!notification) {
      return { outcome: 'not_owned', reason: 'notification_lease_not_owned_before_send' };
    }

    notification = await dependencies.markGraphRequestStarted(
      notification.id,
      notification.clinicId,
      {
        lockedBy: notification.lockedBy,
        startedAt: now.toISOString()
      }
    );
    if (!notification) {
      return { outcome: 'not_owned', reason: 'notification_lease_not_owned_at_graph_boundary' };
    }

    graphRequestStarted = true;
    const sendResult = await dependencies.sendChannelScopedMessage(sendPayload, {
      requestId: `order-summary:${notification.id}`,
      credentials: {
        tenantId: clinic.externalTenantId || null,
        clinicId: notification.clinicId,
        conversationId: route.conversation.id,
        channelId: route.channel.id,
        accessToken: route.channel.accessToken,
        phoneNumberId: route.channel.phoneNumberId,
        provider: route.channel.provider,
        status: route.channel.status,
        wabaId: route.channel.wabaId || null
      }
    });
    graphSuccessMessageId = normalizeText(sendResult && sendResult.messageId, 300);
    if (!graphSuccessMessageId) {
      const error = new Error('graph_success_without_provider_message_id');
      error.code = 'GRAPH_SUCCESS_WITHOUT_MESSAGE_ID';
      throw error;
    }

    notification = await finishNotification(notification, {
      status: 'sent',
      resultCode: 'graph_accepted',
      providerMessageId: graphSuccessMessageId,
      sentAt: now.toISOString(),
      lastError: null,
      errorMetadata: { graphAccepted: true, inboxPersisted: false }
    }, dependencies);
    if (!notification) {
      const error = new Error('notification_sent_state_persistence_failed');
      error.code = 'SENT_STATE_NOT_PERSISTED';
      throw error;
    }

    try {
      await persistNotificationInboxMessage({
        notification,
        conversation: route.conversation,
        channel: route.channel,
        recipient,
        renderedText: formatted.text,
        dependencies
      });
      await dependencies.mergeMetadata(notification.id, notification.clinicId, {
        inboxPersisted: true,
        inboxPersistedAt: now.toISOString()
      });
      return { outcome: 'sent', reason: 'graph_and_inbox_persisted', notification };
    } catch (inboxError) {
      const inboxPendingNotification = await finishNotification(notification, {
        status: 'sent',
        resultCode: 'inbox_persistence_pending',
        errorMetadata: {
          inboxPersisted: false,
          inboxPersistenceError: sanitizeDiagnosticText(inboxError.message)
        }
      }, dependencies).catch(() => null);
      if (inboxPendingNotification) notification = inboxPendingNotification;
      logWarn('order_customer_notification_inbox_persist_failed', {
        notificationId: notification.id,
        clinicId: notification.clinicId,
        channelId: route.channel.id,
        conversationId: route.conversation.id,
        providerMessageId: graphSuccessMessageId,
        error: sanitizeDiagnosticText(inboxError.message)
      });
      return { outcome: 'sent_inbox_pending', reason: 'graph_sent_inbox_recovery_required', notification };
    }
  } catch (error) {
    if (graphSuccessMessageId) {
      const updated = await finishNotification(notification, {
        status: 'unknown_delivery',
        resultCode: 'graph_accepted_state_uncertain',
        providerMessageId: graphSuccessMessageId,
        lastError: 'graph_accepted_but_sent_state_uncertain',
        errorMetadata: buildFailureMetadata(error, {
          reason: 'graph_accepted_but_sent_state_uncertain',
          retriable: false
        })
      }, dependencies).catch(() => null);
      return { outcome: 'unknown_delivery', reason: 'graph_accepted_but_sent_state_uncertain', notification: updated };
    }

    if (graphRequestStarted) {
      const classification = classifySendFailure(error, notification.attemptCount, now);
      const updated = await finishNotification(notification, {
        status: classification.status,
        resultCode: classification.reason,
        lastError: classification.reason,
        errorMetadata: buildFailureMetadata(error, {
          reason: classification.reason,
          retriable: classification.status === 'failed_retryable'
        }),
        ...(classification.availableAt ? { availableAt: classification.availableAt } : {})
      }, dependencies).catch(() => null);
      return { outcome: classification.status, reason: classification.reason, notification: updated };
    }

    const retryAt = new Date(now.getTime() + 2000).toISOString();
    const updated = await finishNotification(notification, {
      status: notification.attemptCount >= MAX_ATTEMPTS ? 'failed_permanent' : 'failed_retryable',
      resultCode: notification.attemptCount >= MAX_ATTEMPTS
        ? 'retry_attempts_exhausted_pre_graph'
        : 'processor_failed_before_graph_request',
      lastError: 'processor_failed_before_graph_request',
      availableAt: retryAt,
      errorMetadata: buildFailureMetadata(error, {
        reason: 'processor_failed_before_graph_request',
        retriable: notification.attemptCount < MAX_ATTEMPTS
      })
    }, dependencies).catch(() => null);
    return {
      outcome: notification.attemptCount >= MAX_ATTEMPTS ? 'failed_permanent' : 'failed_retryable',
      reason: 'processor_failed_before_graph_request',
      notification: updated
    };
  }
}

async function recoverOrderCustomerNotificationInbox(notification, options = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...(options.dependencies || {}) };
  const renderedText = normalizeText(notification.errorMetadata && notification.errorMetadata.renderedText, 3500);
  const recipient = normalizeRecipient({ waId: notification.errorMetadata && notification.errorMetadata.recipient });
  if (!notification.providerMessageId || !notification.conversationId || !notification.channelId || !renderedText || !recipient) {
    return { recovered: false, reason: 'inbox_recovery_metadata_incomplete' };
  }

  const [conversation, contact, channels] = await Promise.all([
    dependencies.getConversationByIdAndClinicId(notification.conversationId, notification.clinicId),
    notification.contactId
      ? dependencies.findContactByIdAndClinicId(notification.contactId, notification.clinicId)
      : Promise.resolve(null),
    dependencies.listWhatsAppChannelsByClinicId(notification.clinicId)
  ]);
  const channel = channels.find((item) => String(item.id) === String(notification.channelId)) || null;
  if (
    !conversation ||
    !contact ||
    !channel ||
    String(conversation.contactId) !== String(contact.id) ||
    String(conversation.channelId) !== String(channel.id) ||
    !conversationMatchesRoute(conversation, channel, { ...contact, waId: recipient, whatsappPhone: null, phone: null })
  ) {
    return { recovered: false, reason: 'inbox_recovery_scope_invalid' };
  }

  await persistNotificationInboxMessage({ notification, conversation, channel, recipient, renderedText, dependencies });
  await dependencies.updateStatus(notification.id, notification.clinicId, {
    status: notification.status,
    resultCode: 'inbox_recovered_without_resend',
    errorMetadata: {
      inboxPersisted: true,
      inboxRecovered: true,
      inboxPersistedAt: new Date().toISOString()
    }
  });
  return { recovered: true, reason: 'inbox_recovered_without_graph_resend' };
}

async function processAvailableOrderCustomerNotifications({
  workerId,
  limit = 10,
  dependencies = {},
  now = null
} = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const stats = { claimed: 0, sent: 0, skipped: 0, retried: 0, unknownDelivery: 0, inboxRecovered: 0, failed: 0 };

  const recoveries = await deps.listInboxRecovery(Math.max(1, limit));
  for (const notification of recoveries) {
    try {
      const recovery = await recoverOrderCustomerNotificationInbox(notification, { dependencies: deps });
      if (recovery.recovered) stats.inboxRecovered += 1;
    } catch (error) {
      stats.failed += 1;
      logWarn('order_customer_notification_inbox_recovery_failed', {
        notificationId: notification.id,
        clinicId: notification.clinicId,
        error: sanitizeDiagnosticText(error.message)
      });
    }
  }

  const claimed = await deps.claimNotifications({ workerId, limit, maxAttempts: MAX_ATTEMPTS });
  stats.claimed = claimed.length;
  for (const notification of claimed) {
    const result = await processOrderCustomerNotification(notification, { dependencies: deps, now });
    if (result.outcome === 'sent') stats.sent += 1;
    else if (result.outcome === 'failed_retryable') stats.retried += 1;
    else if (result.outcome === 'unknown_delivery') stats.unknownDelivery += 1;
    else if (result.outcome === 'skipped') stats.skipped += 1;
    else if (result.outcome !== 'sent_inbox_pending') stats.failed += 1;
  }

  if (stats.claimed || stats.inboxRecovered || stats.failed) {
    logInfo('order_customer_notification_sweep_result', { workerId, ...stats });
  }
  return stats;
}

module.exports = {
  DEFAULT_TEMPLATE_LANGUAGE,
  MAX_ATTEMPTS,
  getOrderCustomerNotificationConfig,
  isOrderCustomerNotificationEnabled,
  evaluateTenantNotificationPolicy,
  resolveNotificationRoute,
  buildOrderSummaryTemplateSend,
  classifySendFailure,
  processOrderCustomerNotification,
  recoverOrderCustomerNotificationInbox,
  processAvailableOrderCustomerNotifications,
  __private__: {
    normalizeRecipient,
    isValidWhatsAppChannel,
    conversationMatchesRoute,
    hasValidNotificationSnapshotIdentity,
    sanitizeDiagnosticText,
    persistNotificationInboxMessage
  }
};
