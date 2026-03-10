require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { DateTime } = require('luxon');
const env = require('./config/env');
const { withTransaction } = require('./db/client');
const { logInfo, logWarn, logError } = require('./utils/logger');
const { findChannelById } = require('./repositories/tenant.repository');
const { findContactById } = require('./repositories/contact.repository');
const {
  findConversationById,
  markLastOutbound,
  updateConversationStatus,
  updateConversationStage
} = require('./repositories/conversation.repository');
const { insertOutboundMessage, getMessageById } = require('./repositories/message.repository');
const { sendTextMessage, sendTemplateMessage } = require('./whatsapp/whatsapp.service');
const { normalizeWhatsAppTo } = require('./whatsapp/normalize-phone');
const conversationRepo = require('./conversations/conversation.repo');
const { decideReply } = require('./conversations/conversation.engine');
const { listProductsByClinicId } = require('./repositories/products.repository');
const { createOrderForClinic } = require('./services/portal-orders.service');
const { generateReply } = require('./ai/openai.client');
const { buildAiMessages } = require('./ai/context.builder');
const {
  upsertLeadForConversation,
  updateLeadStatus,
  findLeadByConversation,
  assignLead
} = require('./repositories/lead.repository');
const {
  getOrCreateCalendarRules,
  ensureSlotsForDateRange,
  listAvailableSlots,
  holdSlot,
  bookHeldSlot,
  releaseExpiredHolds,
  getClinic,
  findBookedAppointmentByConversation,
  cancelAppointment
} = require('./repositories/calendar.repository');
const { getDefaultAssignee } = require('./repositories/staff.repository');
const { openHandoff, assignHandoff, getOpenHandoff } = require('./repositories/handoff.repository');
const {
  addEvent,
  findLatestEventByType,
  countRecentEventsByType
} = require('./repositories/conversation-events.repository');
const { claimJobs, markJobDone, requeueOrFailJob } = require('./repositories/job.repository');

const WORKER_ID = env.workerId || 'worker-1';
const POLL_MS = Number(env.workerPollMs || 1000);
const BATCH_SIZE = Number(env.workerBatchSize || 10);
const DAYS_AHEAD = Number(env.defaultAppointmentDaysAhead || 7);
const HOLD_MINUTES = Number(env.defaultHoldMinutes || 10);
const AI_ALLOWED_STATES = new Set((env.aiAllowedStates || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean));
const AI_DENIED_STATES = new Set((env.aiDeniedStates || []).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean));
const AI_ALLOWED_JOB_TYPES = new Set((env.aiAllowedJobTypes || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean));
const AI_MAX_CALLS_PER_WINDOW = Number(env.aiMaxCallsPerConversationWindow || 5);
const AI_WINDOW_MS = Number(env.aiWindowMs || 3600000);
const AI_ENABLED_CLINIC_IDS = new Set((env.aiEnabledClinicIds || []).map((s) => String(s || '').trim()).filter(Boolean));
const AI_DISABLED_CLINIC_IDS = new Set((env.aiDisabledClinicIds || []).map((s) => String(s || '').trim()).filter(Boolean));
const AI_ENABLED_CHANNEL_IDS = new Set((env.aiEnabledChannelIds || []).map((s) => String(s || '').trim()).filter(Boolean));
const AI_DISABLED_CHANNEL_IDS = new Set((env.aiDisabledChannelIds || []).map((s) => String(s || '').trim()).filter(Boolean));

let stopped = false;
let polling = false;
let processingCount = 0;
let timer = null;
let started = false;
const aiBudget = new Map();

function sanitizeDatabaseUrl(databaseUrl) {
  const raw = String(databaseUrl || '').trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname || 'localhost';
    const port = parsed.port || '5432';
    const dbname = (parsed.pathname || '').replace(/^\//, '') || null;
    return { hostPort: `${host}:${port}`, dbname };
  } catch (error) {
    const match = raw.match(/@([^/]+)\/([^?\s]+)/);
    if (!match) return null;
    return { hostPort: match[1], dbname: match[2] || null };
  }
}

function normalizeText(input) {
  return String(input || '').trim().toLowerCase();
}

function normalizeCommandText(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?]+$/g, '')
    .trim();
}

function normalizeDigitsOnly(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function parseJobPayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch (error) {
      throw new Error('Invalid JSON payload for job');
    }
  }
  throw new Error('Unsupported job payload format');
}

function sanitizeAiUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  return {
    prompt_tokens:
      usage.prompt_tokens !== undefined && usage.prompt_tokens !== null
        ? Number(usage.prompt_tokens)
        : null,
    completion_tokens:
      usage.completion_tokens !== undefined && usage.completion_tokens !== null
        ? Number(usage.completion_tokens)
        : null,
    total_tokens:
      usage.total_tokens !== undefined && usage.total_tokens !== null
        ? Number(usage.total_tokens)
        : null
  };
}

function reserveAiBudget(conversationId) {
  const now = Date.now();
  const key = String(conversationId || '').trim();
  if (!key) {
    return { allowed: false, reason: 'missing_conversation_id', usedCount: 0 };
  }

  const current = aiBudget.get(key);
  if (!current || now - current.windowStartMs > AI_WINDOW_MS) {
    const fresh = { windowStartMs: now, usedCount: 1 };
    aiBudget.set(key, fresh);
    return { allowed: true, usedCount: fresh.usedCount };
  }

  if (current.usedCount >= AI_MAX_CALLS_PER_WINDOW) {
    return { allowed: false, reason: 'rate_limited', usedCount: current.usedCount };
  }

  current.usedCount += 1;
  aiBudget.set(key, current);
  return { allowed: true, usedCount: current.usedCount };
}

function evaluateAiEligibility({ jobType, state }) {
  const normalizedJobType = String(jobType || '').trim().toLowerCase();
  const normalizedState = String(state || '').trim().toUpperCase();

  if (AI_ALLOWED_JOB_TYPES.size > 0 && !AI_ALLOWED_JOB_TYPES.has(normalizedJobType)) {
    return { allowed: false, reason: 'job_type_not_allowed' };
  }

  if (AI_DENIED_STATES.has(normalizedState)) {
    return { allowed: false, reason: 'state_denied' };
  }

  if (AI_ALLOWED_STATES.size > 0 && !AI_ALLOWED_STATES.has(normalizedState)) {
    return { allowed: false, reason: 'state_not_allowed' };
  }

  return { allowed: true, reason: null };
}

function isAiAllowedForScope({ clinicId, channelId }) {
  const safeClinicId = String(clinicId || '').trim();
  const safeChannelId = String(channelId || '').trim();

  if (safeClinicId && AI_DISABLED_CLINIC_IDS.has(safeClinicId)) {
    return { ok: false, reason: 'clinic_denied' };
  }

  if (safeChannelId && AI_DISABLED_CHANNEL_IDS.has(safeChannelId)) {
    return { ok: false, reason: 'channel_denied' };
  }

  if (AI_ENABLED_CLINIC_IDS.size > 0 && (!safeClinicId || !AI_ENABLED_CLINIC_IDS.has(safeClinicId))) {
    return { ok: false, reason: 'clinic_not_allowed' };
  }

  if (AI_ENABLED_CHANNEL_IDS.size > 0 && (!safeChannelId || !AI_ENABLED_CHANNEL_IDS.has(safeChannelId))) {
    return { ok: false, reason: 'channel_not_allowed' };
  }

  return { ok: true, reason: null };
}

function detectIntent(rawText) {
  const text = normalizeText(rawText);

  const appointmentWords = /(turno|cita|agenda|sacar turno|reservar|agendar)/i;
  const urgentWords = /(dolor|urgencia|sangrado|inflamado|se me sali[oó]|me duele mucho)/i;
  const pricingWords = /(precio|cuanto|cu[aá]nto|valor|costo)/i;
  const humanWords = /(humano|recepcion|persona|llamar|asesor)/i;

  if (urgentWords.test(text)) return 'urgent';
  if (humanWords.test(text)) return 'human';
  if (appointmentWords.test(text)) return 'appointment';
  if (pricingWords.test(text)) return 'pricing';
  return 'unknown';
}

function isCommerceEntryIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return (
    text === 'hola' ||
    text === 'buenas' ||
    text === 'buen dia' ||
    text === 'buenas tardes' ||
    text === 'buenas noches' ||
    text === 'productos' ||
    text === 'catalogo' ||
    text === 'comprar' ||
    text === 'pedido' ||
    text === 'pedidos'
  );
}

function buildCommerceCatalog(products) {
  return (Array.isArray(products) ? products : [])
    .filter((product) => {
      const status = String(product && product.status ? product.status : '').toLowerCase();
      const stock = Number(product && product.stock ? product.stock : 0);
      return status === 'active' && stock > 0;
    })
    .slice(0, 10)
    .map((product, index) => ({
      index: index + 1,
      productId: product.id,
      name: product.name,
      price: Number(product.price || 0),
      currency: String(product.currency || 'ARS').toUpperCase() || 'ARS',
      stock: Number(product.stock || 0),
      sku: product.sku || null
    }));
}

function buildCommerceCatalogReply(products) {
  if (!products.length) {
    return 'Hola. En este momento no tenemos productos disponibles para pedir por WhatsApp.';
  }

  const lines = [
    'Hola.',
    'Estos son nuestros productos disponibles:',
    '',
    ...products.map((product) => `${product.index}) ${product.name} - ${formatMoney(product.price, product.currency)}`),
    '',
    'Responde con el numero del producto que queres.'
  ];

  return lines.join('\n');
}

function parseCommerceSelection(rawText, max) {
  const text = normalizeCommandText(rawText);
  const match = text.match(/^(\d{1,2})$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return null;
  }
  return value;
}

function parseCommerceQuantity(rawText) {
  const text = normalizeCommandText(rawText);
  const match = text.match(/^(\d{1,3})$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function buildCommerceResetPatch(extra = {}) {
  return {
    commerceCatalog: null,
    commerceSelectedProduct: null,
    ...extra
  };
}

async function resolveCommerceDecision({ conversation, clinic, contact, inboundText }) {
  const currentState = String(conversation.state || '').toUpperCase();
  const safeContext = conversation.context && typeof conversation.context === 'object' ? conversation.context : {};
  const catalogFromContext = Array.isArray(safeContext.commerceCatalog) ? safeContext.commerceCatalog : [];

  if (isCommerceEntryIntent(inboundText)) {
    const products = buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId));
    return {
      replyText: buildCommerceCatalogReply(products),
      newState: products.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceCatalog: products
      })
    };
  }

  if (currentState === 'WAITING_PRODUCT_SELECTION') {
    if (isGlobalMenuCommand(inboundText)) {
      return {
        replyText: 'Listo. Cuando quieras ver el catalogo otra vez, escribi "productos".',
        newState: 'IDLE',
        contextPatch: buildCommerceResetPatch()
      };
    }

    const products = catalogFromContext.length
      ? catalogFromContext
      : buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId));
    const selection = parseCommerceSelection(inboundText, products.length);
    if (!selection) {
      return {
        replyText: products.length
          ? 'No entendi ese producto. Por favor elegi un numero de la lista.'
          : 'No hay productos disponibles ahora mismo. Escribi "productos" para intentar de nuevo.',
        newState: products.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: products.length ? products : null
        })
      };
    }

    const selectedProduct = products[selection - 1] || null;
    if (!selectedProduct) {
      return {
        replyText: 'No entendi ese producto. Por favor elegi un numero de la lista.',
        newState: 'WAITING_PRODUCT_SELECTION',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: products
        })
      };
    }

    return {
      replyText: `Elegiste: ${selectedProduct.name}\n\nCuantas unidades queres?`,
      newState: 'WAITING_QUANTITY',
      contextPatch: {
        commerceCatalog: products,
        commerceSelectedProduct: selectedProduct
      }
    };
  }

  if (currentState === 'WAITING_QUANTITY') {
    if (isGlobalMenuCommand(inboundText)) {
      const products = buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId));
      return {
        replyText: buildCommerceCatalogReply(products),
        newState: products.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: products
        })
      };
    }

    const selectedProduct = safeContext.commerceSelectedProduct || null;
    if (!selectedProduct || !selectedProduct.productId) {
      const products = buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId));
      return {
        replyText: buildCommerceCatalogReply(products),
        newState: products.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: products
        })
      };
    }

    const quantity = parseCommerceQuantity(inboundText);
    if (!quantity) {
      return {
        replyText: 'Decime un numero valido de unidades.',
        newState: 'WAITING_QUANTITY',
        contextPatch: {
          commerceCatalog: catalogFromContext,
          commerceSelectedProduct: selectedProduct
        }
      };
    }

    const orderResult = await createOrderForClinic(conversation.clinicId, {
      customerName: contact.name || `Cliente ${String(contact.waId || contact.phone || '').slice(-4) || 'WhatsApp'}`,
      customerPhone: contact.phone || contact.waId || null,
      notes: 'Pedido creado desde WhatsApp commerce',
      items: [
        {
          productId: selectedProduct.productId,
          quantity
        }
      ]
    });

    if (!orderResult.ok) {
      if (orderResult.reason === 'order_item_insufficient_stock') {
        return {
          replyText: 'Lo siento, no tenemos suficiente stock de ese producto en este momento.',
          newState: 'WAITING_QUANTITY',
          contextPatch: {
            commerceCatalog: catalogFromContext,
            commerceSelectedProduct: selectedProduct
          }
        };
      }

      if (orderResult.reason === 'order_item_product_not_found' || orderResult.reason === 'order_item_product_inactive') {
        const products = buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId));
        return {
          replyText: products.length
            ? `Ese producto ya no esta disponible.\n\n${buildCommerceCatalogReply(products)}`
            : 'Ese producto ya no esta disponible y no hay otros productos activos para pedir ahora mismo.',
          newState: products.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
          contextPatch: buildCommerceResetPatch({
            commerceCatalog: products.length ? products : null
          })
        };
      }

      return {
        replyText: 'No pude registrar tu pedido en este momento. Intenta nuevamente en unos minutos.',
        newState: 'IDLE',
        contextPatch: buildCommerceResetPatch()
      };
    }

    const order = orderResult.order;
    return {
      replyText: [
        'Perfecto.',
        '',
        'Tu pedido fue registrado:',
        `${selectedProduct.name} x${quantity}`,
        `Total: ${formatMoney(Number(order.total || 0), order.currency || selectedProduct.currency || 'ARS')}`,
        '',
        'En breve te confirmamos la preparacion.'
      ].join('\n'),
      newState: 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceLastOrderId: order.id || null,
        commerceLastOrderAt: new Date().toISOString()
      })
    };
  }

  return null;
}

function formatMoney(value, currency = 'ARS') {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: String(currency || 'ARS').toUpperCase(),
    maximumFractionDigits: 0
  }).format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

function extractSelection(rawText) {
  const text = normalizeText(rawText);
  const match = text.match(/^([1-5])$/);
  if (!match) return null;
  return Number(match[1]);
}

function parseTimeWindowInput(rawText) {
  const text = normalizeCommandText(rawText);
  if (/(manana|temprano)/.test(text)) return 'morning';
  if (/\btarde\b/.test(text)) return 'afternoon';
  if (/\bnoche\b/.test(text)) return 'evening';
  return null;
}

function isAffirmativeSimple(rawText) {
  const text = normalizeCommandText(rawText);
  return ['si', 's', 'confirmo', 'ok', 'dale'].includes(text);
}

function isGlobalMenuCommand(rawText) {
  const text = normalizeCommandText(rawText);
  return ['cancelar', 'salir', 'menu', 'volver', 'atras'].includes(text);
}

function isSuggestionExpired(createdAtIso, ttlMinutes = 30) {
  const raw = String(createdAtIso || '').trim();
  if (!raw) return true;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return true;
  return Date.now() - dt.getTime() > ttlMinutes * 60 * 1000;
}

