const { findPreferredWhatsAppChannelByClinicId, findClinicByExternalTenantId, getClinicBusinessProfileById } = require('../repositories/tenant.repository');
const { listProductsByClinicId } = require('../repositories/products.repository');
const {
  findAutomationTemplateByKey,
  findTenantAutomationTemplateByClinicIdAndKey
} = require('../repositories/automation-templates.repository');

const BUSINESS_TYPES = new Set(['dental_clinic', 'medical_clinic', 'retail_products', 'services_general', 'beauty_salon']);
const BUSINESS_CAPABILITIES = new Set(['whatsapp', 'contacts', 'agenda', 'catalog', 'payments']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeBusinessType(value) {
  const safe = normalizeString(value).toLowerCase();
  return BUSINESS_TYPES.has(safe) ? safe : 'services_general';
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => normalizeString(item).toLowerCase())
        .filter((item) => BUSINESS_CAPABILITIES.has(item))
    )
  );
}

async function resolveClinicForAutomation({ tenantId, clinicId }) {
  const safeTenantId = normalizeString(tenantId);
  const safeClinicId = normalizeString(clinicId);

  if (safeClinicId) {
    const clinic = await getClinicBusinessProfileById(safeClinicId);
    if (!clinic) return null;
    return clinic;
  }

  if (!safeTenantId) return null;
  return findClinicByExternalTenantId(safeTenantId);
}

async function buildResolvedCapabilities({ clinic, capabilitiesHint = [] }) {
  const businessProfile = clinic && clinic.businessProfile && typeof clinic.businessProfile === 'object' ? clinic.businessProfile : {};
  const resolved = new Set(normalizeCapabilities(businessProfile.capabilities));

  for (const capability of normalizeCapabilities(capabilitiesHint)) {
    resolved.add(capability);
  }

  resolved.add('contacts');

  if (clinic && clinic.id) {
    const [channel, products] = await Promise.all([
      findPreferredWhatsAppChannelByClinicId(clinic.id),
      listProductsByClinicId(clinic.id)
    ]);

    if (channel && String(channel.status || '').trim().toLowerCase() === 'active') {
      resolved.add('whatsapp');
    }

    if (Array.isArray(products) && products.some((product) => String(product && product.status ? product.status : '').trim().toLowerCase() === 'active')) {
      resolved.add('catalog');
    }
  }

  return Array.from(resolved);
}

function evaluateTemplateCompatibility({ template, businessType, resolvedCapabilities }) {
  const requiredCapabilities = Array.isArray(template && template.requiredCapabilities) ? template.requiredCapabilities : [];
  const allowedBusinessTypes = Array.isArray(template && template.compatibleBusinessTypes)
    ? template.compatibleBusinessTypes
    : Array.isArray(template && template.businessTypes)
      ? template.businessTypes
      : [];
  const capabilitySet = new Set(Array.isArray(resolvedCapabilities) ? resolvedCapabilities : []);
  const businessTypeMatch = !allowedBusinessTypes.length || allowedBusinessTypes.includes(businessType);
  const missingCapabilities = requiredCapabilities.filter((item) => !capabilitySet.has(item));

  return {
    businessTypeMatch,
    missingCapabilities,
    compatible: businessTypeMatch && missingCapabilities.length === 0
  };
}

async function getAutomationEnablementState({ tenantId = null, clinicId = null, key, capabilitiesHint = [] }) {
  const safeKey = normalizeString(key);
  if (!safeKey) {
    return {
      enabled: false,
      reason: 'missing_automation_key'
    };
  }

  const [template, clinic] = await Promise.all([
    findAutomationTemplateByKey(safeKey),
    resolveClinicForAutomation({ tenantId, clinicId })
  ]);

  if (!template || String(template.status || '').trim().toLowerCase() !== 'active') {
    return {
      enabled: false,
      key: safeKey,
      reason: 'automation_template_not_found'
    };
  }

  if (!clinic || !clinic.id) {
    return {
      enabled: false,
      key: safeKey,
      reason: 'tenant_mapping_not_found'
    };
  }

  const businessProfile = clinic.businessProfile && typeof clinic.businessProfile === 'object' ? clinic.businessProfile : {};
  const businessType = normalizeBusinessType(businessProfile.businessType);
  const resolvedCapabilities = await buildResolvedCapabilities({ clinic, capabilitiesHint });
  const compatibility = evaluateTemplateCompatibility({
    template,
    businessType,
    resolvedCapabilities
  });

  if (!compatibility.compatible) {
    return {
      enabled: false,
      key: safeKey,
      clinicId: clinic.id,
      tenantId: normalizeString(tenantId) || normalizeString(clinic.externalTenantId) || null,
      reason: compatibility.businessTypeMatch ? 'automation_missing_capabilities' : 'automation_business_type_incompatible',
      businessType,
      missingCapabilities: compatibility.missingCapabilities,
      resolvedCapabilities
    };
  }

  const tenantTemplate = await findTenantAutomationTemplateByClinicIdAndKey(clinic.id, safeKey);
  const enabled = tenantTemplate ? tenantTemplate.enabled === true : template.defaultEnabled === true;

  return {
    enabled,
    key: safeKey,
    clinicId: clinic.id,
    tenantId: normalizeString(tenantId) || normalizeString(clinic.externalTenantId) || null,
    reason: enabled ? 'enabled' : tenantTemplate ? 'tenant_disabled' : 'default_disabled',
    businessType,
    missingCapabilities: [],
    resolvedCapabilities,
    template,
    tenantTemplate
  };
}

async function isAutomationEnabled(input) {
  const state = await getAutomationEnablementState(input || {});
  return state.enabled === true;
}

module.exports = {
  normalizeBusinessType,
  normalizeCapabilities,
  buildResolvedCapabilities,
  evaluateTemplateCompatibility,
  getAutomationEnablementState,
  isAutomationEnabled
};
