# BILL-006C: immutable contract and provider proof before webhook application

## Release boundary

Production verified on 2026-10-01: `ffa90f8352abe2df515f228bdbe34e59959e732c`.
Implementation parent: held BILL-006B `41647d1eee5bd8820ceac04cde086628b833fc18`.
Branch: `fix/billing-provider-contract-validation`.

The eventual release is **production ffa90f -> final 6C commit**, containing
6B routing and 6C validation in one transition. Never deploy 6B alone. This task
does not deploy, replay events, mutate production data or run a migration.
There is no historical 6B production invoice window to reconcile.
Migration 086 and the native 6A contract are sufficient; no schema change.

## Provider resources and evidence

Mercado Pago documents separate [invoice retrieval](https://www.mercadopago.com.ar/developers/en/reference/online-payments/subscriptions/get-authorized-payment/get)
and [invoice search by payment ID](https://www.mercadopago.com.ar/developers/en/reference/online-payments/subscriptions/authorized-payment-search/get).
`searchAuthorizedPaymentsByPaymentId` uses
`GET /authorized_payments/search?payment_id=<encoded paymentId>`.
The response must have a coherent `paging.total` and `results` array. An exact
single match is only a candidate; both search Payment ID and the separately
fetched canonical invoice Payment ID must equal the notified canonical Payment.
Multiple matches never select the first result.

Provider [invoice processing documentation](https://www.mercadopago.com.ar/developers/en/docs/subscriptions/integration-configuration/subscription-no-associated-plan/authorized-payments)
describes retries and final processing after failed attempts. Accordingly,
neither `invoice.status`, `summarized` nor nested `payment.status` proves approval.

| Webhook | Canonical reads | Result |
| --- | --- | --- |
| `subscription_authorized_payment` | invoice, preapproval, nested Payment | Full contract gate |
| Legacy `authorized_payment` alias | Same | Same gate; not declared an official topic |
| `payment` | Payment, authorized invoice search, invoice, preapproval | Same gate; no second Payment fetch needed |
| Preapproval subscription events | preapproval | Contract gate before existing state mapping |
| `subscription_preapproval_plan` | None | Explicit unsupported ignore; cannot fall through via action |

The 6B-only invoice ignore with NULL outcome has been removed. The 6B routing
document describes the historical held commit; this document supersedes its
deferred invoice gate and preserved weak Payment correlation.

## Local authority and exact comparison

The gate calls `resolveLocalBillingContract` on the freshly locked subscription.
Only a KNOWN native `metadata.contract`, version 1, profile `ordinary_recurring`
is accepted. UNKNOWN becomes `manual_review/legacy_contract_unknown`; CONFLICT
becomes `manual_review/local_contract_conflict`. Legacy version-0 `metadata.plan`
can remain KNOWN for read compatibility, but is not INSERT-only immutable
authority and is routed to legacy manual review. Nothing is backfilled or
reconstructed from today's plan catalog or mutable row money.

`exactMinorUnits` uses the 6A decimal parser, then `BigInt` of the canonical
two-decimal string. No multiplication by floating point, rounding, tolerance,
epsilon or default currency. Values with excess precision or missing/invalid
currency are insufficient evidence; exact differences are proven mismatches.
Currency is explicitly normalized with trim/uppercase. Native cadence requires
1/months/monthly; missing remote cadence does not default to monthly.

Strong subscription predicate:

1. Canonical preapproval request ID equals its response ID.
2. The unique local provider ID binding equals that preapproval ID, or the row
   is an unbound, durably started BILL-004 recovery claim (started timestamp and
   `provider_call_started`, `reconciliation_required` or `provider_created`).
3. Native contract subscription UUID, clinic UUID, tenant, plan and external
   reference agree with the locked row. The locked clinic UUID and tenant agree.
4. Canonical preapproval external reference equals native contract reference.
   Only UUID casing is normalized; tenant casing remains significant.
5. Preapproval amount, currency and cadence exactly match the contract.
6. For a charge, canonical invoice ID, preapproval ID and Payment ID match;
   invoice amount/currency match; canonical Payment is approved and has the
   same exact amount/currency. Unsupported charge types require review.

The UUID in a canonical preapproval reference can locate a recovery candidate,
but cannot authorize it alone. Payment metadata, subscription_id, preapproval_id
and external_reference are never financial authority. Existing compatibility
parsing remains available for observations only.

## Outcomes and future updates

The pure validator returns `VALID`, `CONTRACT_REJECTED`, `MANUAL_REVIEW` or
`NO_ACTION`. Provider/DB failures become `RETRYABLE_PROCESSING_FAILURE` in the
event executor. Only VALID reaches the existing SaaS subscription/tenant update.

| Situation | Durable state | HTTP / next delivery |
| --- | --- | --- |
| Valid approved charge | processed, no contract outcome | 200; duplicate performs no work |
| Proven identity/reference/amount/currency/cadence contradiction | ignored + 6D contract_rejected | 200 after commit |
| Unknown/conflicting local contract, ambiguous relationship, unsupported charge | ignored + 6D manual_review | 200 after commit |
| Missing invoice Payment | failed / invoice_payment_pending, NULL outcome | 503; same event may later process |
| Canonical pending/in_process/rejected/cancelled/authorized/in_mediation | failed / payment_not_approved, NULL outcome | 503; same event may later process |
| Search proves zero current invoices | failed / authorized_invoice_not_found, NULL outcome | 503; no SaaS mutation or rejection |
| Fetch timeout/network/5xx/404, malformed transport response, SQL error | failed / webhook_processing_failed | 503; retryable |

Zero search matches are not proof of permanent unrelatedness. This conservative
NO_ACTION policy allows provider indexing to catch up, and can produce extra
retries for genuinely unrelated payments. No polling job or new scheduler was
added. Missing/incomplete semantic fields become review where evidence is
insufficient; an empty/malformed resource response preserves BILL-005 retry.

Refunded/charged_back and unknown canonical Payment states create a visible,
durable `manual_review/unsupported_charge_type`. They do not apply a successful
payment. A positive `transaction_amount_refunded` also requires review even if
status is approved; this field is present in the [canonical Payment reference](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/get-payment/get).
An already active local subscription is not automatically reversed:
that is BILL-007 lifecycle policy, not contract validation. The outcome is the
explicit review signal; no notification/reconciliation worker is introduced.

Dedupe key remains `topic:action:resourceId:notification:<notificationId>` or
`topic:action:resourceId` when no notification ID exists. Different notifications
of the same invoice/Payment are distinct durable events. Do not assume every
provider update has a new notification ID. Keeping ordinary non-approved events
failed lets even the same ID or fallback key later apply approved evidence.
Processed and semantic terminal outcomes retain 005/6D duplicate behavior:
a subsequent update after a terminal event requires a distinct notification
identity. A same-key terminal replay does not re-fetch; no replay endpoint was
added. Future distinct post-approval refund notifications produce manual review.

Only allowlisted reasons and bounded details are persisted. raw remains exactly
the received webhook; no provider payload, payer PII, credentials, arbitrary
text or stack traces are placed in contractOutcome or returned diagnostics.

## Atomicity and locking

Actual order intentionally preserves BILL-005 ownership before provider IO:
event INSERT -> event transaction/row lock -> terminal duplicate check ->
provider GETs -> subscription FOR UPDATE -> resolver and locked clinic identity
check -> full validation -> existing business updates + event processed -> COMMIT.
This retains cross-process dedupe and zero provider calls for terminal duplicates;
moving all GETs ahead of ownership would regress that invariant. All financial
validation still precedes business writes. No business-row lock is held during
provider IO; contract resolution is not trusted from a pre-fetch snapshot.

On mismatch/manual review the business savepoint is rolled back before the 6D
outcome is durably stored. On NO_ACTION it is rolled back before the retryable
marker. Provider deadlines and SQL failures cannot leave a partial business
update. HTTP 200 is emitted only after COMMIT.

Native contract capture remains INSERT-only. Repository metadata merges strip
`contract` atomically in SQL. The row lock spans validation and mutation, so a
concurrent writer waits; tests exercise a real independent PostgreSQL writer.

## Scope and regression evidence

No BILL-007 plan assignment/status-policy/upgrade changes. No BILL-008 pricing
normalization. Explicit administrative provider actions and the existing exported
refresh helper were not changed; code search finds no runtime caller of the
refresh helper (only its declaration/export and local test). 6C guards webhooks;
it does not claim to redesign these separate administrative paths.

The focused 6C suite uses signed loopback HTTP, isolated PostgreSQL schemas,
transactional mutation counters, independent writers and mocked GET-only MP
transport. Cases A-AP and variants cover exact decimals, UNKNOWN/CONFLICT,
preapproval/invoice/Payment mismatches, pending evolution, refunds, weak metadata,
search ambiguity, signature rejection, timeouts, outcome SQL failure, duplicate
and concurrent delivery, immutable raw/contract and recovery. No production DB
URL or real provider credential is used.

The 167-test held-6B baseline is retained. Success/retry fixtures now provide the
native contract, explicit cadence and invoice/Payment evidence required by 6C.
6B tests intentionally replace deferred-ignore assertions with validated charge
assertions while retaining endpoint separation and the same routing safety cases.
6A tests still prove provider observations never overwrite the native contract;
remote drift on webhook now asserts contract rejection. This is the requested
change, not weakening retry or atomicity assertions.

Local invocation (with a loopback-only BILLING_TEST_DATABASE_URL):

```text
node --test scripts/tests/mercado-pago-diagnostics-readonly.test.js scripts/tests/mercado-pago-webhook-signature-enforcement.test.js scripts/tests/saas-billing-durable-provisioning.test.js scripts/tests/saas-billing-webhook-retry.test.js scripts/tests/saas-billing-contract.test.js scripts/tests/saas-billing-contract-postgres.test.js scripts/tests/saas-billing-contract-outcomes.test.js scripts/tests/saas-billing-resource-routing.test.js scripts/tests/saas-billing-provider-contract.test.js
```

Executed result: **245 PASS / 0 FAIL / 0 SKIP**, an increase of 78 over the held
167-test baseline (Node's count includes parent tests). All ten affected JS files
pass `node --check`; `git diff --check` passes. The local cluster and disposable
schemas are isolated from production. No Mercado Pago API request was executed.
