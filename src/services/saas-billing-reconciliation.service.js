const { requireGeneration } = require('../repositories/saas-billing-runtime.repository');
const { claimReconciliation, lockReconciliationClaim, completeReconciliation, AUTO_RECONCILE_STATES } = require('../repositories/saas-billing-reconciliation.repository');
const { shortTransaction, withProviderBudget, providerFailureReason } = require('./saas-billing-webhook-claims');
const { isContractOutcome, validateContractOutcome } = require('./saas-billing-webhook-outcomes');

async function runBillingReconciliationOnce() {
  await requireGeneration(2);
  const claim = await shortTransaction(claimReconciliation);
  if (!claim) return { claimed: false };
  const executor = require('./saas-billing.service').__internal;
  let prepared; let failure;
  try {
    prepared = await withProviderBudget(async signal => {
      const value = await executor.prepareMercadoPagoWebhook({ resourceId: claim.resourceId }, signal);
      await executor.validatePreparedWebhook(value, null);
      signal.throwIfAborted(); return value;
    });
  } catch (error) { failure = providerFailureReason(error); }
  const finishFailure = reason => shortTransaction(async client => {
    if (!await lockReconciliationClaim(client, claim)) return { claimed: true, stale: true };
    await requireGeneration(2, client, { lock: true });
    await completeReconciliation(client, claim, { status: 'failed', reason, retry: true });
    return { claimed: true, retry: true };
  });
  if (failure) return finishFailure(failure);
  try {
    return await shortTransaction(async client => {
      if (!await lockReconciliationClaim(client, claim)) return { claimed: true, stale: true };
      await requireGeneration(2, client, { lock: true });
      await client.query('SAVEPOINT reconciliation_business');
      const result = await executor.applyPreparedWebhook(prepared, {}, {}, client, { runId: claim.runId });
      if (isContractOutcome(result)) {
        const outcome = validateContractOutcome(result);
        await client.query('ROLLBACK TO SAVEPOINT reconciliation_business');
        await completeReconciliation(client, claim, { status: 'manual_review', reason: outcome.reasonCode });
      } else if (result?.type === 'NO_ACTION') {
        await client.query('ROLLBACK TO SAVEPOINT reconciliation_business');
        await completeReconciliation(client, claim, { status: result.reasonCode === 'canonical_effect_already_applied' ? 'completed' : 'no_action',
          reason: result.reasonCode, retry: AUTO_RECONCILE_STATES.includes(result.reasonCode) });
      } else {
        if (result?.ok !== true) throw new Error('billing_reconciliation_incomplete');
        await completeReconciliation(client, claim, { status: 'completed', reason: 'payment_applied' });
      }
      return { claimed: true, completed: true };
    });
  } catch { return finishFailure('db_retryable'); }
}

// Dedicated loop, concurrency one. It never blocks the existing messaging poll.
function startBillingReconciliationWorker({ intervalMs = 30000 } = {}) {
  let stopped = false; let timer; let running = Promise.resolve();
  function tick() {
    if (stopped) return;
    running = runBillingReconciliationOnce().catch(() => {
      try { require('../utils/logger').logWarn('billing_reconciliation_poll_failed'); } catch { /* safe diagnostic */ }
    }).finally(() => {
      if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref(); }
    });
  }
  timer = setTimeout(tick, intervalMs); timer.unref();
  return async () => { stopped = true; clearTimeout(timer); await running; };
}
module.exports = { runBillingReconciliationOnce, startBillingReconciliationWorker };
