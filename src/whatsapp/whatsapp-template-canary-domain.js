function normalize(value) {
  return String(value || '').trim();
}

function templateComponents(template) {
  const definition = template && template.definition && typeof template.definition === 'object'
    ? template.definition
    : {};
  if (definition.provider && Array.isArray(definition.provider.components)) return definition.provider.components;
  if (Array.isArray(definition.components)) return definition.components;
  if (definition.blueprint && Array.isArray(definition.blueprint.components)) return definition.blueprint.components;
  return [];
}

function placeholderNumbers(text) {
  return [...String(text || '').matchAll(/\{\{(\d+)\}\}/g)]
    .map((match) => Number(match[1]))
    .filter((value, index, all) => Number.isInteger(value) && value > 0 && all.indexOf(value) === index)
    .sort((left, right) => left - right);
}

function variableDescriptors(template) {
  const descriptors = [];
  templateComponents(template).forEach((component, componentIndex) => {
    const type = normalize(component && component.type).toLowerCase();
    const values = placeholderNumbers(component && component.text);
    if (type === 'header' && normalize(component && component.format).toLowerCase() && normalize(component.format).toLowerCase() !== 'text' && values.length) {
      return;
    }
    values.forEach((position) => {
      const key = type === 'button' || type === 'buttons'
        ? `button.${componentIndex}.${position}`
        : `${type}.${position}`;
      descriptors.push({
        key,
        componentType: type,
        componentIndex,
        position,
        label: `${type === 'body' ? 'Cuerpo' : type === 'header' ? 'Encabezado' : 'Boton'} {{${position}}}`
      });
    });
  });
  return descriptors;
}

function validateVariables(template, input) {
  const variables = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const descriptors = variableDescriptors(template);
  const missing = descriptors.filter((item) => !normalize(variables[item.key])).map((item) => item.key);
  return { ok: missing.length === 0, descriptors, missing, variables };
}

function renderText(text, descriptors, variables, componentIndex) {
  let rendered = String(text || '');
  descriptors.filter((item) => item.componentIndex === componentIndex).forEach((item) => {
    rendered = rendered.replace(new RegExp(`\\{\\{${item.position}\\}\\}`, 'g'), normalize(variables[item.key]));
  });
  return rendered;
}

function buildTemplatePayload(template, variables) {
  const descriptors = variableDescriptors(template);
  const components = [];
  const preview = [];
  templateComponents(template).forEach((component, componentIndex) => {
    const type = normalize(component && component.type).toLowerCase();
    const scoped = descriptors.filter((item) => item.componentIndex === componentIndex);
    const text = renderText(component && component.text, descriptors, variables, componentIndex);
    if (text) preview.push({ type, text });
    if (!scoped.length) return;
    if (type === 'button' || type === 'buttons') {
      components.push({
        type: 'button',
        sub_type: normalize(component && component.sub_type).toLowerCase() || 'url',
        index: String(component && component.index !== undefined ? component.index : componentIndex),
        parameters: scoped.map((item) => ({ type: 'text', text: normalize(variables[item.key]) }))
      });
      return;
    }
    components.push({
      type,
      parameters: scoped.map((item) => ({ type: 'text', text: normalize(variables[item.key]) }))
    });
  });
  return { components, preview };
}

module.exports = { templateComponents, variableDescriptors, validateVariables, buildTemplatePayload };
