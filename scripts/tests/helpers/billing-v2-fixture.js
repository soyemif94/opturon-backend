const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { activateCutover } = require('../../billing/activate-billing-contract-v2-cutover');
async function activateFixture(pool) {
  // Combined runtime keeps the 087/088 baseline and upgrades it additively.
  if (!(await pool.query("SELECT to_regclass('saas_billing_lifecycles') AS name")).rows[0].name) {
    await pool.query(require('fs').readFileSync(require('path').resolve(__dirname,
      '../../../db/migrations/089_saas_billing_entitlement_lifecycle.sql'), 'utf8'));
  }
  const planConstraint = (await pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='saas_subscriptions'::regclass AND conname='chk_saas_subscriptions_plan_code'")).rows[0];
  if (!planConstraint || !planConstraint.definition.includes("'core'")) {
    await pool.query(require('fs').readFileSync(require('path').resolve(__dirname,
      '../../../db/migrations/090_canonical_plan_entitlements.sql'), 'utf8'));
  }
  const client = await pool.connect();
  try { await activateCutover(client, { apply: true }); } finally { client.release(); }
}
function delivery(payload, secret = 'local-only-6b-signature', requestId = 'fixture-request') {
  const provider = require('../../../src/services/mercado-pago.service');
  const id = String(payload.data?.id ?? 'fixture-resource').trim().toLowerCase();
  const timestamp = '1727300000';
  const signature = crypto.createHmac('sha256', secret).update(`id:${id};request-id:${requestId};ts:${timestamp};`).digest('hex');
  const req = { query: { 'data.id': id }, get: key => ({ 'x-request-id': requestId,
    'x-signature': `ts=${timestamp},v1=${signature}` }[key]) };
  assert.equal(provider.verifyWebhookSignature(req), true);
  const verifiedDelivery = provider.getVerifiedWebhookContext(req);
  return { signatureValid: true, requestId, verifiedDelivery, dedupeKey: provider.signedDeliveryIdentity(verifiedDelivery) };
}
function canonicalReads(adapter, ids = {}) {
  const expected = { getPayment: 'pay-1', getAuthorizedPayment: 'invoice-1', getPreapproval: 'mp-1', getPreapprovalPlan: 'plan-1', ...ids };
  const result = { ...adapter };
  for (const [method, expectedId] of Object.entries(expected)) result[method] = async (id, ...args) => {
    if (String(id) !== expectedId) throw Object.assign(new Error('mock_resource_not_found'), { status: 404 });
    if (method === 'getPreapprovalPlan') return { id: 'plan-1', status: 'active' };
    return adapter[method](id, ...args);
  };
  return result;
}
module.exports = { activateFixture, delivery, canonicalReads };
