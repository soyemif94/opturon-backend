const { updateSaasSubscriptionById } = require('../repositories/saas-subscriptions.repository');
const { reserveEffect, effectKey, bindings, matches, paymentCreatedAt, historicalEligible } = require('./saas-billing-effects');
const { exactMinorUnits, noAction, resourceId } = require('./saas-billing-provider-contract');
const { manualReview } = require('./saas-billing-webhook-outcomes');

// Existing product mapping, not a price/catalog lookup. The contract selects it.
const PLAN_MAP = Object.freeze({ inicial: 'basic', crecimiento: 'growth', empresa: 'enterprise' });
const persistedDecisions = new WeakSet();
const retainLifecycle = result => { persistedDecisions.add(result); return result; };
const hasPersistedLifecycle = result => Boolean(result && persistedDecisions.has(result));
const review = (prepared, subscription, reasonCode) => manualReview({
  subscriptionId: subscription.id, resource: prepared.resource, reasonCode
});
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const normalizeStatus = value => String(value || '').trim().toLowerCase();
const isCanceled = value => ['cancelled', 'canceled'].includes(normalizeStatus(value));

async function readLifecycle(client, id) {
  return (await client.query('SELECT data FROM saas_billing_lifecycles WHERE "subscriptionId"=$1', [id])).rows[0]?.data || {
    version: 1, billingState: 'awaiting_payment', entitlementState: 'unactivated', paidThrough: null
  };
}
async function saveLifecycle(client, id, data) {
  await client.query(`INSERT INTO saas_billing_lifecycles ("subscriptionId",data) VALUES ($1,$2::jsonb)
    ON CONFLICT ("subscriptionId") DO UPDATE SET data=EXCLUDED.data,"updatedAt"=clock_timestamp()`, [id, JSON.stringify(data)]);
}
async function isLater(client, newer, older) {
  if (paymentCreatedAt(newer) === null) return false;
  if (!older) return true;
  return (await client.query('SELECT $1::timestamptz > $2::timestamptz AS later', [newer, older])).rows[0].later;
}
function snapshot(subscription, state) {
  const { id, mercadoPagoPreapprovalId, localStatus, mercadoPagoStatus, planCode, amount, currency,
    billingInterval, mercadoPagoPayerEmail, currentPeriodStart, currentPeriodEnd, nextBillingDate,
    lastPaymentId, lastPaymentStatus, authorizationUrl, externalReference, updatedAt } = subscription;
  return { provider: 'mercado_pago', subscriptionId: id, preapprovalId: mercadoPagoPreapprovalId,
    status: localStatus, mercadoPagoStatus, planCode, amount, currency, billingInterval,
    payerEmail: mercadoPagoPayerEmail, currentPeriodStart, currentPeriodEnd, nextBillingDate,
    lastPaymentId, lastPaymentStatus, authorizationUrl, externalReference, updatedAt, lifecycle: state };
}

// The ONLY automatic billing path that changes product entitlement. All callers
// hold subscription -> clinic locks; admin changes also advance the DB revision.
async function syncBillingSnapshot(client, clinic, subscription, state, entitlement = null, advanceRevision = false) {
  const settings = object(clinic.settings), portal = object(settings.portal);
  const nextPortal = { ...portal, billing: { ...object(portal.billing), status: state.billingState,
    subscription: snapshot(subscription, state) } };
  if (entitlement || advanceRevision) {
    nextPortal.billing.entitlement = { subscriptionId: subscription.id, state: state.entitlementState,
      paidAccessAllowed: state.entitlementState !== 'suspended_for_nonpayment' };
    if (entitlement && Object.hasOwn(entitlement, 'billingEntitlement')) {
      nextPortal.billing.entitlement = entitlement.billingEntitlement;
    }
  }
  if (entitlement) {
    nextPortal.policy = { ...object(portal.policy), planCode: entitlement.planCode };
    nextPortal.lifecycle = { ...object(portal.lifecycle) };
    if (entitlement.statusPresent) nextPortal.lifecycle.status = entitlement.status;
    else delete nextPortal.lifecycle.status;
  }
  const row = (await client.query(`UPDATE clinics SET settings = $2::jsonb,
    "billingEntitlementRevision"="billingEntitlementRevision"+$3,"updatedAt"=NOW()
    WHERE id=$1 RETURNING "billingEntitlementRevision"`,
  [clinic.id, JSON.stringify({ ...settings, portal: nextPortal }), entitlement || advanceRevision ? 1 : 0])).rows[0];
  if (!row) throw new Error('billing_tenant_update_missing');
  return String(row.billingEntitlementRevision);
}

