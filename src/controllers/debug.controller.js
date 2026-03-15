const env = require('../config/env');
const { query } = require('../db/client');
const { discoverAssets, sendTestMessage, sanitizePhoneNumber, autoDetectPhoneNumberId } = require('../whatsapp/whatsapp.service');
const { ensureAppSubscribed } = require('../services/waba.service');
const { getConfiguredChannelStatus } = require('../services/channel-resolution.service');
const { listFailures } = require('../repositories/inbound-failures.repository');
const { listWebhookEvents } = require('../repositories/webhook-event.repository');
const {
  listConversations,
  listConversationMessages,
  listAppointmentRequests,
  getLastInboundTextByConversationIds,
  listInboxAppointments,
  setAppointmentStatus,
  createAppointmentFromConversation,
  suggestNextAvailableSlots,
  suggestSlotsForTimeWindow,
  resolveCandidateTiming,
  listAppointmentsCalendar,
  getConversationById,
  enqueueJob,
  getLastMessagesForAi,
  listOutboundAiAudit
} = require('../conversations/conversation.repo');
const { findContactById } = require('../repositories/contact.repository');
const { findChannelById } = require('../repositories/tenant.repository');
const { sanitizeString } = require('../utils/validators');
const { buildAiMessages } = require('../ai/context.builder');
const { generateReply } = require('../ai/openai.client');
const { getInboxItems, clearInbox, getInboxHealth } = require('../debug/inbox-store');
const { getWebhookEvents: getRecentWebhookBufferEvents } = require('../debug/webhook-store');

function getDebugConfig(req, res) {
  return res.status(200).json({
    success: true,
    data: {
      apiVersion: env.whatsappApiVersion,
      phoneNumberId: env.whatsappPhoneNumberId,
      tokenLen: env.whatsappAccessToken.length,
      debugEnabled: env.whatsappDebug
    }
  });
}

async function getWhatsAppAssets(req, res) {
  try {
    const assets = await discoverAssets({ requestId: req.requestId });
    return res.status(200).json({
      success: true,
      data: assets
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudieron descubrir assets de WhatsApp.',
      details: error.message,
      graphStatus: error.graphStatus || null,
      graphErrorCode: error.graphErrorCode || null,
      graphErrorSubcode: error.graphErrorSubcode || null,
      graphErrorMessage: error.graphErrorMessage || null,
      fbtrace_id: error.fbtrace_id || null,
      rawGraphErrorBody: error.rawGraphErrorBody || null,
      errorCategory: error.errorCategory || null
    });
  }
}

async function getWhatsAppFailures(req, res) {
  const requested = Number.parseInt(String(req.query.limit || '50'), 10);
  const limit = Number.isFinite(requested) ? requested : 50;

  try {
    const rows = await listFailures(limit);
    return res.status(200).json({
      success: true,
      data: rows,
      count: rows.length
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo listar inbound_failures.',
      details: error.message
    });
  }
}

async function sendDebugMessage(req, res) {
  const payload = req.body || {};
  const to = sanitizePhoneNumber(payload.to);
  const text = sanitizeString(payload.text);

  if (!to) {
    return res.status(400).json({
      success: false,
      error: 'El campo "to" es obligatorio.'
    });
  }

  if (!text) {
    return res.status(400).json({
      success: false,
      error: 'El campo "text" es obligatorio.'
    });
  }

  try {
    const result = await sendTestMessage(to, text, { requestId: req.requestId });
    return res.status(200).json({
      success: true,
      messageId: result && result.messageId ? result.messageId : null,
      status: result && result.status ? result.status : null
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo enviar el mensaje de prueba.',
      details: error.message,
      graphStatus: error.graphStatus || null,
      graphErrorCode: error.graphErrorCode || null,
      graphErrorSubcode: error.graphErrorSubcode || null,
      graphErrorMessage: error.graphErrorMessage || null,
      fbtrace_id: error.fbtrace_id || null,
      rawGraphErrorBody: error.rawGraphErrorBody || null,
      to: error.to || null,
      phoneNumberId: error.phoneNumberId || null,
      payloadShape: error.payloadShape || null
    });
  }
}

