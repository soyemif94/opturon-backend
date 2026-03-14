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
const { listProductsByClinicId, findProductById } = require('./repositories/products.repository');
const { createOrderForClinic, patchOrderStatusForClinic } = require('./services/portal-orders.service');
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
    text === 'quiero hacer un pedido' ||
    text === 'quiero comprar' ||
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

function formatCommerceIndex(index) {
  const digits = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  return digits[index - 1] || `${index}.`;
}

function buildCommerceCatalogReply(products) {
  if (!products.length) {
    return 'Hola 👋\n\n¡Bienvenido! Te ayudo a armar tu pedido por aca.\n\nEn este momento no tenemos productos disponibles para pedir por WhatsApp.';
  }

  const lines = [
    'Hola 👋',
    '',
    '¡Bienvenido! Te ayudo a armar tu pedido por aca.',
    '',
    'Estos son nuestros productos disponibles:',
    '',
    ...products.map((product) => `${formatCommerceIndex(product.index)} ${product.name} — ${formatMoney(product.price, product.currency)}`),
    '',
    'Podes:',
    '- escribir el numero del producto que queres agregar',
    '- escribir "confirmar" para cerrar tu pedido',
    '- escribir "productos" para ver el catalogo otra vez',
    '- escribir "deshacer" para quitar el ultimo producto agregado',
    '- escribir "cancelar" para anular la compra'
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

function parseCommerceNaturalOrder(rawText) {
  let text = normalizeCommandText(rawText);
  if (!text) return null;

  text = text
    .replace(/^(quiero|quisiera|agrega|agrega me|agregame|agrega un|agrega una|agrega unos|agrega unas|agrega dos|agrega tres|agrega cuatro|agrega cinco|agrega seis|agrega siete|agrega ocho|agrega nueve|agrega diez|agrega \d+|agrega)\b/g, 'agrega')
    .trim();

  text = text.replace(/^(agrega|agrega|agregame|agregame|agregá|suma|suma me|sumame|sumá|pone|poneme|dame|mandame|manda|llevo|necesito)\s+/g, '');
  text = text.replace(/^(por favor\s+)/g, '').trim();
  if (!text) return null;

  const quantityWords = {
    un: 1,
    una: 1,
    uno: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10
  };

  const parts = text.split(' ').filter(Boolean);
  if (!parts.length) return null;

  let quantity = 1;
  let nameStartIndex = 0;
  const firstPart = parts[0];

  if (/^\d{1,3}$/.test(firstPart)) {
    quantity = Number(firstPart);
    nameStartIndex = 1;
  } else if (quantityWords[firstPart]) {
    quantity = quantityWords[firstPart];
    nameStartIndex = 1;
  }

  const nameParts = parts
    .slice(nameStartIndex)
    .filter((part) => !['de', 'del'].includes(part) || parts.slice(nameStartIndex).length === 1);
  const productName = nameParts.join(' ').trim();

  if (!productName || !Number.isInteger(quantity) || quantity <= 0) {
    return null;
  }

  return {
    quantity,
    productName
  };
}

function normalizeCommerceProductLookupName(value) {
  const normalized = normalizeCommandText(value)
    .replace(/[()]/g, ' ')
    .replace(/\b(de|del|la|las|el|los|un|una|unos|unas)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = normalized
    .split(' ')
    .filter(Boolean)
    .map((token) => {
      if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
      if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
      return token;
    });

  return tokens.join(' ').trim();
}

function findProductByName(products, rawName) {
  const safeProducts = Array.isArray(products) ? products : [];
  const targetName = normalizeCommerceProductLookupName(rawName);
  if (!targetName) return null;

  let bestMatch = null;
  let bestScore = 0;
  const targetTokens = new Set(targetName.split(' ').filter(Boolean));

  for (const product of safeProducts) {
    const productName = normalizeCommerceProductLookupName(product && product.name ? product.name : '');
    if (!productName) continue;

    let score = 0;
    if (productName === targetName) {
      score = 100;
    } else if (productName.includes(targetName) || targetName.includes(productName)) {
      score = 85;
    } else {
      const productTokens = new Set(productName.split(' ').filter(Boolean));
      const sharedTokens = Array.from(targetTokens).filter((token) => productTokens.has(token)).length;
      if (sharedTokens > 0) {
        score = sharedTokens * 20;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = product;
    }
  }

  return bestScore >= 40 ? bestMatch : null;
}

function isCommerceCancelIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return (
    text === 'cancelar' ||
    text === 'cancelar pedido' ||
    text === 'anular' ||
    text === 'anular pedido' ||
    text === 'quiero cancelar el pedido' ||
    text === 'quiero anular el pedido'
  );
}

function isCommerceConfirmIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return text === 'confirmar' || text === 'confirmar pedido';
}

function isCommerceUndoIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return text === 'deshacer' || text === 'borrar ultimo' || text === 'quitar ultimo';
}

function isCommerceViewCartIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return text === 'ver carrito' || text === 'carrito' || text === 'mi pedido';
}

function isCommerceClearCartIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return text === 'vaciar carrito' || text === 'borrar carrito' || text === 'limpiar carrito';
}

function isCommerceHelpIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return false;
  return text === 'ayuda' || text === 'menu' || text === 'opciones';
}

function parseCommerceRemoveCartItemIntent(rawText) {
  const text = normalizeCommandText(rawText);
  if (!text) return null;

  const match = text.match(/^(quitar|eliminar)\s+(\d{1,2})$/);
  if (!match) return null;

  const index = Number(match[2]);
  if (!Number.isInteger(index) || index < 1) {
    return null;
  }

  return index;
}

function hasCommerceContext(context) {
  const safeContext = context && typeof context === 'object' ? context : {};
  return Boolean(
    (Array.isArray(safeContext.commerceCatalog) && safeContext.commerceCatalog.length > 0) ||
    (Array.isArray(safeContext.commerceCartItems) && safeContext.commerceCartItems.length > 0) ||
    (safeContext.commerceSelectedProduct && typeof safeContext.commerceSelectedProduct === 'object') ||
    safeContext.commerceLastOrderId
  );
}

function buildCommerceResetPatch(extra = {}) {
  return {
    commerceCatalog: null,
    commerceSelectedProduct: null,
    commerceLastAddedItem: null,
    ...extra
  };
}

function normalizeCommerceCartItems(context) {
  const safeContext = context && typeof context === 'object' ? context : {};
  const rawItems = Array.isArray(safeContext.commerceCartItems) ? safeContext.commerceCartItems : [];

  return rawItems
    .map((item) => ({
      productId: String(item && item.productId ? item.productId : '').trim() || null,
      name: String(item && item.name ? item.name : '').trim(),
      price: Number(item && item.price ? item.price : 0),
      currency: String(item && item.currency ? item.currency : 'ARS').trim().toUpperCase() || 'ARS',
      quantity: Number.parseInt(String(item && item.quantity ? item.quantity : 0), 10)
    }))
    .filter((item) => item.productId && item.name && Number.isInteger(item.quantity) && item.quantity > 0);
}

function mergeCommerceCartItem(cartItems, product, quantity) {
  const safeCart = Array.isArray(cartItems) ? cartItems : [];
  const normalizedQuantity = Number.parseInt(String(quantity || 0), 10);
  const productId = String(product && (product.productId || product.id) ? (product.productId || product.id) : '').trim();
  if (!productId || !Number.isInteger(normalizedQuantity) || normalizedQuantity <= 0) {
    return safeCart;
  }

  const nextItems = safeCart.map((item) => ({ ...item }));
  const existingIndex = nextItems.findIndex((item) => String(item.productId || '') === productId);
  const nextItem = {
    productId,
    name: String(product.name || '').trim(),
    price: Number(product.price || 0),
    currency: String(product.currency || 'ARS').trim().toUpperCase() || 'ARS',
    quantity: normalizedQuantity
  };

  if (existingIndex >= 0) {
    nextItems[existingIndex] = {
      ...nextItems[existingIndex],
      name: nextItem.name,
      price: nextItem.price,
      currency: nextItem.currency,
      quantity: Number(nextItems[existingIndex].quantity || 0) + normalizedQuantity
    };
    return nextItems;
  }

  nextItems.push(nextItem);
  return nextItems;
}

function removeLastAddedCommerceCartItem(cartItems, lastAddedItem) {
  const safeCart = Array.isArray(cartItems) ? cartItems.map((item) => ({ ...item })) : [];
  const productId = String(lastAddedItem && lastAddedItem.productId ? lastAddedItem.productId : '').trim();
  const quantity = Number.parseInt(String(lastAddedItem && lastAddedItem.quantity ? lastAddedItem.quantity : 0), 10);
  if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
    return safeCart;
  }

  const existingIndex = safeCart.findIndex((item) => String(item.productId || '') === productId);
  if (existingIndex < 0) {
    return safeCart;
  }

  const currentQuantity = Number.parseInt(String(safeCart[existingIndex].quantity || 0), 10);
  if (!Number.isInteger(currentQuantity) || currentQuantity <= quantity) {
    safeCart.splice(existingIndex, 1);
    return safeCart;
  }

  safeCart[existingIndex] = {
    ...safeCart[existingIndex],
    quantity: currentQuantity - quantity
  };
  return safeCart;
}

