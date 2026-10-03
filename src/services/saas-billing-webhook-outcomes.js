// Internal decisions only: callers must establish evidence before choosing an
// outcome. This module neither inspects provider objects nor validates contracts.
const CONTRACT_REJECT_REASON_CODES = Object.freeze([
  'contract_amount_mismatch', 'contract_currency_mismatch', 'contract_interval_mismatch',
  'provider_identity_mismatch', 'external_reference_mismatch'
]);
const MANUAL_REVIEW_REASON_CODES = Object.freeze([
  'legacy_contract_unknown', 'local_contract_conflict', 'unsupported_charge_type',
  'provider_relationship_unproven', 'legacy_effect_unreconciled'
]);
const FIELDS = new Set(['amount', 'currency', 'frequency', 'frequencyType', 'billingInterval',
  'externalReference', 'providerId', 'transaction_amount', 'currency_id', 'frequency_type',
  'external_reference', 'preapproval_id', 'subscription_id', 'id']);
const SOURCES = new Set(['contract', 'legacy_metadata_plan', 'backend_plan_catalog']);
const RESOURCE_TYPES = new Set(['preapproval', 'payment', 'authorized_payment', 'invoice']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid() { throw new Error('webhook_contract_outcome_invalid'); }

function objectWithKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) invalid();
}

function safeDetails(input = {}) {
  objectWithKeys(input, ['expectedField', 'observedField', 'observedValue', 'contractVersion', 'contractSource']);
  const result = {};
  for (const name of ['expectedField', 'observedField']) {
    if (input[name] !== undefined) {
      if (!FIELDS.has(input[name])) invalid();
      result[name] = input[name];
    }
  }
  if (input.contractVersion !== undefined) {
    if (!Number.isSafeInteger(input.contractVersion) || input.contractVersion < 1) invalid();
    result.contractVersion = input.contractVersion;
  }
  if (input.contractSource !== undefined) {
    if (!SOURCES.has(input.contractSource)) invalid();
    result.contractSource = input.contractSource;
  }
  // No unrestricted text values: identifiers/references and payer data must not
  // be smuggled into diagnostics under an otherwise allowed detail key.
  if (input.observedValue !== undefined) {
    const value = input.observedValue;
    const field = input.observedField;
    const valid = ['amount', 'transaction_amount'].includes(field)
      ? typeof value === 'string' && /^\d{1,12}(\.\d{1,4})?$/.test(value)
      : ['currency', 'currency_id'].includes(field)
        ? typeof value === 'string' && /^[A-Z]{3}$/.test(value)
        : field === 'frequency'
          ? Number.isSafeInteger(value) && value >= 0
          : ['frequencyType', 'frequency_type', 'billingInterval'].includes(field)
            && ['days', 'months', 'monthly'].includes(value);
    if (!valid) invalid();
    result.observedValue = value;
  }
  return Object.freeze(result);
}

function makeOutcome(type, input) {
  objectWithKeys(input, ['eventId', 'subscriptionId', 'reasonCode', 'details', 'resource']);
  const reasons = type === 'contract_rejected'
    ? CONTRACT_REJECT_REASON_CODES : MANUAL_REVIEW_REASON_CODES;
  if (!reasons.includes(input.reasonCode)) invalid();
  for (const key of ['eventId', 'subscriptionId']) {
    if (input[key] != null && (typeof input[key] !== 'string' || !UUID.test(input[key]))) invalid();
  }
  let resource = null;
  if (input.resource != null) {
    objectWithKeys(input.resource, ['type', 'id']);
    if (!RESOURCE_TYPES.has(input.resource.type) || typeof input.resource.id !== 'string'
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.resource.id)) invalid();
    resource = Object.freeze({ type: input.resource.type, id: input.resource.id });
  }
  return Object.freeze({ type, eventId: input.eventId || null,
    subscriptionId: input.subscriptionId || null, reasonCode: input.reasonCode,
    details: safeDetails(input.details), resource });
}

function isContractOutcome(value) {
  return value?.type === 'contract_rejected' || value?.type === 'manual_review';
}

// Revalidate at persistence as well as construction. Nothing is trusted because
// it arrived in webhook raw data or because it resembles an internal result.
function validateContractOutcome(value) {
  if (!isContractOutcome(value)) invalid();
  const { type, ...input } = value;
  return makeOutcome(type, input);
}

function durableContractOutcomeResult(event, duplicate = false) {
  if (event.processingStatus !== 'ignored' || !isContractOutcome(event.contractOutcome)) invalid();
  return { ok: true, duplicate, ignored: true, processingStatus: event.processingStatus,
    outcome: event.contractOutcome.type.toUpperCase(),
    contractOutcome: event.contractOutcome };
}

module.exports = {
  CONTRACT_REJECT_REASON_CODES, MANUAL_REVIEW_REASON_CODES,
  contractRejected: input => makeOutcome('contract_rejected', input),
  manualReview: input => makeOutcome('manual_review', input),
  isContractOutcome, validateContractOutcome, durableContractOutcomeResult
};
