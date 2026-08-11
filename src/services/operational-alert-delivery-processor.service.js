const deliveryRepository = require('../repositories/operational-alert-deliveries.repository');
const instanceRepository = require('../repositories/operational-alert-instances.repository');
const ruleRepository = require('../repositories/operational-alert-rules.repository');
const recipientRepository = require('../repositories/operational-alert-recipients.repository');
const { findStaffUserByIdAndClinicId } = require('../repositories/staff.repository');
const {
  getClinicBusinessProfileById,
  findChannelByIdAndClinicId
} = require('../repositories/tenant.repository');
const { findWhatsAppTemplateByClinicAndKey } = require('../repositories/whatsapp-templates.repository');
const { sendChannelScopedMessage } = require('../whatsapp/whatsapp.service');
const { normalizeWhatsAppTo } = require('../whatsapp/normalize-phone');
const {
  evaluateInternalOperationalAlertAuthority
} = require('../operational-alerts/internal-operational-alert-authority');
const {
  formatOperationalAlertMessage,
  validateOperationalAlertTemplateContract,
  buildOperationalAlertMessageSnapshot,
  buildOperationalAlertTemplateSend
} = require('../operational-alerts/operational-alert-formatter');
const {
  classifySendFailure,
  MAX_ATTEMPTS
} = require('./order-customer-notification-processor.service');
const { logInfo, logWarn } = require('../utils/logger');

const DEFAULT_DEPENDENCIES = Object.freeze({
  recoverLeases: deliveryRepository.recoverOperationalAlertDeliveryLeases,
  claimDeliveries: deliveryRepository.claimOperationalAlertDeliveries,
  materializeMessageSnapshot: deliveryRepository.materializeOperationalAlertMessageSnapshot,
  markGraphRequestStarted: deliveryRepository.markOperationalAlertGraphRequestStarted,
  updateStatus: deliveryRepository.updateOperationalAlertDeliveryStatus,
  findInstance: instanceRepository.findOperationalAlertInstanceById,
  aggregateInstance: instanceRepository.aggregateOperationalAlertInstanceStatus,
  findRule: ruleRepository.findOperationalAlertRuleById,
  findRecipient: recipientRepository.findOperationalAlertRecipientById,
  findStaff: findStaffUserByIdAndClinicId,
  getClinicById: getClinicBusinessProfileById,
  findChannel: findChannelByIdAndClinicId,
  findTemplate: findWhatsAppTemplateByClinicAndKey,
  sendChannelScopedMessage
});

function safeId(value) {
  return String(value || '').slice(0, 8) || null;
}

function safeErrorMetadata(error, extra = {}) {
  const graphStatus = error && error.graphStatus;
  const graphCode = error && error.graphErrorCode;
  return {
    ...extra,
    graphStatus: graphStatus !== undefined && graphStatus !== null && Number.isFinite(Number(graphStatus))
      ? Number(graphStatus)
      : null,
    graphErrorCode: graphCode !== undefined && graphCode !== null && Number.isFinite(Number(graphCode))
      ? Number(graphCode)
      : null,
    errorCode: String(error && error.code || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) || null
  };
}

async function finishDelivery(delivery, patch, dependencies) {
  const updated = await dependencies.updateStatus(delivery.id, delivery.clinicId, {
    ...patch,
    expectedLockedBy: delivery.lockedBy || null
  });
  if (updated) {
    try {
      const instance = await dependencies.aggregateInstance(updated.instanceId, updated.clinicId);
      if (instance && instance.status !== 'pending') {
        logInfo('operational_alert_instance_completed', {
          instanceId: safeId(instance.id),
          status: instance.status
        });
      }
    } catch (error) {
      logWarn('operational_alert_instance_aggregation_failed', {
        instanceId: safeId(updated.instanceId),
        deliveryId: safeId(updated.id),
        resultCode: 'instance_aggregation_pending'
      });
    }
  }
  return updated;
}