function removeCommerceCartItemByIndex(cartItems, index) {
  const safeCart = Array.isArray(cartItems) ? cartItems.map((item) => ({ ...item })) : [];
  if (!Number.isInteger(index) || index < 1 || index > safeCart.length) {
    return safeCart;
  }

  safeCart.splice(index - 1, 1);
  return safeCart;
}

function buildCommerceCartItemLines(cartItems, { numbered = false } = {}) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];
  return safeItems.map((item, index) => {
    const prefix = numbered ? `${index + 1}. ` : '• ';
    return `${prefix}${item.name} ×${item.quantity}`;
  });
}

function buildCommerceCartReply(cartItems) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];
  const subtotal = safeItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
  const currency = safeItems[0] && safeItems[0].currency ? safeItems[0].currency : 'ARS';

  return [
    'Agregado al carrito 👍',
    '',
    'Tu carrito ahora tiene:',
    ...buildCommerceCartItemLines(safeItems),
    `• Total parcial: ${formatMoney(subtotal, currency)}`,
    '',
    'Podés:',
    '- escribir otro número de producto para seguir agregando',
    '- escribir "confirmar" para cerrar el pedido',
    '- escribir "productos" para ver el catálogo otra vez',
    '- escribir "deshacer" para quitar el ultimo producto agregado',
    '- escribir "cancelar" para anular la compra'
  ].join('\n');
}

function buildCommerceUndoReply(cartItems) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];

  if (!safeItems.length) {
    return [
      'Listo 👍',
      '',
      'Saque el ultimo producto agregado.',
      '',
      'Tu carrito quedo vacio.',
      'Escribi "productos" para ver el catalogo o mandame otro numero para seguir.'
    ].join('\n');
  }

  return [
    'Listo 👍',
    '',
    'Saque el ultimo producto agregado.',
    '',
    'Tu carrito ahora tiene:',
    ...buildCommerceCartItemLines(safeItems),
    '',
    'Podes:',
    '- escribir otro numero de producto',
    '- escribir "confirmar"',
    '- escribir "productos"',
    '- escribir "cancelar"'
  ].join('\n');
}

function buildCommerceOrderConfirmation(order, cartItems) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];
  const currency = order && order.currency ? order.currency : safeItems[0] && safeItems[0].currency ? safeItems[0].currency : 'ARS';

  return [
    'Perfecto 🙌',
    '',
    'Tu pedido ya quedó registrado.',
    '',
    'Resumen:',
    ...buildCommerceCartItemLines(safeItems),
    '',
    `Total: ${formatMoney(Number(order && order.total ? order.total : 0), currency)}`,
    '',
    'En breve te confirmamos la preparación.'
  ].join('\n');
}

function buildCommerceEmptyCartReply() {
  return 'Tu carrito está vacío por ahora. Escribí "productos" para ver el catálogo.';
}

function buildCommerceCartSummaryReply(cartItems) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];
  if (!safeItems.length) {
    return buildCommerceEmptyCartReply();
  }

  const subtotal = safeItems.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
  const currency = safeItems[0] && safeItems[0].currency ? safeItems[0].currency : 'ARS';

  return [
    'Tu carrito ahora tiene:',
    '',
    ...buildCommerceCartItemLines(safeItems, { numbered: true }),
    '',
    `Total estimado: ${formatMoney(subtotal, currency)}`,
    '',
    'Podés:',
    '- escribir otro número de producto para seguir agregando',
    '- escribir "confirmar" para cerrar el pedido',
    '- escribir "productos" para ver el catálogo',
    '- escribir "deshacer" para quitar lo último agregado',
    '- escribir "quitar 1" o "eliminar 1" para sacar un producto puntual',
    '- escribir "vaciar carrito" para borrar todo',
    '- escribir "cancelar" para anular la compra'
  ].join('\n');
}

function buildCommerceCartClearedReply() {
  return [
    'Listo 👍',
    'Vacié tu carrito.',
    '',
    'Escribí "productos" para ver el catálogo y empezar de nuevo.'
  ].join('\n');
}

function buildCommerceAlreadyEmptyCartReply() {
  return 'Tu carrito ya está vacío. Escribí "productos" para ver el catálogo.';
}

