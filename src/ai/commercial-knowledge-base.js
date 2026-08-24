const VERSION = 'commercial-kb-2026-06-10';

const CATEGORY_REPLY_INTENT = {
  business_fit_general: 'feature_fit',
  business_fit_by_industry: 'industry_fit',
  multi_business: 'feature_fit',
  multi_service: 'feature_fit',
  multi_user_sellers: 'feature_fit',
  existing_whatsapp_number: 'whatsapp_number_portability',
  instagram_sales: 'channel_compatibility',
  excel_import: 'catalog_import_fit',
  replaces_secretary_or_seller: 'seller_replacement',
  appointment_business: 'industry_fit',
  product_catalog_business: 'catalog_import_fit',
  delivery_or_distribution_business: 'industry_fit',
  small_business_fit: 'feature_fit',
  scaling_business_fit: 'feature_fit',
  crm_and_follow_up: 'feature_fit',
  human_takeover: 'feature_fit',
  pricing_interest: 'recommend_plan_by_business_context',
  plan_recommendation: 'recommend_plan_by_business_context',
  onboarding_how_to_start: 'implementation_followup',
  limitations_or_edge_cases: 'feature_fit'
};

const COMMERCIAL_KB = [
  {
    category: 'business_fit_general',
    intent: 'business_fit_general',
    replyIntent: 'feature_fit',
    responseType: 'general_fit',
    entities: ['rubro', 'canal', 'si vende productos', 'si trabaja con turnos'],
    examples: [
      'me sirve para mi negocio?',
      'esto sirve para vender mas?',
      'que puede hacer la plataforma por mi empresa?',
      'tengo un comercio, me sirve?',
      'trabajo por whatsapp, sirve?',
      'atiendo consultas de clientes, me puede ayudar?',
      'quiero que conteste cuando yo no estoy'
    ],
    patterns: [
      /\b(me|nos)\s+sirve\b/,
      /\bsirve\s+para\s+mi\s+(negocio|empresa|emprendimiento|comercio)\b/,
      /\bque\s+(puede|hace|ofrece)\s+(?:la\s+)?(?:plataforma|sistema|solucion)\b/,
      /\btrabajo\s+por\s+whatsapp\b/,
      /\bconteste?\s+cuando\s+yo\s+no\s+estoy\b/,
      /\bcontestar\s+fuera\s+de\s+horario\b/
    ]
  },
  {
    category: 'business_fit_by_industry',
    intent: 'business_fit_by_industry',
    replyIntent: 'industry_fit',
    responseType: 'industry_fit',
    entities: ['rubro', 'necesidades probables'],
    examples: [
      'sirve para una rotiseria?',
      'tengo una casa de repuestos',
      'tengo inmobiliaria',
      'tengo una estetica',
      'tengo lubricentro',
      'tengo tienda de ropa',
      'tengo distribuidora',
      'sirve para servicios y productos?'
    ],
    patterns: [
      /\bsirve\s+para\s+(una|un)\s+[a-z0-9\s]{3,40}\b/,
      /\btengo\s+(una|un)\s+(rotiseria|casa de repuestos|inmobiliaria|estetica|lubricentro|tienda de ropa|distribuidora|ferreteria|consultorio)\b/,
      /\bsirve\s+para\s+servicios\s+y\s+productos\b/
    ]
  },
  {
    category: 'multi_business',
    intent: 'multi_business',
    replyIntent: 'feature_fit',
    responseType: 'multi_business',
    entities: ['cantidad de negocios', 'rubros'],
    examples: [
      'tengo dos emprendimientos',
      'mi mujer atiende un consultorio y yo tengo una distribuidora',
      'tengo dos negocios distintos',
      'los puedo centralizar?',
      'tengo local y vendo online',
      'puedo manejar dos marcas?'
    ],
    patterns: [
      /\b(dos|2|varios|varias)\s+(emprendimientos|negocios|marcas)\b/,
      /\bcentralizar\b/,
      /\bmi\s+(mujer|socio|pareja).+\byo\s+tengo\b/,
      /\btengo\s+local\s+y\s+vendo\s+online\b/
    ]
  },
  {
    category: 'multi_service',
    intent: 'multi_service',
    replyIntent: 'feature_fit',
    responseType: 'multi_service',
    entities: ['servicios', 'agenda', 'turnos'],
    examples: [
      'soy podologa a la mañana y masajista a la tarde',
      'hago uñas y tambien masajes',
      'tengo varios servicios',
      'puedo separar servicios?',
      'atiendo dos actividades',
      'soy profesional y vendo productos tambien'
    ],
    patterns: [
      /\bsoy\s+[a-z0-9\s]{3,30}\s+(a la manana|a la mañana).+\s+y\s+[a-z0-9\s]{3,30}\s+(a la tarde|a la noche)\b/,
      /\b(varios|varias|dos|2)\s+servicios\b/,
      /\bseparar\s+servicios\b/,
      /\bdos\s+actividades\b/
    ]
  },
  {
    category: 'multi_user_sellers',
    intent: 'multi_user_sellers',
    replyIntent: 'feature_fit',
    responseType: 'multi_user_sellers',
    entities: ['cantidad de vendedores', 'usuarios', 'roles'],
    examples: [
      'tengo varios vendedores',
      'puedo tener usuarios?',
      'somos 3 vendedores',
      'necesito organizar vendedores',
      'puedo ver metricas?',
      'quiero controlar mi equipo'
    ],
    patterns: [
      /\b(varios|varias|muchos|muchas|\d+)\s+(vendedores|usuarios|asesores|personas)\b/,
      /\bpuedo\s+tener\s+usuarios\b/,
      /\bver\s+metricas\b/,
      /\bcontrolar\s+(mi\s+)?equipo\b/
    ]
  },
  {
    category: 'existing_whatsapp_number',
    intent: 'existing_whatsapp_number',
    replyIntent: 'whatsapp_number_portability',
    responseType: 'existing_whatsapp_number',
    entities: ['canal', 'tipo de cuenta de WhatsApp'],
    examples: [
      'puedo usar mi numero actual?',
      'ya tengo mi numero de whatsapp, lo puedo usar?',
      'tengo whatsapp business',
      'puedo mantener mi numero?',
      'tengo un numero comercial',
      'hay que cambiar de numero?'
    ],
    patterns: [
      /\b(numero|nro)\s+actual\b/,
      /\bmantener\s+mi\s+(numero|nro)\b/,
      /\busar\s+mi\s+(numero|nro)\b/,
      /\bcambiar\s+de\s+(numero|nro)\b/,
      /\bwhatsapp\s+business\b/
    ]
  },
  {
    category: 'instagram_sales',
    intent: 'instagram_sales',
    replyIntent: 'channel_compatibility',
    responseType: 'instagram_sales',
    entities: ['canal'],
    examples: [
      'vendo por instagram',
      'atiendo por whatsapp y por instagram',
      'tengo una distribuidora y tambien vendo por instagram',
      'me escriben por instagram',
      'instagram se puede usar?',
      'llegan consultas desde instagram'
    ],
    patterns: [
      /\binstagram\b/,
      /\bwhatsapp\s+(e|y)\s+instagram\b/
    ]
  },
  {
    category: 'excel_import',
    intent: 'excel_import',
    replyIntent: 'catalog_import_fit',
    responseType: 'excel_import',
    entities: ['herramienta actual', 'catalogo', 'cantidad de productos'],
    examples: [
      'ya uso excel',
      'tengo mis productos en excel',
      'puedo importar excel?',
      'necesito cargar mis productos',
      'tengo muchos productos',
      'como cargo el catalogo?'
    ],
    patterns: [
      /\bexcel\b/,
      /\bimportar\b/,
      /\bcargar\s+(mis\s+)?productos\b/,
      /\bcargo\s+(el\s+)?catalogo\b/,
      /\bmuchos\s+productos\b/
    ]
  },
  {
    category: 'replaces_secretary_or_seller',
    intent: 'replaces_secretary_or_seller',
    replyIntent: 'seller_replacement',
    responseType: 'replaces_secretary_or_seller',
    entities: ['equipo humano'],
    examples: [
      'esto reemplaza a mis vendedores?',
      'reemplaza a una secretaria?',
      'voy a necesitar menos gente?',
      'saca trabajo a mi equipo?',
      'puede vender solo?',
      'atiende sin personas?'
    ],
    patterns: [
      /\breemplaza\b/,
      /\bmenos\s+gente\b/,
      /\bsaca\s+trabajo\b/,
      /\bvender\s+solo\b/,
      /\bsin\s+personas\b/
    ]
  },
  {
    category: 'appointment_business',
    intent: 'appointment_business',
    replyIntent: 'industry_fit',
    responseType: 'appointment_business',
    entities: ['turnos', 'agenda', 'servicio'],
    examples: [
      'trabajo con turnos',
      'necesito agenda',
      'tengo consultorio',
      'doy turnos por whatsapp',
      'agenda pacientes?',
      'organiza reservas?'
    ],
    patterns: [
      /\btrabajo\s+con\s+turnos\b/,
      /\bnecesito\s+agenda\b/,
      /\b(doy|manejo|organizo)\s+turnos\b/,
      /\bagenda\s+(pacientes|clientes|reservas)\b/,
      /\breservas\b/
    ]
  },
  {
    category: 'product_catalog_business',
    intent: 'product_catalog_business',
    replyIntent: 'catalog_import_fit',
    responseType: 'product_catalog_business',
    entities: ['productos', 'catalogo', 'stock'],
    examples: [
      'vendo productos',
      'necesito pedidos',
      'necesito catalogo',
      'manejo stock',
      'quiero cargar productos',
      'tengo lista de precios'
    ],
    patterns: [
      /\bvendo\s+productos\b/,
      /\bnecesito\s+(pedidos|catalogo)\b/,
      /\bmanejo\s+stock\b/,
      /\blista\s+de\s+precios\b/
    ]
  },
  {
    category: 'delivery_or_distribution_business',
    intent: 'delivery_or_distribution_business',
    replyIntent: 'industry_fit',
    responseType: 'delivery_or_distribution_business',
    entities: ['delivery', 'distribucion', 'pedidos'],
    examples: [
      'tengo delivery',
      'tengo distribuidora',
      'reparto pedidos',
      'hago envios',
      'vendo mayorista',
      'tomo pedidos por whatsapp'
    ],
    patterns: [
      /\bdelivery\b/,
      /\bdistribuidora\b/,
      /\breparto\b/,
      /\bhago\s+envios\b/,
      /\bmayorista\b/,
      /\btomo\s+pedidos\b/
    ]
  },
  {
    category: 'small_business_fit',
    intent: 'small_business_fit',
    replyIntent: 'feature_fit',
    responseType: 'small_business_fit',
    entities: ['tamaño del negocio'],
    examples: [
      'me sirve si soy chico?',
      'tengo pocos clientes todavia',
      'recien arranco',
      'soy emprendedor',
      'atiendo yo solo',
      'no tengo muchos mensajes'
    ],
    patterns: [
      /\bsoy\s+chic[oa]\b/,
      /\bpocos\s+clientes\b/,
      /\brecien\s+arranco\b/,
      /\bsoy\s+emprendedor\b/,
      /\batiendo\s+yo\s+sol[oa]\b/
    ]
  },
  {
    category: 'scaling_business_fit',
    intent: 'scaling_business_fit',
    replyIntent: 'feature_fit',
    responseType: 'scaling_business_fit',
    entities: ['volumen de mensajes', 'clientes', 'equipo'],
    examples: [
      'tengo muchos clientes',
      'tengo muchos mensajes y se me pierden',
      'me escriben todo el dia',
      'quiero ordenar la atencion',
      'se me pasan consultas',
      'necesito vender mas ordenado'
    ],
    patterns: [
      /\bmuchos\s+(clientes|mensajes)\b/,
      /\bse\s+me\s+(pierden|pasan)\b/,
      /\btodo\s+el\s+dia\b/,
      /\borderar\s+la\s+atencion\b/,
      /\bvender\s+mas\s+ordenado\b/
    ]
  },
  {
    category: 'crm_and_follow_up',
    intent: 'crm_and_follow_up',
    replyIntent: 'feature_fit',
    responseType: 'crm_and_follow_up',
    entities: ['seguimiento', 'clientes', 'crm'],
    examples: [
      'necesito seguimiento',
      'quiero hacer seguimiento de clientes',
      'se me enfria la venta',
      'necesito CRM',
      'quiero ordenar clientes',
      'puedo ver historial?'
    ],
    patterns: [
      /\bseguimiento\b/,
      /\bcrm\b/,
      /\borderar\s+clientes\b/,
      /\bhistorial\b/,
      /\bse\s+me\s+enfria\s+la\s+venta\b/
    ]
  },
  {
    category: 'human_takeover',
    intent: 'human_takeover',
    replyIntent: 'feature_fit',
    responseType: 'human_takeover',
    entities: ['handoff humano', 'pausa del bot'],
    examples: [
      'quiero que derive a una persona',
      'puedo hablar yo si quiero?',
      'puedo pausar el bot?',
      'quiero tomar la conversacion',
      'si no entiende, pasa a humano?',
      'puede intervenir una persona?'
    ],
    patterns: [
      /\bderive?\s+a\s+(una\s+)?persona\b/,
      /\bhablar\s+yo\b/,
      /\bpausar\s+(el\s+)?bot\b/,
      /\btomar\s+la\s+conversacion\b/,
      /\b(no\s+entiende|no entiende).+(humano|persona)\b/,
      /\bintervenir\s+(una\s+)?persona\b/
    ]
  },
  {
    category: 'pricing_interest',
    intent: 'pricing_interest',
    replyIntent: 'recommend_plan_by_business_context',
    responseType: 'pricing_interest',
    entities: ['plan', 'precio'],
    examples: [
      'cuanto sale?',
      'cuanto cuesta?',
      'tienen planes?',
      'precio del bot',
      'que sale implementar?',
      'pasame valores'
    ],
    patterns: [
      /\bcuanto\s+(sale|cuesta|vale)\b/,
      /\bprecio\b/,
      /\bplanes\b/,
      /\bvalores\b/
    ]
  },
  {
    category: 'plan_recommendation',
    intent: 'plan_recommendation',
    replyIntent: 'recommend_plan_by_business_context',
    responseType: 'plan_recommendation',
    entities: ['rubro', 'volumen', 'equipo'],
    examples: [
      'que plan me conviene?',
      'que me recomendas?',
      'cual me sirve?',
      'necesito algo para empezar',
      'quiero crecer, que plan va?',
      'no se que contratar'
    ],
    patterns: [
      /\bque\s+plan\s+me\s+conviene\b/,
      /\bque\s+me\s+recomendas\b/,
      /\bcual\s+me\s+sirve\b/,
      /\bque\s+contratar\b/
    ]
  },
  {
    category: 'onboarding_how_to_start',
    intent: 'onboarding_how_to_start',
    replyIntent: 'implementation_followup',
    responseType: 'onboarding_how_to_start',
    entities: ['implementacion', 'inicio'],
    examples: [
      'como empiezo?',
      'cuanto tarda en implementarse?',
      'como es la implementacion?',
      'que necesitan de mi?',
      'como se configura?',
      'cuando podria estar funcionando?'
    ],
    patterns: [
      /\bcomo\s+empiezo\b/,
      /\bcuanto\s+tarda\b/,
      /\bimplementa(?:rse|cion)\b/,
      /\bque\s+necesitan\s+de\s+mi\b/,
      /\bconfigura\b/,
      /\bfuncionando\b/
    ]
  },
  {
    category: 'limitations_or_edge_cases',
    intent: 'limitations_or_edge_cases',
    replyIntent: 'feature_fit',
    responseType: 'limitations_or_edge_cases',
    entities: ['limite', 'aprendizaje', 'error'],
    examples: [
      'el bot aprende solo?',
      'que pasa si no entiende?',
      'puede equivocarse?',
      'que limitaciones tiene?',
      'responde cualquier cosa?',
      'puedo revisar las respuestas?'
    ],
    patterns: [
      /\baprende\s+solo\b/,
      /\bque\s+pasa\s+si\s+no\s+entiende\b/,
      /\bequivoca\b/,
      /\blimitaciones\b/,
      /\bcualquier\s+cosa\b/,
      /\brevisar\s+las\s+respuestas\b/
    ]
  }
];

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferEntitiesFromText(rawText, category) {
  const text = normalizeText(rawText);
  const channels = [];
  if (text.includes('whatsapp')) channels.push('whatsapp');
  if (text.includes('instagram')) channels.push('instagram');

  const entities = {};
  if (channels.length) entities.channels = channels;
  if (text.includes('excel')) entities.currentTool = 'excel';
  if (/(turno|agenda|reserva)/.test(text)) entities.worksWithAppointments = true;
  if (/(producto|catalogo|stock|pedido|delivery|distribuidora)/.test(text)) entities.sellsProducts = true;
  if (/(vendedor|usuario|equipo|persona)/.test(text)) entities.hasTeamSignal = true;
  if (/(dos|2|varios|varias)/.test(text) && /(emprendimiento|negocio|marca|servicio)/.test(text)) {
    entities.multiOperation = true;
  }
  if (category) entities.kbCategory = category;
  return entities;
}

