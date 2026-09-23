const { withTransaction } = require('../db/client');
const { logInfo, logWarn } = require('../utils/logger');
const { findCoexistenceChannelByPhoneNumberId } = require('../repositories/tenant.repository');
const conversationRepo = require('./conversation.repo');
const { invalidatePendingForMessage } = require('../repositories/order-closure.repository');
const { invalidateForMessage: invalidateAmendmentForMessage } = require('../repositories/order-amendment.repository');
const { resolveWhatsAppConversation } = require('./whatsapp-conversation-resolver');
const { activateHumanTakeover, TAKEOVER_SOURCES } = require('./human-takeover.service');
const { extractSmbMessageEchoes, digits } = require('../webhooks/smb-message-echoes');

function validateEchoChannel(event, channel) {
  if (!channel) return 'channel_not_found_or_ambiguous';
  if (channel.provider !== 'whatsapp_cloud' || channel.connectionMode !== 'COEXISTENCE') return 'not_coexistence';
  if (String(channel.status || '').toLowerCase() !== 'active') return 'channel_inactive';
  if (String(channel.phoneNumberId || '') !== event.phoneNumberId) return 'phone_id_mismatch';
  if (!channel.wabaId || String(channel.wabaId) !== event.wabaId) return 'waba_mismatch';
  const businessNumber = digits(channel.displayPhoneNumber);
  if (!businessNumber || businessNumber !== event.from || businessNumber !== event.displayPhoneNumber) {
    return 'business_phone_mismatch';
  }
  return null;
}

function createSmbMessageEchoProcessor(overrides = {}) {
  const deps = {
    transaction: withTransaction,
    findChannel: findCoexistenceChannelByPhoneNumberId,
    findMessage: conversationRepo.findInboundMessageByProviderId,
    resolveConversation: resolveWhatsAppConversation,
    insertMessage: conversationRepo.insertOutboundMessage,
    activateTakeover: activateHumanTakeover,
    invalidateCandidate: async (...args) => {
      await invalidatePendingForMessage(...args);
      await invalidateAmendmentForMessage(...args);
    },
    logInfo,
    logWarn,
    ...overrides
  };

  return async function processSmbMessageEchoes(payload, { requestId = null } = {}) {
    const events = extractSmbMessageEchoes(payload);
    const counts = { received: events.length, persisted: 0, duplicates: 0, ignored: 0, failed: 0 };

    for (const event of events) {
      if (event.invalidReason || event.type === 'edit' || event.type === 'revoke') {
        counts.ignored += 1;
        deps.logWarn('smb_message_echo_ignored', {
          requestId, eventType: 'smb_message_echoes', messageId: event.id || null,
          reason: event.invalidReason || 'edit_revoke_deferred'
        });
        continue;
      }

      try {
        const channel = await deps.findChannel(event.phoneNumberId);
        const invalidChannel = validateEchoChannel(event, channel);
        if (invalidChannel) {
          counts.ignored += 1;
          deps.logWarn('smb_message_echo_ignored', {
            requestId, eventType: 'smb_message_echoes', messageId: event.id,
            channelId: channel && channel.id || null, reason: invalidChannel
          });
          continue;
        }

        const result = await deps.transaction(async (client) => {
          const existing = await deps.findMessage(event.id, client);
          if (existing) return { duplicate: true };

          const { conversation } = await deps.resolveConversation({
            direction: 'outbound',
            providerIdentity: event.to,
            phone: event.to,
            waTo: event.from,
            clinicId: channel.clinicId,
            channelId: channel.id,
            preserveExistingName: true,
            preserveExistingIdentity: true
          }, client);

          const write = await deps.insertMessage({
            clinicId: channel.clinicId,
            channelId: channel.id,
            conversationId: conversation.id,
            waMessageId: event.id,
            from: event.from,
            to: event.to,
            type: event.type,
            text: event.text || null,
            raw: {
              actor: 'HUMAN',
              source: TAKEOVER_SOURCES.WHATSAPP_BUSINESS_APP,
              echoTimestamp: event.timestamp,
              message: {
                id: event.id,
                from: event.from,
                to: event.to,
                type: event.type,
                [event.type]: event.content
              }
            }
          }, client);
          if (!write || !write.inserted) return { duplicate: true };

          const takeover = await deps.activateTakeover({
            clinicId: channel.clinicId,
            conversationId: conversation.id,
            source: TAKEOVER_SOURCES.WHATSAPP_BUSINESS_APP,
            at: new Date(Number(event.timestamp) * 1000).toISOString()
          }, client);
          if (!takeover) throw new Error('smb_message_echo_takeover_failed');
          await deps.invalidateCandidate(channel.clinicId, conversation.id, write.row.id, client);
          return { duplicate: false, conversationId: conversation.id, takeoverActivated: takeover.activated };
        });

        if (result.duplicate) {
          counts.duplicates += 1;
        } else {
          counts.persisted += 1;
          deps.logInfo('smb_message_echo_persisted', {
            requestId, eventType: 'smb_message_echoes', tenantId: channel.clinicId,
            channelId: channel.id, conversationId: result.conversationId,
            messageId: event.id, takeoverActivated: result.takeoverActivated,
            source: TAKEOVER_SOURCES.WHATSAPP_BUSINESS_APP
          });
        }
      } catch (error) {
        counts.failed += 1;
        deps.logWarn('smb_message_echo_processing_failed', {
          requestId, eventType: 'smb_message_echoes', messageId: event.id,
          errorCode: error && error.code || 'PROCESSING_FAILED'
        });
      }
    }
    return counts;
  };
}

const processSmbMessageEchoes = createSmbMessageEchoProcessor();

module.exports = { validateEchoChannel, createSmbMessageEchoProcessor, processSmbMessageEchoes };