async function getWhatsAppAutofix(req, res) {
  try {
    const result = await autoDetectPhoneNumberId({ requestId: req.requestId, applyEnvFix: true });
    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo ejecutar autofix de Phone Number ID.',
      details: error.message
    });
  }
}

async function getWhatsAppWaba(req, res) {
  try {
    const result = await ensureAppSubscribed({ requestId: req.requestId });
    return res.status(200).json({
      phoneNumberId: result.phoneNumberId,
      wabaId: result.wabaId,
      subscribedApps: result.subscribedApps,
      subscribedNow: result.subscribedNow
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo diagnosticar o suscribir la app al WABA.',
      details: error.message,
      graphStatus: error.graphStatus || null,
      graphErrorCode: error.graphErrorCode || null,
      graphErrorSubcode: error.graphErrorSubcode || null,
      graphErrorMessage: error.graphErrorMessage || null,
      fbtrace_id: error.fbtrace_id || null,
      rawGraphErrorBody: error.rawGraphErrorBody || null,
      errorCategory: error.errorCategory || null
    });
  }
}

async function getWhatsAppChannel(req, res) {
  const applyFix = String(req.query.applyFix || '').toLowerCase() === 'true';

  try {
    const result = await getConfiguredChannelStatus({
      requestId: req.requestId,
      autoCreate: applyFix
    });

    return res.status(result.ok ? 200 : 500).json({
      success: result.ok,
      configuredPhoneNumberId: result.configuredPhoneNumberId,
      channel: result.channel,
      reason: result.reason,
      autofixed: result.autofixed === true,
      existingChannels: result.existingChannels,
      clinics: result.clinics
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      configuredPhoneNumberId: env.whatsappPhoneNumberId || null,
      error: 'No se pudo diagnosticar o sincronizar el channel de WhatsApp.',
      details: error.message
    });
  }
}

async function getWebhookEvents(req, res) {
  const requested = Number.parseInt(String(req.query.limit || '50'), 10);
  const limit = Number.isFinite(requested) ? requested : 50;
  const eventType = sanitizeString(req.query.eventType);
  const waMessageId = sanitizeString(req.query.waMessageId);
  const includeRaw = String(req.query.includeRaw || '').toLowerCase() === 'true';

  try {
    const events = await listWebhookEvents({
      limit,
      eventType: eventType || null,
      waMessageId: waMessageId || null
    });

    const safeEvents = includeRaw
      ? events
      : events.map((event) => {
          const clone = { ...event };
          delete clone.raw;
          return clone;
        });

    return res.status(200).json({
      success: true,
      count: safeEvents.length,
      events: safeEvents
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo listar webhook_events.',
      details: error.message
    });
  }
}

async function getDebugConversations(req, res) {
  const requested = Number.parseInt(String(req.query.limit || '50'), 10);
  const limit = Number.isFinite(requested) ? requested : 50;

  try {
    const rows = await listConversations(limit);
    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo listar conversaciones.',
      details: error.message
    });
  }
}

async function getDebugConversationMessages(req, res) {
  const conversationId = sanitizeString(req.params.id);
  const requested = Number.parseInt(String(req.query.limit || '100'), 10);
  const limit = Number.isFinite(requested) ? requested : 100;

  if (!conversationId) {
    return res.status(400).json({
      success: false,
      error: 'conversationId es obligatorio.'
    });
  }

  try {
    const rows = await listConversationMessages(conversationId, limit);
    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudieron listar mensajes de la conversación.',
      details: error.message
    });
  }
}

function weekdayToEs(weekday) {
  const map = {
    monday: 'lunes',
    tuesday: 'martes',
    wednesday: 'miércoles',
    thursday: 'jueves',
    friday: 'viernes',
    saturday: 'sábado',
    sunday: 'domingo'
  };
  return map[String(weekday || '').toLowerCase()] || null;
}