function formatDateIsoShort(dateISO) {
  const match = String(dateISO || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(dateISO || '');
  return `${match[3]}/${match[2]}`;
}

function buildSuggestionReply({ dateISO, timeWindow, suggestions }) {
  const windowLabel = timeWindow === 'morning' ? 'mañana' : timeWindow === 'afternoon' ? 'tarde' : 'noche';
  const dateLabel = formatDateIsoShort(dateISO);
  const lines = [
    `Tengo estos horarios disponibles para ${dateLabel} (${windowLabel}):`,
    ...suggestions.map((slot, idx) => `${idx + 1}) ${slot.displayText}`),
    'Responde con 1, 2 o 3.'
  ];
  return lines.join('\n');
}

function isReplaySafeConfirmation(context, startAt) {
  const safeContext = context && typeof context === 'object' ? context : {};
  const status = String(safeContext.appointmentStatus || '').toLowerCase();
  const lastStartAt = String(safeContext.appointmentLastConfirmedStartAt || '').trim();
  const targetStartAt = String(startAt || '').trim();
  return status === 'confirmed' && !!lastStartAt && !!targetStartAt && lastStartAt === targetStartAt;
}

function buildConfirmedContextPatch(startAt) {
  return {
    appointmentStatus: 'confirmed',
    appointmentConfirmedAt: new Date().toISOString(),
    appointmentLastConfirmedStartAt: startAt || null,
    appointmentSuggestions: null,
    appointmentSuggestionsForDate: null,
    appointmentSuggestionsTimeWindow: null,
    appointmentSuggestionsCreatedAt: null
  };
}

function isCancellation(rawText) {
  const text = normalizeText(rawText);
  return /(cancelar|cancelo|cancelaci[oó]n|anular turno)/i.test(text);
}

function detectTurnManagementIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  if (
    /(^|\s)(reprogramar|cambiar turno|otro horario|no puedo|mover turno)(\s|$)/i.test(text)
  ) {
    return 'reschedule';
  }

  if (
    /(^|\s)(cancelar|anular|darlo de baja)(\s|$)/i.test(text)
  ) {
    return 'cancel';
  }

  return null;
}

function formatSlotForHuman(utcIso, timezone) {
  return DateTime.fromISO(String(utcIso), { zone: 'utc' }).setZone(timezone).toFormat('ccc dd/LL HH:mm');
}

async function sendAndPersistReply({ clinicId, channel, conversationId, contact, text, requestId, correlationMessageId }) {
  const sendResult = await sendTextMessage(
    { to: contact.waId, text },
    {
      requestId,
      credentials: {
        accessToken: channel.accessToken || env.whatsappAccessToken,
        phoneNumberId: channel.phoneNumberId || env.whatsappPhoneNumberId
      }
    }
  );

  await insertOutboundMessage({
    clinicId,
    channelId: channel.id,
    conversationId,
    providerMessageId: sendResult.messageId,
    from: channel.phoneNumberId || env.whatsappPhoneNumberId,
    to: contact.waId,
    type: 'text',
    body: text,
    raw: sendResult.raw || {}
  });

  await markLastOutbound(conversationId);

  logInfo('worker_outbound_sent', {
    requestId,
    clinicId,
    channelId: channel.id,
    conversationId,
    contactId: contact.id,
    messageId: correlationMessageId || null,
    outboundMessageId: sendResult.messageId || null
  });

  return sendResult;
}

async function openHandoffFlow({ clinicId, conversationId, contact, lead, reason, clinicSettings, channel, requestId, messageId }) {
  await withTransaction(async (client) => {
    const handoff = await openHandoff(
      {
        clinicId,
        conversationId,
        contactId: contact.id,
        leadId: lead ? lead.id : null,
        reason
      },
      client
    );

    await updateConversationStatus(conversationId, 'needs_human', client);
    await updateConversationStage(conversationId, 'handoff', client);

    if (lead) {
      await updateLeadStatus(lead.id, 'handoff', `handoff:${reason}`, client);
    }

    await addEvent(
      {
        clinicId,
        conversationId,
        type: 'HANDOFF_OPENED',
        data: {
          handoffId: handoff.id,
          reason
        }
      },
      client
    );

    const defaultAssignee = await getDefaultAssignee(clinicId, client);
    if (defaultAssignee) {
      await assignHandoff(handoff.id, defaultAssignee.id, client);
      if (lead) {
        await assignLead(lead.id, defaultAssignee.id, client);
      }
      await addEvent(
        {
          clinicId,
          conversationId,
          type: 'HANDOFF_ASSIGNED',
          data: {
            handoffId: handoff.id,
            staffUserId: defaultAssignee.id,
            staffName: defaultAssignee.name
          }
        },
        client
      );

      logInfo('handoff_assigned_default_staff', {
        requestId,
        clinicId,
        conversationId,
        contactId: contact.id,
        staffUserId: defaultAssignee.id,
        staffName: defaultAssignee.name
      });
    }
  });

  const handoffMessage =
    (clinicSettings && clinicSettings.handoffMessage) ||
    'Te derivamos con un humano. En breve te contactamos.';

  await sendAndPersistReply({
    clinicId,
    channel,
    conversationId,
    contact,
    text: handoffMessage,
    requestId,
    correlationMessageId: messageId
  });
}

async function tryAppointmentSelection({ clinicId, conversationId, contact, lead, rawText, channel, timezone, requestId, messageId }) {
  const selection = extractSelection(rawText);
  if (!selection) {
    return false;
  }

  const offeredEvent = await findLatestEventByType(clinicId, conversationId, 'SLOT_OFFERED', 20);
  if (!offeredEvent || !offeredEvent.data || !Array.isArray(offeredEvent.data.options)) {
    return false;
  }

  const chosen = offeredEvent.data.options.find((item) => Number(item.index) === selection);
  if (!chosen || !chosen.slotId) {
    return false;
  }

  const booked = await withTransaction(async (client) => {
    const held = await holdSlot(clinicId, chosen.slotId, conversationId, HOLD_MINUTES, client);
    if (!held) {
      return null;
    }

    await addEvent(
      {
        clinicId,
        conversationId,
        type: 'SLOT_HELD',
        data: {
          slotId: held.id,
          startsAt: held.startsAt,
          heldUntil: held.heldUntil
        }
      },
      client
    );

    const bookedResult = await bookHeldSlot(clinicId, held.id, lead.id, conversationId, contact.id, client);
    if (!bookedResult) {
      return null;
    }

    await updateLeadStatus(lead.id, 'confirmed', null, client);
    await updateConversationStage(conversationId, 'confirmed', client);
    await updateConversationStatus(conversationId, 'open', client);

    await addEvent(
      {
        clinicId,
        conversationId,
        type: 'APPOINTMENT_BOOKED',
        data: {
          appointmentId: bookedResult.appointment.id,
          slotId: bookedResult.slot.id,
          startsAt: bookedResult.slot.startsAt,
          leadId: lead.id
        }
      },
      client
    );

    return bookedResult;
  });

  if (!booked) {
    const reply = 'Ese turno ya no esta disponible. Te muestro nuevas opciones en segundos.';
    await sendAndPersistReply({
      clinicId,
      channel,
      conversationId,
      contact,
      text: reply,
      requestId,
      correlationMessageId: messageId
    });
    return true;
  }

  const humanTime = formatSlotForHuman(booked.slot.startsAt, timezone);
  const confirmation = `Listo, tu turno quedo confirmado para ${humanTime}. Queres agregar un motivo?`;

  await sendAndPersistReply({
    clinicId,
    channel,
    conversationId,
    contact,
    text: confirmation,
    requestId,
    correlationMessageId: messageId
  });

  return true;
}

