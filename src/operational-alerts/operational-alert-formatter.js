const {
  normalizeString,
  isPlainObject,
  cloneJsonObject
} = require('./operational-alert-validation');
const { getOperationalAlertDefinition } = require('./operational-alert-registry');

const OPERATIONAL_ALERT_TEMPLATE_CONTRACT = 'operational_alert_body_parameters_v1';

function textParameter(value) {
  return { type: 'text', text: String(value) };
}

function formatInventoryLotExpiring(snapshot) {
  const material = snapshot && snapshot.event && snapshot.event.material;
  if (!isPlainObject(material)) return null;
  const values = [
    material.productName,
    material.lotId,
    material.expiresAt,
    material.availableQuantity,
    material.quantityBasis
  ];
  if (values.some((value) => value === null || value === undefined || String(value).trim() === '')) return null;
  return {
    parameters: values.map(textParameter),
    auditText: `Lote ${material.lotId} de ${material.productName} vence ${material.expiresAt}; cantidad ${material.availableQuantity} (${material.quantityBasis}).`
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
    bodyParameterCount: 5
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
    bodyParameterCount: descriptor.bodyParameterCount
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
        bodyParameterCount: rendered.parameters.length
      }
    }
  };
}

function extractTemplateComponents(definition) {
  if (!isPlainObject(definition)) return [];
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