function buildCandidateDisplay(context = {}) {
  const candidate = context.appointmentCandidate || {};
  const parsed = candidate.parsed || {};
  const dateISO = parsed.dateISO || null;
  const weekday = weekdayToEs(parsed.weekday);
  const time = parsed.time || null;
  const timeWindow = parsed.timeWindow || null;

  const base = dateISO
    ? (() => {
        const m = String(dateISO).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? `${m[3]}/${m[2]}` : String(dateISO);
      })()
    : (weekday || null);

  if (!base) return candidate.rawText || null;
  if (candidate.displayText) return String(candidate.displayText);
  if (time) return `${base} a las ${time}`;
  if (timeWindow === 'morning') return `${base} por la mañana`;
  if (timeWindow === 'afternoon') return `${base} por la tarde`;
  if (timeWindow === 'evening') return `${base} por la noche`;
  return base;
}

function buildPanelMessage({ baseText, defaultText, suffix }) {
  const base = sanitizeString(baseText) || sanitizeString(defaultText) || '';
  const safeSuffix = sanitizeString(suffix) || '';
  if (!base) return safeSuffix;
  if (!safeSuffix) return base;

  if (/menu/i.test(base)) {
    return base;
  }

  const punctuated = /[.!?]$/.test(base) ? base : `${base}.`;
  return `${punctuated} ${safeSuffix}`;
}

function buildInboxWarnings({ sort, reqQuery }) {
  const warnings = [];
  if (String(sort || '') === 'priority' && Object.prototype.hasOwnProperty.call(reqQuery || {}, 'order')) {
    warnings.push('order ignored when sort=priority');
  }
  return warnings;
}

async function getAppointmentRequests(req, res) {
  const limit = Number.parseInt(String(req.query.limit || '50'), 10);
  const offset = Number.parseInt(String(req.query.offset || '0'), 10);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50;
  const safeOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;

  try {
    const rows = await listAppointmentRequests({ limit: safeLimit, offset: safeOffset });
    const conversationIds = rows.map((r) => r.id).filter(Boolean);
    const lastInboundByConversation = await getLastInboundTextByConversationIds(conversationIds);

    const items = rows.map((row) => {
      const context = row.context || {};
      const candidate = context.appointmentCandidate || {};
      return {
        conversationId: row.id,
        clinicId: row.clinicId,
        channelId: row.channelId,
        contactId: row.contactId,
        waId: row.waId || null,
        name: context.name || row.name || null,
        status: context.appointmentStatus || null,
        requestedAt: context.appointmentRequestedAt || row.updatedAt || null,
        candidate: {
          displayText: candidate.displayText || buildCandidateDisplay(context),
          rawText: candidate.rawText || null,
          parsed: candidate.parsed || null
        },
        lastInboundText:
          lastInboundByConversation[row.id] && lastInboundByConversation[row.id].text
            ? lastInboundByConversation[row.id].text
            : null,
        updatedAt: row.updatedAt || null
      };
    });

    const nextOffset = items.length === safeLimit ? safeOffset + items.length : null;

    return res.status(200).json({
      success: true,
      items,
      page: {
        limit: safeLimit,
        offset: safeOffset,
        nextOffset
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudieron listar pedidos de turno.',
      details: error.message
    });
  }
}

async function getInboxAppointments(req, res) {
  const parseBoolean = (value) => {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const raw = String(value).trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return null;
  };

  const rawStatus = sanitizeString(req.query.status);
  const statuses = (rawStatus || 'requested,reschedule_proposed')
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const rawQ = sanitizeString(req.query.q) || null;
  const q = rawQ && rawQ.length >= 2 ? rawQ : null;
  const limit = Number.parseInt(String(req.query.limit || '25'), 10);
  const offset = Number.parseInt(String(req.query.offset || '0'), 10);
  const sort = sanitizeString(req.query.sort) || 'requestedAt';
  const order = sanitizeString(req.query.order) || 'desc';
  const includeTotal = String(req.query.includeTotal || 'true').toLowerCase() !== 'false';
  const clinicId = sanitizeString(req.query.clinicId) || null;
  const channelId = sanitizeString(req.query.channelId) || null;
  const hasTime = parseBoolean(req.query.hasTime);
  const needsHumanAction = parseBoolean(req.query.needsHumanAction);
  const allowedTimeWindows = new Set(['morning', 'afternoon', 'evening']);
  const timeWindow = (sanitizeString(req.query.timeWindow) || '')
    .split(',')
    .map((w) => String(w || '').trim().toLowerCase())
    .filter((w) => allowedTimeWindows.has(w));
  const safeTimeWindow = timeWindow.length ? timeWindow : null;
  const allowedPriority = new Set(['high', 'normal', 'low']);
  const priority = (sanitizeString(req.query.priority) || '')
    .split(',')
    .map((p) => String(p || '').trim().toLowerCase())
    .filter((p) => allowedPriority.has(p));
  const safePriority = priority.length ? priority : null;

  const safeSort = sort === 'updatedAt' || sort === 'priority' ? sort : 'requestedAt';
  const safeOrder = String(order).toLowerCase() === 'asc' ? 'asc' : 'desc';
  const warnings = buildInboxWarnings({ sort: safeSort, reqQuery: req.query });

  try {
    const result = await listInboxAppointments({
      statuses,
      q,
      limit,
      offset,
      sort: safeSort,
      order: safeOrder,
      includeTotal,
      clinicId,
      channelId,
      hasTime,
      timeWindow: safeTimeWindow,
      needsHumanAction,
      priority: safePriority
    });

    const nextOffset = result.items.length === result.limit ? result.offset + result.items.length : null;

    const response = {
      success: true,
      items: result.items,
      page: {
        limit: result.limit,
        offset: result.offset,
        nextOffset,
        total: includeTotal ? result.total : null
      }
    };

    if (warnings.length) {
      response.warnings = warnings;
    }

    return res.status(200).json(response);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo cargar la bandeja operativa.',
      details: error.message
    });
  }
}

