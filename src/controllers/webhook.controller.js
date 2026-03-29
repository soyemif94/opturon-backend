const env = require('../config/env');
const { withTransaction } = require('../db/client');
const { sanitizeString } = require('../utils/validators');
const { logInfo, logWarn, logError } = require('../utils/logger');
const { findChannelByPhoneNumberId } = require('../repositories/tenant.repository');
const { upsertContact } = require('../repositories/contact.repository');
const { upsertConversation } = require('../repositories/conversation.repository');
const { insertInboundMessage } = require('../repositories/message.repository');
const { enqueueInboundJob } = require('../repositories/job.repository');
const { createFailure } = require('../repositories/inbound-failures.repository');
const { insertWebhookEvent } = require('../repositories/webhook-event.repository');
const {
  deriveMetaWebhookProvider,
  deriveMetaEventType,
  extractMetaWebhookIdentifiers,
  hasInstagramMessagingEntries,
  hasWhatsAppChangeEntries
} = require('../webhooks/meta.webhook');
const { processInboundMessages } = require('../conversations/conversation.service');
const { pushInboxItem } = require('../debug/inbox-store');
const { pushWebhookEvent } = require('../debug/webhook-store');
const { sendChannelScopedMessage } = require('../whatsapp/whatsapp.service');

function withRequestMeta(req, meta = {}) {
  return {
    requestId: req && req.requestId ? req.requestId : null,
    ...meta
  };
}

function truncateText(value, maxChars) {
  const text = String(value || '');
  if (!text) {
    return null;
  }

  return text.length > maxChars ? `${text.slice(0, maxChars)}...[truncated]` : text;
}

function summarizeWebhookPayload(payload) {
  const entry = Array.isArray(payload && payload.entry) ? payload.entry : [];
  const firstEntry = entry[0] || null;
  const changes = Array.isArray(firstEntry && firstEntry.changes) ? firstEntry.changes : [];
  const firstChange = changes[0] || null;
  const value = firstChange && firstChange.value ? firstChange.value : {};
  const firstMessage = Array.isArray(value.messages) && value.messages[0] ? value.messages[0] : null;

  return {
    object: sanitizeString(payload && payload.object) || null,
    entryCount: entry.length,
    firstChangeField: sanitizeString(firstChange && firstChange.field) || null,
    from: sanitizeString(firstMessage && (firstMessage.from || firstMessage.wa_id)) || null,
    messageId: sanitizeString(firstMessage && firstMessage.id) || null,
    textPreview: sanitizeString(firstMessage && firstMessage.text && firstMessage.text.body) || null
  };
}

function getSafeRawBody(req, payload) {
  if (req && req.rawBody && Buffer.isBuffer(req.rawBody)) {
    return truncateText(req.rawBody.toString('utf-8'), 2000);
  }

  try {
    return truncateText(JSON.stringify(payload || {}), 2000);
  } catch (error) {
    return truncateText(String(payload || ''), 2000);
  }
}

function verifyWebhook(req, res) {
  const mode = sanitizeString(req.query['hub.mode']);
  const token = sanitizeString(req.query['hub.verify_token']);
  const challenge = sanitizeString(req.query['hub.challenge']);
  const tokenMatch = token && token === env.metaVerifyToken;

  if (mode === 'subscribe' && tokenMatch) {
    logInfo('Webhook verification succeeded', withRequestMeta(req, { mode, tokenMatch: true }));
    return res.status(200).type('text/plain').send(challenge);
  }

  logWarn('Webhook verification rejected', withRequestMeta(req, { mode, tokenMatch: !!tokenMatch }));
  return res.status(401).json({ success: false, error: 'No autorizado para verificar webhook.' });
}

