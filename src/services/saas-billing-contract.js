// Local expectations only. No provider access, catalogue lookup or persistence.
const CONTRACT_VERSION = 1;
const CONTRACT_SOURCE = 'backend_plan_catalog';
const PLAN_CODES = new Set(['inicial', 'crecimiento', 'empresa']);
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' ? value.trim() : '';
const code = (value) => text(value).toLowerCase();

function canonicalizeContractAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  // Interpret the decimal spelling, never round or multiply a binary float.
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) return null;
  const integer = match[1].replace(/^0+(?=\d)/, '');
  if (integer.length > 10) return null; // NUMERIC(12,2)
  const fraction = (match[2] || '').padEnd(2, '0');
  if (BigInt(integer + fraction) === 0n) return null;
  return `${integer}.${fraction}`;
}

function normalizeContractCurrency(value) {
  const currency = text(value).toUpperCase();
  return CURRENCIES.has(currency) ? currency : null;
}

function canonicalizeExternalReferenceUuid(value) {
  const reference = text(value);
  const separator = reference.lastIndexOf(':');
  const subscriptionId = reference.slice(separator + 1);
  if (separator < 0 || !UUID.test(subscriptionId)) return null;
  // Only UUID casing is equivalent; prefix and tenant remain case-sensitive.
  return `${reference.slice(0, separator)}:${subscriptionId.toLowerCase()}`;
}

function localIdentity(subscription) {
  const identity = {
    subscriptionId: text(subscription.id).toLowerCase(),
    clinicId: text(subscription.clinicId).toLowerCase(),
    externalTenantId: text(subscription.externalTenantId),
    externalReference: text(subscription.externalReference)
  };
  const missing = Object.entries(identity).filter(([, value]) => !value).map(([key]) => `missing_${key}`);
  if (missing.length) return { status: 'UNKNOWN', reasons: missing };
  if (!UUID.test(identity.subscriptionId) || !UUID.test(identity.clinicId)) {
    return { status: 'CONFLICT', reasons: ['invalid_local_identity'] };
  }
  const reference = canonicalizeExternalReferenceUuid(identity.externalReference);
  if (reference !== `opturon:${identity.externalTenantId}:${identity.subscriptionId}`) {
    return { status: 'CONFLICT', reasons: ['external_reference_identity_conflict'] };
  }
  identity.externalReference = reference;
  return { identity };
}

function captureLocalBillingContract({ plan, subscriptionId, clinicId, externalTenantId, externalReference, capturedAt }) {
  const amount = canonicalizeContractAmount(plan && plan.amount);
  const currency = normalizeContractCurrency(plan && plan.currency);
  const planCode = code(plan && plan.code);
  const checked = localIdentity({ id: subscriptionId, clinicId, externalTenantId, externalReference });
  const timestamp = text(capturedAt);
  if (!amount || !currency || !PLAN_CODES.has(planCode) || !checked.identity
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error('invalid_local_billing_contract');
  }
  return Object.freeze({
    version: CONTRACT_VERSION, source: CONTRACT_SOURCE, planCode, amount, currency,
    frequency: 1, frequencyType: 'months', billingInterval: 'monthly', capturedAt: timestamp,
    ...checked.identity, profile: 'ordinary_recurring'
  });
}

function resolveLocalBillingContract(subscription) {
  const result = (status, source, reasons, contract = null) => ({ status, source, reasons, contract });
  if (!isObject(subscription)) return result('UNKNOWN', null, ['missing_subscription']);
  const metadata = isObject(subscription.metadata) ? subscription.metadata : {};
  const native = Object.prototype.hasOwnProperty.call(metadata, 'contract');
  const source = native ? 'contract' : 'legacy_metadata_plan';
  const candidate = native ? metadata.contract : metadata.plan;
  // Never fall back to legacy evidence if an explicit contract is invalid or newer.
  if (!isObject(candidate)) return result('UNKNOWN', native ? source : null, [native ? 'invalid_contract' : 'missing_legacy_plan']);
  if (native && (candidate.version !== CONTRACT_VERSION || candidate.source !== CONTRACT_SOURCE)) {
    return result('UNKNOWN', source, ['unsupported_contract_version_or_source']);
  }
  const checked = localIdentity(subscription);
  if (!checked.identity) return result(checked.status, source, checked.reasons);
  const planCode = code(native ? candidate.planCode : candidate.code);
  const rowPlan = code(subscription.planCode);
  if (!PLAN_CODES.has(planCode) || !PLAN_CODES.has(rowPlan)) return result('UNKNOWN', source, ['invalid_plan_code']);
  if (planCode !== rowPlan) return result('CONFLICT', source, ['plan_code_conflict']);
  if (code(subscription.billingInterval) !== 'monthly') return result('UNKNOWN', source, ['unsupported_local_interval']);
  const amount = canonicalizeContractAmount(candidate.amount);
  const currency = normalizeContractCurrency(candidate.currency);
  if (!amount || !currency) return result('UNKNOWN', source, [!amount ? 'invalid_expected_amount' : 'missing_or_invalid_expected_currency']);

  if (native) {
    for (const [key, expected] of Object.entries(checked.identity)) {
      let actual = key === 'subscriptionId' || key === 'clinicId' ? code(candidate[key]) : text(candidate[key]);
      if (!actual) return result('UNKNOWN', source, [`missing_contract_${key}`]);
      if (key === 'externalReference') actual = canonicalizeExternalReferenceUuid(actual);
      if (actual !== expected) return result('CONFLICT', source, [`contract_${key}_conflict`]);
    }
    if (candidate.frequency !== 1 || candidate.frequencyType !== 'months'
      || candidate.billingInterval !== 'monthly' || candidate.profile !== 'ordinary_recurring') {
      return result('UNKNOWN', source, ['unsupported_contract_profile']);
    }
    try {
      // Return a fresh canonical object; callers cannot mutate the input snapshot.
      const contract = captureLocalBillingContract({
        plan: { code: planCode, amount, currency }, ...checked.identity, capturedAt: candidate.capturedAt
      });
      return result('KNOWN', source, [], contract);
    } catch {
      return result('UNKNOWN', source, ['invalid_contract_capture_time']);
    }
  }

  // Structural provenance of the audited legacy pending-link generation.
  // No current prices, mutable row amounts or provider snapshots are consulted.
  if (metadata.billingModel !== 'pending_link' || !text(candidate.label)) {
    return result('UNKNOWN', source, ['unproven_legacy_snapshot_generation']);
  }
  return result('KNOWN', source, [], Object.freeze({
    version: 0, source, planCode, amount, currency, frequency: 1, frequencyType: 'months',
    billingInterval: 'monthly', capturedAt: null, ...checked.identity, profile: 'ordinary_recurring'
  }));
}

module.exports = {
  CONTRACT_VERSION, CONTRACT_SOURCE, canonicalizeContractAmount, normalizeContractCurrency,
  captureLocalBillingContract, resolveLocalBillingContract
};