async function getAppointmentRequestDetail(req, res) {
  const conversationId = sanitizeString(req.params.conversationId);
  if (!conversationId) {
    return res.status(400).json({ success: false, error: 'conversationId es obligatorio.' });
  }

  try {
    const conversation = await getConversationById(conversationId);
    if (!conversation) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada.' });
    }
    const contact = await findContactById(conversation.contactId);
    const channel = conversation.channelId ? await findChannelById(conversation.channelId) : null;
    const messages = await listConversationMessages(conversationId, 20);

    return res.status(200).json({
      success: true,
      conversation,
      contact: contact
        ? {
            id: contact.id,
            waId: contact.waId || null,
            name: contact.name || null
          }
        : null,
      channel: channel
        ? {
            id: channel.id,
            phoneNumberId: channel.phoneNumberId || null
          }
        : null,
      messages
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo obtener detalle del pedido.',
      details: error.message
    });
  }
}

async function processAppointmentAction(req, res, actionType) {
  const conversationId = sanitizeString(req.params.conversationId);
  const actionId = sanitizeString(req.get('x-action-id'));
  const payload = req.body || {};

  if (!conversationId) {
    return res.status(400).json({ success: false, error: 'conversationId es obligatorio.' });
  }

  try {
    const conversation = await getConversationById(conversationId);
    if (!conversation) {
      return res.status(404).json({ success: false, error: 'Conversación no encontrada.' });
    }

    const context = conversation.context || {};
    if (actionId && context.appointmentLastActionId && String(context.appointmentLastActionId) === actionId) {
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'duplicate_action_id',
        conversationId
      });
    }

    const contact = await findContactById(conversation.contactId);
    if (!contact || !contact.waId) {
      return res.status(400).json({
        success: false,
        error: 'No se encontró contacto/waId para esta conversación.'
      });
    }

    const nowIso = new Date().toISOString();
    const candidateDisplay = buildCandidateDisplay(context);
    const menuSuffix = "Si necesitás cambiarlo, respondé 'menu'.";
    let status = 'requested';
    let patch = {};
    let text = '';
    const currentAppointmentStatus = sanitizeString(context.appointmentStatus) || null;
    const warning =
      currentAppointmentStatus && currentAppointmentStatus !== 'requested'
        ? `appointmentStatus was ${currentAppointmentStatus}, updated anyway`
        : null;

    if (actionType === 'confirm') {
      const confirmedText = sanitizeString(payload.confirmedText) || candidateDisplay || 'el horario coordinado';
      const customMessage = sanitizeString(payload.message);
      status = 'confirmed';
      text = buildPanelMessage({
        baseText: customMessage,
        defaultText: `✅ Turno confirmado. Te esperamos el ${confirmedText}.`,
        suffix: menuSuffix
      });
      patch = {
        appointmentClinicResponse: {
          type: 'confirmed',
          confirmedText: confirmedText || null,
          message: text
        }
      };
    } else if (actionType === 'reject') {
      const customMessage = sanitizeString(payload.message);
      status = 'rejected';
      text = buildPanelMessage({
        baseText: customMessage,
        defaultText: "❌ No tenemos disponibilidad en ese horario. Respondé con otro día/hora o escribí 'menu' para opciones.",
        suffix: menuSuffix
      });
      patch = {
        appointmentClinicResponse: {
          type: 'rejected',
          message: text
        }
      };
    } else {
      const proposed = sanitizeString(payload.proposed);
      if (!proposed) {
        return res.status(400).json({ success: false, error: 'proposed es obligatorio para reprogramación.' });
      }
      const customMessage = sanitizeString(payload.message);
      status = 'reschedule_proposed';
      text = buildPanelMessage({
        baseText: customMessage,
        defaultText: `🔄 No llegamos con ese horario. ¿Te sirve ${proposed}? Respondé 'si' para confirmar o 'no' para enviar otro.`,
        suffix: menuSuffix
      });
      patch = {
        appointmentRescheduleProposal: {
          proposed,
          createdAt: nowIso,
          createdBy: 'human_panel'
        },
        appointmentClinicResponse: {
          type: 'reschedule_proposed',
          proposed,
          message: text
        }
      };
    }

    patch.appointmentLastActionId = actionId || null;

    await setAppointmentStatus({
      conversationId,
      status,
      patch
    });

    let appointmentId = null;
    let appointmentCreated = false;
    let appointmentWarning = null;
    let suggestions = [];
    if (actionType === 'confirm') {
      const candidate = context.appointmentCandidate || null;
      const timing = resolveCandidateTiming(candidate);
      if (!timing.startAt) {
        if (timing.timeWindow && timing.dateISO) {
          appointmentWarning = 'Missing exact time; suggested slots for timeWindow';
          suggestions = await suggestSlotsForTimeWindow({
            clinicId: conversation.clinicId,
            dateISO: timing.dateISO,
            timeWindow: timing.timeWindow,
            count: 3,
            stepMinutes: 30
          });
        } else {
          appointmentWarning = 'Appointment conflict: missing exact time for suggestions';
          suggestions = [];
        }
      } else {
        const createdAppointment = await createAppointmentFromConversation({
          clinicId: conversation.clinicId,
          channelId: conversation.channelId,
          conversationId: conversation.id,
          contactId: conversation.contactId,
          waId: contact.waId || null,
          patientName: (context && context.name) || contact.name || null,
          candidate,
          source: 'human_panel'
        });

        if (createdAppointment && createdAppointment.created && createdAppointment.row) {
          appointmentId = createdAppointment.row.id;
          appointmentCreated = true;
        } else if (createdAppointment && createdAppointment.conflict) {
          appointmentWarning = 'Appointment conflict: already booked';
          suggestions = await suggestNextAvailableSlots({
            clinicId: conversation.clinicId,
            startAt: timing.startAt,
            count: 3,
            stepMinutes: 30,
            maxLookaheadDays: 7
          });
        }
      }
    }

    const job = await enqueueJob('whatsapp_send', {
      clinicId: conversation.clinicId,
      channelId: conversation.channelId,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      to: contact.waId,
      text,
      type: 'text'
    });

    return res.status(200).json({
      success: true,
      conversationId,
      status,
      actionId: actionId || null,
      jobId: job ? job.id : null,
      warning: appointmentWarning || warning || null,
      appointmentId,
      appointmentCreated,
      suggestions
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo procesar acción de appointment.',
      details: error.message
    });
  }
}

