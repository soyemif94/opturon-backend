const {
  listAutomationsByClinicId,
  findAutomationByClinicIdAndName,
  createAutomation,
  updateAutomation
} = require('../repositories/automations.repository');
const { logInfo } = require('../utils/logger');
const { listProductsByClinicId, findProductById } = require('../repositories/products.repository');
const { openHandoff, assignHandoff, getOpenHandoff } = require('../repositories/handoff.repository');
const { getDefaultAssignee } = require('../repositories/staff.repository');
const { addEvent } = require('../repositories/conversation-events.repository');
const { updateConversationStage } = require('../repositories/conversation.repository');

const DEFAULT_WELCOME_MESSAGE = [
  'Hola 👋 gracias por escribirnos. Te dejo algunas opciones rápidas:',
  '1️⃣ Ver productos',
  '2️⃣ Consultar precios',
  '3️⃣ Hablar con una persona',
  '',
  'Respondé con el número de la opción 👇'
].join('\n');

const DEFAULT_PRICING_MESSAGE = [
  'Genial 💰',
  '',
  'Podés consultarme el precio de cualquier producto o servicio.',
  '',
  'Ejemplo:',
  '👉 "precio limpieza facial"',
  '👉 "cuánto sale botox"',
  '',
  'Decime qué estás buscando 👇'
].join('\n');

const DEFAULT_HUMAN_MESSAGE = [
  'Perfecto 👍 te voy a derivar con una persona de nuestro equipo.',
  '',
  'En breve te responden por acá 👇'
].join('\n');

const DEFAULT_FALLBACK_MESSAGE = [
  'No llegué a entenderte 🤔',
  '',
  'Podés elegir una de estas opciones:',
  '',
  '1️⃣ Ver productos',
  '2️⃣ Consultar precios',
  '3️⃣ Hablar con una persona',
  '',
  'Respondé con el número 👇'
].join('\n');

const DEFAULT_PRODUCTS_EMPTY = [
  'Perfecto 👌 te paso algunos de nuestros productos más consultados:',
  '',
  '🛍️ Aún no tenemos productos activos cargados para mostrarte por acá.',
  '',
  'Si querés, escribime qué estás buscando y te ayudo 👇'
].join('\n');

const SALES_WELCOME_MESSAGE = [
  'Hola 👋 gracias por escribirnos.',
  '',
  'Estoy para ayudarte a elegir lo que necesitás 👇',
  '',
  '1️⃣ Ver productos',
  '2️⃣ Consultar precios',
  '3️⃣ Hablar con una persona',
  '',
  'Respondé con el número y te ayudo al instante 💬'
].join('\n');

const SALES_PRODUCTS_MESSAGE = [
  'Estos son algunos de nuestros productos más elegidos 👇',
  '',
  '{{LISTA_PRODUCTOS}}',
  '',
  '👉 Podés pedirme uno por número o por nombre',
  '',
  'Si querés ver más, escribí "más" 👇'
].join('\n');

const SALES_PRICING_MESSAGE = [
  'Puedo ayudarte a comparar los planes de Opturon y recomendarte uno según lo que necesitás.',
  '',
  'Por ejemplo, podés decirme:',
  '- "quiero algo simple"',
  '- "quiero vender más"',
  '- "somos empresa"'
].join('\n');

const SALES_HUMAN_MESSAGE = [
  'Perfecto 🙌',
  '',
  'Te conecto con alguien del equipo para ayudarte mejor.',
  '',
  'Mientras tanto, si querés, podés ver productos escribiendo "1" 👇'
].join('\n');

const SALES_FALLBACK_MESSAGE = [
  'No llegué a entenderte 🤔',
  '',
  'Podés elegir una opción:',
  '',
  '1️⃣ Ver productos',
  '2️⃣ Consultar precios',
  '3️⃣ Hablar con una persona',
  '',
  'Estoy para ayudarte 👇'
].join('\n');