function findCommercialKnowledgeMatch(rawText) {
  const text = normalizeText(rawText);
  if (!text) return null;
  let bestMatch = null;

  for (const [index, item] of COMMERCIAL_KB.entries()) {
    const exactExampleMatch = item.examples.some((example) => text === normalizeText(example));
    const exampleMatch = exactExampleMatch || item.examples.some((example) => text.includes(normalizeText(example)));
    const patternMatch = item.patterns.some((pattern) => pattern.test(text));
    if (!exampleMatch && !patternMatch) continue;
    const channelSpecificBoost =
      item.category === 'instagram_sales' && text.includes('instagram')
        ? 0.08
        : item.category === 'existing_whatsapp_number' && text.includes('numero')
          ? 0.08
          : 0;
    const confidence = exactExampleMatch ? 0.95 : (exampleMatch ? 0.9 : 0.78);
    const candidate = {
      version: VERSION,
      category: item.category,
      intent: item.intent,
      replyIntent: item.replyIntent || CATEGORY_REPLY_INTENT[item.category] || 'feature_fit',
      responseType: item.responseType,
      confidence: Math.min(0.98, confidence + channelSpecificBoost),
      entities: inferEntitiesFromText(rawText, item.category),
      reason: `commercial_kb_match:${item.category}`
    };

    if (
      !bestMatch ||
      candidate.confidence > bestMatch.confidence ||
      (candidate.confidence === bestMatch.confidence && index > bestMatch.index)
    ) {
      bestMatch = { ...candidate, index };
    }
  }

  if (!bestMatch) return null;
  const { index, ...match } = bestMatch;
  return match;
}

function getCommercialKnowledgePromptContext() {
  return {
    version: VERSION,
    safetyRules: [
      'No redactar respuesta final libre al usuario.',
      'Devolver JSON estructurado para routing.',
      'No prometer integraciones ni funciones no confirmadas.',
      'WhatsApp actual requiere revisar compatibilidad de conexion.',
      'Instagram se menciona como canal de origen de consultas/ventas, no integracion profunda.',
      'Excel se comunica como catalogo/carga masiva y avance para facilitar importaciones, no importador 100% cerrado.'
    ],
    categories: COMMERCIAL_KB.map((item) => ({
      category: item.category,
      intent: item.intent,
      replyIntent: item.replyIntent,
      responseType: item.responseType,
      entities: item.entities,
      examples: item.examples
    }))
  };
}

module.exports = {
  VERSION,
  COMMERCIAL_KB,
  CATEGORY_REPLY_INTENT,
  findCommercialKnowledgeMatch,
  getCommercialKnowledgePromptContext,
  normalizeText
};
