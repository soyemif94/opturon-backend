const { randomUUID } = require('crypto');
const { withTransaction } = require('../db/client');
const {
  insertSubscriptionEvent, lockSubscriptionEventByDedupeKey, lockClaimedSubscriptionEvent,
  updateSubscriptionEventStatus, persistSubscriptionEventContractOutcome
} = require('../repositories/saas-subscriptions.repository');
const { isContractOutcome, validateContractOutcome, durableContractOutcomeResult } = require('./saas-billing-webhook-outcomes');
const { enqueueReconciliation } = require('../repositories/saas-billing-reconciliation.repository');
const { hasPersistedLifecycle } = require('./saas-billing-lifecycle');

const CLAIM_STALE_AFTER_MS = 30000;
const PROVIDER_BUDGET_MS = 15000;
const LOCK_TIMEOUT_MS = 1000;
const STATEMENT_TIMEOUT_MS = 2000;
const retryable = () => ({ ok: false, outcome: 'RETRYABLE_PROCESSING_FAILURE' });
const NO_ACTION_REASONS = new Set([
  'notification_identity_missing', 'invoice_payment_pending', 'authorized_invoice_not_found',
  'payment_pending', 'payment_in_process', 'payment_rejected', 'payment_cancelled', 'payment_canceled',
  'payment_authorized', 'payment_in_mediation', 'preapproval_plan_unsupported', 'unsupported_event',
  'canonical_effect_already_applied', 'reversal_already_recorded', 'payment_retrying'
]);

async function shortTransaction(fn) {
  return withTransaction(async client => {
    // These settings precede even INSERT ... ON CONFLICT, which can wait on an
    // uncommitted unique index entry from another delivery.
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    return fn(client);
  });
}

async function withProviderBudget(prepare) {
  const controller = new AbortController();
  const error = Object.assign(new Error('webhook_provider_timeout'), { code: 'provider_timeout' });
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(error); reject(error); }, PROVIDER_BUDGET_MS);
    });
    // The race also bounds a broken test adapter; the signal is what cancels
    // actual fetch headers/body I/O. Late results cannot reach finalization.
    return await Promise.race([Promise.resolve().then(() => prepare(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function providerFailureReason(error) {
  if (error?.code === 'provider_timeout' || error?.name === 'AbortError') return 'provider_timeout';
  if (error?.status === 404) return 'provider_not_found';
  if (error?.status >= 500) return 'provider_5xx';
  return 'provider_network_error';
}

async function recordFailure(ownership, reason) {
  try {
    await shortTransaction(async client => {
      const event = await lockClaimedSubscriptionEvent(ownership.id, ownership.dedupeKey, ownership.marker, client);
      if (!event) return; // Another claim/terminal result owns this row now.
      await updateSubscriptionEventStatus(event.id, {
        processingStatus: 'failed', processingError: `${ownership.prefix}:${reason}`
      }, client, ownership.marker);
    });
  } catch {
    // A DB outage must not erase the durable claim_active rollback guard.
  }
  return retryable();
}

// Only internal application callbacks are accepted. prepare performs all remote
// reads after the claim COMMIT; apply revalidates local authority under CAS.
async function processSubscriptionWebhookEvent(input, apply, prepare = async () => undefined) {
  let ownership;
  try {
    ownership = await shortTransaction(async client => {
      await insertSubscriptionEvent(input, client);
      const event = await lockSubscriptionEventByDedupeKey(input.dedupeKey, client, CLAIM_STALE_AFTER_MS);
      if (!event) throw new Error('webhook_event_missing');
      if (['processed', 'ignored'].includes(event.processingStatus)) {
        const result = event.processingStatus === 'ignored' && isContractOutcome(event.contractOutcome)
          ? durableContractOutcomeResult(event, true)
          : { ok: true, outcome: 'ALREADY_PROCESSED', duplicate: true, ignored: event.processingStatus === 'ignored' };
        return { result };
      }
      if (!['received', 'failed', 'processing'].includes(event.processingStatus)) throw new Error('webhook_event_status_invalid');
      // Both marked AND historical unmarked processing rows need stale proof.
      // Missing timestamps are not proof of staleness. UUID, never JS Date, owns.
      if (event.processingStatus === 'processing' && event.claimStale !== true) return { result: retryable() };
      const prefix = `billing_contract_v2:claim:${randomUUID()}`;
      const marker = `${prefix}:claim_active`;
      if (!await updateSubscriptionEventStatus(event.id, { processingStatus: 'processing', processingError: marker }, client)) {
        throw new Error('webhook_claim_missing');
      }
      return { id: event.id, dedupeKey: input.dedupeKey, prefix, marker };
    });
  } catch { return retryable(); }
  if (ownership.result) return ownership.result;

  let prepared;
  try { prepared = await withProviderBudget(prepare); }
  catch (error) { return recordFailure(ownership, providerFailureReason(error)); }

  try {
    return await shortTransaction(async client => {
      const event = await lockClaimedSubscriptionEvent(ownership.id, ownership.dedupeKey, ownership.marker, client);
      if (!event) return retryable(); // Stale worker: zero apply calls/SQL writes.
      await client.query('SAVEPOINT webhook_business');
      const result = await apply(client, event, prepared);
      if (isContractOutcome(result)) {
        const outcome = validateContractOutcome(result);
        if (outcome.eventId && outcome.eventId.toLowerCase() !== event.id.toLowerCase()) throw new Error('webhook_outcome_event_mismatch');
        if (!hasPersistedLifecycle(result)) await client.query('ROLLBACK TO SAVEPOINT webhook_business');
        const completed = await persistSubscriptionEventContractOutcome(event.id, outcome, client, ownership.marker);
        if (!completed) throw new Error('webhook_completion_missing');
        return durableContractOutcomeResult(completed);
      }
      if (result?.type === 'NO_ACTION') {
        if (!NO_ACTION_REASONS.has(result.reasonCode)) throw new Error('webhook_no_action_invalid');
        if (!hasPersistedLifecycle(result)) await client.query('ROLLBACK TO SAVEPOINT webhook_business');
        await enqueueReconciliation(client, { id: event.id,
          resourceId: result.reconciliationResourceId || input.resourceId }, result.reasonCode);
        const completed = await updateSubscriptionEventStatus(event.id, {
          processingStatus: 'ignored', processingError: result.reasonCode
        }, client, ownership.marker);
        if (!completed) throw new Error('webhook_completion_missing');
        return { ok: true, outcome: 'IGNORED_NO_ACTION', duplicate: false, ignored: true };
      }
      if (!result || result.ok !== true) throw new Error('webhook_processing_incomplete');
      const completed = await updateSubscriptionEventStatus(event.id, {
        subscriptionId: result.subscription?.id || null,
        processingStatus: result.ignored ? 'ignored' : 'processed', processingError: null
      }, client, ownership.marker);
      if (!completed) throw new Error('webhook_completion_missing');
      return result;
    });
  } catch { return recordFailure(ownership, 'db_retryable'); }
}

module.exports = { processSubscriptionWebhookEvent, withProviderBudget, shortTransaction, providerFailureReason,
  CLAIM_STALE_AFTER_MS, PROVIDER_BUDGET_MS, LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS };
