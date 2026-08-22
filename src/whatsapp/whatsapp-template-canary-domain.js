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
    if (type === 'buttons') {
      (Array.isArray(component && component.buttons) ? component.buttons : []).forEach((button, buttonIndex) => {
        placeholderNumbers(button && button.url).forEach((position) => descriptors.push({
          key: `button.${buttonIndex}.${position}`,
          componentType: 'button',
          componentIndex,
          buttonIndex,
          subType: normalize(button && button.type).toLowerCase(),
          position,
          label: `Boton ${buttonIndex + 1} {{${position}}}`
        }));
      });
      return;
    }
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
    if (type === 'buttons') {
      const buttons = Array.isArray(component && component.buttons) ? component.buttons : [];
      buttons.forEach((button, buttonIndex) => {
        const buttonVariables = scoped.filter((item) => item.buttonIndex === buttonIndex);
        let url = String(button && button.url || '');
        buttonVariables.forEach((item) => { url = url.replace(new RegExp(`\\{\\{${item.position}\\}\\}`, 'g'), normalize(variables[item.key])); });
        preview.push({ type: 'button', text: [normalize(button && button.text), url].filter(Boolean).join(' · ') });
        if (buttonVariables.length) components.push({ type: 'button', sub_type: 'url', index: String(buttonIndex),
          parameters: buttonVariables.map((item) => ({ type: 'text', text: normalize(variables[item.key]) })) });
      });
      return;
    }
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

function unsupportedTemplateReason(template) {
  for (const component of templateComponents(template)) {
    const type = normalize(component && component.type).toLowerCase();
    const format = normalize(component && component.format).toLowerCase();
    if (type === 'header' && format && format !== 'text') return 'unsupported_header_media';
    if (type === 'buttons') {
      const buttons = Array.isArray(component && component.buttons) ? component.buttons : [];
      if (buttons.some((button) => placeholderNumbers(button && button.url).length && normalize(button && button.type).toLowerCase() !== 'url')) {
        return 'unsupported_dynamic_button';
      }
    }
  }
  return null;
}

module.exports = { templateComponents, variableDescriptors, validateVariables, buildTemplatePayload, unsupportedTemplateReason };
