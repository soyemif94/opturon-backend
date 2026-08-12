const {
  normalizeString,
  isPlainObject,
  cloneJsonObject
} = require('./operational-alert-validation');
const { getOperationalAlertDefinition } = require('./operational-alert-registry');
const {
  INVENTORY_EXPIRY_FORMATTER_ITEM_LIMIT,
  INVENTORY_EXPIRY_TEMPLATE_CONTRACT
} = require('./inventory-lot-expiry-alert');

const OPERATIONAL_ALERT_TEMPLATE_CONTRACT = 'operational_alert_body_parameters_v1';

function textParameter(value) {
  return { type: 'text', text: String(value) };
}

function compactText(value, maxLength) {
  const normalized = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function formatQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity)) return null;
  return quantity.toFixed(3).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function formatInventoryExpiryLine(item) {
  const quantity = formatQuantity(item.relevantQuantity);
  if (!quantity) return null;
  const productName = compactText(item.productName, 36);
  const lotCode = compactText(item.lotCode || item.lotId.slice(0, 8), 18);
  const days = Number(item.daysRemaining);
  const daysLabel = days === 0 ? 'hoy' : `${days} ${days === 1 ? 'dia' : 'dias'}`;
  return `${productName} | lote ${lotCode} | cant. ${quantity} | ${item.expiresAt} (${daysLabel})`;
}

function formatInventoryLotExpiring(snapshot) {
  const material = snapshot && snapshot.event && snapshot.event.material;
  if (!isPlainObject(material) || !Array.isArray(material.items) || material.items.length === 0) return null;
  const visibleLines = [];
  let visibleLength = 0;
  for (const item of material.items.slice(0, INVENTORY_EXPIRY_FORMATTER_ITEM_LIMIT)) {
    const line = formatInventoryExpiryLine(item);
    if (!line) return null;
    const nextLength = visibleLength + line.length + (visibleLines.length > 0 ? 1 : 0);
    if (nextLength > 1000) break;
    visibleLines.push(line);
    visibleLength = nextLength;
  }
  if (visibleLines.length === 0) return null;

  const totalLots = Number(material.totalLots);
  const totalProducts = Number(material.totalProducts);
  const daysBefore = Number(material.daysBefore);
  const quantityBasis = material.quantityBasis === 'commercial' ? 'comercial' : 'fisico';
  if (!Number.isInteger(totalLots) || !Number.isInteger(totalProducts) || !Number.isInteger(daysBefore)) return null;
  const hiddenLots = Math.max(0, totalLots - visibleLines.length);
  const values = [
    'Vencimientos proximos',
    `${totalLots} lotes de ${totalProducts} productos dentro de ${daysBefore} dias; stock ${quantityBasis}.`,
    visibleLines.join('\n'),
    hiddenLots > 0 ? `...y ${hiddenLots} lotes mas` : `Total incluido: ${totalLots} lotes.`,
    `Evaluacion ${material.localDate}. Revisar inventario; estos lotes no estan informados como vencidos.`
  ];
  if (values.some((value) => value === null || value === undefined || String(value).trim() === '')) return null;
  return {
    parameters: values.map(textParameter),
    auditText: values.join('\n'),
    metadata: {
      totalLots,
      totalProducts,
      visibleLots: visibleLines.length,
      hiddenLots,
      eventSnapshotTruncated: Number(material.truncation && material.truncation.omittedLots || 0) > 0
    }
  };
}

function formatCashSessionClosed(snapshot) {
  const material = snapshot && snapshot.event && snapshot.event.material;
  if (!isPlainObject(material)) return null;
  const values = [material.sessionId, material.closedAt, material.differenceAmount, material.currency];
  if (values.some((value) => value === null || value === undefined || String(value).trim() === '')) return null;
  return {
    parameters: values.map(textParameter),
    auditText: `Caja ${material.sessionId} cerrada ${material.closedAt}; diferencia ${material.differenceAmount} ${material.currency}.`
  };
}

const FORMATTERS = Object.freeze({
  'inventory_lot_expiring@1': Object.freeze({
    format: formatInventoryLotExpiring,
    bodyParameterCount: 5,
    templateSpecification: INVENTORY_EXPIRY_TEMPLATE_CONTRACT
  }),
  'cash_session_closed@1': Object.freeze({
    format: formatCashSessionClosed,
    bodyParameterCount: 4
  })
});

function getOperationalAlertFormatterDescriptor(formatterKey, formatterVersion) {
  const key = normalizeString(formatterKey);
  const version = Number(formatterVersion);
  const descriptor = FORMATTERS[`${key}@${version}`];
  if (!descriptor) return null;
  return {
    formatterKey: key,
    formatterVersion: version,
    bodyParameterCount: descriptor.bodyParameterCount,
    templateSpecification: descriptor.templateSpecification
      ? JSON.parse(JSON.stringify(descriptor.templateSpecification))
      : null
  };
}

