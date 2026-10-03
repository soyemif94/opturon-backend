const { createHash } = require('crypto');
const { resourceId } = require('./saas-billing-provider-contract');
const { manualReview } = require('./saas-billing-webhook-outcomes');

const EFFECT_TYPE = 'billing_payment_applied';
function effectKey(paymentId) {
  if (!resourceId(paymentId)) throw new Error('canonical_payment_id_required');
  return 'mp:effect:v1:' + createHash('sha256').update(JSON.stringify(['mercado_pago', EFFECT_TYPE, resourceId(paymentId)])).digest('hex');
}
function bindings(prepared, subscription) {
  const paymentAccount = resourceId(prepared.payment?.collector_id);
  const preapprovalAccount = resourceId(prepared.preapproval?.collector_id);
  if ((prepared.payment?.collector_id != null && !paymentAccount)
    || (prepared.preapproval?.collector_id != null && !preapprovalAccount)
    || (paymentAccount && preapprovalAccount && paymentAccount !== preapprovalAccount)) return null;
  return { provider: 'mercado_pago', effectType: EFFECT_TYPE, canonicalPaymentId: resourceId(prepared.payment.id),
    effectKey: effectKey(prepared.payment.id), providerPreapprovalId: prepared.preapprovalId,
    providerAccountId: paymentAccount || preapprovalAccount || null,
    subscriptionId: subscription.id.toLowerCase(), clinicId: subscription.clinicId.toLowerCase(),
    externalTenantId: subscription.externalTenantId };
}
function matches(row, expected) {
  return Object.keys(expected).every(key => row[key] === expected[key]);
}
const review = (prepared, subscription, reasonCode = 'provider_relationship_unproven') => manualReview({
  reasonCode, resource: prepared.resource, subscriptionId: subscription.id
});

// Require a timezone and a real calendar date; Date.parse alone normalizes Feb 30.
function paymentCreatedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parts = value.slice(0, 19).match(/\d+/g).map(Number);
  const [y, m, d, h, min, sec] = parts;
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() || h > 23 || min > 59 || sec > 59) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
async function historicalEligible(client, subscription, payment) {
  if (paymentCreatedAt(payment.date_created) === null) return false;
  // Compare in PostgreSQL: converting either timestamp to JS Date would lose
  // microseconds at the exact boundary. createdAt is DB-owned and precursor
  // creation transactions share the cutover barrier.
  const result = await client.query(`SELECT (s."createdAt">r."cutoverAt" OR $2::timestamptz>=r."autoApplyNotBefore") AS eligible
    FROM saas_subscriptions s CROSS JOIN saas_billing_runtime_state r
    WHERE s.id=$1 AND r.id=1 AND r.generation=2 AND r."billingContractV2CutoverActive"=true`,
  [subscription.id, payment.date_created]);
  return result.rows[0]?.eligible === true;
}
async function findEffect(client, key) {
  return (await client.query('SELECT * FROM saas_billing_effects WHERE "effectKey"=$1', [key])).rows[0] || null;
}
async function insertEffect(client, expected, source) {
  const result = await client.query(`INSERT INTO saas_billing_effects
    (provider,"effectType","canonicalPaymentId","effectKey","providerPreapprovalId","providerAccountId",
     "subscriptionId","clinicId","externalTenantId","sourceEventId","sourceReconciliationRunId",status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'applied') ON CONFLICT DO NOTHING RETURNING *`,
  [...Object.values(expected), source.eventId || null, source.runId || null]);
  return result.rows[0] || null;
}
async function reserveEffect(client, prepared, subscription, state, source, { historical = false } = {}) {
  const expected = bindings(prepared, subscription);
  if (!expected) return review(prepared, subscription);
  const duplicate = row => matches(row, expected)
    ? { type: 'NO_ACTION', reasonCode: 'canonical_effect_already_applied' } : review(prepared, subscription);
  const existing = await findEffect(client, expected.effectKey);
  if (existing) return duplicate(existing);
  if (!historical && !await historicalEligible(client, subscription, prepared.payment)) {
    return review(prepared, subscription, 'legacy_effect_unreconciled');
  }
  if (await insertEffect(client, expected, source)) return null;
  const winner = await findEffect(client, expected.effectKey);
  if (!winner) throw new Error('billing_effect_conflict_missing');
  return duplicate(winner);
}
module.exports = { effectKey, bindings, matches, paymentCreatedAt, historicalEligible, findEffect, reserveEffect };
