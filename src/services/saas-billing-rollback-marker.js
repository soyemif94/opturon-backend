// Internal durable protocol, never read from webhook payloads. Future validated
// runtimes must preserve this marker on every nonterminal event they own.
const BILLING_CONTRACT_V2_MARKER_PREFIX = 'billing_contract_v2:';
const BILLING_CONTRACT_V2_RETRY_REASONS = Object.freeze([
  'provider_timeout', 'provider_network_error', 'provider_5xx',
  'provider_not_found', 'db_retryable', 'claim_active'
]);
const BILLING_CONTRACT_V2_MARKER_MAX_LENGTH = BILLING_CONTRACT_V2_MARKER_PREFIX.length
  + 'claim:'.length + 36 + 1
  + Math.max(...BILLING_CONTRACT_V2_RETRY_REASONS.map(reason => reason.length));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isBillingContractV2Marker(value) {
  if (typeof value !== 'string' || value.length > BILLING_CONTRACT_V2_MARKER_MAX_LENGTH) return false;
  const parts = value.split(':');
  if (parts.length !== 3 && parts.length !== 4) return false;
  if (`${parts[0]}:` !== BILLING_CONTRACT_V2_MARKER_PREFIX || parts[1] !== 'claim') return false;
  if (parts[2].length !== 36 || !UUID_V4.test(parts[2])) return false;
  return parts.length === 3 || BILLING_CONTRACT_V2_RETRY_REASONS.includes(parts[3]);
}

module.exports = {
  BILLING_CONTRACT_V2_MARKER_PREFIX, BILLING_CONTRACT_V2_RETRY_REASONS,
  BILLING_CONTRACT_V2_MARKER_MAX_LENGTH, isBillingContractV2Marker
};