async function processAppointmentIntent({ clinicId, conversationId, contact, lead, channel, clinic, requestId, messageId }) {
  const rules = await getOrCreateCalendarRules(clinicId);
  const nowUtc = DateTime.utc();
  const fromUtc = nowUtc.plus({ minutes: Number(rules.leadTimeMinutes || 60) });
  const toUtc = nowUtc.plus({ days: DAYS_AHEAD });

  await ensureSlotsForDateRange(clinicId, fromUtc.toISO(), toUtc.toISO());
  const slots = await listAvailableSlots(clinicId, fromUtc.toISO(), toUtc.toISO(), 5);

  if (!slots.length) {
    await openHandoffFlow({
      clinicId,
      conversationId,
      contact,
      lead,
      reason: 'manual',
      clinicSettings: clinic.settings,
      channel,
      requestId,
      messageId
    });
    return;
  }

  const timezone = rules.timezone || clinic.timezone || 'America/Argentina/Buenos_Aires';
  const options = slots.slice(0, 5).map((slot, idx) => ({
    index: idx + 1,
    slotId: slot.id,
    startsAt: slot.startsAt,
    label: formatSlotForHuman(slot.startsAt, timezone)
  }));

  const intro =
    (clinic.settings && clinic.settings.appointmentIntroMessage) ||
    'Tengo estos turnos disponibles:';

  const lines = [intro, ...options.map((opt) => `${opt.index}) ${opt.label}`), 'Responde con 1, 2, 3, 4 o 5.'];
  await sendAndPersistReply({
    clinicId,
    channel,
    conversationId,
    contact,
    text: lines.join('\n'),
    requestId,
    correlationMessageId: messageId
  });

  await addEvent({
    clinicId,
    conversationId,
    type: 'SLOT_OFFERED',
    data: { options }
  });

  await updateLeadStatus(lead.id, 'offering', null);
  await updateConversationStage(conversationId, 'offering');
}

async function processInboundJob(job) {
  const payload = job.payload || {};
  const requestId = `worker:${job.id}`;
  const clinicId = job.clinicId;
  const channelId = job.channelId;
  const messageId = payload.messageId || null;

  const channel = await findChannelById(channelId);
  if (!channel) {
    throw new Error('Channel not found for job');
  }

  const contact = await findContactById(payload.contactId);
  if (!contact) {
    throw new Error('Contact not found for job');
  }

  const conversation = await findConversationById(payload.conversationId);
  if (!conversation || conversation.clinicId !== clinicId) {
    throw new Error('Conversation not found for job');
  }

  const clinic = await getClinic(clinicId);
  if (!clinic) {
    throw new Error('Clinic not found for job');
  }

  const dbMessageId = payload.dbMessageId || null;
  const inboundMessage = dbMessageId ? await getMessageById(dbMessageId) : null;
  const inboundText = inboundMessage && inboundMessage.body ? inboundMessage.body : '';

  const meta = {
    requestId,
    clinicId,
    channelId,
    conversationId: conversation.id,
    contactId: contact.id,
    messageId
  };

  if (contact.optedOut) {
    const leadOpt = await upsertLeadForConversation({
      clinicId,
      channelId,
      conversationId: conversation.id,
      contactId: contact.id,
      primaryIntent: null
    });
    await updateLeadStatus(leadOpt.id, 'lost', 'contact_opted_out');
    await addEvent({
      clinicId,
      conversationId: conversation.id,
      type: 'CONTACT_OPTED_OUT',
      data: { contactId: contact.id }
    });

    logInfo('worker_job_skipped_opted_out', meta);
    return;
  }

  const intent = detectIntent(inboundText);
  const lead = await upsertLeadForConversation({
    clinicId,
    channelId,
    conversationId: conversation.id,
    contactId: contact.id,
    primaryIntent: intent === 'unknown' ? null : intent
  });

  await addEvent({
    clinicId,
    conversationId: conversation.id,
    type: 'LEAD_CREATED',
    data: { leadId: lead.id, intent }
  });

  const openHandoff = await getOpenHandoff(clinicId, conversation.id);
  if (openHandoff) {
    logInfo('worker_bot_paused_handoff_open', {
      ...meta,
      handoffId: openHandoff.id
    });
    return;
  }

  if (isCancellation(inboundText)) {
    const booked = await findBookedAppointmentByConversation(clinicId, conversation.id);
    if (booked) {
      await cancelAppointment(clinicId, booked.id, 'cancelled_by_patient');
      await updateLeadStatus(lead.id, 'qualifying', 'appointment_cancelled');
      await addEvent({
        clinicId,
        conversationId: conversation.id,
        type: 'APPOINTMENT_CANCELLED',
        data: { appointmentId: booked.id, slotId: booked.slotId }
      });

      await sendAndPersistReply({
        clinicId,
        channel,
        conversationId: conversation.id,
        contact,
        text: 'Tu turno fue cancelado. Si queres, te puedo ofrecer nuevas opciones.',
        requestId,
        correlationMessageId: messageId
      });
      return;
    }
  }

  const handledSelection = await tryAppointmentSelection({
    clinicId,
    conversationId: conversation.id,
    contact,
    lead,
    rawText: inboundText,
    channel,
    timezone: clinic.timezone || 'America/Argentina/Buenos_Aires',
    requestId,
    messageId
  });
  if (handledSelection) {
    return;
  }

  if (intent === 'urgent' || intent === 'human') {
    await openHandoffFlow({
      clinicId,
      conversationId: conversation.id,
      contact,
      lead,
      reason: intent === 'urgent' ? 'urgent' : 'manual',
      clinicSettings: clinic.settings,
      channel,
      requestId,
      messageId
    });
    return;
  }

  if (intent === 'appointment') {
    await updateLeadStatus(lead.id, 'qualifying', null);
    await processAppointmentIntent({
      clinicId,
      conversationId: conversation.id,
      contact,
      lead,
      channel,
      clinic,
      requestId,
      messageId
    });
    return;
  }

  if (intent === 'pricing') {
    await updateLeadStatus(lead.id, 'offering', null);
    await updateConversationStage(conversation.id, 'offering');
    const pricingMessage =
      (clinic.settings && clinic.settings.pricingMessage) ||
      'Te compartimos informacion de tratamientos y valores en una llamada breve. Si queres, te ofrezco turnos disponibles ahora mismo.';

    await sendAndPersistReply({
      clinicId,
      channel,
      conversationId: conversation.id,
      contact,
      text: pricingMessage,
      requestId,
      correlationMessageId: messageId
    });
    return;
  }

  await addEvent({
    clinicId,
    conversationId: conversation.id,
    type: 'UNKNOWN_INTENT',
    data: { messageId, body: inboundText }
  });
  const unknownCount = await countRecentEventsByType(clinicId, conversation.id, 'UNKNOWN_INTENT', 120);

  if (unknownCount >= 2) {
    await openHandoffFlow({
      clinicId,
      conversationId: conversation.id,
      contact,
      lead,
      reason: 'unknown_intent',
      clinicSettings: clinic.settings,
      channel,
      requestId,
      messageId
    });
    return;
  }

  await updateLeadStatus(lead.id, 'qualifying', 'unknown_intent');
  await updateConversationStage(conversation.id, 'qualifying');
  await sendAndPersistReply({
    clinicId,
    channel,
    conversationId: conversation.id,
    contact,
    text: 'Gracias por escribirnos. Puedo ayudarte con turnos, urgencias o consultas de precios. Contame que necesitas.',
    requestId,
    correlationMessageId: messageId
  });
}

