const { validateTransferConfig } = require('../utils/transfer-config');

const MAX_MESSAGE_CHARS = 3500;
const MAX_VISIBLE_ITEMS = 12;

function normalizeText(value, maxLength = 200) {
  const safe = String(value || '').replace(/\s+/g, ' ').trim();
  if (!safe) return null;
  return safe.slice(0, maxLength);
}

function normalizeAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function formatMoney(value, currency) {
  const amount = normalizeAmount(value);
  const safeCurrency = normalizeCurrency(currency);
  if (amount === null) return null;
  if (!safeCurrency) return amount.toFixed(2);

  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: safeCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount).replace(/\u00a0/g, ' ');
  } catch {
    return `${safeCurrency} ${amount.toFixed(2)}`;
  }
}

function buildShortOrderReference(orderId) {
  const compact = String(orderId || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  return compact ? compact.slice(0, 8) : null;
}

function normalizePaymentMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  return ['cash', 'bank_transfer', 'card', 'mercado_pago', 'other'].includes(method)
    ? method
    : null;
}

function paymentMethodLabel(value) {
  const method = normalizePaymentMethod(value);
  if (method === 'cash') return 'Efectivo';
  if (method === 'bank_transfer') return 'Transferencia bancaria';
  if (method === 'card') return 'Tarjeta';
  if (method === 'mercado_pago') return 'Mercado Pago';
  if (method === 'other') return 'Otro';
  return null;
}

function resolveOrderTransferDetails(snapshot, settings) {
  const payment = snapshot && snapshot.payment && typeof snapshot.payment === 'object'
    ? snapshot.payment
    : {};
  if (normalizePaymentMethod(payment.method) !== 'bank_transfer') {
    return { included: false, reason: 'payment_method_not_bank_transfer', details: null };
  }

  const bot = settings && settings.bot && typeof settings.bot === 'object' ? settings.bot : {};
  const raw = bot.transferConfig && typeof bot.transferConfig === 'object' ? bot.transferConfig : null;
  const validation = validateTransferConfig(raw);
  const config = validation.config;
  if (!raw || config.enabled !== true) {
    return { included: false, reason: 'transfer_config_disabled_or_missing', details: null };
  }
  if (!validation.ok) {
    return { included: false, reason: 'transfer_config_invalid', details: null };
  }

  const snapshotDestinationId = normalizeText(payment.destination && payment.destination.id, 100);
  const configuredDestinationId = normalizeText(config.destinationId, 100);
  if (snapshotDestinationId && configuredDestinationId !== snapshotDestinationId) {
    return { included: false, reason: 'transfer_destination_mismatch', details: null };
  }

  const alias = normalizeText(config.alias, 40);
  const cbu = normalizeText(config.cbu, 22);
  if (!alias && !cbu) {
    return { included: false, reason: 'transfer_alias_or_cbu_missing', details: null };
  }

  return {
    included: true,
    reason: 'transfer_config_matched',
    details: {
      alias,
      cbu,
      holder: normalizeText(config.titular, 120),
      bank: normalizeText(config.bank, 120),
      reference: normalizeText(config.reference, 160),
      instructions: normalizeText(config.instructions, 280)
    }
  };
}

function formatItemLine(item, currency) {
  const quantity = normalizeAmount(item && item.quantity);
  const description = normalizeText(item && item.description, 120) || 'Producto';
  const variant = normalizeText(item && item.variant, 60);
  const sku = normalizeText(item && item.sku, 60);
  const lineTotal = formatMoney(item && item.lineTotal, currency);
  const details = [variant, sku ? `SKU ${sku}` : null].filter(Boolean).join(' - ');

  return [
    `- ${quantity === null ? '' : `${quantity} x `}${description}${details ? ` (${details})` : ''}`,
    lineTotal ? `: ${lineTotal}` : ''
  ].join('');
}

function formatOrderCustomerSummary({ snapshot, customerName = null, settings = {} } = {}) {
  const safeSnapshot = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const currency = normalizeCurrency(safeSnapshot.currency);
  const items = Array.isArray(safeSnapshot.items) ? safeSnapshot.items : [];
  const visibleItems = items.slice(0, MAX_VISIBLE_ITEMS);
  const hiddenItemCount = Math.max(0, items.length - visibleItems.length);
  const reference = buildShortOrderReference(safeSnapshot.orderId);
  const greetingName = normalizeText(customerName, 80);
  const lines = [];

  if (greetingName) lines.push(`Hola ${greetingName}.`);
  lines.push(reference ? `Resumen de tu pedido ${reference}:` : 'Resumen de tu pedido:');
  lines.push('');
  visibleItems.forEach((item) => lines.push(formatItemLine(item, currency)));
  if (hiddenItemCount > 0) lines.push(`...y ${hiddenItemCount} productos mas`);

  const subtotal = formatMoney(safeSnapshot.subtotal, currency);
  const taxAmount = normalizeAmount(safeSnapshot.tax);
  const tax = taxAmount !== null && taxAmount !== 0 ? formatMoney(taxAmount, currency) : null;
  const total = formatMoney(safeSnapshot.total, currency);
  if (subtotal || tax || total) lines.push('');
  if (subtotal) lines.push(`Subtotal: ${subtotal}`);
  if (tax) lines.push(`Impuestos: ${tax}`);
  if (total) lines.push(`Total: ${total}`);

  const methodLabel = paymentMethodLabel(safeSnapshot.payment && safeSnapshot.payment.method);
  if (methodLabel) lines.push(`Medio de pago: ${methodLabel}`);

  const transfer = resolveOrderTransferDetails(safeSnapshot, settings);
  if (transfer.included) {
    const details = transfer.details;
    lines.push('', 'Datos para la transferencia:');
    if (details.alias) lines.push(`- Alias: ${details.alias}`);
    if (details.cbu) lines.push(`- CBU: ${details.cbu}`);
    if (details.holder) lines.push(`- Titular: ${details.holder}`);
    if (details.bank) lines.push(`- Banco: ${details.bank}`);
    if (details.reference) lines.push(`- Referencia: ${details.reference}`);
    if (details.instructions) lines.push('', details.instructions);
  }

  const fullText = lines.join('\n').trim();
  const text = fullText.length <= MAX_MESSAGE_CHARS
    ? fullText
    : `${fullText.slice(0, MAX_MESSAGE_CHARS - 3).trimEnd()}...`;

  return {
    text,
    metadata: {
      formatterVersion: 1,
      itemCount: items.length,
      visibleItemCount: visibleItems.length,
      hiddenItemCount,
      currency,
      paymentMethod: normalizePaymentMethod(safeSnapshot.payment && safeSnapshot.payment.method),
      transferIncluded: transfer.included,
      transferReason: transfer.reason,
      truncated: text.length < fullText.length
    }
  };
}

module.exports = {
  MAX_MESSAGE_CHARS,
  MAX_VISIBLE_ITEMS,
  buildShortOrderReference,
  formatMoney,
  resolveOrderTransferDetails,
  formatOrderCustomerSummary
};