const MENU_PRODUCTS_PAGE_SIZE = 5;
const MORE_PRODUCTS_KEYWORDS = new Set(['mas', 'más', 'ver mas', 'ver más', 'mostrar mas', 'mostrar más', 'siguiente']);

const DEFAULT_AUTOMATIONS = [
  {
    name: 'Conversational Welcome Menu',
    trigger: { type: 'message_received', keyword: null },
    conditions: {
      conversationFlow: true,
      scope: 'welcome',
      priority: 10,
      genericGreetingsOnly: true,
      welcomeFallbackOnFirstMessage: true
    },
    actions: [{ type: 'send_message', message: SALES_WELCOME_MESSAGE }],
    enabled: true
  },
  {
    name: 'Conversational Menu Products',
    trigger: { type: 'keyword', keyword: 'productos' },
    conditions: {
      conversationFlow: true,
      scope: 'menu_option',
      optionKey: 'products',
      priority: 100,
      exactKeywords: ['1', 'producto', 'productos'],
      containsKeywords: ['ver productos', 'quiero productos', 'mostrar productos', 'catalogo', 'catálogo']
    },
    actions: [
      {
        type: 'send_message',
        message: [
          'Perfecto 👌 te paso algunos de nuestros productos más consultados:',
          '',
          '🛍️ {{LISTA_PRODUCTOS}}',
          '',
          'Si querés info de alguno en particular, decime el nombre o el número 👇'
        ].join('\n')
      }
    ],
    enabled: true
  },
  {
    name: 'Conversational Menu Pricing',
    trigger: { type: 'keyword', keyword: 'precio' },
    conditions: {
      conversationFlow: true,
      scope: 'menu_option',
      optionKey: 'pricing',
      priority: 95,
      exactKeywords: ['2', 'precio', 'precios'],
      containsKeywords: ['consultar precios', 'cuanto sale', 'cuánto sale', 'valor', 'costa', 'costo']
    },
    actions: [{ type: 'send_message', message: SALES_PRICING_MESSAGE }],
    enabled: true
  },
  {
    name: 'Conversational Menu Human',
    trigger: { type: 'keyword', keyword: 'humano' },
    conditions: {
      conversationFlow: true,
      scope: 'menu_option',
      optionKey: 'human',
      priority: 90,
      exactKeywords: ['3', 'humano', 'persona', 'asesor'],
      containsKeywords: ['hablar con una persona', 'hablar con humano', 'hablar con un asesor', 'atencion humana', 'atención humana']
    },
    actions: [
      { type: 'assign_human' },
      { type: 'send_message', message: SALES_HUMAN_MESSAGE }
    ],
    enabled: true
  },
  {
    name: 'Conversational Menu Fallback',
    trigger: { type: 'message_received', keyword: null },
    conditions: {
      conversationFlow: true,
      scope: 'fallback',
      priority: 5
    },
    actions: [{ type: 'send_message', message: SALES_FALLBACK_MESSAGE }],
    enabled: true
  }
];

const defaultProductsAutomation = DEFAULT_AUTOMATIONS.find((automation) => automation && automation.name === 'Conversational Menu Products');
if (defaultProductsAutomation) {
  defaultProductsAutomation.actions = [{ type: 'send_message', message: SALES_PRODUCTS_MESSAGE }];
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?]+$/g, '')
    .trim();
}

function isPlanLikeProduct(product) {
  if (!product) return false;
  const name = normalizeText(product.name || '');
  const sku = normalizeText(product.sku || '');
  return name.includes('plan') || sku.startsWith('plan');
}

function isPlanCatalog(products) {
  const safeProducts = Array.isArray(products)
    ? products.filter((product) => String(product.status || '').toLowerCase() === 'active')
    : [];
  if (!safeProducts.length) return false;
  const planCount = safeProducts.filter(isPlanLikeProduct).length;
  return planCount >= Math.ceil(safeProducts.length * 0.6);
}