async function processConversationReplyJob(job) {
  const payload = parseJobPayload(job.payload);
  const requestId = `worker:${job.id}`;
  const conversationId = String(payload.conversationId || '').trim();
  const inboundMessageId = String(payload.inboundMessageId || '').trim();
  const channelId = String(payload.channelId || job.channelId || '').trim();
  const contactId = String(payload.contactId || '').trim();
  const waMessageId = String(payload.waMessageId || '').trim() || null;

  if (!conversationId || !inboundMessageId || !channelId || !contactId) {
    throw new Error('Invalid conversation_reply payload: missing conversationId/inboundMessageId/channelId/contactId');
  }

  const [conversation, inboundMessage, channel, contact] = await Promise.all([
    conversationRepo.getConversationById(conversationId),
    conversationRepo.getMessageById(inboundMessageId),
    findChannelById(channelId),
    findContactById(contactId)
  ]);

  if (!conversation) {
    throw new Error('Conversation not found for conversation_reply job');
  }
  if (!inboundMessage) {
    throw new Error('Inbound message not found for conversation_reply job');
  }
  if (!channel) {
    throw new Error('Channel not found for conversation_reply job');
  }
  if (!contact) {
    throw new Error('Contact not found for conversation_reply job');
  }
  const clinic = await getClinic(conversation.clinicId);
  if (!clinic) {
    throw new Error('Clinic not found for conversation_reply job');
  }

  const inboundText = String(inboundMessage.text || '').trim();
  const currentState = String(conversation.state || '').toUpperCase();
  const safeContext = conversation.context && typeof conversation.context === 'object' ? conversation.context : {};
  const normalizedInboundText = normalizeCommandText(inboundText);
  const inboundLooksLikeCommerce = isCommerceEntryIntent(inboundText);

  logInfo('incoming_whatsapp_message_received', {
    requestId,
    jobId: job.id,
    conversationId: conversation.id,
    clinicId: conversation.clinicId,
    currentState,
    inboundText: normalizedInboundText,
    inboundMessageId
  });

  const buildSuggestionsFromContext = async (count = 3) => {
    const timing = conversationRepo.resolveCandidateTiming(safeContext.appointmentCandidate || null);
    if (timing.startAt) {
      const suggestions = await conversationRepo.suggestNextAvailableSlots({
        clinicId: conversation.clinicId,
        startAt: timing.startAt,
        count,
        stepMinutes: 30,
        maxLookaheadDays: 7
      });
      return { suggestions, timing };
    }

    if (timing.dateISO && timing.timeWindow) {
      const suggestions = await conversationRepo.suggestSlotsForTimeWindow({
        clinicId: conversation.clinicId,
        dateISO: timing.dateISO,
        timeWindow: timing.timeWindow,
        count,
        stepMinutes: 30
      });
      return { suggestions, timing };
    }

    return { suggestions: [], timing };
  };

  let decision = null;
  let decisionSource = null;
  decision = await resolveCommerceDecision({
    conversation,
    clinic,
    contact,
    inboundText
  });
  if (decision) {
    decisionSource = 'commerce';
    logInfo('commerce_flow_entered', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      currentState,
      nextState: decision.newState || null,
      inboundText: normalizedInboundText
    });
  } else {
    logInfo('commerce_flow_skipped', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      currentState,
      inboundText: normalizedInboundText,
      reason: inboundLooksLikeCommerce ? 'resolve_commerce_returned_null' : 'not_a_commerce_command'
    });
  }

  const managementIntent = detectTurnManagementIntent(inboundText);
  if (
    !decision &&
    managementIntent &&
    (currentState === 'READY' || currentState === 'SELECT_APPOINTMENT_SLOT' || currentState === 'CONFIRM_APPOINTMENT')
  ) {
    const latestAppointment = await conversationRepo.findLatestConfirmedAppointment({
      clinicId: conversation.clinicId,
      waId: contact.waId || null,
      conversationId: conversation.id
    });

    if (!latestAppointment) {
      decision = {
        replyText: 'No encuentro un turno confirmado. Decime dia y horario para sacar uno.',
        newState: 'ASKED_APPOINTMENT_DATETIME',
        contextPatch: {
          appointmentSuggestions: null,
          appointmentSuggestionsForDate: null,
          appointmentSuggestionsTimeWindow: null,
          appointmentSuggestionsCreatedAt: null
        }
      };
    } else if (
      String(safeContext.appointmentStatus || '').toLowerCase() === 'cancelled' &&
      String(safeContext.appointmentLastCancelledStartAt || '') === String(latestAppointment.startAt || '')
    ) {
      if (managementIntent === 'cancel') {
        decision = {
          replyText: "Listo. Cancele tu turno. Si queres sacar otro, decime dia y horario.",
          newState: 'READY',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentLastCancelledStartAt: latestAppointment.startAt || null,
            appointmentSuggestions: null,
            appointmentSuggestionsForDate: null,
            appointmentSuggestionsTimeWindow: null,
            appointmentSuggestionsCreatedAt: null
          }
        };
      } else {
        decision = {
          replyText: "Dale. Para que dia y horario queres reprogramar? (Ej: 'lunes 15:30' o 'martes a la tarde')",
          newState: 'ASKED_APPOINTMENT_DATETIME',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentLastCancelledStartAt: latestAppointment.startAt || null,
            appointmentCandidate: null,
            appointmentSuggestions: null,
            appointmentSuggestionsForDate: null,
            appointmentSuggestionsTimeWindow: null,
            appointmentSuggestionsCreatedAt: null
          }
        };
      }
    } else {
      const cancelled = await conversationRepo.cancelAppointmentById({
        appointmentId: latestAppointment.id
      });
      const cancelledStartAt = (cancelled && cancelled.startAt) || latestAppointment.startAt || null;

      if (managementIntent === 'cancel') {
        decision = {
          replyText: "Listo. Cancele tu turno. Si queres sacar otro, decime dia y horario.",
          newState: 'READY',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentCancelledAt: new Date().toISOString(),
            appointmentLastCancelledStartAt: cancelledStartAt,
            appointmentSuggestions: null,
            appointmentSuggestionsForDate: null,
            appointmentSuggestionsTimeWindow: null,
            appointmentSuggestionsCreatedAt: null
          }
        };
      } else {
        decision = {
          replyText: "Dale. Para que dia y horario queres reprogramar? (Ej: 'lunes 15:30' o 'martes a la tarde')",
          newState: 'ASKED_APPOINTMENT_DATETIME',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentCancelledAt: new Date().toISOString(),
            appointmentLastCancelledStartAt: cancelledStartAt,
            appointmentCandidate: null,
            appointmentSuggestions: null,
            appointmentSuggestionsForDate: null,
            appointmentSuggestionsTimeWindow: null,
            appointmentSuggestionsCreatedAt: null
          }
        };
      }
    }

    if (decision) {
      decisionSource = 'legacy_appointment_management';
      logInfo('legacy_clinic_flow_matched', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id,
        clinicId: conversation.clinicId,
        currentState,
        reason: 'appointment_management',
        nextState: decision.newState || null
      });
    }
  }

  if (!decision && currentState === 'ASKED_APPOINTMENT_TIMEWINDOW') {
    const selectedWindow = parseTimeWindowInput(inboundText);
    if (selectedWindow) {
      const candidate = safeContext.appointmentCandidate || {};
      const parsed = candidate.parsed && typeof candidate.parsed === 'object' ? candidate.parsed : {};
      const patchedCandidate = {
        ...candidate,
        parsed: {
          ...parsed,
          timeWindow: selectedWindow
        }
      };
      const timing = conversationRepo.resolveCandidateTiming(patchedCandidate);
      if (timing.dateISO) {
        const suggestions = await conversationRepo.suggestSlotsForTimeWindow({
          clinicId: conversation.clinicId,
          dateISO: timing.dateISO,
          timeWindow: selectedWindow,
          count: 3,
          stepMinutes: 30
        });
        if (suggestions.length > 0) {
          decision = {
            replyText: buildSuggestionReply({
              dateISO: timing.dateISO,
              timeWindow: selectedWindow,
              suggestions
            }),
            newState: 'SELECT_APPOINTMENT_SLOT',
            contextPatch: {
              appointmentCandidate: patchedCandidate,
              appointmentSuggestions: suggestions,
              appointmentSuggestionsForDate: timing.dateISO,
              appointmentSuggestionsTimeWindow: selectedWindow,
              appointmentSuggestionsCreatedAt: new Date().toISOString()
            }
          };
        }
      }
    }
  }

  if (!decision && currentState === 'SELECT_APPOINTMENT_SLOT') {
    if (isGlobalMenuCommand(inboundText)) {
      decision = {
        replyText: 'Listo. Volvemos al menu:\n1) Sacar turno\n2) Precios\n3) Direccion',
        newState: 'READY',
        contextPatch: {
          appointmentSuggestions: null,
          appointmentSuggestionsForDate: null,
          appointmentSuggestionsTimeWindow: null,
          appointmentSuggestionsCreatedAt: null
        }
      };
    } else {
      const selection = extractSelection(inboundText);
      const suggestions = Array.isArray(safeContext.appointmentSuggestions) ? safeContext.appointmentSuggestions : [];
      const expired = isSuggestionExpired(safeContext.appointmentSuggestionsCreatedAt, 30);

      if (!selection || selection < 1 || selection > 3) {
        decision = {
          replyText: 'Responde con 1, 2 o 3 para elegir un horario.',
          newState: 'SELECT_APPOINTMENT_SLOT',
          contextPatch: null
        };
      } else if (!suggestions.length || expired) {
        const regen = await buildSuggestionsFromContext(3);
        if (!regen.suggestions.length) {
          decision = {
            replyText: 'No pude encontrar horarios en este momento. Decime dia y hora nuevamente (ej: lunes 10:30).',
            newState: 'ASKED_APPOINTMENT_DATETIME',
            contextPatch: {
              appointmentSuggestions: null,
              appointmentSuggestionsForDate: null,
              appointmentSuggestionsTimeWindow: null,
              appointmentSuggestionsCreatedAt: null
            }
          };
        } else {
          decision = {
            replyText: buildSuggestionReply({
              dateISO: regen.timing.dateISO,
              timeWindow: regen.timing.timeWindow || safeContext.appointmentSuggestionsTimeWindow || 'afternoon',
              suggestions: regen.suggestions
            }),
            newState: 'SELECT_APPOINTMENT_SLOT',
            contextPatch: {
              appointmentSuggestions: regen.suggestions,
              appointmentSuggestionsForDate: regen.timing.dateISO || null,
              appointmentSuggestionsTimeWindow: regen.timing.timeWindow || null,
              appointmentSuggestionsCreatedAt: new Date().toISOString()
            }
          };
        }
      } else {
        const chosen = suggestions[selection - 1] || null;
        if (!chosen || !chosen.startAt) {
          decision = {
            replyText: 'Esa opcion no es valida. Elegi 1, 2 o 3.',
            newState: 'SELECT_APPOINTMENT_SLOT',
            contextPatch: null
          };
        } else if (isReplaySafeConfirmation(safeContext, chosen.startAt)) {
          decision = {
            replyText: `Listo. Te reserve el turno para ${formatSlotForHuman(chosen.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires')}. Si necesitas cambiarlo, responde 'menu'.`,
            newState: 'READY',
            contextPatch: buildConfirmedContextPatch(chosen.startAt)
          };
        } else {
          const available = await conversationRepo.isSlotAvailable({
            clinicId: conversation.clinicId,
            startAt: chosen.startAt
          });

          if (!available) {
            const alternatives = await conversationRepo.suggestNextAvailableSlots({
              clinicId: conversation.clinicId,
              startAt: chosen.startAt,
              count: 3,
              stepMinutes: 30,
              maxLookaheadDays: 7
            });
            decision = {
              replyText: alternatives.length
                ? `Ese horario se ocupo recien.\n${buildSuggestionReply({
                    dateISO: safeContext.appointmentSuggestionsForDate || null,
                    timeWindow: safeContext.appointmentSuggestionsTimeWindow || 'afternoon',
                    suggestions: alternatives
                  })}`
                : 'Ese horario se ocupo recien. Decime dia y hora nuevamente (ej: lunes 10:30).',
              newState: alternatives.length ? 'SELECT_APPOINTMENT_SLOT' : 'ASKED_APPOINTMENT_DATETIME',
              contextPatch: alternatives.length
                ? {
                    appointmentSuggestions: alternatives,
                    appointmentSuggestionsForDate: safeContext.appointmentSuggestionsForDate || null,
                    appointmentSuggestionsTimeWindow: safeContext.appointmentSuggestionsTimeWindow || null,
                    appointmentSuggestionsCreatedAt: new Date().toISOString()
                  }
                : {
                    appointmentSuggestions: null,
                    appointmentSuggestionsForDate: null,
                    appointmentSuggestionsTimeWindow: null,
                    appointmentSuggestionsCreatedAt: null
                  }
            };
          } else {
            const created = await conversationRepo.createAppointmentFromSuggestion({
              clinicId: conversation.clinicId,
              channelId: conversation.channelId || channel.id,
              conversationId: conversation.id,
              contactId: contact.id,
              waId: contact.waId || null,
              patientName: (safeContext && safeContext.name) || contact.name || null,
              startAt: chosen.startAt,
              endAt: chosen.endAt || null,
              requestedText: chosen.displayText || null,
              source: 'bot'
            });

            if (created && created.created) {
              decision = {
                replyText: `Listo. Te reserve el turno para ${formatSlotForHuman(chosen.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires')}. Si necesitas cambiarlo, responde 'menu'.`,
                newState: 'READY',
                contextPatch: buildConfirmedContextPatch(chosen.startAt)
              };
            } else {
              const alternatives = await conversationRepo.suggestNextAvailableSlots({
                clinicId: conversation.clinicId,
                startAt: chosen.startAt,
                count: 3,
                stepMinutes: 30,
                maxLookaheadDays: 7
              });
              decision = {
                replyText: alternatives.length
                  ? `Ese horario se ocupo recien.\n${buildSuggestionReply({
                      dateISO: safeContext.appointmentSuggestionsForDate || null,
                      timeWindow: safeContext.appointmentSuggestionsTimeWindow || 'afternoon',
                      suggestions: alternatives
                    })}`
                  : 'Ese horario se ocupo recien. Decime dia y hora nuevamente (ej: lunes 10:30).',
                newState: alternatives.length ? 'SELECT_APPOINTMENT_SLOT' : 'ASKED_APPOINTMENT_DATETIME',
                contextPatch: alternatives.length
                  ? {
                      appointmentSuggestions: alternatives,
                      appointmentSuggestionsForDate: safeContext.appointmentSuggestionsForDate || null,
                      appointmentSuggestionsTimeWindow: safeContext.appointmentSuggestionsTimeWindow || null,
                      appointmentSuggestionsCreatedAt: new Date().toISOString()
                    }
                  : {
                      appointmentSuggestions: null,
                      appointmentSuggestionsForDate: null,
                      appointmentSuggestionsTimeWindow: null,
                      appointmentSuggestionsCreatedAt: null
                    }
              };
            }
          }
        }
      }
    }
  }

  if (!decision && currentState === 'CONFIRM_APPOINTMENT' && isAffirmativeSimple(inboundText)) {
    const timing = conversationRepo.resolveCandidateTiming(safeContext.appointmentCandidate || null);
    if (timing.startAt) {
      if (isReplaySafeConfirmation(safeContext, timing.startAt)) {
        decision = {
          replyText: `Listo. Te reserve el turno para ${formatSlotForHuman(timing.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires')}. Si necesitas cambiarlo, responde 'menu'.`,
          newState: 'READY',
          contextPatch: buildConfirmedContextPatch(timing.startAt)
        };
      }
    }

    if (!decision && timing.startAt) {
      const available = await conversationRepo.isSlotAvailable({
        clinicId: conversation.clinicId,
        startAt: timing.startAt
      });

      if (available) {
        const created = await conversationRepo.createAppointmentFromSuggestion({
          clinicId: conversation.clinicId,
          channelId: conversation.channelId || channel.id,
          conversationId: conversation.id,
          contactId: contact.id,
          waId: contact.waId || null,
          patientName: (safeContext && safeContext.name) || contact.name || null,
          startAt: timing.startAt,
          endAt: timing.endAt || null,
          requestedText: timing.requestedText || null,
          source: 'bot'
        });

        if (created && created.created) {
          decision = {
            replyText: `Listo. Te reserve el turno para ${formatSlotForHuman(timing.startAt, clinic.timezone || 'America/Argentina/Buenos_Aires')}. Si necesitas cambiarlo, responde 'menu'.`,
            newState: 'READY',
            contextPatch: buildConfirmedContextPatch(timing.startAt)
          };
        }
      }

      if (!decision) {
        const alternatives = await conversationRepo.suggestNextAvailableSlots({
          clinicId: conversation.clinicId,
          startAt: timing.startAt,
          count: 3,
          stepMinutes: 30,
          maxLookaheadDays: 7
        });
        if (alternatives.length) {
          decision = {
            replyText: `Ese horario se ocupo recien.\n${buildSuggestionReply({
              dateISO: timing.dateISO || safeContext.appointmentSuggestionsForDate || null,
              timeWindow: timing.timeWindow || safeContext.appointmentSuggestionsTimeWindow || 'afternoon',
              suggestions: alternatives
            })}`,
            newState: 'SELECT_APPOINTMENT_SLOT',
            contextPatch: {
              appointmentSuggestions: alternatives,
              appointmentSuggestionsForDate: timing.dateISO || null,
              appointmentSuggestionsTimeWindow: timing.timeWindow || null,
              appointmentSuggestionsCreatedAt: new Date().toISOString()
            }
          };
        }
      }
    } else if (timing.timeWindow && timing.dateISO) {
      const suggestions = await conversationRepo.suggestSlotsForTimeWindow({
        clinicId: conversation.clinicId,
        dateISO: timing.dateISO,
        timeWindow: timing.timeWindow,
        count: 3,
        stepMinutes: 30
      });
      if (suggestions.length) {
        decision = {
          replyText: buildSuggestionReply({
            dateISO: timing.dateISO,
            timeWindow: timing.timeWindow,
            suggestions
          }),
          newState: 'SELECT_APPOINTMENT_SLOT',
          contextPatch: {
            appointmentSuggestions: suggestions,
            appointmentSuggestionsForDate: timing.dateISO,
            appointmentSuggestionsTimeWindow: timing.timeWindow,
            appointmentSuggestionsCreatedAt: new Date().toISOString()
          }
        };
      }
    }
  }

  if (!decision) {
    logInfo('legacy_clinic_flow_matched', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      currentState,
      reason: 'conversation_engine_fallback'
    });
    decision = decideReply({
      state: conversation.state,
      context: safeContext,
      inboundText
    });
    decisionSource = 'legacy_conversation_engine';
  }

  if (
    decision &&
    typeof decision.replyText === 'string' &&
    /1\)\s*Sacar turno[\s\S]*2\)\s*Precios[\s\S]*3\)\s*Direccion/i.test(decision.replyText)
  ) {
    logInfo('legacy_menu_generated', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      currentState,
      source: decisionSource || 'unknown',
      inboundText: normalizedInboundText
    });
  }

  const deterministicReplyText = String(decision && decision.replyText ? decision.replyText : '').trim();

  logInfo('reply_job_response_selected', {
    requestId,
    jobId: job.id,
    conversationId: conversation.id,
    clinicId: conversation.clinicId,
    currentState,
    nextState: decision && decision.newState ? decision.newState : null,
    source: decisionSource || 'unknown',
    inboundText: normalizedInboundText
  });

  let replyText = deterministicReplyText;
  let aiUsed = false;
  let aiFallbackUsed = false;
  let aiModel = null;
  let aiUsage = null;
  let aiAttempted = false;
  let aiSkipReason = null;

  const aiEnabled = env.aiEnabled === true;
  const hasAiKey = !!String(env.openaiApiKey || '').trim();
  const aiEligibility = evaluateAiEligibility({
    jobType: job.type,
    state: conversation.state
  });
  const aiScope = isAiAllowedForScope({
    clinicId: conversation.clinicId || job.clinicId || null,
    channelId: conversation.channelId || channelId || null
  });

  if (aiEnabled && hasAiKey && aiEligibility.allowed && aiScope.ok) {
    const budget = reserveAiBudget(conversation.id);
    if (!budget.allowed) {
      aiSkipReason = budget.reason || 'rate_limited';
      if (aiSkipReason === 'rate_limited') {
        logWarn('ai_rate_limited', {
          requestId,
          jobId: job.id,
          conversationId: conversation.id,
          usedCount: budget.usedCount,
          max: AI_MAX_CALLS_PER_WINDOW,
          windowMs: AI_WINDOW_MS
        });
      }
    }
  } else if (!aiEligibility.allowed) {
    aiSkipReason = aiEligibility.reason;
  } else if (!aiScope.ok) {
    aiSkipReason = aiScope.reason;
  }

  if (aiEnabled && hasAiKey && aiEligibility.allowed && aiScope.ok && !aiSkipReason) {
    aiAttempted = true;
    logInfo('ai_request_start', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      model: env.openaiModel
    });

    try {
      const historyMessages = await conversationRepo.getLastMessagesForAi(conversation.id, 10);
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

      replyText = String(aiResult.replyText || '').trim() || deterministicReplyText;
      aiUsed = !!String(aiResult.replyText || '').trim();
      aiModel = aiResult.model || env.openaiModel;
      aiUsage = sanitizeAiUsage(aiResult.usage || null);

      logInfo('ai_request_success', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id,
        model: aiModel,
        used: aiUsed
      });
    } catch (error) {
      aiFallbackUsed = true;
      replyText = deterministicReplyText;
      logWarn('ai_request_error', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id,
        error: error.message
      });
      logWarn('ai_fallback_used', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id
      });
    }
  } else if (aiEnabled && hasAiKey && aiSkipReason) {
    logInfo('ai_skipped', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      clinicId: conversation.clinicId || job.clinicId || null,
      channelId: conversation.channelId || channelId || null,
      state: conversation.state || null,
      reason: aiSkipReason
    });
  }

  if (!replyText) {
    throw new Error('Conversation engine returned empty replyText');
  }

  await conversationRepo.updateConversationState({
    conversationId: conversation.id,
    state: decision.newState || conversation.state || 'READY',
    contextPatch: decision.contextPatch || null
  });

  const sendResult = await sendTextMessage(
    { to: contact.waId, text: replyText },
    {
      requestId,
      credentials: {
        accessToken: channel.accessToken || env.whatsappAccessToken,
        phoneNumberId: channel.phoneNumberId || env.whatsappPhoneNumberId
      }
    }
  );

  const outboundWrite = await conversationRepo.insertOutboundMessage({
    conversationId: conversation.id,
    waMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null,
    from: channel.phoneNumberId || env.whatsappPhoneNumberId || null,
    to: contact.waId || null,
    type: 'text',
    text: replyText,
    raw: {
      ...(sendResult && sendResult.raw ? sendResult.raw : {}),
      ai: {
        enabled: aiEnabled && hasAiKey,
        attempted: aiAttempted,
        used: aiUsed,
        model: aiModel,
        usage: aiUsage,
        fallbackUsed: aiFallbackUsed,
        skipReason: aiSkipReason
      }
    }
  });

  if (outboundWrite && outboundWrite.inserted === false) {
    logWarn('outbound_duplicate_waMessageId_skipped', {
      requestId,
      jobId: job.id,
      conversationId: conversation.id,
      waMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null
    });
  }

  logInfo('conversation_reply_processed', {
    requestId,
    jobId: job.id,
    clinicId: conversation.clinicId || job.clinicId || null,
    channelId: conversation.channelId || channelId,
    conversationId: conversation.id,
    contactId: contact.id,
    waMessageId,
    graphStatus: sendResult && sendResult.status ? sendResult.status : null,
    outboundMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null
  });
}