async function confirmAppointmentRequest(req, res) {
  return processAppointmentAction(req, res, 'confirm');
}

async function rejectAppointmentRequest(req, res) {
  return processAppointmentAction(req, res, 'reject');
}

async function rescheduleAppointmentRequest(req, res) {
  return processAppointmentAction(req, res, 'reschedule');
}

async function getAiReply(req, res) {
  const aiEnabled = env.aiEnabled === true;
  const hasAiKey = !!String(env.openaiApiKey || '').trim();
  if (!aiEnabled) {
    return res.status(400).json({
      success: false,
      error: 'AI is disabled. Set AI_ENABLED=true.'
    });
  }

  if (!hasAiKey) {
    return res.status(400).json({
      success: false,
      error: 'Missing OPENAI_API_KEY.'
    });
  }

  const payload = req.body || {};
  const conversationId = sanitizeString(payload.conversationId);
  const inboundText = sanitizeString(payload.text);

  if (!inboundText) {
    return res.status(400).json({
      success: false,
      error: 'text es obligatorio.'
    });
  }

  try {
    let conversation = null;
    let historyMessages = [];

    if (conversationId) {
      conversation = await getConversationById(conversationId);
      if (!conversation) {
        return res.status(404).json({
          success: false,
          error: 'Conversación no encontrada.'
        });
      }
      historyMessages = await getLastMessagesForAi(conversation.id, 10);
    }

    const aiContext = buildAiMessages({
      conversation,
      historyMessages,
      inboundText
    });
    const aiResult = await generateReply({
      systemPrompt: aiContext.systemPrompt,
      messages: aiContext.messages,
      model: env.openaiModel,
      timeoutMs: env.openaiTimeoutMs
    });

    return res.status(200).json({
      success: true,
      replyText: aiResult.replyText,
      model: aiResult.model,
      usage: aiResult.usage || null
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo generar respuesta IA.',
      details: error.message
    });
  }
}