function extractMetaInboundMessages(payload) {
  const events = [];
  const entry = Array.isArray(payload && payload.entry) ? payload.entry : [];

  entry.forEach((entryItem) => {
    const changes = Array.isArray(entryItem && entryItem.changes) ? entryItem.changes : [];
    changes.forEach((change) => {
      const value = change && change.value ? change.value : {};
      const metadata = value && value.metadata ? value.metadata : {};
      const inboundPhoneNumberId = sanitizeString(metadata.phone_number_id || metadata.phoneNumberId);
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const contactNameByWaId = new Map();
      contacts.forEach((contact) => {
        const waId = sanitizeString(contact && (contact.wa_id || contact.waId));
        const name = sanitizeString(contact && contact.profile && contact.profile.name);
        if (waId) {
          contactNameByWaId.set(waId, name || null);
        }
      });

      const messages = Array.isArray(value.messages) ? value.messages : [];
      messages.forEach((msg) => {
        if (!msg) return;

        const providerMessageId = sanitizeString(msg.id);
        const waId = sanitizeString(msg.from || msg.wa_id);
        const type = sanitizeString(msg.type || 'unknown') || 'unknown';
        const body = sanitizeString(msg && msg.text && msg.text.body);
        const name = contactNameByWaId.get(waId) || null;

        events.push({
          inboundPhoneNumberId,
          waId,
          name,
          providerMessageId,
          type,
          body,
          raw: {
            entry: entryItem,
            change,
            message: msg
          }
        });
      });
    });
  });

  return events;
}

function extractLegacyInbound(payload) {
  const from = sanitizeString(payload.from);
  const body = sanitizeString(payload.message);
  const providerMessageId = sanitizeString(payload.messageId);
  if (!from || !body) {
    return [];
  }

  return [
    {
      inboundPhoneNumberId: env.whatsappPhoneNumberId,
      waId: from.replace(/^\+/, ''),
      name: sanitizeString(payload.name) || null,
      providerMessageId: providerMessageId || null,
      type: 'text',
      body,
      raw: payload
    }
  ];
}

function toDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function normalizeTextForRule(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function detectAutoReplyRule(text) {
  const normalized = normalizeTextForRule(text);
  if (!normalized) return 'default';
  if (normalized.includes('hola') || normalized.includes('buenas')) return 'greeting';
  if (normalized.includes('precio')) return 'pricing';
  if (normalized.includes('gracias')) return 'thanks';
  return 'default';
}

function buildAutoReplyText(rule) {
  if (rule === 'greeting') {
    return 'Hola 👋 Soy el asistente de Opturon. ¿En qué puedo ayudarte?';
  }
  if (rule === 'pricing') {
    return 'Contame qué producto/servicio buscás y te paso opciones 😊';
  }
  if (rule === 'thanks') {
    return '¡De nada! 💛';
  }
  return 'Te leo 👀. Contame un poco más así te ayudo.';
}

function extractInboxObservedEvents(payload) {
  const nowIso = new Date().toISOString();
  const items = [];
  const textEvents = [];
  const entry = Array.isArray(payload && payload.entry) ? payload.entry : [];

  entry.forEach((entryItem) => {
    const changes = Array.isArray(entryItem && entryItem.changes) ? entryItem.changes : [];
    changes.forEach((change) => {
      const value = change && change.value ? change.value : {};
      const metadata = value && value.metadata ? value.metadata : {};
      const metadataPhone = sanitizeString(metadata.phone_number_id || metadata.display_phone_number);
      const metadataPhoneDigits = toDigits(metadataPhone);
      const field = sanitizeString(change && change.field) || null;

      const messages = Array.isArray(value.messages) ? value.messages : [];
      if (messages.length > 0) {
        messages.forEach((msg) => {
          const from = sanitizeString(msg && (msg.from || msg.wa_id)) || null;
          const fromDigits = toDigits(from);
          const messageType = sanitizeString(msg && msg.type) || 'unknown';
          const text = sanitizeString(msg && msg.text && msg.text.body) || null;
          const messageId = sanitizeString(msg && msg.id) || null;
          const isEcho = Boolean(
            msg && (msg.is_echo === true || msg.from_me === true || msg.echo === true || msg.message_echoes === true)
          );
          const fromBusiness = !!(fromDigits && metadataPhoneDigits && fromDigits === metadataPhoneDigits);

          items.push({
            ts: nowIso,
            type: 'message',
            from,
            messageId,
            text,
            payload: {
              field,
              metadata: {
                phone_number_id: metadata.phone_number_id || null,
                display_phone_number: metadata.display_phone_number || null
              },
              messageType,
              message: {
                id: messageId,
                from,
                type: messageType
              }
            }
          });

          textEvents.push({
            from,
            text,
            messageId,
            isEcho,
            fromBusiness,
            messageType,
            phoneNumberId: sanitizeString(metadata.phone_number_id) || null
          });
        });
      }

      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      if (statuses.length > 0) {
        statuses.forEach((status) => {
          items.push({
            ts: nowIso,
            type: 'status',
            from: sanitizeString(status && status.recipient_id) || null,
            messageId: sanitizeString(status && status.id) || null,
            text: sanitizeString(status && status.status) || null,
            payload: {
              field,
              metadata: {
                phone_number_id: metadata.phone_number_id || null,
                display_phone_number: metadata.display_phone_number || null
              },
              status: {
                id: sanitizeString(status && status.id) || null,
                recipient_id: sanitizeString(status && status.recipient_id) || null,
                status: sanitizeString(status && status.status) || null
              }
            }
          });
        });
      }

      if (messages.length === 0 && statuses.length === 0) {
        items.push({
          ts: nowIso,
          type: 'unknown',
          from: null,
          messageId: null,
          text: null,
          payload: {
            field,
            metadata: {
              phone_number_id: metadata.phone_number_id || null,
              display_phone_number: metadata.display_phone_number || null
            }
          }
        });
      }
    });
  });

  return { items, textEvents };
}

async function runAutoReplyIfEnabled(req, textEvents) {
  if (!env.autoReplyEnabled || !env.legacyWebhookAutoReplyEnabled) {
    logInfo(
      'legacy_auto_reply_skipped',
      withRequestMeta(req, {
        sourcePath: 'webhook.observeAndAutoReply',
        autoReplyEnabled: env.autoReplyEnabled === true,
        legacyWebhookAutoReplyEnabled: env.legacyWebhookAutoReplyEnabled === true,
        textEventsCount: Array.isArray(textEvents) ? textEvents.length : 0
      })
    );
    return;
  }

  for (const event of textEvents) {
    if (!event || event.messageType !== 'text' || !event.text || !event.from) {
      continue;
    }
    if (event.isEcho || event.fromBusiness) {
      continue;
    }

    if (!event.phoneNumberId) {
      logWarn(
        'webhook_auto_reply_skipped_missing_phone_number_id',
        withRequestMeta(req, {
          to: event.from,
          messageId: event.messageId || null
        })
      );
      continue;
    }

    const rule = detectAutoReplyRule(event.text);
    const replyText = buildAutoReplyText(rule);

    try {
      logInfo(
        'legacy_auto_reply_entered',
        withRequestMeta(req, {
          sourcePath: 'webhook.observeAndAutoReply',
          to: event.from,
          messageId: event.messageId || null,
          phoneNumberId: event.phoneNumberId || null,
          rule,
          inboundText: event.text || null
        })
      );

      const channel = await findChannelByPhoneNumberId(event.phoneNumberId);
      if (!channel) {
        logWarn(
          'webhook_auto_reply_skipped_unrouted_channel',
          withRequestMeta(req, {
            to: event.from,
            messageId: event.messageId || null,
            phoneNumberId: event.phoneNumberId
          })
        );
        continue;
      }

      if (!String(channel.accessToken || '').trim() || !String(channel.phoneNumberId || '').trim()) {
        logWarn(
          'webhook_auto_reply_skipped_incomplete_channel',
          withRequestMeta(req, {
            clinicId: channel.clinicId || null,
            channelId: channel.id || null,
            to: event.from,
            messageId: event.messageId || null,
            phoneNumberId: event.phoneNumberId,
            hasAccessToken: !!String(channel.accessToken || '').trim(),
            hasChannelPhoneNumberId: !!String(channel.phoneNumberId || '').trim()
          })
        );
        continue;
      }

      const sendResult = await sendChannelScopedMessage(
        { to: event.from, text: replyText },
        {
          requestId: req && req.requestId ? req.requestId : null,
          credentials: {
            clinicId: channel.clinicId || null,
            channelId: channel.id,
            accessToken: channel.accessToken,
            phoneNumberId: channel.phoneNumberId,
            provider: channel.provider || null,
            status: channel.status || null,
            wabaId: channel.wabaId || null
          }
        }
      );
      logInfo(
        'legacy_auto_reply_sent',
        withRequestMeta(req, {
          sourcePath: 'webhook.observeAndAutoReply',
          clinicId: channel.clinicId || null,
          channelId: channel.id || null,
          to: event.from,
          messageId: event.messageId || null,
          rule,
          outboundMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null
        })
      );
    } catch (error) {
      logWarn(
        'legacy_auto_reply_failed',
        withRequestMeta(req, {
          sourcePath: 'webhook.observeAndAutoReply',
          to: event.from,
          messageId: event.messageId || null,
          rule,
          error: error.message
        })
      );
    }
  }
}

async function observeAndAutoReply(req, payload) {
  const observed = extractInboxObservedEvents(payload);
  logInfo(
    'legacy_auto_reply_observer_entered',
    withRequestMeta(req, {
      sourcePath: 'webhook.observeAndAutoReply',
      observedItems: observed.items.length,
      textEvents: observed.textEvents.length
    })
  );
  observed.items.forEach((item) => {
    pushInboxItem(item);
  });
  await runAutoReplyIfEnabled(req, observed.textEvents);
}

async function persistAndEnqueue(event, req) {
  const requestId = req && req.requestId ? req.requestId : null;
  const messageId = event.providerMessageId || null;

  try {
    const channel = await findChannelByPhoneNumberId(event.inboundPhoneNumberId || '');

    if (!channel) {
      await createFailure({
        reason: 'UNROUTED_CHANNEL',
        phoneNumberId: event.inboundPhoneNumberId || null,
        providerMessageId: messageId,
        requestId,
        raw: event.raw || event,
        error: 'No channel found for inbound phone_number_id'
      });

      logWarn(
        'webhook_unrouted_channel',
        withRequestMeta(req, {
          clinicId: null,
          channelId: null,
          messageId,
          inboundPhoneNumberId: event.inboundPhoneNumberId || null,
          waId: event.waId || null
        })
      );

      return { status: 'unrouted' };
    }

    const txResult = await withTransaction(async (client) => {
      const clinicId = channel.clinicId;
      const channelId = channel.id;

      const contact = await upsertContact(
        {
          clinicId,
          waId: event.waId,
          phone: event.waId,
          name: event.name || null
        },
        client
      );

      const conversation = await upsertConversation(
        {
          clinicId,
          channelId,
          contactId: contact.id
        },
        client
      );

      const messageWrite = await insertInboundMessage(
        {
          clinicId,
          channelId,
          conversationId: conversation.id,
          providerMessageId: messageId,
          from: event.waId,
          to: event.inboundPhoneNumberId || channel.phoneNumberId,
          type: event.type || 'text',
          body: event.body || null,
          raw: event.raw || {}
        },
        client
      );

      if (!messageWrite.inserted) {
        return {
          status: 'duplicate',
          clinicId,
          channelId,
          contactId: contact.id,
          conversationId: conversation.id,
          dbMessageId: messageWrite.message ? messageWrite.message.id : null
        };
      }

      await enqueueInboundJob(
        {
          clinicId,
          channelId,
          payload: {
            messageId,
            dbMessageId: messageWrite.message ? messageWrite.message.id : null,
            clinicId,
            channelId,
            conversationId: conversation.id,
            contactId: contact.id
          }
        },
        client
      );

      return {
        status: 'enqueued',
        clinicId,
        channelId,
        contactId: contact.id,
        conversationId: conversation.id,
        dbMessageId: messageWrite.message ? messageWrite.message.id : null
      };
    });

    if (txResult.status === 'duplicate') {
      logInfo(
        'webhook_duplicate_message_db',
        withRequestMeta(req, {
          clinicId: txResult.clinicId,
          channelId: txResult.channelId,
          messageId
        })
      );
      return { status: 'duplicate' };
    }

    logInfo(
      'webhook_message_enqueued',
      withRequestMeta(req, {
        clinicId: txResult.clinicId,
        channelId: txResult.channelId,
        messageId,
        contactId: txResult.contactId,
        conversationId: txResult.conversationId,
        dbMessageId: txResult.dbMessageId
      })
    );

    return { status: 'enqueued' };
  } catch (error) {
    try {
      await createFailure({
        reason: 'DB_ERROR',
        phoneNumberId: event.inboundPhoneNumberId || null,
        providerMessageId: messageId,
        requestId,
        raw: event.raw || event,
        error: error.message
      });
    } catch (failureWriteError) {
      logError(
        'webhook_failure_persist_failed',
        withRequestMeta(req, {
          messageId,
          originalError: error.message,
          failureWriteError: failureWriteError.message
        })
      );
    }

    throw error;
  }
}

async function handleWebhook(req, res) {
  const payload = req.body || {};
  const payloadSummary = summarizeWebhookPayload(payload);
  const topLevelBodyKeys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];

  logInfo(
    'webhook_post_received',
    withRequestMeta(req, {
      event: 'webhook_post_received',
      headers: {
        userAgent: req.get('user-agent') || null,
        hasXHubSignature256: !!req.get('x-hub-signature-256')
      },
      bodyKeys: topLevelBodyKeys,
      object: payloadSummary.object,
      entryCount: payloadSummary.entryCount,
      firstChangeField: payloadSummary.firstChangeField
    })
  );

  pushWebhookEvent({
    timestamp: new Date().toISOString(),
    requestId: req.requestId || null,
    object: payloadSummary.object,
    field: payloadSummary.firstChangeField,
    from: payloadSummary.from,
    messageId: payloadSummary.messageId,
    textPreview: payloadSummary.textPreview,
    rawBody: getSafeRawBody(req, payload)
  });

  const isMetaPayload = Array.isArray(payload.entry);
  const signatureValid = env.verifySignature ? (req.metaSignatureValid ?? null) : null;
  const provider = deriveMetaWebhookProvider(payload);
  const hasInstagramEntries = hasInstagramMessagingEntries(payload);
  const hasWhatsAppEntries = hasWhatsAppChangeEntries(payload);
  const eventType = deriveMetaEventType(payload);
  const meta = extractMetaWebhookIdentifiers(payload);
  const safeHeaders = {
    'x-hub-signature-256': req.get('x-hub-signature-256') || null,
    'x-forwarded-for': req.get('x-forwarded-for') || null,
    'user-agent': req.get('user-agent') || null
  };

  try {
    const persisted = await insertWebhookEvent({
      requestId: req.requestId || null,
      provider,
      object: sanitizeString(payload.object) || null,
      eventType,
      waMessageId: meta.waMessageId,
      waFrom: meta.waFrom,
      waTo: meta.waTo,
      raw: payload,
      headers: safeHeaders,
      signatureValid
    });

    if (persisted) {
      logInfo(
        'webhook_event_persisted',
        withRequestMeta(req, {
          id: persisted.id,
          eventType: persisted.eventType || eventType || null,
          waMessageId: persisted.waMessageId || meta.waMessageId || null
        })
      );
    }
  } catch (error) {
    logError(
      'webhook_event_persist_failed',
      withRequestMeta(req, {
        eventType: eventType || null,
        waMessageId: meta.waMessageId || null,
        error: error.message
      })
    );
  }

  try {
    if (isMetaPayload) {
      logInfo('meta_webhook_routed', withRequestMeta(req, {
        provider,
        object: sanitizeString(payload.object) || null,
        eventType: eventType || null,
        hasInstagramEntries,
        hasWhatsAppEntries,
        waMessageId: meta.waMessageId || null
      }));

      if (provider === 'meta_unknown') {
        logWarn('meta_webhook_ignored_unknown_provider', withRequestMeta(req, {
          object: sanitizeString(payload.object) || null,
          eventType: eventType || null,
          hasInstagramEntries,
          hasWhatsAppEntries
        }));

        return res.status(200).json({
          success: true,
          received: 0,
          enqueued: 0,
          unrouted: 0,
          duplicates: 0,
          warning: 'ignored_unknown_meta_provider'
        });
      }

      if (provider === 'meta_whatsapp') {
        try {
          await observeAndAutoReply(req, payload);
        } catch (error) {
          logWarn('webhook_observer_failed', withRequestMeta(req, { error: error.message }));
        }
      }

      const processed = await processInboundMessages({
        body: payload,
        headers: safeHeaders,
        requestId: req.requestId || null
      });

      return res.status(200).json({
        success: true,
        received: processed && Number.isInteger(processed.received) ? processed.received : 0,
        enqueued: processed && Number.isInteger(processed.enqueued) ? processed.enqueued : 0,
        unrouted: processed && Number.isInteger(processed.unrouted) ? processed.unrouted : 0,
        duplicates: processed && Number.isInteger(processed.duplicates) ? processed.duplicates : 0
      });
    }

    let events = [];
    events = extractLegacyInbound(payload);

    if (events.length > 0) {
      events.forEach((event) => {
        pushInboxItem({
          ts: new Date().toISOString(),
          type: 'message',
          from: event.waId || null,
          messageId: event.providerMessageId || null,
          text: event.body || null,
          payload: {
            field: 'legacy',
            messageType: event.type || null,
            message: {
              id: event.providerMessageId || null,
              from: event.waId || null,
              type: event.type || null
            }
          }
        });
      });
    }

    if (env.autoReplyEnabled && events.length > 0) {
      logWarn(
        'webhook_auto_reply_skipped_legacy_payload',
        withRequestMeta(req, {
          reason: 'legacy_payload_not_channel_scoped',
          eventCount: events.length
        })
      );
    }

    if (events.length === 0) {
      try {
        await createFailure({
          reason: 'EMPTY_PAYLOAD',
          phoneNumberId: null,
          providerMessageId: null,
          requestId: req.requestId || null,
          raw: payload,
          error: 'No inbound messages found in payload'
        });
      } catch (error) {
        logError('webhook_empty_payload_failure_persist_failed', withRequestMeta(req, { error: error.message }));
      }

      return res.status(200).json({ success: true, received: 0, enqueued: 0, unrouted: 0, duplicates: 0 });
    }

    let enqueued = 0;
    let unrouted = 0;
    let duplicates = 0;

    for (const event of events) {
      try {
        const result = await persistAndEnqueue(event, req);
        if (result.status === 'enqueued') enqueued += 1;
        if (result.status === 'unrouted') unrouted += 1;
        if (result.status === 'duplicate') duplicates += 1;
      } catch (error) {
        logError(
          'webhook_persist_failed',
          withRequestMeta(req, {
            clinicId: null,
            channelId: null,
            messageId: event.providerMessageId || null,
            error: error.message
          })
        );
      }
    }

    return res.status(200).json({
      success: true,
      received: events.length,
      enqueued,
      unrouted,
      duplicates
    });
  } catch (error) {
    logWarn(
      'webhook_payload_ignored',
      withRequestMeta(req, {
        provider,
        error: error.message,
        hasEntry: Array.isArray(payload && payload.entry),
        object: sanitizeString(payload && payload.object) || null
      })
    );
    return res.status(200).json({
      success: true,
      warning: 'ignored/invalid payload'
    });
  }
}

module.exports = {
  verifyWebhook,
  handleWebhook
};

