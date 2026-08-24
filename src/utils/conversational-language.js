function normalizeConversationalText(input) {
  return applyBasicConversationalNormalizations(
    String(input || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[¿¡.,!?]+|[¿¡.,!?]+$/g, '')
      .trim()
  );
}

function applyBasicConversationalNormalizations(text) {
  let normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return '';

  if (/^hol+a+$/.test(normalized) || /^ola+s*$/.test(normalized) || normalized === 'ols') {
    return 'hola';
  }

  if (normalized === 'q tal') return 'que tal';

  return normalized
    .replace(/\bholis+\b/g, 'hola')
    .replace(/\bbuenass+\b/g, 'buenas')
    .replace(/\bgrax\b/g, 'gracias')
    .replace(/\bgrasias\b/g, 'gracias')
    .replace(/\bgraxias\b/g, 'gracias')
    .replace(/\bgraciass+\b/g, 'gracias')
    .replace(/\bpresio(s)?\b/g, 'precio$1')
    .replace(/\btransferecnia\b/g, 'transferencia')
    .replace(/\btranferencia\b/g, 'transferencia')
    .replace(/\baseptan\b/g, 'aceptan')
    .replace(/\bqiero\b/g, 'quiero')
    .replace(/\bkiero\b/g, 'quiero')
    .replace(/\bq\s*onda\b/g, 'que onda')
    .replace(/\bcuant\b/g, 'cuanto')
    .replace(/\binfoo+\b/g, 'info')
    .replace(/\bnesecito\b/g, 'necesito')
    .replace(/\bnesesito\b/g, 'necesito')
    .replace(/\boki+\b/g, 'ok')
    .replace(/\bokey\b/g, 'ok')
    .replace(/\bokei\b/g, 'ok')
    .replace(/\bokay\b/g, 'ok')
    .replace(/\bbuenisim[oa]\b/g, 'buenisimo')
    .replace(/\bbarbaroo+\b/g, 'barbaro')
    .replace(/\bgenia+l+\b/g, 'genial')
    .replace(/\bq\s+/g, 'que ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  applyBasicConversationalNormalizations,
  normalizeConversationalText
};