async function observePreapproval(client, clinic, subscription, patch) {
  const state = await readLifecycle(client, subscription.id);
  const providerStatus = normalizeStatus(patch.mercadoPagoStatus);
  const canceled = isCanceled(providerStatus);
  // Pending/authorization/refresh is never financial authority. A cancellation
  // is sticky absent a new proven payment or explicit later lifecycle handling.
  const nextState = { ...state };
  if (canceled) {
    nextState.billingState = 'subscription_cancelled';
    nextState.cancellationAt ||= (await client.query('SELECT clock_timestamp()::text AS now')).rows[0].now;
    nextState.reviewReason = state.activatedAt ? 'cancellation_expiry_unproven' : null;
  } else if (!state.cancellationAt) {
    nextState.billingState = providerStatus === 'paused' ? 'subscription_paused'
      : state.activatedAt ? state.billingState : 'awaiting_payment';
  }
  const next = await updateSaasSubscriptionById(subscription.id, { ...patch,
    localStatus: canceled || state.cancellationAt ? 'canceled' : providerStatus === 'paused' ? 'paused'
      : state.activatedAt ? subscription.localStatus : 'pending'
  }, client);
  if (!next) throw new Error('subscription_update_missing');
  await saveLifecycle(client, subscription.id, nextState);
  await syncBillingSnapshot(client, clinic, next, nextState);
  return next;
}

