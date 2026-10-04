# BILL-007 — paid entitlement lifecycle (local implementation)

Base: `ec4ea75c2b4b63bd20df97c27431b9ed061cdd4b`.
Branch: `fix/billing-entitlement-lifecycle`.
No production operations, provider mutations, push or deployment were performed.

## Inline audit of the base

- `saas-billing.service.js:syncTenantBillingState` assigned
  `settings.portal.policy.planCode` from the subscription plan regardless of
  payment proof. Its four callers were provisioning completion, admin provider
  action, provider refresh, and the shared webhook/reconciliation executor.
  Thus a pending preapproval prematurely selected the requested paid plan.
- The same helper derived tenant lifecycle status from local provider status:
  authorization could activate and cancellation could immediately suspend.
- Subscription INSERT establishes requested plan, amount and immutable
  `metadata.contract`; repository UPDATE projects provider status, payment and
  scheduling fields. The INSERT-only contract protection remains unchanged.
- `tenant-policy.service.js:updateTenantPolicyByExternalTenantId` is a separate
  non-financial administrative plan path; tenant mode preserves the current plan.
  Partner request plan selection is not a paid SaaS activation path. Neither was
  changed. No public plan prices or plan names changed.
- Existing entitlement is in `clinics.settings.portal.policy.planCode` and
  `portal.lifecycle.status`. Existing billing fields include localStatus,
  mercadoPagoStatus, lastPaymentId/status, currentPeriodStart/End and
  nextBillingDate. There was no durable activation/previous-entitlement record.
- Existing period fields are populated from preapproval auto_recurring
  start_date/end_date and next_payment_date/next_date. This code does not prove
  those scheduling values are a paid coverage boundary. They remain observations;
  `paidThrough` is NULL and is never calculated from webhook timestamps.

## Policy and storage

`saas-billing-lifecycle.js` is the shared policy for webhook and reconciliation.
Its private `syncBillingSnapshot` is the only automatic billing plan writer.

Migration 089 adds:

1. `saas_billing_lifecycles`: per-subscription JSONB lifecycle, with separate
   billingState, entitlementState, activation timestamp/payment, latest successful
   canonical payment timestamp/ID, previous entitlement, cancellation/review
   reason and entitlement revision.
2. `clinics.billingEntitlementRevision` and a trigger. Financial ownership changes
   and changes to portal policy/lifecycle advance the revision. Even an admin
   plan A -> B -> A edit invalidates an old reversal's ownership proof. Other
   policy edits conservatively require review before a subsequent renewal.
3. `saas_billing_reversals`: durable negative evidence, unique by provider,
   canonical Payment ID and negative kind, linked to the original positive
   effect when proven and to a source event or reconciliation run.

The positive ledger, immutable contract, raw event and contractOutcome are not
repurposed. A terminal review decision still uses the existing bounded
contractOutcome protocol; financial evidence lives in the new tables.

| Observation | Entitlement decision |
| --- | --- |
| Subscription creation / pending or authorized preapproval | Preserve current plan and access; awaiting payment. |
| Pending / in_process Payment | Existing BILL-006 no-action/retry policy; no plan changes. |
| First approved Payment | Full canonical proof, historical eligibility and unique positive effect required; assign the immutable contracted plan and record DB activation time plus exact previous plan/status. |
| Duplicate positive effect | No extra activation, plan update or lifecycle update. |
| Later approved renewal | Preserve plan and activatedAt; update latest successful payment and financial ownership revision. Changed ownership requires review. |
| Rejected/cancelled Payment | Record payment_failed only if not older than the latest success; retain previous paid access. |
| Cancelled preapproval | Record cancellation; no future automatic renewal is assumed. Previously paid access stays unchanged, paidThrough remains NULL and cancellation_expiry_unproven explicitly requires admin expiry handling. |
| Partial refund | One durable review observation; no positive reapplication or plan change. |
| Full refund | Reverse only the proven entitlement-changing Payment, with no other positive effect, unchanged tenant revision/current plan and a durably known previous plan. Restore that exact plan/status atomically. Otherwise review. |
| Chargeback | Durable payment_chargeback review; no invented suspension/default plan. |
| Older reversal after later success | Retain later entitlement. This includes another subscription's activation on the same clinic. |