async function processJob(job) {
  processingCount += 1;
  try {
    if (job.type === 'conversation_reply') {
      await processConversationReplyJob(job);
      await markJobDone(job.id);
      return;
    }

    if (job.type === 'PROCESS_INBOUND_MESSAGE') {
      await processInboundJob(job);
      await markJobDone(job.id);
      return;
    }

    if (job.type === 'whatsapp_send' || job.type === 'whatsapp_template_send') {
      const requestId = `worker:${job.id}`;
      const payload = parseJobPayload(job.payload);
      const payloadType = String(payload.type || '').trim().toLowerCase();
      const isTemplateJob = job.type === 'whatsapp_template_send' || payloadType === 'template';
      const phoneNumberId = String(
        payload.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || env.whatsappPhoneNumberId || ''
      ).trim();
      const originalToRaw = String(payload.to || '');
      const originalTo = normalizeDigitsOnly(originalToRaw);
      const to = normalizeWhatsAppTo(originalTo);
      const toLast4 = to ? to.slice(-4) : null;
      const toLen = to ? to.length : 0;
      const originalLast4 = originalTo ? originalTo.slice(-4) : null;
      const originalLen = originalTo ? originalTo.length : 0;
      const text = String(payload.text || 'ClinicAI test message').trim() || 'ClinicAI test message';

      payload.to = to;

      // Extra visibility: identify common AR mobile prefix 549 in raw input (without logging full number)
      const rawDigits = normalizeDigitsOnly(originalToRaw);
      logInfo('worker_to_input_detected', {
        requestId,
        jobId: job.id,
        rawHas549Prefix: rawDigits.startsWith('549'),
        rawLen: rawDigits.length,
        rawLast4: rawDigits ? rawDigits.slice(-4) : null
      });

      logInfo('worker_to_normalized', {
        requestId,
        jobId: job.id,
        originalLast4,
        normalizedLast4: toLast4,
        originalLen,
        normalizedLen: toLen
      });

      logInfo('worker_whatsapp_send_start', {
        requestId,
        jobId: job.id,
        sendType: isTemplateJob ? 'template' : 'text',
        clinicId: job.clinicId || null,
        channelId: job.channelId || null,
        phoneNumberId: phoneNumberId || null,
        toLast4,
        toLen
      });

      if (!phoneNumberId) {
        throw new Error('Missing phoneNumberId for whatsapp_send job');
      }

      if (!/^\d{8,15}$/.test(to)) {
        throw new Error('Invalid "to" for whatsapp_send job. Expected 8..15 digits');
      }

      // Ultra-defensive: ensure final `to` is normalized right before sending
      const finalTo = normalizeWhatsAppTo(normalizeDigitsOnly(to));

      const credentials = {
        accessToken: env.whatsappAccessToken,
        phoneNumberId
      };
      let sendResult = null;

      if (isTemplateJob) {
        const templateName = String(payload.templateName || (payload.template && payload.template.name) || '').trim();
        const languageCode = String(
          payload.languageCode || (payload.template && payload.template.languageCode) || 'es'
        ).trim() || 'es';
        const components = Array.isArray(payload.components)
          ? payload.components
          : (payload.template && Array.isArray(payload.template.components) ? payload.template.components : []);

        if (!templateName) {
          throw new Error('templateName is required for template send jobs');
        }

        sendResult = await sendTemplateMessage(
          {
            to: finalTo,
            templateName,
            languageCode,
            components
          },
          {
            requestId,
            credentials
          }
        );
      } else {
        sendResult = await sendTextMessage(
          { to: finalTo, text },
          {
            requestId,
            credentials
          }
        );
      }

      const payloadConversationId = String(payload.conversationId || '').trim();
      if (payloadConversationId) {
        const outboundWrite = await conversationRepo.insertOutboundMessage({
          conversationId: payloadConversationId,
          waMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null,
          from: phoneNumberId,
          to: finalTo,
          type: isTemplateJob ? 'template' : 'text',
          text: isTemplateJob ? null : text,
          raw: sendResult && sendResult.raw ? sendResult.raw : {}
        });

        if (outboundWrite && outboundWrite.inserted === false) {
          logWarn('outbound_duplicate_waMessageId_skipped', {
            requestId,
            jobId: job.id,
            conversationId: payloadConversationId,
            waMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null
          });
        }
      }

      logInfo('worker_whatsapp_send_ok', {
        requestId,
        jobId: job.id,
        sendType: isTemplateJob ? 'template' : 'text',
        clinicId: job.clinicId || null,
        channelId: job.channelId || null,
        phoneNumberId,
        toLast4,
        toLen,
        outboundMessageId: sendResult && sendResult.messageId ? sendResult.messageId : null
      });

      await markJobDone(job.id);
      return;
    }

    await markJobDone(job.id);
    logWarn('worker_unknown_job_type_marked_done', {
      requestId: `worker:${job.id}`,
      jobId: job.id,
      type: job.type
    });
  } catch (error) {
    const result = await requeueOrFailJob(job, error);
    logWarn('worker_job_failed', {
      requestId: `worker:${job.id}`,
      jobId: job.id,
      clinicId: job.clinicId,
      channelId: job.channelId,
      type: job.type,
      statusAfterFailure: result.status,
      nextRunAt: result.nextRunAt || null,
      graphErrorCode:
        error && error.graphErrorCode !== undefined && error.graphErrorCode !== null
          ? Number(error.graphErrorCode)
          : null,
      error: error.message
    });
  } finally {
    processingCount -= 1;
  }
}