function formatOperationalAlertMessage(instanceSnapshot) {
  if (!isPlainObject(instanceSnapshot) || !isPlainObject(instanceSnapshot.rule)) {
    return { ok: false, reason: 'operational_alert_instance_snapshot_invalid' };
  }
  const rule = instanceSnapshot.rule;
  const definition = getOperationalAlertDefinition(rule.eventType, Number(rule.eventVersion));
  const formatterIdentity = `${normalizeString(rule.formatterKey)}@${Number(rule.formatterVersion)}`;
  const formatter = FORMATTERS[formatterIdentity];
  if (
    !definition || !formatter ||
    definition.formatterKey !== rule.formatterKey ||
    definition.formatterVersion !== Number(rule.formatterVersion)
  ) {
    return { ok: false, reason: 'operational_alert_formatter_not_registered' };
  }

  const templateKey = normalizeString(rule.templateKey);
  const language = normalizeString(rule.templateLanguage);
  if (!templateKey || !language) {
    return { ok: false, reason: 'template_not_configured' };
  }
  if (
    formatter.templateSpecification && (
      templateKey !== formatter.templateSpecification.templateKey ||
      language !== formatter.templateSpecification.language
    )
  ) {
    return { ok: false, reason: 'template_contract_mismatch' };
  }
  const rendered = formatter.format(instanceSnapshot);
  if (!rendered) return { ok: false, reason: 'operational_alert_formatter_material_invalid' };

  return {
    ok: true,
    value: {
      templateKey,
      language,
      components: [{ type: 'body', parameters: rendered.parameters }],
      auditText: rendered.auditText,
      metadata: {
        eventType: rule.eventType,
        eventVersion: Number(rule.eventVersion),
        formatterKey: rule.formatterKey,
        formatterVersion: Number(rule.formatterVersion),
        templateContract: OPERATIONAL_ALERT_TEMPLATE_CONTRACT,
        bodyParameterCount: rendered.parameters.length,
        templateSpecification: formatter.templateSpecification
          ? JSON.parse(JSON.stringify(formatter.templateSpecification))
          : null,
        ...(rendered.metadata || {})
      }
    }
  };
}

function extractTemplateComponents(definition) {
  if (!isPlainObject(definition)) return [];
  if (isPlainObject(definition.provider) && Array.isArray(definition.provider.components)) {
    return definition.provider.components;
  }
  if (Array.isArray(definition.components)) return definition.components;
  if (isPlainObject(definition.blueprint) && Array.isArray(definition.blueprint.components)) {
    return definition.blueprint.components;
  }
  return [];
}

function validateOperationalAlertTemplateContract(template, formatted) {
  if (!template || !formatted) return { ok: false, reason: 'template_not_configured' };
  const metadata = isPlainObject(template.metadata) ? template.metadata : {};
  if (metadata.operationalAlertContract !== OPERATIONAL_ALERT_TEMPLATE_CONTRACT) {
    return { ok: false, reason: 'template_contract_invalid' };
  }
  const body = extractTemplateComponents(template.definition)
    .find((component) => normalizeString(component && component.type).toUpperCase() === 'BODY');
  const placeholders = String(body && body.text || '').match(/\{\{\d+\}\}/g) || [];
  const expected = Number(formatted.metadata && formatted.metadata.bodyParameterCount);
  const sequential = placeholders.every((placeholder, index) => placeholder === `{{${index + 1}}}`);
  if (!Number.isInteger(expected) || expected < 1 || placeholders.length !== expected || !sequential) {
    return { ok: false, reason: 'template_contract_invalid' };
  }
  const specification = formatted.metadata && formatted.metadata.templateSpecification;
  if (isPlainObject(specification) && (
    normalizeString(template.templateKey) !== normalizeString(specification.templateKey) ||
    normalizeString(template.language) !== normalizeString(specification.language) ||
    normalizeString(template.category).toUpperCase() !== normalizeString(specification.category).toUpperCase() ||
    expected !== Number(specification.bodyParameterCount)
  )) {
    return { ok: false, reason: 'template_contract_invalid' };
  }
  return { ok: true };
}

function buildOperationalAlertMessageSnapshot({ formatted, template }) {
  const components = cloneJsonObject({ components: formatted.components });
  if (!components) return null;
  return {
    schemaVersion: 1,
    formatter: {
      key: formatted.metadata.formatterKey,
      version: formatted.metadata.formatterVersion
    },
    template: {
      key: formatted.templateKey,
      name: normalizeString(template.metaTemplateName),
      language: formatted.language,
      contract: OPERATIONAL_ALERT_TEMPLATE_CONTRACT,
      version: 1
    },
    components: components.components,
    auditText: formatted.auditText,
    metadata: cloneJsonObject(formatted.metadata)
  };
}

function buildOperationalAlertTemplateSend(messageSnapshot, recipientDigits) {
  if (
    !isPlainObject(messageSnapshot) ||
    !isPlainObject(messageSnapshot.template) ||
    messageSnapshot.template.contract !== OPERATIONAL_ALERT_TEMPLATE_CONTRACT ||
    !Array.isArray(messageSnapshot.components)
  ) {
    return null;
  }
  const templateName = normalizeString(messageSnapshot.template.name);
  const languageCode = normalizeString(messageSnapshot.template.language);
  if (!templateName || !languageCode || !recipientDigits) return null;
  return {
    to: recipientDigits,
    templateName,
    languageCode,
    components: cloneJsonObject({ value: messageSnapshot.components }).value
  };
}

module.exports = {
  OPERATIONAL_ALERT_TEMPLATE_CONTRACT,
  getOperationalAlertFormatterDescriptor,
  formatOperationalAlertMessage,
  validateOperationalAlertTemplateContract,
  buildOperationalAlertMessageSnapshot,
  buildOperationalAlertTemplateSend
};