function isPlanSalesBypassIntent(normalizedInboundText) {
  const text = normalizeText(normalizedInboundText);
  if (!text) return false;

  return [
    'precio',
    'precios',
    'cuanto sale',
    'cuánto sale',
    'valor',
    'costo',
    'cual me conviene',
    'cuál me conviene',
    'cual recomendas',
    'cuál recomendás',
    'que cambia entre planes',
    'qué cambia entre planes',
    'que diferencia hay',
    'qué diferencia hay',
    'que plan me sirve',
    'qué plan me sirve',
    'quiero algo simple',
    'recien empiezo',
    'recién empiezo',
    'quiero vender mas',
    'quiero vender más',
    'quiero automatizar mejor',
    'quiero algo para empresa',
    'somos empresa',
    'necesito algo personalizado',
    'quiero integraciones',
    'que incluye',
    'qué incluye'
  ].some((pattern) => text.includes(normalizeText(pattern)));
}

function formatMoney(value, currency = 'ARS') {
  const amount = Number(value || 0);
  const safeCurrency = String(currency || 'ARS').trim().toUpperCase() || 'ARS';

  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: safeCurrency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(amount);
  } catch (error) {
    return `${safeCurrency} ${amount.toFixed(2)}`;
  }
}

function sanitizeConditions(conditions) {
  return conditions && typeof conditions === 'object' && !Array.isArray(conditions) ? conditions : {};
}

function sanitizeActions(actions) {
  return Array.isArray(actions) ? actions.filter((action) => action && typeof action === 'object') : [];
}

function isMenuCompatibleState(state) {
  const currentState = String(state || '').trim().toUpperCase();
  return currentState === '' || currentState === 'NEW' || currentState === 'READY' || currentState === 'IDLE';
}

function hasConversationFlowAutomations(automations) {
  return automations.some((automation) => sanitizeConditions(automation.conditions).conversationFlow === true);
}

function getAutomationPriority(automation) {
  const conditions = sanitizeConditions(automation.conditions);
  const priority = Number(conditions.priority);
  return Number.isFinite(priority) ? priority : 0;
}