async function pollOnce() {
  if (polling || stopped) {
    return;
  }

  polling = true;
  try {
    logInfo('worker_poll_tick', {
      workerId: WORKER_ID,
      now: new Date().toISOString()
    });

    await releaseExpiredHolds();
    const jobs = await claimJobs({ workerId: WORKER_ID, limit: BATCH_SIZE });

    logInfo('worker_poll_result', {
      workerId: WORKER_ID,
      found: jobs.length,
      ids: jobs.map((j) => j.id),
      types: jobs.map((j) => j.type),
      statuses: jobs.map((j) => j.status),
      nextRunAt: jobs.map((j) => j.nextRunAt || j.runAt || null)
    });

    for (const job of jobs) {
      if (stopped) {
        break;
      }

      logInfo('worker_job_picked', {
        workerId: WORKER_ID,
        jobId: job.id,
        type: job.type,
        status: job.status
      });

      await processJob(job);
    }
  } catch (error) {
    logWarn('worker_poll_failed', {
      workerId: WORKER_ID,
      error: error.message
    });
  } finally {
    polling = false;
  }
}

function scheduleNextPoll() {
  if (stopped) {
    return;
  }

  timer = setTimeout(async () => {
    await pollOnce();
    scheduleNextPoll();
  }, POLL_MS);
}