async function applyPaymentLifecycle(client, proof, prepared, patch, runtimeState, source) {
  const { subscription, clinic, contract } = proof;
  const payment = prepared.payment, status = normalizeStatus(payment.status);
  const paymentId = resourceId(payment.id);
  const state = await readLifecycle(client, subscription.id);
  // A payment notification also contains canonical preapproval evidence. Do not
  // wait for a separate cancellation webhook to record the missing expiry proof.
  if (isCanceled(prepared.preapproval.status)) {
    state.cancellationAt ||= (await client.query('SELECT clock_timestamp()::text AS now')).rows[0].now;
    state.billingState = 'subscription_cancelled';
    if (state.activatedAt) state.reviewReason = 'cancellation_expiry_unproven';
  }
  clinic.billingEntitlementRevision = (await client.query('SELECT "billingEntitlementRevision" FROM clinics WHERE id=$1', [clinic.id])).rows[0].billingEntitlementRevision;
  const refunded = payment.transaction_amount_refunded;
  const refundMinor = refunded == null || /^0+(?:\.0{1,2})?$/.test(String(refunded).trim()) ? 0n : exactMinorUnits(refunded);
  const reversal = ['refunded', 'charged_back'].includes(status) || (refundMinor !== null && refundMinor > 0n);
  if (reversal) return applyReversal(client, proof, prepared, state, source, refundMinor);
  if (status === 'rejected') return applyRejectedPayment(client, proof, prepared, state);
  if (status !== 'approved') {
    // Pending remains BILL-006 no-action. Rejected/cancelled observations have
    // their own durable billing state without overwriting any paid entitlement.
    if (['rejected', 'cancelled', 'canceled'].includes(status)) {
      if (await isLater(client, payment.date_created, state.lastSuccessfulPaymentAt)) {
        const nextState = { ...state, billingState: state.cancellationAt ? 'subscription_cancelled' : 'payment_failed', reason: `payment_${status}` };
        await saveLifecycle(client, subscription.id, nextState);
      }
    }
    return retainLifecycle(noAction(`payment_${status}`));
  }
  const planCode = PLAN_MAP[contract.planCode];
  if (!planCode) return review(prepared, subscription, 'local_contract_conflict');
  const previousEffect = (await client.query('SELECT * FROM saas_billing_effects WHERE "effectKey"=$1', [effectKey(payment.id)])).rows[0];
  if (!previousEffect && (await client.query('SELECT 1 FROM saas_billing_reversals WHERE provider=\'mercado_pago\' AND "canonicalPaymentId"=$1', [paymentId])).rowCount) {
    return review(prepared, subscription, 'reversal_requires_review');
  }
  if (!previousEffect && !state.activatedAt && (await client.query('SELECT 1 FROM saas_billing_effects WHERE "subscriptionId"=$1 LIMIT 1', [subscription.id])).rowCount) {
    return review(prepared, subscription, 'reversal_requires_review');
  }
  if (!previousEffect && state.lastSuccessfulPaymentId &&
    !await isLater(client, payment.date_created, state.lastSuccessfulPaymentAt)) {
    return review(prepared, subscription, 'stale_billing_observation');
  }
  if (!previousEffect && state.entitlementState === 'reversed') return review(prepared, subscription, 'reversal_requires_review');
  const sameUnfinishedAttempt = state.nonpayment?.paymentId === paymentId
    && state.entitlementState !== 'suspended_for_nonpayment'
    && !state.collectionHistory?.some(item => item.paymentId === paymentId && item.failedAt);
  if (!previousEffect && state.nonpayment && !sameUnfinishedAttempt &&
    !await isLater(client, payment.date_created, state.nonpayment.paymentCreatedAt)) {
    return review(prepared, subscription, 'stale_billing_observation');
  }
  if (!previousEffect && !state.activatedAt) {
    // The clinic lock serializes competing subscriptions. A delayed first
    // payment must not overwrite a newer entitlement from another contract.
    const otherStates = (await client.query(`SELECT l.data FROM saas_billing_lifecycles l
      JOIN saas_subscriptions s ON s.id=l."subscriptionId"
      WHERE s."clinicId"=$1 AND s.id<>$2 AND l.data ? 'lastSuccessfulPaymentId'`,
    [clinic.id, subscription.id])).rows;
    for (const other of otherStates) {
      if (!await isLater(client, payment.date_created, other.data.lastSuccessfulPaymentAt)) {
        return review(prepared, subscription, 'stale_billing_observation');
      }
    }
  }
  const decision = await reserveEffect(client, prepared, subscription, runtimeState, source);
  if (decision) return decision;
  const first = !state.activatedAt;
  const current = object(object(clinic.settings).portal);
  const currentPlan = object(current.policy).planCode;
  // A different admin/subscription entitlement is not an implicit upgrade path.
  if (!first && (currentPlan !== planCode || String(clinic.billingEntitlementRevision) !== state.entitlementRevision)) {
    // Caller rolls back the just-reserved effect together with this decision.
    return review(prepared, subscription, 'reversal_requires_review');
  }
  const now = (await client.query('SELECT clock_timestamp()::text AS now')).rows[0].now;
  const reactivating = state.entitlementState === 'suspended_for_nonpayment';
  const nextState = { ...state, billingState: state.cancellationAt ? 'subscription_cancelled' : 'active',
    entitlementState: 'active', activatedAt: state.activatedAt || now,
    activationPaymentId: state.activationPaymentId || paymentId,
    previousEntitlement: state.previousEntitlement || { planCode: typeof currentPlan === 'string' ? currentPlan : null,
      status: object(current.lifecycle).status ?? null, statusPresent: Object.hasOwn(object(current.lifecycle), 'status'),
      billingEntitlement: object(current.billing).entitlement || null },
    lastSuccessfulPaymentId: paymentId, lastSuccessfulPaymentAt: payment.date_created,
    reviewReason: state.cancellationAt ? 'cancellation_expiry_unproven' : null,
    entitlementRevision: String(BigInt(clinic.billingEntitlementRevision) + 1n) };
  nextState.reason = 'payment_approved';
  if (state.collectionHistory) {
    nextState.collectionHistory = state.collectionHistory.map(item => item.resolvedAt ? item
      : { ...item, resolvedAt: now, resolvedByPaymentId: paymentId });
  }
  if (state.nonpayment) { nextState.nonpayment = null; nextState.lastRegularizedAt = now; }
  const next = await updateSaasSubscriptionById(subscription.id, { ...patch,
    localStatus: state.cancellationAt ? 'canceled' : 'active', lastPaymentId: paymentId, lastPaymentStatus: 'approved' }, client);
  if (!next) throw new Error('subscription_update_missing');
  nextState.entitlementRevision = await syncBillingSnapshot(client, clinic, next, nextState,
    first || reactivating ? { planCode, status: 'active', statusPresent: true } : null, true);
  await saveLifecycle(client, subscription.id, nextState);
  return { ok: true, outcome: 'PROCESSED_SUCCESSFULLY', duplicate: false, subscription: next };
}