function sortAutomations(automations) {
  return [...automations].sort((a, b) => {
    const priorityDiff = getAutomationPriority(b) - getAutomationPriority(a);
    if (priorityDiff !== 0) return priorityDiff;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
}

function isGenericGreeting(text) {
  return [
    'hola',
    'buenas',
    'buen dia',
    'buenos dias',
    'buenas tardes',
    'buenas noches',
    'info',
    'consulta',
    'consulta por favor',
    'informacion',
    'información'
  ].includes(text);
}

function getActionMessage(automation) {
  const action = sanitizeActions(automation.actions).find((item) => String(item.type || '').trim().toLowerCase() === 'send_message');
  return String(action && action.message ? action.message : '').trim() || null;
}

function hasAssignHumanAction(automation) {
  return sanitizeActions(automation.actions).some((item) => String(item.type || '').trim().toLowerCase() === 'assign_human');
}

function matchesKeywordAutomation(automation, normalizedInboundText, flowState) {
  const conditions = sanitizeConditions(automation.conditions);
  const exactKeywords = Array.isArray(conditions.exactKeywords)
    ? conditions.exactKeywords.map((item) => normalizeText(item)).filter(Boolean)
    : [];
  const containsKeywords = Array.isArray(conditions.containsKeywords)
    ? conditions.containsKeywords.map((item) => normalizeText(item)).filter(Boolean)
    : [];
  const triggerKeyword = normalizeText(automation && automation.trigger ? automation.trigger.keyword : '');
  const optionKey = String(conditions.optionKey || '').trim();

  if (!normalizedInboundText) {
    return false;
  }

  if (optionKey && optionKey === 'products' && flowState.lastIntent === 'products') {
    return false;
  }

  if (exactKeywords.includes(normalizedInboundText)) {
    return true;
  }

  if (containsKeywords.some((keyword) => normalizedInboundText.includes(keyword))) {
    return true;
  }

  return triggerKeyword ? normalizedInboundText.includes(triggerKeyword) : false;
}

function getFlowState(conversation) {
  const currentState = String(conversation && conversation.state ? conversation.state : '').toUpperCase();
  const context = conversation && conversation.context && typeof conversation.context === 'object' ? conversation.context : {};
  return {
    currentState,
    menuActive: context.menuFlowActive === true,
    lastIntent: String(context.menuLastIntent || '').trim() || null,
    productsPreview: Array.isArray(context.menuProductsPreview) ? context.menuProductsPreview : [],
    productsNextOffset: Number.isFinite(Number(context.menuProductsNextOffset)) ? Number(context.menuProductsNextOffset) : null,
    productsTotal: Number.isFinite(Number(context.menuProductsTotal)) ? Number(context.menuProductsTotal) : 0,
    firstTouch: currentState === 'NEW'
  };
}

async function getMenuProductsPreview(clinicId, { offset = 0, limit = MENU_PRODUCTS_PAGE_SIZE } = {}) {
  const products = await listProductsByClinicId(clinicId);
  const safeOffset = Math.max(0, Number(offset || 0));
  const safeLimit = Math.max(1, Math.min(20, Number(limit || MENU_PRODUCTS_PAGE_SIZE)));
  const activeProducts = products.filter((product) => String(product.status || '').toLowerCase() === 'active');
  const previewItems = activeProducts.slice(safeOffset, safeOffset + safeLimit).map((product, index) => ({
      index: safeOffset + index + 1,
      id: product.id,
      name: product.name,
      price: Number(product.price || product.unitPrice || 0),
      currency: String(product.currency || 'ARS').toUpperCase() || 'ARS',
      description: product.description || null
    }));
  const nextOffset = safeOffset + previewItems.length;
  const hasMore = nextOffset < activeProducts.length;

  return {
    items: previewItems,
    formattedList: previewItems.length
      ? previewItems.map((product) => `${product.index}. ${product.name} — ${formatMoney(product.price, product.currency)}`).join('\n')
      : 'Aún no tenemos productos activos cargados.',
    source: previewItems.length ? 'catalog' : 'placeholder',
    total: activeProducts.length,
    offset: safeOffset,
    nextOffset: hasMore ? nextOffset : null,
    hasMore
  };
}

function isMoreProductsRequest(normalizedInboundText) {
  return MORE_PRODUCTS_KEYWORDS.has(normalizedInboundText);
}

async function maybeResolvePreviewSelection({ clinicId, flowState, normalizedInboundText }) {
  if (flowState.lastIntent !== 'products' || !flowState.productsPreview.length) {
    return null;
  }

  const numericSelection = normalizedInboundText.match(/^(\d{1,2})$/);
  let previewItem = null;

  if (numericSelection) {
    const selectedIndex = Number(numericSelection[1]);
    previewItem = flowState.productsPreview.find((item) => Number(item.index) === selectedIndex) || null;
  }

  if (!previewItem) {
    previewItem =
      flowState.productsPreview.find((item) => normalizeText(item.name) === normalizedInboundText) ||
      flowState.productsPreview.find((item) => normalizeText(item.name).includes(normalizedInboundText)) ||
      null;
  }

  if (!previewItem) {
    return null;
  }

  const fullProduct = previewItem.id ? await findProductById(previewItem.id, clinicId) : null;
  const name = fullProduct ? fullProduct.name : previewItem.name;
  const price = fullProduct ? Number(fullProduct.price || fullProduct.unitPrice || 0) : Number(previewItem.price || 0);
  const currency = fullProduct ? String(fullProduct.currency || 'ARS').toUpperCase() : String(previewItem.currency || 'ARS').toUpperCase();
  const description = fullProduct && fullProduct.description ? `\n${fullProduct.description}` : '';

  return {
    replyText: `Perfecto 👌\n\n${name} está disponible por ${formatMoney(price, currency)}.${description}\n\nSi querés, también podés pedirme el precio de otro producto o escribir "3" para hablar con una persona 👇`,
    replyText: `Perfecto 👌\n\n${name} está disponible por ${formatMoney(price, currency)}${description ? `\n${description.trim()}` : ''}\n\n👉 ¿Querés que te lo reserve o te paso más opciones?`,
    newState: 'READY',
    contextPatch: {
      menuFlowActive: true,
      menuLastIntent: 'products',
      menuLastProductId: previewItem.id || null,
      menuLastProductName: name,
      menuLastProductQuotedAt: new Date().toISOString()
    },
    source: 'conversation_product_preview_selection',
    automation: null
  };
}

function maybeResolvePricingFollowUp({ flowState, normalizedInboundText, inboundText }) {
  if (flowState.lastIntent !== 'pricing' || !normalizedInboundText) {
    return null;
  }

  if (['1', '2', '3'].includes(normalizedInboundText) || isGenericGreeting(normalizedInboundText)) {
    return null;
  }

  return {
    replyText: [
      'Perfecto 👌',
      '',
      `Tomo tu consulta por "${String(inboundText || '').trim()}".`,
      '',
      'Si querés, también puedo derivarte con una persona para pasarte el valor exacto por acá 👇'
    ].join('\n'),
    newState: 'READY',
    contextPatch: {
      menuFlowActive: true,
      menuLastIntent: 'pricing',
      pricingRequestedItem: String(inboundText || '').trim() || null,
      pricingRequestedAt: new Date().toISOString()
    },
    source: 'conversation_pricing_follow_up',
    automation: null
  };
}

async function maybeResolveMoreProducts({ clinicId, flowState, normalizedInboundText }) {
  if (flowState.lastIntent !== 'products' || !isMoreProductsRequest(normalizedInboundText)) {
    return null;
  }

  if (!flowState.productsNextOffset || flowState.productsNextOffset >= flowState.productsTotal) {
    return {
      replyText: [
        'Ya te mostré todos los productos que tenemos cargados por ahora 👌',
        '',
        'Si querés, escribime el nombre de uno en particular o decime "3" para hablar con una persona 👇'
      ].join('\n'),
      newState: 'READY',
      contextPatch: {
        menuFlowActive: true,
        menuLastIntent: 'products'
      },
      source: 'conversation_products_no_more',
      automation: null
    };
  }

  const preview = await getMenuProductsPreview(clinicId, {
    offset: flowState.productsNextOffset,
    limit: MENU_PRODUCTS_PAGE_SIZE
  });

  const extraLine = preview.hasMore
    ? '\n\nSi querés ver más productos, escribí "más" 👇'
    : '\n\nSi querés info de alguno, decime el nombre o el número 👇';

  return {
    replyText: `Te paso más productos 👌\n\n🛍️ ${preview.formattedList}${extraLine}`,
    newState: 'READY',
    contextPatch: {
      menuFlowActive: true,
      menuLastIntent: 'products',
      menuProductsPreview: preview.items,
      menuProductsOffset: preview.offset,
      menuProductsNextOffset: preview.nextOffset,
      menuProductsTotal: preview.total
    },
    source: 'conversation_products_more',
    automation: null
  };
}

function buildContextPatch({ optionKey = null, productsPreview = null, productsOffset = 0, productsNextOffset = null, productsTotal = 0, handoffRequested = false } = {}) {
  return {
    menuFlowActive: true,
    menuLastIntent: optionKey,
    menuLastMatchedAt: new Date().toISOString(),
    menuPresentedAt: optionKey ? null : new Date().toISOString(),
    menuProductsPreview: productsPreview || null,
    menuProductsOffset: productsOffset,
    menuProductsNextOffset: productsNextOffset,
    menuProductsTotal: productsTotal,
    humanHandoffRequestedAt: handoffRequested ? new Date().toISOString() : null
  };
}

async function ensureHumanHandoff({ clinicId, conversation, contact }) {
  let handoff = await getOpenHandoff(clinicId, conversation.id);
  if (!handoff) {
    handoff = await openHandoff({
      clinicId,
      conversationId: conversation.id,
      contactId: contact.id,
      leadId: null,
      reason: 'conversation_menu_human_request'
    });
  }

  if (handoff && !handoff.assignedTo) {
    const assignee = await getDefaultAssignee(clinicId);
    if (assignee && assignee.id) {
      handoff = (await assignHandoff(handoff.id, assignee.id)) || handoff;
    }
  }

  await addEvent({
    clinicId,
    conversationId: conversation.id,
    type: 'HUMAN_HANDOFF_REQUESTED',
    data: {
      source: 'conversation_menu',
      handoffId: handoff ? handoff.id : null,
      assignedTo: handoff ? handoff.assignedTo || null : null
    }
  });
  await updateConversationStage(conversation.id, 'handoff');

  return handoff;
}

async function buildDecisionFromAutomation({ automation, clinicId, conversation, contact }) {
  const conditions = sanitizeConditions(automation.conditions);
  const optionKey = String(conditions.optionKey || '').trim() || null;
  let replyText = getActionMessage(automation);
  let productsPreview = null;
  let handoff = null;

  if (optionKey === 'products') {
    const preview = await getMenuProductsPreview(clinicId, { offset: 0, limit: MENU_PRODUCTS_PAGE_SIZE });
    productsPreview = preview.items;
    if (replyText && replyText.includes('{{LISTA_PRODUCTOS}}')) {
      replyText = replyText.replace('{{LISTA_PRODUCTOS}}', preview.formattedList);
      if (preview.hasMore) {
        replyText = `${replyText}\n\nSi querés ver más productos, escribí "más" 👇`;
      }
    } else {
      replyText = preview.items.length
        ? [
            'Perfecto 👌 te paso algunos de nuestros productos más consultados:',
            '',
            `🛍️ ${preview.formattedList}`,
            '',
            preview.hasMore
              ? 'Si querés ver más productos, escribí "más". También podés decirme el nombre o el número de alguno 👇'
              : 'Si querés info de alguno en particular, decime el nombre o el número 👇'
          ].join('\n')
        : DEFAULT_PRODUCTS_EMPTY;
    }

    if (preview.items.length) {
      replyText = SALES_PRODUCTS_MESSAGE.replace('{{LISTA_PRODUCTOS}}', preview.formattedList);
      if (!preview.hasMore) {
        replyText = replyText.replace('\n\nSi querés ver más, escribí "más" 👇', '');
      }
    }

    return {
      replyText,
      newState: 'READY',
      contextPatch: buildContextPatch({
        optionKey,
        productsPreview,
        productsOffset: preview.offset,
        productsNextOffset: preview.nextOffset,
        productsTotal: preview.total,
        handoffRequested: false
      }),
      source: `automation:${automation.name}`,
      automation,
      handoff: null,
      catalogPrepared: true
    };
  }

  if (!replyText && conditions.scope === 'fallback') {
    replyText = SALES_FALLBACK_MESSAGE;
  }

  if (!replyText && conditions.scope === 'welcome') {
    replyText = SALES_WELCOME_MESSAGE;
  }

  if (hasAssignHumanAction(automation) || optionKey === 'human') {
    handoff = await ensureHumanHandoff({ clinicId, conversation, contact });
  }

  return {
    replyText,
    newState: 'READY',
    contextPatch: buildContextPatch({
      optionKey,
      productsPreview,
      productsOffset: 0,
      productsNextOffset: null,
      productsTotal: 0,
      handoffRequested: Boolean(handoff)
    }),
    source: `automation:${automation.name}`,
    automation,
    handoff,
    catalogPrepared: optionKey === 'products'
  };
}

async function evaluateConversationAutomation({ clinicId, conversation, contact, inboundText }) {
  const automations = sortAutomations(
    (await listAutomationsByClinicId(clinicId)).filter((automation) => automation && automation.enabled !== false)
  );
  const flowAutomations = automations.filter((automation) => sanitizeConditions(automation.conditions).conversationFlow === true);
  const normalizedInboundText = normalizeText(inboundText);
  const flowState = getFlowState(conversation);

  logInfo('automation_runtime_loaded', {
    clinicId,
    conversationId: conversation && conversation.id ? conversation.id : null,
    inboundText: String(inboundText || ''),
    normalizedInboundText,
    currentState: conversation && conversation.state ? conversation.state : null,
    menuActive: flowState.menuActive,
    lastIntent: flowState.lastIntent,
    automations: flowAutomations.map((automation) => ({
      id: automation.id,
      name: automation.name,
      isActive: automation.enabled !== false,
      priority: getAutomationPriority(automation),
      triggerType: automation && automation.trigger ? automation.trigger.type || null : null,
      conditions: sanitizeConditions(automation.conditions),
      clinicId: automation.clinicId
    }))
  });

  if (!flowAutomations.length || !isMenuCompatibleState(conversation.state)) {
    logInfo('automation_runtime_skipped', {
      clinicId,
      conversationId: conversation && conversation.id ? conversation.id : null,
      reason: !flowAutomations.length ? 'no_conversation_flow_automations' : 'state_not_menu_compatible',
      currentState: conversation && conversation.state ? conversation.state : null
    });
    return null;
  }

  if (isPlanSalesBypassIntent(normalizedInboundText)) {
    const clinicProducts = await listProductsByClinicId(clinicId);
    if (isPlanCatalog(clinicProducts)) {
      logInfo('automation_runtime_skipped', {
        clinicId,
        conversationId: conversation && conversation.id ? conversation.id : null,
        reason: 'plan_sales_pricing_bypass',
        normalizedInboundText
      });
      return null;
    }
  }

  const previewSelection = await maybeResolvePreviewSelection({ clinicId, flowState, normalizedInboundText });
  if (previewSelection) {
    logInfo('automation_runtime_matched', {
      clinicId,
      conversationId: conversation && conversation.id ? conversation.id : null,
      normalizedInboundText,
      source: previewSelection.source,
      reason: 'product_preview_selection'
    });
    return previewSelection;
  }

  const moreProducts = await maybeResolveMoreProducts({ clinicId, flowState, normalizedInboundText });
  if (moreProducts) {
    logInfo('automation_runtime_matched', {
      clinicId,
      conversationId: conversation && conversation.id ? conversation.id : null,
      normalizedInboundText,
      source: moreProducts.source,
      reason: 'products_more'
    });
    return moreProducts;
  }

  const pricingFollowUp = maybeResolvePricingFollowUp({ flowState, normalizedInboundText, inboundText });
  if (pricingFollowUp) {
    logInfo('automation_runtime_matched', {
      clinicId,
      conversationId: conversation && conversation.id ? conversation.id : null,
      normalizedInboundText,
      source: pricingFollowUp.source,
      reason: 'pricing_follow_up'
    });
    return pricingFollowUp;
  }

  const keywordAutomations = flowAutomations.filter((automation) => String((automation.trigger && automation.trigger.type) || '').toLowerCase() === 'keyword');
  for (const automation of keywordAutomations) {
    const conditions = sanitizeConditions(automation.conditions);
    const exactKeywords = Array.isArray(conditions.exactKeywords)
      ? conditions.exactKeywords.map((item) => normalizeText(item)).filter(Boolean)
      : [];
    const containsKeywords = Array.isArray(conditions.containsKeywords)
      ? conditions.containsKeywords.map((item) => normalizeText(item)).filter(Boolean)
      : [];
    const matched = matchesKeywordAutomation(automation, normalizedInboundText, flowState);

    logInfo('automation_runtime_keyword_evaluated', {
      clinicId,
      conversationId: conversation && conversation.id ? conversation.id : null,
      automationId: automation.id,
      automationName: automation.name,
      normalizedInboundText,
      exactKeywords,
      containsKeywords,
      matched
    });

    if (matched) {
      logInfo('automation_runtime_matched', {
        clinicId,
        conversationId: conversation && conversation.id ? conversation.id : null,
        normalizedInboundText,
        source: `automation:${automation.name}`,
        reason: 'keyword_match'
      });
      return buildDecisionFromAutomation({ automation, clinicId, conversation, contact });
    }
  }

  const welcomeAutomation = flowAutomations.find((automation) => sanitizeConditions(automation.conditions).scope === 'welcome') || null;
  if (welcomeAutomation && isGenericGreeting(normalizedInboundText)) {
    logInfo('automation_runtime_matched', {
      clinicId,
      conversationId: conversation && conversation.id ? conversation.id : null,
      normalizedInboundText,
      source: `automation:${welcomeAutomation.name}`,
      reason: 'generic_greeting_match'
    });
    return buildDecisionFromAutomation({ automation: welcomeAutomation, clinicId, conversation, contact });
  }

  const fallbackAutomation = flowAutomations.find((automation) => sanitizeConditions(automation.conditions).scope === 'fallback') || null;
  if (fallbackAutomation && (flowState.firstTouch || flowState.menuActive || isGenericGreeting(normalizedInboundText) || hasConversationFlowAutomations(flowAutomations))) {
    logInfo('automation_runtime_matched', {
      clinicId,
      conversationId: conversation && conversation.id ? conversation.id : null,
      normalizedInboundText,
      source: `automation:${fallbackAutomation.name}`,
      reason: 'fallback_selected_after_no_specific_match'
    });
    return buildDecisionFromAutomation({ automation: fallbackAutomation, clinicId, conversation, contact });
  }

  logInfo('automation_runtime_no_match', {
    clinicId,
    conversationId: conversation && conversation.id ? conversation.id : null,
    normalizedInboundText,
    currentState: conversation && conversation.state ? conversation.state : null
  });
  return null;
}

async function resolveAutomationReplyForInbound({ clinic, conversation, inboundText, recentMessages = [] }) {
  const decision = await evaluateConversationAutomation({
    clinicId: clinic && clinic.id ? clinic.id : null,
    conversation,
    contact: {
      id: conversation && conversation.contactId ? conversation.contactId : null,
      waId: conversation && conversation.contactWaId ? conversation.contactWaId : null
    },
    inboundText
  });

  if (!decision) {
    return { matched: [], contextPatch: null, replyText: null };
  }

  const matched = decision.automation ? [decision.automation] : [];
  return {
    matched,
    contextPatch: decision.contextPatch || null,
    replyText: decision.replyText || null,
    source: decision.source || null,
    recentMessagesCount: Array.isArray(recentMessages) ? recentMessages.length : 0
  };
}

async function ensureClinicConversationFlowAutomations({ clinicId, externalTenantId = null }) {
  const ensured = [];

  for (const automationInput of DEFAULT_AUTOMATIONS) {
    const existing = await findAutomationByClinicIdAndName(clinicId, automationInput.name);
    if (!existing) {
      const created = await createAutomation({
        clinicId,
        externalTenantId,
        ...automationInput
      });
      ensured.push({ action: 'created', automation: created });
      continue;
    }

    const needsUpdate =
      JSON.stringify(existing.trigger || {}) !== JSON.stringify(automationInput.trigger || {}) ||
      JSON.stringify(existing.conditions || {}) !== JSON.stringify(automationInput.conditions || {}) ||
      JSON.stringify(existing.actions || []) !== JSON.stringify(automationInput.actions || []) ||
      existing.enabled !== (automationInput.enabled !== false) ||
      existing.externalTenantId !== (externalTenantId || null);

    if (needsUpdate) {
      const updated = await updateAutomation(existing.id, {
        clinicId,
        externalTenantId,
        ...automationInput
      });
      ensured.push({ action: 'updated', automation: updated });
      continue;
    }

    ensured.push({ action: 'unchanged', automation: existing });
  }

  return ensured;
}

module.exports = {
  DEFAULT_AUTOMATIONS,
  DEFAULT_WELCOME_MESSAGE,
  DEFAULT_FALLBACK_MESSAGE,
  getMenuProductsPreview,
  evaluateConversationAutomation,
  resolveAutomationReplyForInbound,
  ensureClinicConversationFlowAutomations
};