function waitForDrain(timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      const elapsed = Date.now() - startedAt;
      if ((!polling && processingCount === 0) || elapsed >= timeoutMs) {
        return resolve();
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function shutdown(signal) {
  if (stopped) {
    return;
  }

  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  logInfo('worker_shutdown_requested', {
    workerId: WORKER_ID,
    signal,
    polling,
    processingCount
  });

  await waitForDrain();

  logInfo('worker_stopped', {
    workerId: WORKER_ID,
    signal
  });

  process.exit(0);
}

function startWorker() {
  if (started) {
    logWarn('worker_start_skipped_already_running', {
      workerId: WORKER_ID
    });
    return;
  }

  started = true;
  const dbInfo = sanitizeDatabaseUrl(env.databaseUrl || '');
  logInfo('worker_env_loaded', {
    dbSource: 'DATABASE_URL',
    hasDatabaseUrl: !!env.databaseUrl,
    dbHostname: dbInfo ? String(dbInfo.hostPort || '').split(':')[0] || null : null,
    dbDatabase: dbInfo ? dbInfo.dbname : null,
    hasToken: !!process.env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null
  });
  logInfo('worker_started', {
    workerId: WORKER_ID,
    pollMs: POLL_MS,
    batchSize: BATCH_SIZE,
    daysAhead: DAYS_AHEAD,
    holdMinutes: HOLD_MINUTES
  });

  pollOnce()
    .catch((error) => {
      logWarn('worker_first_poll_failed', { workerId: WORKER_ID, error: error.message });
    })
    .finally(() => {
      scheduleNextPoll();
    });

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      logWarn('worker_shutdown_failed', { workerId: WORKER_ID, signal: 'SIGINT', error: error.message });
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      logWarn('worker_shutdown_failed', { workerId: WORKER_ID, signal: 'SIGTERM', error: error.message });
      process.exit(1);
    });
  });
}

if (require.main === module) {
  startWorker();
}

module.exports = {
  startWorker
};