async function processOperationalAlertDelivery(claimedDelivery, options = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...(options.dependencies || {}) };
  const now = options.now ? new Date(options.now) : new Date();
  let delivery = claimedDelivery;
  let graphBoundaryStarted = false;
  let graphSuccessMessageId = null;

  try {
    const instance = await dependencies.findInstance(delivery.instanceId, delivery.clinicId);
    const ruleSnapshot = instance && instance.snapshot && instance.snapshot.rule;
    if (
      !instance || !ruleSnapshot ||
      String(instance.clinicId) !== String(delivery.clinicId) ||
      String(instance.id) !== String(delivery.instanceId) ||
      String(ruleSnapshot.id) !== String(instance.ruleId) ||
      Number(ruleSnapshot.configVersion) !== Number(instance.ruleVersion)
    ) {
      const updated = await finishDelivery(delivery, {
        status: 'failed_permanent',
        resultCode: 'instance_snapshot_invalid',
        lastError: 'instance_snapshot_identity_invalid',
        errorMetadata: { reason: 'instance_snapshot_identity_invalid', retriable: false }
      }, dependencies);
      return { outcome: 'failed_permanent', reason: 'instance_snapshot_identity_invalid', delivery: updated };
    }
    if (instance.expiresAt && new Date(instance.expiresAt).getTime() <= now.getTime()) {
      const updated = await finishDelivery(delivery, {
        status: 'skipped',
        resultCode: 'delivery_expired',
        lastError: 'operational_alert_delivery_expired',
        errorMetadata: { reason: 'operational_alert_delivery_expired', retriable: false }
      }, dependencies);
      return { outcome: 'skipped', reason: 'operational_alert_delivery_expired', delivery: updated };
    }

    const clinic = await dependencies.getClinicById(delivery.clinicId);
    const currentRule = await dependencies.findRule(instance.ruleId, delivery.clinicId);
    const recipient = await dependencies.findRecipient(delivery.recipientId, delivery.clinicId);
    const staff = recipient && recipient.staffUserId
      ? await dependencies.findStaff(recipient.staffUserId, delivery.clinicId)
      : null;
    const channel = ruleSnapshot.channelId
      ? await dependencies.findChannel(ruleSnapshot.channelId, delivery.clinicId)
      : null;
    const template = ruleSnapshot.templateKey && ruleSnapshot.templateLanguage
      ? await dependencies.findTemplate(
          delivery.clinicId,
          ruleSnapshot.templateKey,
          ruleSnapshot.templateLanguage
        )
      : null;
    const authority = evaluateInternalOperationalAlertAuthority({
      clinic,
      currentRule,
      ruleSnapshot,
      delivery,
      recipient,
      staff,
      channel,
      template,
      workerId: delivery.lockedBy,
      now
    });
    if (!authority.allowed) {
      const updated = await finishDelivery(delivery, {
        status: authority.status,
        resultCode: authority.resultCode,
        lastError: authority.reason,
        errorMetadata: { reason: authority.reason, retriable: false }
      }, dependencies);
      logWarn('operational_alert_delivery_failed', {
        deliveryId: safeId(delivery.id),
        instanceId: safeId(delivery.instanceId),
        eventType: ruleSnapshot.eventType,
        attempt: delivery.attemptCount,
        resultCode: authority.resultCode
      });
      return { outcome: authority.status, reason: authority.reason, delivery: updated };
    }

    if (!delivery.messageSnapshot) {
      const formatted = formatOperationalAlertMessage(instance.snapshot);
      if (!formatted.ok) {
        const updated = await finishDelivery(delivery, {
          status: 'failed_permanent',
          resultCode: formatted.reason,
          lastError: formatted.reason,
          errorMetadata: { reason: formatted.reason, retriable: false }
        }, dependencies);
        return { outcome: 'failed_permanent', reason: formatted.reason, delivery: updated };
      }
      const templateContract = validateOperationalAlertTemplateContract(template, formatted.value);
      if (!templateContract.ok) {
        const updated = await finishDelivery(delivery, {
          status: 'failed_permanent',
          resultCode: templateContract.reason,
          lastError: templateContract.reason,
          errorMetadata: { reason: templateContract.reason, retriable: false }
        }, dependencies);
        return { outcome: 'failed_permanent', reason: templateContract.reason, delivery: updated };
      }
      const messageSnapshot = buildOperationalAlertMessageSnapshot({
        formatted: formatted.value,
        template
      });
      delivery = await dependencies.materializeMessageSnapshot(delivery.id, delivery.clinicId, {
        lockedBy: delivery.lockedBy,
        messageSnapshot,
        templateVersion: 1
      });
      if (!delivery) return { outcome: 'not_owned', reason: 'delivery_lease_not_owned_at_snapshot' };
    }
    if (
      !delivery.messageSnapshot ||
      String(delivery.messageSnapshot.template && delivery.messageSnapshot.template.name || '') !== String(template.metaTemplateName || '')
    ) {
      const updated = await finishDelivery(delivery, {
        status: 'failed_permanent',
        resultCode: 'template_changed_before_send',
        lastError: 'message_snapshot_template_no_longer_matches_approved_template',
        errorMetadata: { reason: 'message_snapshot_template_no_longer_matches_approved_template', retriable: false }
      }, dependencies);
      return { outcome: 'failed_permanent', reason: 'template_changed_before_send', delivery: updated };
    }
    const currentSnapshotTemplateContract = validateOperationalAlertTemplateContract(
      template,
      delivery.messageSnapshot
    );
    if (!currentSnapshotTemplateContract.ok) {
      const updated = await finishDelivery(delivery, {
        status: 'failed_permanent',
        resultCode: currentSnapshotTemplateContract.reason,
        lastError: currentSnapshotTemplateContract.reason,
        errorMetadata: { reason: currentSnapshotTemplateContract.reason, retriable: false }
      }, dependencies);
      return { outcome: 'failed_permanent', reason: currentSnapshotTemplateContract.reason, delivery: updated };
    }

    const recipientDigits = normalizeWhatsAppTo(recipient.phoneE164);
    const sendPayload = buildOperationalAlertTemplateSend(delivery.messageSnapshot, recipientDigits);
    if (!sendPayload || Object.prototype.hasOwnProperty.call(sendPayload, 'text')) {
      const updated = await finishDelivery(delivery, {
        status: 'failed_permanent',
        resultCode: 'template_only_contract_violation',
        lastError: 'operational_alert_freeform_send_forbidden',
        errorMetadata: { reason: 'operational_alert_freeform_send_forbidden', retriable: false }
      }, dependencies);
      return { outcome: 'failed_permanent', reason: 'template_only_contract_violation', delivery: updated };
    }

    delivery = await dependencies.markGraphRequestStarted(delivery.id, delivery.clinicId, {
      lockedBy: delivery.lockedBy,
      startedAt: now.toISOString()
    });
    if (!delivery) return { outcome: 'not_owned', reason: 'delivery_lease_not_owned_at_graph_boundary' };
    graphBoundaryStarted = true;
    logInfo('operational_alert_graph_boundary_started', {
      deliveryId: safeId(delivery.id),
      instanceId: safeId(delivery.instanceId),
      eventType: ruleSnapshot.eventType,
      eventVersion: ruleSnapshot.eventVersion,
      attempt: delivery.attemptCount
    });

    const sendResult = await dependencies.sendChannelScopedMessage(sendPayload, {
      requestId: `operational-alert:${safeId(delivery.id)}`,
      suppressRoutingDiagnostics: true,
      credentials: {
        tenantId: clinic.externalTenantId || null,
        clinicId: delivery.clinicId,
        channelId: channel.id,
        accessToken: channel.accessToken,
        phoneNumberId: channel.phoneNumberId,
        provider: channel.provider,
        status: channel.status,
        wabaId: channel.wabaId
      }
    });
    graphSuccessMessageId = String(sendResult && sendResult.messageId || '').trim().slice(0, 500) || null;
    if (!graphSuccessMessageId) {
      const error = new Error('graph_success_without_provider_message_id');
      error.code = 'GRAPH_SUCCESS_WITHOUT_MESSAGE_ID';
      throw error;
    }

    const updated = await finishDelivery(delivery, {
      status: 'sent',
      resultCode: 'graph_accepted',
      providerMessageId: graphSuccessMessageId,
      sentAt: now.toISOString(),
      lastError: null,
      errorMetadata: { reason: 'graph_accepted', retriable: false }
    }, dependencies);
    if (!updated) {
      const error = new Error('operational_alert_sent_state_persistence_failed');
      error.code = 'SENT_STATE_NOT_PERSISTED';
      throw error;
    }
    logInfo('operational_alert_graph_accepted', {
      deliveryId: safeId(delivery.id),
      instanceId: safeId(delivery.instanceId),
      eventType: ruleSnapshot.eventType,
      attempt: delivery.attemptCount,
      resultCode: 'graph_accepted'
    });
    return { outcome: 'sent', reason: 'graph_accepted', delivery: updated };
  } catch (error) {
    if (graphSuccessMessageId) {
      const updated = await finishDelivery(delivery, {
        status: 'unknown_delivery',
        resultCode: 'graph_accepted_state_uncertain',
        providerMessageId: graphSuccessMessageId,
        lastError: 'graph_accepted_but_sent_state_uncertain',
        errorMetadata: safeErrorMetadata(error, {
          reason: 'graph_accepted_but_sent_state_uncertain',
          retriable: false
        })
      }, dependencies).catch(() => null);
      return { outcome: 'unknown_delivery', reason: 'graph_accepted_but_sent_state_uncertain', delivery: updated };
    }
    if (graphBoundaryStarted) {
      const classification = classifySendFailure(error, delivery.attemptCount, now);
      const updated = await finishDelivery(delivery, {
        status: classification.status,
        resultCode: classification.reason,
        lastError: classification.reason,
        errorMetadata: safeErrorMetadata(error, {
          reason: classification.reason,
          retriable: classification.status === 'failed_retryable'
        }),
        ...(classification.availableAt ? { availableAt: classification.availableAt } : {})
      }, dependencies).catch(() => null);
      logWarn('operational_alert_delivery_failed', {
        deliveryId: safeId(delivery.id),
        instanceId: safeId(delivery.instanceId),
        attempt: delivery.attemptCount,
        resultCode: classification.reason
      });
      return { outcome: classification.status, reason: classification.reason, delivery: updated };
    }

    const permanent = Number(delivery.attemptCount) >= MAX_ATTEMPTS;
    const updated = await finishDelivery(delivery, {
      status: permanent ? 'failed_permanent' : 'failed_retryable',
      resultCode: permanent ? 'retry_attempts_exhausted_pre_graph' : 'processor_failed_before_graph_request',
      lastError: 'processor_failed_before_graph_request',
      availableAt: permanent ? null : new Date(now.getTime() + 2000).toISOString(),
      errorMetadata: safeErrorMetadata(error, {
        reason: 'processor_failed_before_graph_request',
        retriable: !permanent
      })
    }, dependencies).catch(() => null);
    return {
      outcome: permanent ? 'failed_permanent' : 'failed_retryable',
      reason: 'processor_failed_before_graph_request',
      delivery: updated
    };
  }
}