async function applyRejectedPayment(client, proof, prepared, state) {
  const { subscription, clinic, contract } = proof, { payment, invoice } = prepared;
  const paymentId = resourceId(payment.id), invoiceId = resourceId(invoice.id);
  if (!bindings(prepared, subscription)) return review(prepared, subscription, 'provider_relationship_unproven');
  // Ordering is canonical, not delivery time. An old failure cannot revoke a
  // more recent regularization, even if its webhook arrives afterwards.
  if (paymentCreatedAt(payment.date_created) === null) return review(prepared, subscription, 'provider_relationship_unproven');
  if (!await isLater(client, payment.date_created, state.lastSuccessfulPaymentAt)) return noAction('payment_rejected');
  const invoiceStatus = normalizeStatus(invoice.status);
  const retrying = invoiceStatus === 'recycling';
  // MP documents processed + a rejected linked Payment as a finished unpaid
  // collection cycle. retry_attempt, webhook counts and local poll exhaustion
  // are never authority for this decision. Contradictory snapshots fail closed.
  const finalUnpaid = invoiceStatus === 'processed' && invoice.type === 'scheduled'
    && normalizeStatus(invoice.payment.status) === 'rejected'
    && paymentCreatedAt(invoice.last_modified) !== null
    && (await client.query('SELECT $1::timestamptz >= $2::timestamptz AS valid',
      [invoice.last_modified, payment.date_created])).rows[0].valid;
  const phase = finalUnpaid ? 'final_unpaid' : retrying ? 'retrying' : 'unproven';
  const history = Array.isArray(state.collectionHistory) ? state.collectionHistory : [];
  const prior = history.find(item => item.invoiceId === invoiceId);
  const outcome = () => retrying ? { ...noAction('payment_retrying'), reconciliationResourceId: invoiceId }
    : noAction('payment_rejected');
  if (prior?.resolvedAt || prior?.phase === 'final_unpaid' || (prior?.phase === phase && prior.paymentId === paymentId)) {
    return prior?.phase === 'final_unpaid' || prior?.resolvedAt ? noAction('payment_rejected') : outcome();
  }
  if (state.nonpayment && paymentId !== state.nonpayment.paymentId &&
    !await isLater(client, payment.date_created, state.nonpayment.paymentCreatedAt)) return noAction('payment_rejected');
  const now = (await client.query('SELECT clock_timestamp()::text AS now')).rows[0].now;
  const observation = { ...prior, invoiceId, paymentId, paymentCreatedAt: payment.date_created,
    invoiceStatus, invoiceModifiedAt: paymentCreatedAt(invoice.last_modified) === null ? null : invoice.last_modified,
    phase, firstObservedAt: prior?.firstObservedAt || now, lastObservedAt: now,
    ...(retrying ? { retryingAt: prior?.retryingAt || now } : {}),
    ...(finalUnpaid ? { failedAt: now } : {}) };
  const nextState = { ...state, collectionHistory: [...history.filter(item => item.invoiceId !== invoiceId), observation],
    reason: finalUnpaid ? 'collection_final_unpaid' : retrying ? 'payment_retrying' : 'collection_state_unproven',
    reviewReason: phase === 'unproven' ? 'collection_state_unproven' : state.reviewReason || null };
  const alreadySuspended = state.entitlementState === 'suspended_for_nonpayment';
  const ownsEntitlement = state.activatedAt && ['active', 'suspended_for_nonpayment'].includes(state.entitlementState)
    && object(object(object(clinic.settings).portal).policy).planCode === PLAN_MAP[contract.planCode]
    && String(clinic.billingEntitlementRevision) === state.entitlementRevision;
  const suspend = finalUnpaid && ownsEntitlement && !alreadySuspended
    && await historicalEligible(client, subscription, payment);
  nextState.billingState = state.cancellationAt ? 'subscription_cancelled'
    : suspend || alreadySuspended ? 'suspended_for_nonpayment'
      : state.activatedAt ? retrying ? 'payment_retrying' : 'past_due' : 'payment_failed';
  nextState.nonpayment = { invoiceId, paymentId, paymentCreatedAt: payment.date_created,
    ...(state.nonpayment?.suspendedAt ? { suspendedAt: state.nonpayment.suspendedAt } : {}) };
  if (finalUnpaid && state.activatedAt && !suspend && !alreadySuspended) nextState.reviewReason = 'nonpayment_suspension_unproven';
  if (suspend) {
    nextState.entitlementState = 'suspended_for_nonpayment';
    nextState.nonpayment.suspendedAt = now;
    nextState.reviewReason = null;
    nextState.entitlementRevision = String(BigInt(clinic.billingEntitlementRevision) + 1n);
    const next = await updateSaasSubscriptionById(subscription.id, {
      localStatus: state.cancellationAt ? 'canceled' : 'suspended', lastPaymentId: paymentId, lastPaymentStatus: 'rejected'
    }, client);
    nextState.entitlementRevision = await syncBillingSnapshot(client, clinic, next, nextState,
      { planCode: PLAN_MAP[contract.planCode], status: 'suspended', statusPresent: true });
  }
  await saveLifecycle(client, subscription.id, nextState);
  return retainLifecycle(outcome());
}

