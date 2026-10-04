// Pure validation: no provider access, DB writes, catalogue lookup or defaults.
const { resolveLocalBillingContract, canonicalizeContractAmount, normalizeContractCurrency,
  canonicalizeExternalReferenceUuid } = require('./saas-billing-contract');

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.trim() : '';
function resourceId(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null;
  const id = String(value).trim();
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : null;
}
const valid = () => ({ type: 'VALID' });
const review = (reasonCode = 'provider_relationship_unproven') => ({ type: 'MANUAL_REVIEW', reasonCode });
const reject = (reasonCode, details = {}) => ({ type: 'CONTRACT_REJECTED', reasonCode, details });
const noAction = reasonCode => ({ type: 'NO_ACTION', reasonCode });

function resolveExpectedContract(subscription) {
  const resolved = resolveLocalBillingContract(subscription);
  if (resolved.status === 'CONFLICT') return review('local_contract_conflict');
  // Legacy KNOWN is a historical observation, not an INSERT-only native contract.
  if (resolved.status !== 'KNOWN' || resolved.source !== 'contract'
    || resolved.contract.version !== 1 || resolved.contract.profile !== 'ordinary_recurring') {
    return review('legacy_contract_unknown');
  }
  return { type: 'VALID', contract: resolved.contract };
}

function identity(observed, expected) {
  const id = resourceId(observed);
  if (!id || !resourceId(expected)) return review();
  return id === resourceId(expected) ? valid() : reject('provider_identity_mismatch');
}

function exactMinorUnits(value) {
  const canonical = canonicalizeContractAmount(value);
  return canonical === null ? null : BigInt(canonical.replace('.', ''));
}

function financialFields(data, contract) {
  if (!object(data)) return review();
  const amount = exactMinorUnits(data.transaction_amount);
  const currency = normalizeContractCurrency(data.currency_id);
  // Missing/malformed observations are insufficient evidence, never defaults.
  if (amount === null || !currency) return review();
  if (amount !== exactMinorUnits(contract.amount)) return reject('contract_amount_mismatch', {
    expectedField: 'amount', observedField: 'transaction_amount',
    observedValue: canonicalizeContractAmount(data.transaction_amount),
    contractVersion: contract.version, contractSource: 'contract'
  });
  if (currency !== contract.currency) return reject('contract_currency_mismatch', {
    expectedField: 'currency', observedField: 'currency_id', observedValue: currency,
    contractVersion: contract.version, contractSource: 'contract'
  });
  return valid();
}

function validatePreapproval({ subscription, clinic, preapproval, preapprovalId, contract }) {
  if (!clinic || String(clinic.id).toLowerCase() !== contract.clinicId
    || clinic.externalTenantId !== contract.externalTenantId) return review('local_contract_conflict');
  const remoteIdentity = identity(preapproval?.id, preapprovalId);
  if (remoteIdentity.type !== 'VALID') return remoteIdentity;
  if (subscription.mercadoPagoPreapprovalId) {
    const localBinding = identity(preapprovalId, subscription.mercadoPagoPreapprovalId);
    if (localBinding.type !== 'VALID') return localBinding;
  } else if (!['provider_call_started', 'reconciliation_required', 'provider_created'].includes(subscription.provisioningState)
    || !subscription.providerCallStartedAt) return review();
  const reference = preapproval?.external_reference;
  if (reference === undefined || reference === null || reference === '') return review();
  if (canonicalizeExternalReferenceUuid(reference) !== contract.externalReference) {
    return reject('external_reference_mismatch');
  }
  const financial = financialFields(preapproval.auto_recurring, contract);
  if (financial.type !== 'VALID') return financial;
  const recurring = preapproval.auto_recurring;
  if (!/^[0-9]+$/.test(String(recurring.frequency ?? '')) || !text(recurring.frequency_type)) return review();
  if (BigInt(String(recurring.frequency)) !== BigInt(contract.frequency)
    || text(recurring.frequency_type).toLowerCase() !== contract.frequencyType) {
    return reject('contract_interval_mismatch');
  }
  if (!text(preapproval.status)) return review();
  return valid();
}

function validateCharge({ invoice, invoiceId, payment, paymentId, preapprovalId, contract }, { lifecycle = false } = {}) {
  for (const [observed, expected] of [[invoice?.id, invoiceId], [invoice?.preapproval_id, preapprovalId]]) {
    const checked = identity(observed, expected);
    if (checked.type !== 'VALID') return checked;
  }
  if (!text(invoice.status)) return review();
  if (invoice.type != null && invoice.type !== 'scheduled') return review('unsupported_charge_type');
  const invoiceMoney = financialFields(invoice, contract);
  if (invoiceMoney.type !== 'VALID') return invoiceMoney;
  if (invoice.payment?.id == null) return noAction('invoice_payment_pending');
  for (const [observed, expected] of [[invoice.payment.id, paymentId], [payment?.id, paymentId]]) {
    const checked = identity(observed, expected);
    if (checked.type !== 'VALID') return checked;
  }
  // Nested status/summarized never authorizes success. Only canonical Payment.
  const status = text(payment.status).toLowerCase();
  // BILL-007 may observe negative states only after the same canonical identity,
  // amount and currency proof. This does not authorize any positive effect.
  if (lifecycle && ['rejected', 'cancelled', 'canceled', 'refunded', 'charged_back'].includes(status)) {
    const money = financialFields(payment, contract);
    if (money.type !== 'VALID') return money;
    const refund = payment.transaction_amount_refunded;
    if (refund != null && !/^0+(?:\.0{1,2})?$/.test(String(refund).trim()) && exactMinorUnits(refund) === null) return review();
    return valid();
  }
  if (['refunded', 'charged_back'].includes(status)) return review('unsupported_charge_type');
  if (['pending', 'in_process', 'rejected', 'cancelled', 'canceled', 'authorized', 'in_mediation'].includes(status)) {
    return noAction(`payment_${status}`);
  }
  if (status !== 'approved') return review('unsupported_charge_type');
  // A partial refund may coexist with an approved status. It cannot be applied
  // as a fresh ordinary recurring success; lifecycle reversal remains BILL-007.
  const refunded = payment.transaction_amount_refunded;
  if (refunded != null) {
    const zero = ['string', 'number'].includes(typeof refunded) && /^0+(?:\.0{1,2})?$/.test(String(refunded).trim());
    if (!zero && (exactMinorUnits(refunded) === null || !lifecycle)) return exactMinorUnits(refunded) !== null ? review('unsupported_charge_type') : review();
  }
  const paymentMoney = financialFields(payment, contract);
  return paymentMoney.type === 'VALID' ? valid() : paymentMoney;
}

function validateAuthorizedPaymentSearch(search, paymentId) {
  const { total, offset, limit } = search?.paging || {};
  if (!Array.isArray(search?.results) || !Number.isSafeInteger(total) || total < 0
    || offset !== 0 || search.results.length > total
    || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit < search.results.length))) return review();
  if (total === 0 && search.results.length === 0) return noAction('authorized_invoice_not_found');
  if (total !== 1 || search.results.length !== 1) return review();
  const invoiceId = resourceId(search.results[0]?.id);
  if (!invoiceId) return review();
  const relationship = identity(search.results[0]?.payment?.id, paymentId);
  return relationship.type === 'VALID' ? { type: 'VALID', invoiceId } : relationship;
}

module.exports = { resourceId, resolveExpectedContract, exactMinorUnits, identity, validateAuthorizedPaymentSearch,
  financialFields, validatePreapproval, validateCharge, review, noAction };