function buildCommerceHelpReply({ currentState, cartItems }) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];
  const hasCart = safeItems.length > 0;
  const isWaitingQuantity = currentState === 'WAITING_QUANTITY';

  const lines = [
    'Te ayudo con tu pedido 👇',
    '',
    'Podés:'
  ];

  if (isWaitingQuantity) {
    lines.push('- escribir cuántas unidades querés del producto que elegiste');
  } else {
    lines.push('- escribir el número de un producto para agregarlo');
  }

  lines.push(`- escribir "productos" para ver el catálogo otra vez`);

  if (hasCart) {
    lines.push('- escribir "ver carrito" para revisar tu pedido');
    lines.push('- escribir "confirmar" para cerrar la compra');
    lines.push('- escribir "vaciar carrito" para borrar todo');
  } else {
    lines.push('- escribir "ver carrito" para revisar tu pedido cuando agregues productos');
  }

  lines.push('- escribir "deshacer" para quitar lo último agregado');
  lines.push('- escribir "cancelar" para anular la compra');

  return lines.join('\n');
}

function buildCommerceAlreadyConfirmedReply(lastOrderId) {
  const orderLabel = String(lastOrderId || '').trim();
  return orderLabel
    ? `Tu pedido ya fue registrado con el comprobante ${orderLabel}. Si querés hacer otro, escribí "productos".`
    : 'Tu pedido ya fue registrado. Si querés hacer otro, escribí "productos".';
}

function isRecentCommerceOrder(lastOrderAt) {
  if (!lastOrderAt) return false;
  const parsedAt = Date.parse(String(lastOrderAt));
  if (!Number.isFinite(parsedAt)) return false;
  return Date.now() - parsedAt <= 2 * 60 * 1000;
}

function buildCommerceRemovedCartItemReply(cartItems, removedItem) {
  const removedName = removedItem && removedItem.name ? removedItem.name : 'ese producto';
  const safeItems = Array.isArray(cartItems) ? cartItems : [];

  if (!safeItems.length) {
    return [
      'Listo 👍',
      `Quité ${removedName} de tu carrito.`,
      '',
      'Tu carrito quedó vacío.',
      'Escribí "productos" para ver el catálogo y empezar de nuevo.'
    ].join('\n');
  }

  return [
    'Listo 👍',
    `Quité ${removedName} de tu carrito.`,
    '',
    buildCommerceCartSummaryReply(safeItems)
  ].join('\n');
}

async function resolveCommerceCartAddition({
  conversation,
  catalogFromContext,
  cartItems,
  quantity,
  productId,
  onStockFailureState = 'WAITING_PRODUCT_SELECTION',
  onStockFailureContextPatch = null
}) {
  const latestProduct = await findProductById(productId, conversation.clinicId);
  if (!latestProduct || String(latestProduct.status || '').toLowerCase() !== 'active') {
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

  if (Number(latestProduct.stock || 0) < quantity) {
    logInfo('commerce_order_create_failed_stock', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      productId: latestProduct.id,
      requestedQuantity: quantity,
      availableStock: Number(latestProduct.stock || 0)
    });
    const stockFailurePatch = onStockFailureContextPatch
      ? {
        ...onStockFailureContextPatch,
        commerceSelectedProduct: onStockFailureContextPatch.commerceSelectedProduct
          ? {
            ...onStockFailureContextPatch.commerceSelectedProduct,
            name: latestProduct.name,
            price: Number(latestProduct.price || 0),
            currency: String(latestProduct.currency || onStockFailureContextPatch.commerceSelectedProduct.currency || 'ARS').toUpperCase(),
            stock: Number(latestProduct.stock || 0),
            sku: latestProduct.sku || null
          }
          : onStockFailureContextPatch.commerceSelectedProduct
      }
      : null;
    return {
      replyText: 'Lo siento, no tenemos suficiente stock de ese producto en este momento.',
      newState: onStockFailureState,
      contextPatch: stockFailurePatch || {
        commerceCatalog: catalogFromContext,
        commerceCartItems: cartItems,
        commerceSelectedProduct: null
      }
    };
  }

  const existingItem = cartItems.find((item) => String(item.productId || '') === String(latestProduct.id));
  const requestedCartQuantity = Number(existingItem && existingItem.quantity ? existingItem.quantity : 0) + quantity;
  if (Number(latestProduct.stock || 0) < requestedCartQuantity) {
    logInfo('commerce_order_create_failed_stock', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      productId: latestProduct.id,
      requestedQuantity: requestedCartQuantity,
      availableStock: Number(latestProduct.stock || 0)
    });
    const stockFailurePatch = onStockFailureContextPatch
      ? {
        ...onStockFailureContextPatch,
        commerceSelectedProduct: onStockFailureContextPatch.commerceSelectedProduct
          ? {
            ...onStockFailureContextPatch.commerceSelectedProduct,
            name: latestProduct.name,
            price: Number(latestProduct.price || 0),
            currency: String(latestProduct.currency || onStockFailureContextPatch.commerceSelectedProduct.currency || 'ARS').toUpperCase(),
            stock: Number(latestProduct.stock || 0),
            sku: latestProduct.sku || null
          }
          : onStockFailureContextPatch.commerceSelectedProduct
      }
      : null;
    return {
      replyText: 'Lo siento, no tenemos suficiente stock de ese producto en este momento.',
      newState: onStockFailureState,
      contextPatch: stockFailurePatch || {
        commerceCatalog: catalogFromContext,
        commerceCartItems: cartItems,
        commerceSelectedProduct: null
      }
    };
  }

  const updatedCartItems = mergeCommerceCartItem(
    cartItems,
    {
      productId: latestProduct.id,
      name: latestProduct.name,
      price: Number(latestProduct.price || 0),
      currency: String(latestProduct.currency || 'ARS').toUpperCase()
    },
    quantity
  );

  logInfo('commerce_cart_item_added', {
    conversationId: conversation.id,
    clinicId: conversation.clinicId,
    productId: latestProduct.id,
    addedQuantity: quantity,
    cartQuantity: requestedCartQuantity
  });

  return {
    replyText: buildCommerceCartReply(updatedCartItems),
    newState: 'WAITING_PRODUCT_SELECTION',
    contextPatch: buildCommerceResetPatch({
      commerceCatalog: catalogFromContext.length
        ? catalogFromContext
        : buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId)),
      commerceCartItems: updatedCartItems,
      commerceLastAddedItem: {
        productId: String(latestProduct.id || '').trim() || null,
        quantity
      }
    })
  };
}

