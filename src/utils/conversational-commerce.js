const { normalizeConversationalText } = require('./conversational-language');

const QUANTITY_WORDS = Object.freeze({
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
});

const PRODUCT_SIMILARITY_NOISE_TOKENS = new Set([
  'x',
  'u',
  'un',
  'una',
  'unidad',
  'unidades',
  'und',
  'pack',
  'packs',
  'caja',
  'cajas',
  'display',
  'displays',
  'sobre',
  'sobres',
  'bolsa',
  'bolsas',
  'botella',
  'botellas',
  'frasco',
  'frascos',
  'sabor',
  'sabores',
  'producto',
  'productos',
  'articulo',
  'articulos',
  'modelo',
  'modelos',
  'marca',
  'marcas',
  'familia',
  'familias',
  'tipo',
  'tipos',
  'gr',
  'g',
  'kg',
  'ml',
  'cc',
  'lt',
  'litro',
  'litros',
  'de',
  'del',
  'la',
  'las',
  'el',
  'los',
  'por'
]);

function parseCommerceQuantity(rawText) {
  const text = normalizeConversationalText(rawText);
  const match = text.match(/^(\d{1,3})$/);
  const value = match ? Number(match[1]) : QUANTITY_WORDS[text];
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseContextualCartAction(rawText) {
  const text = normalizeConversationalText(rawText);
  if (!text) return null;

  if (/^(?:sumame|agregame|anadime|añadime)\s+(?:otro|otra|uno|una)$/.test(text) || /^(?:uno|una)\s+mas$/.test(text)) {
    return { type: 'add', quantity: 1 };
  }

  const addMatch = text.match(/^(?:dame|quiero|poneme|agregame|sumame)\s+(\d{1,3}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)(?:\s+mas)?$/);
  if (addMatch) {
    const quantity = parseCommerceQuantity(addMatch[1]);
    if (quantity) return { type: 'add', quantity };
  }

  const setMatch = text.match(/^(?:mejor|dejame|deja|que sean|cambia(?:lo)? a)\s+(.+)$/);
  if (setMatch) {
    const quantity = parseCommerceQuantity(setMatch[1]);
    if (quantity) return { type: 'set', quantity };
  }
  return null;
}

function parseCommerceNaturalOrder(rawText) {
  let text = normalizeConversationalText(rawText);
  if (!text) return null;
  text = text.replace(/^y\s+/, '').trim();
  text = text
    .replace(/^(quiero|quisiera|agrega|agrega me|agregame|agrega un|agrega una|agrega unos|agrega unas|agrega dos|agrega tres|agrega cuatro|agrega cinco|agrega seis|agrega siete|agrega ocho|agrega nueve|agrega diez|agrega \d+|agrega)\b/g, 'agrega')
    .trim()
    .replace(/^(agrega|agrega|agregame|agregame|agregá|suma|suma me|sumame|sumá|pone|poneme|dame|mandame|manda|llevo|necesito)\s+/g, '')
    .replace(/^(por favor\s+)/g, '')
    .trim();
  if (!text) return null;

  const parts = text.split(' ').filter(Boolean);
  let quantity = 1;
  let nameStartIndex = 0;
  if (/^\d{1,3}$/.test(parts[0])) {
    quantity = Number(parts[0]);
    nameStartIndex = 1;
  } else if (QUANTITY_WORDS[parts[0]]) {
    quantity = QUANTITY_WORDS[parts[0]];
    nameStartIndex = 1;
  }
  const productName = parts
    .slice(nameStartIndex)
    .filter((part) => !['de', 'del'].includes(part) || parts.slice(nameStartIndex).length === 1)
    .join(' ')
    .trim();
  if (!productName || !Number.isInteger(quantity) || quantity <= 0) return null;
  return { quantity, productName };
}

function normalizeCommerceProductLookupName(value) {
  return normalizeConversationalText(value)
    .replace(/[()]/g, ' ')
    .replace(/\b(de|del|la|las|el|los|un|una|unos|unas)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((token) => {
      if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
      if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
      return token;
    })
    .join(' ')
    .trim();
}

function extractCommercialProductQuery(rawText) {
  return normalizeConversationalText(rawText)
    .replace(/\b(?:cuanto|que)\s+(?:sale|cuesta|vale)\b/g, ' ')
    .replace(/\b(?:precio|precios|costo|costos|valor)\s+(?:de|del)?\b/g, ' ')
    .replace(/\b(?:hay|tienen|tenes|queda|quedan|esta)\s+(?:stock|disponibilidad|disponible)?\b/g, ' ')
    .replace(/\b(?:stock|disponibilidad|disponible)\s+(?:de|del)?\b/g, ' ')
    .replace(/\b(?:el|la|los|las|de|del|un|una)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findProductsByQuery(products, rawText) {
  const safeProducts = Array.isArray(products) ? products : [];
  const query = normalizeCommerceProductLookupName(extractCommercialProductQuery(rawText));
  if (!query) return [];
  const queryTokens = new Set(query.split(' ').filter(Boolean));
  return safeProducts.filter((product) => [product && product.name, product && product.categoryName, product && product.brand, product && product.sku]
    .map(normalizeCommerceProductLookupName)
    .filter(Boolean)
    .some((value) => {
      if (value === query || value.includes(query) || query.includes(value)) return true;
      const shared = value.split(' ').filter((token) => queryTokens.has(token)).length;
      return shared >= Math.min(2, queryTokens.size);
    }));
}

function normalizeProductSimilarityToken(value) {
  const token = normalizeConversationalText(value)
    .replace(/[^a-z0-9]/g, '')
    .trim();
  if (!token || /^\d+(?:g|gr|kg|ml|cc|lt)?$/.test(token) || PRODUCT_SIMILARITY_NOISE_TOKENS.has(token)) {
    return '';
  }
  if (token.length > 6 && token.endsWith('itos')) return token.slice(0, -4);
  if (token.length > 6 && token.endsWith('itas')) return token.slice(0, -4);
  if (token.length > 5 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function productSimilarityTokens(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const rawValues = [
    safeProduct.name,
    safeProduct.brand,
    safeProduct.family,
    safeProduct.productFamily,
    safeProduct.subcategory,
    safeProduct.type,
    safeProduct.categoryName
  ];
  return [...new Set(rawValues
    .flatMap((value) => normalizeConversationalText(value).split(/\s+/))
    .map(normalizeProductSimilarityToken)
    .filter(Boolean))];
}

function normalizeProductSimilarityField(value) {
  return normalizeConversationalText(value)
    .split(/\s+/)
    .map(normalizeProductSimilarityToken)
    .filter(Boolean)
    .join(' ');
}

function resolveProductSimilarityFamily(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const metadata = safeProduct.metadata && typeof safeProduct.metadata === 'object' ? safeProduct.metadata : {};
  const catalog = metadata.catalog && typeof metadata.catalog === 'object' ? metadata.catalog : {};
  return normalizeProductSimilarityField(
    safeProduct.family || safeProduct.productFamily || safeProduct.subcategory || safeProduct.type || metadata.family || catalog.family || catalog.subcategory || ''
  );
}

function resolveProductSimilarityBrand(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const metadata = safeProduct.metadata && typeof safeProduct.metadata === 'object' ? safeProduct.metadata : {};
  const catalog = metadata.catalog && typeof metadata.catalog === 'object' ? metadata.catalog : {};
  return normalizeProductSimilarityField(safeProduct.brand || metadata.brand || catalog.brand || '');
}

function resolveProductStockPriority(product) {
  const rawStock = product && Object.prototype.hasOwnProperty.call(product, 'stock') ? product.stock : null;
  if (rawStock === null || rawStock === undefined || rawStock === '') return 1;
  const stock = Number(rawStock);
  if (!Number.isFinite(stock)) return 1;
  return stock > 0 ? 2 : 0;
}

function rankSimilarProducts(products, selectedProduct, { minimumRelevance = 18 } = {}) {
  const safeProducts = Array.isArray(products) ? products.filter(Boolean) : [];
  const selected = selectedProduct && typeof selectedProduct === 'object' ? selectedProduct : null;
  const selectedId = String(selected && (selected.id || selected.productId) || '').trim();
  if (!selected || !selectedId) return [];

  const selectedTokens = productSimilarityTokens(selected);
  const tokenDocuments = new Map();
  for (const product of safeProducts) {
    for (const token of productSimilarityTokens(product)) {
      tokenDocuments.set(token, (tokenDocuments.get(token) || 0) + 1);
    }
  }

  const selectedCategoryId = String(selected.categoryId || '').trim();
  const selectedCategoryName = normalizeProductSimilarityField(selected.categoryName);
  const selectedBrand = resolveProductSimilarityBrand(selected);
  const selectedFamily = resolveProductSimilarityFamily(selected);
  const documentCount = Math.max(1, safeProducts.length);
  const ranked = [];

  for (const product of safeProducts) {
    const productId = String(product && (product.id || product.productId) || '').trim();
    if (!productId || productId === selectedId) continue;

    const signals = [];
    let relevanceScore = 0;
    const productCategoryId = String(product.categoryId || '').trim();
    const productCategoryName = normalizeProductSimilarityField(product.categoryName);
    if (
      (selectedCategoryId && productCategoryId && selectedCategoryId === productCategoryId) ||
      (selectedCategoryName && productCategoryName && selectedCategoryName === productCategoryName)
    ) {
      relevanceScore += 55;
      signals.push('same_category');
    }

    const productBrand = resolveProductSimilarityBrand(product);
    if (selectedBrand && productBrand && selectedBrand === productBrand) {
      relevanceScore += 45;
      signals.push('same_brand');
    }

    const productFamily = resolveProductSimilarityFamily(product);
    if (selectedFamily && productFamily && selectedFamily === productFamily) {
      relevanceScore += 50;
      signals.push('same_family');
    }

    const candidateTokens = productSimilarityTokens(product);
    const sharedTokens = selectedTokens.filter((token) => candidateTokens.includes(token));
    if (sharedTokens.length) {
      const tokenScore = sharedTokens.reduce((score, token) => {
        const frequency = Math.max(1, tokenDocuments.get(token) || 1);
        const inverseFrequency = Math.log((documentCount + 1) / frequency) + 1;
        return score + Math.min(32, 8 + inverseFrequency * 5);
      }, 0);
      relevanceScore += tokenScore;
      signals.push('significant_token_overlap');
    }

    const fuzzyFamilyMatch = selectedTokens.some((left) => (
      left.length >= 5 && candidateTokens.some((right) => right.length >= 5 && left.slice(0, 5) === right.slice(0, 5))
    ));
    if (!sharedTokens.length && fuzzyFamilyMatch) {
      relevanceScore += 20;
      signals.push('product_family_similarity');
    }

    if (relevanceScore < minimumRelevance) continue;
    const stockPriority = resolveProductStockPriority(product);
    const stockScore = stockPriority === 2 ? 15 : stockPriority === 1 ? 7 : 0;
    ranked.push({
      product,
      relevanceScore,
      stockPriority,
      score: relevanceScore + stockScore,
      signals
    });
  }

  return ranked.sort((left, right) => (
    right.score - left.score ||
    right.relevanceScore - left.relevanceScore ||
    right.stockPriority - left.stockPriority ||
    String(left.product.name || '').localeCompare(String(right.product.name || ''), 'es')
  ));
}

function parseProductDiscoveryRequest(rawText) {
  const text = normalizeConversationalText(rawText);
  if (!text) return null;
  const patterns = [
    /^(?:que|qué)\s+(?:tenes|tienen)\s+de\s+(.+)$/,
    /^(?:que|qué)\s+(.+)\s+(?:tenes|tienen)$/,
    /^(?:mostrame|mostrar|ver)\s+(.+)$/,
    /^(?:tenes|tienen)\s+algo\s+de\s+(.+)$/,
    /^(?:tenes|tienen)\s+(.+)$/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const query = String(match[1] || '').replace(/\b(?:producto|productos|algo)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (query) return { intent: 'product_discovery', query };
  }
  return null;
}

function parseTenantBusinessOfferRequest(rawText) {
  const text = normalizeConversationalText(rawText);
  if (!text) return null;

  if (
    /\b(?:que|cuales)\s+(?:productos|servicios|articulos|mercaderia|categorias)\s+(?:manejan|tienen|venden|ofrecen)\b/.test(text) ||
    /\b(?:queria|quisiera)\s+saber\s+(?:que|cuales)\s+(?:productos|servicios|articulos|mercaderia|categorias)\s+(?:manejan|tienen|venden|ofrecen)\b/.test(text) ||
    /^(?:que|cuales)\s+(?:manejan|tienen|venden|ofrecen)$/.test(text)
  ) {
    return { intent: 'tenant_offer_discovery', query: null };
  }

  const offerMatch = text.match(/\b(?:que|cuales)\s+(.+?)\s+(?:me\s+)?(?:podes|pueden|podrian)\s+ofrecer\b/);
  if (offerMatch) {
    const query = String(offerMatch[1] || '')
      .replace(/\b(?:productos|servicios|articulos|mercaderia|opciones)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { intent: 'tenant_offer_discovery', query: query || null };
  }

  const searchMatch = text.match(/\bbusco\s+(?:algo|opciones?|productos?|servicios?)?\s*(?:para|de)\s+(.+)$/);
  if (searchMatch) {
    const query = String(searchMatch[1] || '')
      .replace(/\balquilar\b/g, 'alquiler')
      .replace(/\s+/g, ' ')
      .trim();
    return query ? { intent: 'tenant_offer_discovery', query } : null;
  }

  return null;
}

module.exports = {
  extractCommercialProductQuery,
  findProductsByQuery,
  normalizeCommerceProductLookupName,
  parseCommerceNaturalOrder,
  parseCommerceQuantity,
  parseContextualCartAction,
  parseProductDiscoveryRequest,
  parseTenantBusinessOfferRequest,
  productSimilarityTokens,
  rankSimilarProducts,
  resolveProductStockPriority
};
