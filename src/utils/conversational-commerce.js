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

module.exports = {
  extractCommercialProductQuery,
  findProductsByQuery,
  normalizeCommerceProductLookupName,
  parseCommerceNaturalOrder,
  parseCommerceQuantity,
  parseContextualCartAction,
  parseProductDiscoveryRequest
};