async function getAiAudit(req, res) {
  const requested = Number.parseInt(String(req.query.limit || '20'), 10);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, requested)) : 20;
  const conversationId = sanitizeString(req.query.conversationId) || null;

  try {
    const items = await listOutboundAiAudit({
      conversationId,
      limit
    });

    return res.status(200).json({
      success: true,
      items
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo obtener auditoría de IA.',
      details: error.message
    });
  }
}

function clampCalendarRange(fromDate, toDate) {
  const maxMs = 31 * 24 * 60 * 60 * 1000;
  const diffMs = toDate.getTime() - fromDate.getTime();
  if (diffMs > maxMs) {
    return new Date(fromDate.getTime() + maxMs);
  }
  return toDate;
}

async function getAppointmentsCalendar(req, res) {
  const clinicId = sanitizeString(req.query.clinicId) || null;
  const fromRaw = sanitizeString(req.query.from);
  const toRaw = sanitizeString(req.query.to);

  const today = new Date();
  const defaultTo = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const fromDate = fromRaw ? new Date(`${fromRaw}T00:00:00`) : today;
  const toDateInput = toRaw ? new Date(`${toRaw}T23:59:59`) : defaultTo;

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDateInput.getTime())) {
    return res.status(400).json({
      success: false,
      error: 'from/to invalidos. Usar YYYY-MM-DD.'
    });
  }

  const toDate = clampCalendarRange(fromDate, toDateInput);

  try {
    const items = await listAppointmentsCalendar({
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      clinicId
    });
    return res.status(200).json({
      success: true,
      items
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo listar agenda de appointments.',
      details: error.message
    });
  }
}

function getDebugInbox(req, res) {
  const requested = Number.parseInt(String(req.query.limit || '50'), 10);
  const limit = Number.isFinite(requested) ? requested : 50;

  return res.status(200).json({
    success: true,
    items: getInboxItems({ limit })
  });
}

function clearDebugInbox(req, res) {
  clearInbox();
  return res.status(200).json({
    success: true
  });
}

function getDebugInboxHealth(req, res) {
  const health = getInboxHealth();
  return res.status(200).json({
    ok: true,
    size: health.size,
    max: health.max
  });
}