Canonical identifiers/status are normalized consistently with BILL-006 proof.
Conflicting collector or original ledger bindings cannot attach negative evidence
to an unrelated positive effect. A delayed first payment cannot replace a newer
successful payment from another subscription. Financial history is append-only
in the runtime: positive ledger rows are never deleted or updated by reversal.

Legacy subscriptions without a BILL-007 row remain readable. The returned
unactivated/awaiting_payment default means no BILL-007 activation evidence exists;
it does not revoke or rewrite existing tenant settings. A pre-existing positive
effect without a lifecycle record prevents guessing an initial activation.

## Transaction and concurrency boundaries

- Provider reads retain phase B, outside the transaction and within the existing
  aggregate timeout/abort budget. No new remote endpoint or provider write.
- Phase C retains generation 2, claim/CAS, subscription -> clinic locks,
  immutable contract revalidation and the 24-hour historical eligibility gate.
- Positive effect reservation, lifecycle/subscription write, tenant activation
  and successful event/run completion commit or roll back together.
- Only decisions registered in a private WeakSet by the lifecycle policy retain
  negative evidence for terminal review/no-action. A payload flag cannot bypass
  the existing business savepoint rollback.
- Negative observation, reversible entitlement update and terminal completion
  share the transaction. SQL failure or a lost claim commits no partial reversal.
- No paid-through expiry scheduler, checkout/catalog redesign or arbitrary plan
  upgrade/downgrade operation is added. Cancellation/reactivation ambiguity stays
  explicit for administrative review.

## One self-audit and resulting corrections

The post-implementation self-audit checked premature assignment, duplicate
activation/reversal, later renewal/activation protection, atomicity, worker
convergence and the BILL-006 protections. It found and corrected these edges:

- Cancellation observed in a paid invoice must be retained even without a
  separate preapproval webhook.
- Whitespace/case normalization must agree between proof and lifecycle; canonical
  ID variants must not duplicate negative records.
- Contradictory collector/ledger bindings must not become a reversible effect.
- Another subscription's newer activation and additional historical positive
  ledger evidence must prevent an unsafe old activation/reversal.

Each correction has an explicit local PostgreSQL/signed HTTP regression.
One completion-failure test initially missed the target SQL statement; its
injection predicate was corrected and the entire suite rerun successfully.

## Verification

- Entire existing 388-case billing/MP baseline retained, with assertions updated
  only for deliberately changed BILL-007 semantics: authorization stays pending;
  invalid refresh rejects; refunds/chargebacks have explicit review reasons.
- New lifecycle suite: 41 scenarios plus its parent test = 42 Node test results.
  Covers A–T, four activation SQL failure points, stale lease, webhook/worker
  race, admin ABA, missing previous plan, stale payments, cross-subscription
  ownership, canonical normalization and negative completion rollback.
- Final combined result: **430 PASS / 0 FAIL / 0 SKIP**.
- Real loopback PostgreSQL, random isolated schemas and intercepted provider
  responses; signed HTTP tests use a local Express server. No real MP traffic.
- Fixtures upgrade the current 087/088 schema with additive 089. The durable
  provisioning suite also retains pre-existing legacy rows through the upgrade.

Reproduce with NODE_PATH pointing at the existing local dependencies and
BILLING_TEST_DATABASE_URL pointing at the isolated loopback billing_test DB:

```powershell
$billingSuites = Get-ChildItem scripts/tests/saas-billing*.test.js,scripts/tests/mercado-pago*.test.js |
  Select-Object -ExpandProperty FullName
node --test --test-reporter=tap --test-timeout=120000 $billingSuites
```

## Future release prerequisites (not executed)

Apply additive migration 089 before deploying this runtime; it requires the new
tables/revision column. Production schema and code have not been modified. A
release/rollback plan must account for older runtimes lacking BILL-007 policy;
leaving the additive schema present alone does not preserve that policy on an
older runtime. No migration down or deployment is authorized by this local task.