async function applyReversal(client, proof, prepared, state, source, refundMinor) {
  const { subscription, clinic, contract } = proof, payment = prepared.payment;
  const paymentId = resourceId(payment.id);
  const kind = normalizeStatus(payment.status) === 'charged_back' ? 'chargeback' : refundMinor === exactMinorUnits(contract.amount)
    ? 'full_refund' : refundMinor > 0n && refundMinor < exactMinorUnits(contract.amount) ? 'partial_refund' : 'refund_unknown';
  const original = (await client.query('SELECT * FROM saas_billing_effects WHERE "effectKey"=$1', [effectKey(payment.id)])).rows[0];
  const expected = bindings(prepared, subscription);
  if (!expected || (original && !matches(original, expected))) {
    return review(prepared, subscription, 'provider_relationship_unproven');
  }
  const validOriginal = Boolean(original && expected && matches(original, expected));
  const previous = state.previousEntitlement;
  const otherEffects = (await client.query(`SELECT 1 FROM saas_billing_effects
    WHERE "subscriptionId"=$1 AND "canonicalPaymentId"<>$2 LIMIT 1`, [subscription.id, paymentId])).rowCount;
  const canReverse = kind === 'full_refund' && validOriginal && state.entitlementState === 'active'
    && state.activationPaymentId === paymentId && state.lastSuccessfulPaymentId === paymentId
    && typeof previous?.planCode === 'string' && previous.planCode.length > 0
    && !otherEffects
    && String(clinic.billingEntitlementRevision) === state.entitlementRevision
    && object(object(object(clinic.settings).portal).policy).planCode === PLAN_MAP[contract.planCode];
  const reason = kind === 'chargeback' ? 'payment_chargeback' : 'payment_refunded';
  const inserted = await client.query(`INSERT INTO saas_billing_reversals
    (provider,"canonicalPaymentId",kind,"subscriptionId","originalEffectId","sourceEventId",
    "sourceReconciliationRunId",amount,"refundedAmount",currency,decision,reason)
    VALUES ('mercado_pago',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT DO NOTHING RETURNING id`, [paymentId, kind, subscription.id, original?.id || null,
    source.eventId || null, source.runId || null, contract.amount, payment.transaction_amount_refunded ?? null,
    contract.currency, canReverse ? 'reversed' : 'manual_review', reason]);
  if (!inserted.rowCount) {
    const existing = (await client.query(`SELECT "subscriptionId" FROM saas_billing_reversals
      WHERE provider='mercado_pago' AND "canonicalPaymentId"=$1 AND kind=$2`, [paymentId, kind])).rows[0];
    return existing?.subscriptionId === subscription.id ? noAction('reversal_already_recorded')
      : review(prepared, subscription, 'provider_relationship_unproven');
  }
  const nextState = { ...state, lastReversalReason: reason, reviewReason: canReverse ? null : 'reversal_requires_review' };
  if (!state.lastSuccessfulPaymentId || state.lastSuccessfulPaymentId === paymentId) {
    nextState.billingState = state.cancellationAt ? 'subscription_cancelled' : reason;
  }
  if (canReverse) {
    nextState.entitlementState = 'reversed'; nextState.billingState = 'payment_refunded';
    nextState.entitlementRevision = String(BigInt(clinic.billingEntitlementRevision) + 1n);
    nextState.reversedAt = (await client.query('SELECT clock_timestamp()::text AS now')).rows[0].now;
    const next = await updateSaasSubscriptionById(subscription.id, { localStatus: 'payment_failed', lastPaymentStatus: 'refunded' }, client);
    nextState.entitlementRevision = await syncBillingSnapshot(client, clinic, next, nextState, previous);
    await saveLifecycle(client, subscription.id, nextState);
    return { ok: true, outcome: 'PROCESSED_SUCCESSFULLY', subscription: next };
  }
  await saveLifecycle(client, subscription.id, nextState);
  return retainLifecycle(review(prepared, subscription, reason));
}

module.exports = { readLifecycle, observePreapproval, applyPaymentLifecycle, hasPersistedLifecycle };
