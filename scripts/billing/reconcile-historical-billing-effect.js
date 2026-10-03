// Import-safe administrator entry point. Dry-run never writes, including runs.
const { randomUUID } = require('crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function reconcileHistoricalEffect({ paymentId, eventId, apply = false }) {
  if (!UUID.test(eventId || '') || !/^[a-zA-Z0-9_-]{1,128}$/.test(paymentId || '')) throw new Error('historical_identifiers_required');
  const { requireGeneration } = require('../../src/repositories/saas-billing-runtime.repository');
  const { shortTransaction, withProviderBudget } = require('../../src/services/saas-billing-webhook-claims');
  const executor = require('../../src/services/saas-billing.service').__internal;
  const { reserveEffect } = require('../../src/services/saas-billing-effects');
  await requireGeneration(2);
  const prepared = await withProviderBudget(signal => executor.prepareMercadoPagoWebhook({ resourceId: paymentId }, signal));
  if (prepared.kind !== 'invoice' || String(prepared.payment?.id) !== paymentId) return { classification: 'insufficient', applied: false };
  return shortTransaction(async client => {
    const state = await requireGeneration(2, client, { lock: true });
    const proof = await executor.validatePreparedWebhook(prepared, client);
    if (proof.decision) return { classification: 'ambiguous', applied: false };
    // xmin equality proves that ALL THREE retained rows were written by the
    // same DB transaction. Status/raw/lastPaymentId alone cannot pass this gate.
    // Require exact SQL timestamp equality too; no JS millisecond truncation.
    const evidence = await client.query(`SELECT e.id FROM saas_subscription_events e
      JOIN saas_subscriptions s ON e."subscriptionId"=s.id
      JOIN clinics c ON c.id=s."clinicId"
      WHERE e.id=$1 AND s.id=$2 AND e."processingStatus"='processed' AND e."signatureValid"=true
        AND e."contractOutcome" IS NULL AND e."updatedAt" < $4::timestamptz
        AND e.xmin=s.xmin AND s.xmin=c.xmin AND e.xmin::text NOT IN ('0','1','2')
        AND e."updatedAt"=s."updatedAt" AND s."updatedAt"=c."updatedAt"
        AND s."lastPaymentId"=$3 AND s."lastPaymentStatus"='approved' AND s."localStatus"='active'
        AND s.metadata->'mercadoPagoPaymentSnapshot'->>'id'=$3
        AND s.metadata->'mercadoPagoPaymentSnapshot'->>'status'='approved'
        AND s.metadata->'mercadoPagoPaymentSnapshot'->>'currency'=$5
        AND (s.metadata->'mercadoPagoPaymentSnapshot'->>'transactionAmount')::numeric=$6::numeric
        AND s.metadata->'mercadoPagoWebhook'->>'requestId'=e."requestId"
        AND s.metadata->'mercadoPagoWebhook'->>'signatureValid'='true'
        AND c.settings->'portal'->'billing'->'subscription'->>'subscriptionId'=s.id::text
        AND c.settings->'portal'->'billing'->'subscription'->>'preapprovalId'=s."mercadoPagoPreapprovalId"
        AND c.settings->'portal'->'billing'->'subscription'->>'lastPaymentId'=$3
        AND c.settings->'portal'->'billing'->'subscription'->>'lastPaymentStatus'='approved'
        AND c.settings->'portal'->'billing'->'subscription'->>'status'='active'
      FOR SHARE OF e`, [eventId, proof.subscription.id, paymentId, state.cutoverAt,
      proof.contract.currency, proof.subscription.amount]);
    if (!evidence.rowCount) return { classification: 'insufficient', applied: false };
    if (!apply) return { classification: 'proven_applied', applied: false, dryRun: true };
    const runId = randomUUID();
    await client.query(`INSERT INTO saas_billing_reconciliation_runs(id,kind,"leaseId",status,reason,"completedAt")
      VALUES ($1,'historical',$2,'completed',$3,clock_timestamp())`, [runId, randomUUID(), `proven_historical_event:${eventId}`]);
    const decision = await reserveEffect(client, prepared, proof.subscription, state, { runId }, { historical: true });
    if (decision?.type === 'manual_review') throw new Error('historical_effect_binding_conflict');
    return { classification: 'proven_applied', applied: !decision, duplicate: Boolean(decision), runId };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--payment-id', '--event-id', '--apply', '--dry-run']);
  const options = {}; let mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!allowed.has(arg)) throw new Error('invalid_arguments');
    if (['--apply', '--dry-run'].includes(arg)) { if (mode) throw new Error('duplicate_mode'); mode = arg; }
    else { if (options[arg] || !args[i + 1]) throw new Error('invalid_arguments'); options[arg] = args[++i]; }
  }
  try {
    console.log(JSON.stringify(await reconcileHistoricalEffect({ paymentId: options['--payment-id'], eventId: options['--event-id'], apply: mode === '--apply' })));
  } finally { await require('../../src/db/client').closePool(); }
}
if (require.main === module) main().catch(() => { console.error('historical_reconciliation_failed'); process.exitCode = 1; });
module.exports = { reconcileHistoricalEffect };