async function recoverOperationalAlertDeliveries({ dependencies = {} } = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const recovered = await deps.recoverLeases({ maxAttempts: MAX_ATTEMPTS });
  const all = [
    ...recovered.providerKnown,
    ...recovered.preGraph,
    ...recovered.postGraph,
    ...recovered.exhausted
  ];
  const instances = new Map(all.map((delivery) => [
    `${delivery.clinicId}:${delivery.instanceId}`,
    delivery
  ]));
  for (const delivery of instances.values()) {
    await deps.aggregateInstance(delivery.instanceId, delivery.clinicId);
  }
  const stats = {
    providerKnown: recovered.providerKnown.length,
    preGraph: recovered.preGraph.length,
    postGraph: recovered.postGraph.length,
    exhausted: recovered.exhausted.length
  };
  if (stats.providerKnown || stats.preGraph || stats.postGraph || stats.exhausted) {
    logInfo('operational_alert_delivery_recovery', stats);
  }
  return stats;
}

async function processAvailableOperationalAlertDeliveries({
  workerId,
  limit = 10,
  dependencies = {},
  now = null
} = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const claimed = await deps.claimDeliveries({ workerId, limit, maxAttempts: MAX_ATTEMPTS });
  const stats = { claimed: claimed.length, sent: 0, skipped: 0, retried: 0, unknownDelivery: 0, failed: 0 };
  for (const delivery of claimed) {
    logInfo('operational_alert_delivery_claimed', {
      deliveryId: safeId(delivery.id),
      instanceId: safeId(delivery.instanceId),
      recipientId: safeId(delivery.recipientId),
      attempt: delivery.attemptCount,
      queueAgeMs: Math.max(0, (now ? new Date(now) : new Date()).getTime() - new Date(delivery.createdAt).getTime())
    });
    const result = await processOperationalAlertDelivery(delivery, { dependencies: deps, now });
    if (result.outcome === 'sent') stats.sent += 1;
    else if (result.outcome === 'skipped') stats.skipped += 1;
    else if (result.outcome === 'failed_retryable') stats.retried += 1;
    else if (result.outcome === 'unknown_delivery') stats.unknownDelivery += 1;
    else if (result.outcome !== 'not_owned') stats.failed += 1;
  }
  return stats;
}

module.exports = {
  processOperationalAlertDelivery,
  recoverOperationalAlertDeliveries,
  processAvailableOperationalAlertDeliveries,
  __private__: {
    safeErrorMetadata
  }
};