function getRecentWebhookEvents(req, res) {
  const requested = Number.parseInt(String(req.query.limit || '20'), 10);
  const limit = Number.isFinite(requested) ? requested : 20;

  return res.status(200).json({
    success: true,
    items: getRecentWebhookBufferEvents({ limit })
  });
}

function parseStoredJobError(lastError) {
  const text = String(lastError || '').trim();
  if (!text) {
    return {
      lastError: null,
      graphStatus: null,
      graphErrorCode: null,
      graphErrorMessage: null,
      fbtrace_id: null,
      phoneNumberId: null,
      to: null,
      graphUrl: null
    };
  }

  const parts = text.split(' | ');
  const parsed = {
    lastError: text,
    graphStatus: null,
    graphErrorCode: null,
    graphErrorMessage: null,
    fbtrace_id: null,
    phoneNumberId: null,
    to: null,
    graphUrl: null
  };

  parts.slice(1).forEach((part) => {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) return;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (!value) return;
    if (key === 'graphStatus') parsed.graphStatus = Number(value);
    if (key === 'graphErrorCode') parsed.graphErrorCode = Number(value);
    if (key === 'graphErrorMessage') parsed.graphErrorMessage = value;
    if (key === 'fbtrace_id') parsed.fbtrace_id = value;
    if (key === 'phoneNumberId') parsed.phoneNumberId = value;
    if (key === 'to') parsed.to = value;
    if (key === 'graphUrl') parsed.graphUrl = value;
  });

  return parsed;
}

async function getRecentWhatsAppJobs(req, res) {
  const requested = Number.parseInt(String(req.query.limit || '10'), 10);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(50, requested)) : 10;

  try {
    const result = await query(
      `SELECT id, type, status, attempts, "lastError", payload, "channelId", "clinicId", "runAt", "updatedAt", "createdAt"
       FROM jobs
       WHERE type IN ('whatsapp_send', 'whatsapp_template_send')
       ORDER BY "updatedAt" DESC, "createdAt" DESC
       LIMIT $1`,
      [limit]
    );

    const items = result.rows.map((row) => {
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const errorMeta = parseStoredJobError(row.lastError);
      const phoneNumberId = payload.phoneNumberId || errorMeta.phoneNumberId || null;

      return {
        id: row.id,
        type: row.type,
        status: row.status,
        attempts: row.attempts,
        clinicId: row.clinicId,
        channelId: row.channelId,
        phoneNumberId,
        to: payload.to || errorMeta.to || null,
        graphUrl:
          errorMeta.graphUrl ||
          (phoneNumberId ? `https://graph.facebook.com/${env.whatsappApiVersion}/${phoneNumberId}/messages` : null),
        graphStatus: errorMeta.graphStatus,
        graphErrorCode: errorMeta.graphErrorCode,
        graphErrorMessage: errorMeta.graphErrorMessage,
        fbtrace_id: errorMeta.fbtrace_id,
        lastError: errorMeta.lastError,
        payload,
        runAt: row.runAt,
        updatedAt: row.updatedAt,
        createdAt: row.createdAt,
        attemptedAt: row.updatedAt
      };
    });

    return res.status(200).json({
      success: true,
      items
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudieron listar jobs recientes de WhatsApp.',
      details: error.message
    });
  }
}

module.exports = {
  getDebugConfig,
  getWhatsAppAssets,
  getWhatsAppFailures,
  sendDebugMessage,
  getWhatsAppAutofix,
  getWhatsAppWaba,
  getWhatsAppChannel,
  getWebhookEvents,
  getDebugConversations,
  getDebugConversationMessages,
  getAppointmentRequests,
  getInboxAppointments,
  getAppointmentRequestDetail,
  confirmAppointmentRequest,
  rejectAppointmentRequest,
  rescheduleAppointmentRequest,
  getAiReply,
  getAiAudit,
  getAppointmentsCalendar,
  getDebugInbox,
  clearDebugInbox,
  getDebugInboxHealth,
  getRecentWebhookEvents,
  getRecentWhatsAppJobs,
  buildPanelMessage,
  buildInboxWarnings
};