async function resolveCommerceCancellation({ conversation, inboundText, currentState, safeContext }) {
  if (!isCommerceCancelIntent(inboundText)) {
    return null;
  }

  logInfo('commerce_flow_cancelled_by_user', {
    conversationId: conversation.id,
    clinicId: conversation.clinicId,
    currentState,
    inboundText: normalizeCommandText(inboundText)
  });

  const cartItems = normalizeCommerceCartItems(safeContext);
  const hasActiveFlow = currentState === 'WAITING_PRODUCT_SELECTION' ||
    currentState === 'WAITING_QUANTITY' ||
    cartItems.length > 0 ||
    Boolean(safeContext && safeContext.commerceSelectedProduct);
  const lastOrderId = String(safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : '').trim();
  if (!lastOrderId || hasActiveFlow) {
    return {
      replyText: "Entendido. Cancele este pedido en curso. Si queres, escribi 'productos' para ver el catalogo otra vez.",
      newState: 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceCartItems: null,
        commerceLastOrderId: null,
        commerceLastOrderAt: null
      })
    };
  }

  logInfo('commerce_order_cancel_attempt', {
    conversationId: conversation.id,
    clinicId: conversation.clinicId,
    orderId: lastOrderId
  });

  const cancelResult = await patchOrderStatusForClinic(conversation.clinicId, lastOrderId, {
    orderStatus: 'cancelled'
  });

  if (!cancelResult.ok) {
    if (cancelResult.reason === 'order_not_found') {
      return {
        replyText: "No encontre ese pedido para cancelarlo. Si queres, escribi 'productos' para ver el catalogo otra vez.",
        newState: 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCartItems: null,
          commerceLastOrderId: null,
          commerceLastOrderAt: null
        })
      };
    }

    return {
      replyText: 'No pude cancelar tu pedido en este momento. Intenta nuevamente en unos minutos.',
      newState: 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceLastOrderId: lastOrderId,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null
      })
    };
  }

  logInfo('commerce_order_cancel_success', {
    conversationId: conversation.id,
    clinicId: conversation.clinicId,
    orderId: lastOrderId,
    finalStatus: cancelResult.order && cancelResult.order.orderStatus ? cancelResult.order.orderStatus : null
  });

  return {
    replyText: "Entendido. Cancele tu pedido y devolvi el stock reservado. Si queres, escribi 'productos' para ver el catalogo otra vez.",
    newState: 'IDLE',
    contextPatch: buildCommerceResetPatch({
      commerceCartItems: null,
      commerceLastOrderId: null,
      commerceLastOrderAt: null
    })
  };
}

async function resolveCommerceDecision({ conversation, clinic, contact, inboundText }) {
  const currentState = String(conversation.state || '').toUpperCase();
  const safeContext = conversation.context && typeof conversation.context === 'object' ? conversation.context : {};
  const catalogFromContext = Array.isArray(safeContext.commerceCatalog) ? safeContext.commerceCatalog : [];
  const cartItems = normalizeCommerceCartItems(safeContext);
  const lastAddedItem = safeContext.commerceLastAddedItem && typeof safeContext.commerceLastAddedItem === 'object'
    ? {
      productId: String(safeContext.commerceLastAddedItem.productId || '').trim() || null,
      quantity: Number.parseInt(String(safeContext.commerceLastAddedItem.quantity || 0), 10)
    }
    : null;

  const cancelDecision = await resolveCommerceCancellation({
    conversation,
    inboundText,
    currentState,
    safeContext
  });
  if (cancelDecision) {
    return cancelDecision;
  }

  if (
    isCommerceHelpIntent(inboundText) &&
    (
      currentState === 'WAITING_PRODUCT_SELECTION' ||
      currentState === 'WAITING_QUANTITY' ||
      catalogFromContext.length > 0 ||
      cartItems.length > 0 ||
      Boolean(safeContext && safeContext.commerceLastOrderId)
    )
  ) {
    return {
      replyText: buildCommerceHelpReply({ currentState, cartItems }),
      newState: currentState === 'WAITING_QUANTITY'
        ? 'WAITING_QUANTITY'
        : (catalogFromContext.length || cartItems.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE'),
      contextPatch: {
        commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
        commerceCartItems: cartItems.length ? cartItems : null,
        commerceSelectedProduct: currentState === 'WAITING_QUANTITY' ? safeContext.commerceSelectedProduct || null : null,
        commerceLastAddedItem: lastAddedItem,
        commerceLastOrderId: safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : null,
        commerceLastOrderAt: safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null
      }
    };
  }

  if (isCommerceViewCartIntent(inboundText)) {
    return {
      replyText: buildCommerceCartSummaryReply(cartItems),
      newState: catalogFromContext.length || cartItems.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: {
        commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
        commerceCartItems: cartItems.length ? cartItems : null,
        commerceSelectedProduct: null,
        commerceLastAddedItem: lastAddedItem
      }
    };
  }

  if (isCommerceClearCartIntent(inboundText)) {
    return {
      replyText: cartItems.length ? buildCommerceCartClearedReply() : buildCommerceAlreadyEmptyCartReply(),
      newState: catalogFromContext.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: {
        commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
        commerceCartItems: null,
        commerceSelectedProduct: null,
        commerceLastAddedItem: null
      }
    };
  }

  const removeCartItemIndex = parseCommerceRemoveCartItemIntent(inboundText);
  if (removeCartItemIndex) {
    if (!cartItems.length) {
      return {
        replyText: buildCommerceEmptyCartReply(),
        newState: catalogFromContext.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: {
          commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
          commerceCartItems: null,
          commerceSelectedProduct: null,
          commerceLastAddedItem: null
        }
      };
    }

    if (removeCartItemIndex > cartItems.length) {
      return {
        replyText: `No encontré ese ítem en tu carrito. Te muestro cómo quedó:\n\n${buildCommerceCartSummaryReply(cartItems)}`,
        newState: 'WAITING_PRODUCT_SELECTION',
        contextPatch: {
          commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
          commerceCartItems: cartItems,
          commerceSelectedProduct: null,
          commerceLastAddedItem: lastAddedItem
        }
      };
    }

    const removedItem = cartItems[removeCartItemIndex - 1] || null;
    const updatedCartItems = removeCommerceCartItemByIndex(cartItems, removeCartItemIndex);

    logInfo('commerce_cart_item_removed_by_index', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      removedIndex: removeCartItemIndex,
      productId: removedItem && removedItem.productId ? removedItem.productId : null,
      cartItemCount: updatedCartItems.length
    });

    return {
      replyText: buildCommerceRemovedCartItemReply(updatedCartItems, removedItem),
      newState: catalogFromContext.length || updatedCartItems.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: {
        commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
        commerceCartItems: updatedCartItems.length ? updatedCartItems : null,
        commerceSelectedProduct: null,
        commerceLastAddedItem: null
      }
    };
  }

  if (isCommerceUndoIntent(inboundText)) {
    if (!cartItems.length || !lastAddedItem || !lastAddedItem.productId || !Number.isInteger(lastAddedItem.quantity) || lastAddedItem.quantity <= 0) {
      return {
        replyText: 'Todavia no hay productos en tu carrito. Escribi "productos" para ver el catalogo.',
        newState: catalogFromContext.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: {
          commerceCatalog: catalogFromContext.length ? catalogFromContext : null,
          commerceCartItems: cartItems,
          commerceSelectedProduct: null,
          commerceLastAddedItem: null
        }
      };
    }

    const updatedCartItems = removeLastAddedCommerceCartItem(cartItems, lastAddedItem);
    logInfo('commerce_cart_item_removed', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      productId: lastAddedItem.productId,
      removedQuantity: lastAddedItem.quantity,
      cartItemCount: updatedCartItems.length
    });

    return {
      replyText: buildCommerceUndoReply(updatedCartItems),
      newState: 'WAITING_PRODUCT_SELECTION',
      contextPatch: {
        commerceCatalog: catalogFromContext.length
          ? catalogFromContext
          : buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId)),
        commerceCartItems: updatedCartItems.length ? updatedCartItems : null,
        commerceSelectedProduct: null,
        commerceLastAddedItem: null
      }
    };
  }

  if (isCommerceConfirmIntent(inboundText)) {
    const lastOrderId = String(safeContext && safeContext.commerceLastOrderId ? safeContext.commerceLastOrderId : '').trim();
    const lastOrderAt = safeContext && safeContext.commerceLastOrderAt ? safeContext.commerceLastOrderAt : null;
    if (!cartItems.length && lastOrderId && isRecentCommerceOrder(lastOrderAt)) {
      return {
        replyText: buildCommerceAlreadyConfirmedReply(lastOrderId),
        newState: 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCartItems: null,
          commerceLastOrderId: lastOrderId,
          commerceLastOrderAt: lastOrderAt
        })
      };
    }

    if (!cartItems.length) {
      return {
        replyText: 'Tu carrito está vacío por ahora. Escribí "productos" para ver el catálogo.',
        newState: 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCartItems: null
        })
      };
    }

    logInfo('commerce_order_create_attempt', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      itemCount: cartItems.length,
      cartItems: cartItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity
      }))
    });

    const orderResult = await createOrderForClinic(conversation.clinicId, {
      customerName: contact.name || `Cliente ${String(contact.waId || contact.phone || '').slice(-4) || 'WhatsApp'}`,
      customerPhone: contact.phone || contact.waId || null,
      notes: 'Pedido creado desde WhatsApp commerce',
      items: cartItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity
      }))
    });

    if (!orderResult.ok) {
      if (
        orderResult.reason === 'order_item_insufficient_stock' ||
        orderResult.reason === 'order_item_product_not_found' ||
        orderResult.reason === 'order_item_product_inactive'
      ) {
        const products = buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId));
        logInfo('commerce_order_create_failed_stock', {
          conversationId: conversation.id,
          clinicId: conversation.clinicId,
          itemCount: cartItems.length,
          reason: orderResult.reason,
          details: orderResult.details || null
        });
        return {
          replyText:
            'No pude confirmar tu pedido porque uno o mas productos ya no tienen stock suficiente.\n\nEscribi "productos" para ver el catalogo actualizado.',
          newState: 'WAITING_PRODUCT_SELECTION',
          contextPatch: buildCommerceResetPatch({
            commerceCatalog: products,
            commerceCartItems: cartItems
          })
        };
      }

      return {
        replyText: 'No pude registrar tu pedido en este momento. Intenta nuevamente en unos minutos.',
        newState: 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCartItems: cartItems
        })
      };
    }

    const order = orderResult.order;
    logInfo('commerce_order_create_success', {
      conversationId: conversation.id,
      clinicId: conversation.clinicId,
      orderId: order.id || null,
      itemCount: cartItems.length,
      total: Number(order.total || 0),
      currency: order.currency || (cartItems[0] && cartItems[0].currency) || 'ARS'
    });

    return {
      replyText: buildCommerceOrderConfirmation(order, cartItems),
      newState: 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceCartItems: null,
        commerceLastOrderId: order.id || null,
        commerceLastOrderAt: new Date().toISOString()
      })
    };
  }

  if (isCommerceEntryIntent(inboundText)) {
    const products = buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId));
    return {
      replyText: buildCommerceCatalogReply(products),
      newState: products.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
      contextPatch: buildCommerceResetPatch({
        commerceCatalog: products,
        commerceCartItems: cartItems,
        commerceLastAddedItem: lastAddedItem
      })
    };
  }

  const naturalOrder = parseCommerceNaturalOrder(inboundText);
  if (naturalOrder) {
    const products = catalogFromContext.length
      ? catalogFromContext
      : buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId));
    const matchedProduct = findProductByName(products, naturalOrder.productName);
    if (!matchedProduct) {
      return {
        replyText: "No encontré ese producto.\nEscribí 'productos' para ver el catálogo.",
        newState: products.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: products.length ? products : null,
          commerceCartItems: cartItems,
          commerceLastAddedItem: lastAddedItem
        })
      };
    }

    return resolveCommerceCartAddition({
      conversation,
      catalogFromContext: products,
      cartItems,
      quantity: naturalOrder.quantity,
      productId: matchedProduct.productId || matchedProduct.id
    });
  }

  if (currentState === 'WAITING_PRODUCT_SELECTION') {
    const products = catalogFromContext.length
      ? catalogFromContext
      : buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId));
    const selection = parseCommerceSelection(inboundText, products.length);
    if (!selection) {
      return {
        replyText: products.length
          ? 'No entendí ese producto. Elegí un número de la lista o escribí "ayuda" si querés ver las opciones.'
          : 'No hay productos disponibles ahora mismo. Escribí "productos" para intentar de nuevo.',
        newState: products.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: products.length ? products : null
        })
      };
    }

    const selectedProduct = products[selection - 1] || null;
    if (!selectedProduct) {
      return {
        replyText: 'No entendí ese producto. Elegí un número de la lista o escribí "ayuda" si querés ver las opciones.',
        newState: 'WAITING_PRODUCT_SELECTION',
        contextPatch: buildCommerceResetPatch({
          commerceCatalog: products
        })
      };
    }

    return {
      replyText: `Elegiste: ${selectedProduct.name}\n\n¿Cuántas unidades querés?`,
      newState: 'WAITING_QUANTITY',
      contextPatch: {
        commerceCatalog: products,
        commerceCartItems: cartItems,
        commerceSelectedProduct: selectedProduct,
        commerceLastAddedItem: lastAddedItem
      }
    };
  }

  if (currentState === 'WAITING_QUANTITY') {
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
        replyText: 'No entendí esa cantidad. Decime cuántas unidades querés.',
        newState: 'WAITING_QUANTITY',
        contextPatch: {
          commerceCatalog: catalogFromContext,
          commerceCartItems: cartItems,
          commerceSelectedProduct: selectedProduct,
          commerceLastAddedItem: lastAddedItem
        }
      };
    }

    return resolveCommerceCartAddition({
      conversation,
      catalogFromContext,
      cartItems,
      quantity,
      productId: selectedProduct.productId,
      onStockFailureState: 'WAITING_QUANTITY',
      onStockFailureContextPatch: {
        commerceCatalog: catalogFromContext,
        commerceCartItems: cartItems,
        commerceLastAddedItem: lastAddedItem,
        commerceSelectedProduct: selectedProduct
      }
    });
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
  const inboundLooksLikeCommerceCancel = isCommerceCancelIntent(inboundText);
  const commerceContextActive = hasCommerceContext(safeContext);

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
    if (inboundLooksLikeCommerceCancel || inboundLooksLikeCommerce || commerceContextActive) {
      logInfo('legacy_menu_blocked_for_commerce', {
        requestId,
        jobId: job.id,
        conversationId: conversation.id,
        clinicId: conversation.clinicId,
        currentState,
        inboundText: normalizedInboundText,
        reason: inboundLooksLikeCommerceCancel
          ? 'commerce_cancel_intent'
          : inboundLooksLikeCommerce
            ? 'commerce_entry_intent'
            : 'commerce_context_active'
      });

      if (inboundLooksLikeCommerceCancel) {
        decision = {
          replyText: "Entendido. Cancele este pedido en curso. Si queres, escribi 'productos' para ver el catalogo otra vez.",
          newState: 'IDLE',
          contextPatch: buildCommerceResetPatch()
        };
        decisionSource = 'commerce_cancel_block';
        logInfo('commerce_flow_cancelled_response_returned', {
          requestId,
          jobId: job.id,
          conversationId: conversation.id,
          clinicId: conversation.clinicId,
          currentState,
          inboundText: normalizedInboundText
        });
      } else {
        const products = buildCommerceCatalog(await listProductsByClinicId(conversation.clinicId));
        decision = {
          replyText: buildCommerceCatalogReply(products),
          newState: products.length ? 'WAITING_PRODUCT_SELECTION' : 'IDLE',
          contextPatch: buildCommerceResetPatch({
            commerceCatalog: products
          })
        };
        decisionSource = 'commerce_legacy_block';
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
        channelId: channel.id,
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
        channelId: job.channelId || null,
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


