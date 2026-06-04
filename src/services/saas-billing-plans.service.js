const PLAN_CATALOG = Object.freeze({
  inicial: Object.freeze({
    code: 'inicial',
    label: 'Plan Inicial',
    amount: 40600,
    currency: 'ARS'
  }),
  crecimiento: Object.freeze({
    code: 'crecimiento',
    label: 'Plan Crecimiento',
    amount: 68600,
    currency: 'ARS'
  }),
  empresa: Object.freeze({
    code: 'empresa',
    label: 'Plan Empresa',
    amount: 208600,
    currency: 'ARS'
  })
});

function normalizeString(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveSaasPlanDefinition(planCode) {
  const normalized = normalizeString(planCode);
  return PLAN_CATALOG[normalized] || null;
}

module.exports = {
  PLAN_CATALOG,
  resolveSaasPlanDefinition
};
