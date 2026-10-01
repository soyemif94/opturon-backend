# BILL-006D: durable contract outcomes

Base and production SHA verified before implementation:
`8928f5ad79d85c4cb162914f5079e302b42b3344`.

## Existing event model

`saas_subscription_events` (migration 050) already provides:

| Purpose | Existing field |
| --- | --- |
| Processing state | `processingStatus TEXT`, without an enum/check constraint |
| Existing states | `received`, `processing`, `processed`, `ignored`, `failed` |
| Reason | `processingError TEXT` |
| Delivery identity | `dedupeKey TEXT`, unique index |
| Original notification | `raw JSONB` |
| Subscription | `subscriptionId UUID`, nullable foreign key |
| Provider resource / topic | `resourceId TEXT`, `topic TEXT` |
| Timestamps | `createdAt`, `updatedAt` |

Migration `086_saas_subscription_event_contract_outcome.sql` adds the dedicated
nullable `contractOutcome JSONB` column. No subscription metadata, tenant policy
or provider raw fields are used to store internal outcomes.

```sql
ALTER TABLE saas_subscription_events
  ADD COLUMN IF NOT EXISTS "contractOutcome" JSONB NULL;
```

This is an additive column with no default, backfill, row rewrite, enum change
or index build. PostgreSQL acquires `ACCESS EXCLUSIVE` on the table until the
migration transaction ends; lock acquisition can wait for existing transactions
and blocks concurrent access while held. A local test observes that lock, checks
the relation's physical file is unchanged and verifies existing rows retain their
raw/status data with a NULL outcome. The migration is idempotent. Apply it before
deploying this corrected runtime; application queries explicitly select the new
column. No production migration is executed by this task.

## Internal API and meaning

`saas-billing-webhook-outcomes.js` exports two pure result constructors:

```js
return contractRejected({
  eventId, // optional; checked against the locked event when supplied
  subscriptionId, // optional, when resolved
  reasonCode: 'contract_amount_mismatch',
  details: {
    expectedField: 'amount', observedField: 'transaction_amount',
    observedValue: '123.45', contractVersion: 1, contractSource: 'contract'
  },
  resource: { type: 'preapproval', id: 'resolved-provider-id' } // optional
});

return manualReview({ reasonCode: 'legacy_contract_unknown' });
```

The internal event executor returns the decision before business application.
`processSubscriptionWebhookEvent` owns persistence and acknowledgement; callers
must not acknowledge a constructor result without running that transaction.
Neither constructor is an HTTP input or a provider response classifier.

`contract_rejected` means a future caller has established a trustworthy local
contract, resolved the relevant provider identity and proved a deterministic
mismatch. `manual_review` means future callers cannot safely automate a decision
because evidence is unknown, conflicting, unsupported or insufficient.
This block does not make those decisions or perform financial comparisons.
The current provider application path returns neither new outcome automatically.

Rejection reasons:
`contract_amount_mismatch`, `contract_currency_mismatch`,
`contract_interval_mismatch`, `provider_identity_mismatch`,
`external_reference_mismatch`.

Review reasons:
`legacy_contract_unknown`, `local_contract_conflict`, `unsupported_charge_type`,
`provider_relationship_unproven`.

Extending these lists is an explicit code change. An arbitrary exception string
or a reason from the other outcome category is invalid and remains retryable.

## Safe detail schema

Unknown keys, nested provider dumps, headers, payer fields and free text are
rejected. `details` supports only:

- `expectedField`, `observedField`: enums for amount/currency/frequency/interval,
  external reference and provider identity field names; see `FIELDS` in the helper.
- `observedValue`: decimal string for amount; three uppercase letters for currency;
  nonnegative safe integer for frequency; days/months/monthly for interval fields.
  Identity and reference values cannot be stored under this generic key.
- `contractVersion`: positive safe integer.
- `contractSource`: `contract`, `legacy_metadata_plan`, `backend_plan_catalog`.

Optional `resource` contains only a type (`preapproval`, `payment`,
`authorized_payment`, `invoice`) and an identifier of 1–128 alphanumeric,
underscore or hyphen characters. Those type names do not add or change routing.
No full provider payload is copied into result details.

## Durability, acknowledgement and concurrency

The existing BILL-005 unique delivery identity and PostgreSQL row lock serialize
all attempts. A duplicate terminal event returns its original durable result
without provider access, business execution, timestamp updates or a new event.

Allowed ordinary lifecycle:

`received|failed -> processing -> processed|ignored|failed`.

Semantic decisions are persisted as `processingStatus = ignored`, with
`contractOutcome.type = contract_rejected | manual_review`. The new semantic
types are never written into `processingStatus`. Ordinary ignored events with
`contractOutcome IS NULL` retain the existing BILL-005 behavior. An ignored event
is interpreted as a contract outcome only if the dedicated column has an
allowlisted type. The provider raw payload is never consulted for that decision.

A recovered `processing` row retains BILL-005 retry behavior. `processed` and
`ignored` remain authoritative; they cannot be downgraded by ordinary redelivery.
The two new terminal outcomes cannot reenter processing through that path.
Explicit operator reconciliation is not implemented.

On an internal semantic result, the executor rolls back its business savepoint
before persisting the result. This also discards speculative subscription/tenant
SQL if a future caller inadvertently issued it before returning the decision.
The resulting transaction commits only the event state and safe result metadata.
The write requires the locked event still to be `processing` and its dedicated
outcome column to be NULL. A missing write fails retryably.

One SQL statement sets `processingStatus = ignored`, `processingError = reasonCode`,
resolved `subscriptionId`, `updatedAt`, and `contractOutcome`:

```text
version, type, eventId, subscriptionId, reasonCode, details, resource, recordedAt
```

`recordedAt` and `updatedAt` share PostgreSQL's transaction timestamp. Event and
subscription identifiers and timestamp are filled by persistence, not accepted
as arbitrary result metadata. Provider topic/resourceId stay in their existing
event columns and are not duplicated into the bounded outcome object. The SQL
never updates `raw`, including keys named `_opturonBillingOutcome`,
`_opturonInternal`, `contractOutcome` or arbitrary nested keys. Tests assert deep
equality and unchanged `raw::text` before/after persistence. JSONB retains the
original semantic value; it does not promise the HTTP body's whitespace/key order.

After successful COMMIT: HTTP **200**, with `outcome: CONTRACT_REJECTED` or
`outcome: MANUAL_REVIEW`; neither is reported as processed. Duplicates include
`duplicate: true`, `ignored: true` and the same outcome. Logs distinguish both outcomes as well.
Reason/details remain in the event for operator inspection, not in the HTTP body.

SQL/write failure: savepoint rollback, durable `failed`, HTTP **503**. If writing
`failed` or COMMIT itself fails, the full attempt rolls back and the earlier
nonterminal row can retry. Lost COMMIT acknowledgement may return 503 while the
terminal state was actually committed; redelivery then deduplicates to 200.
Existing provider/network/DB failures retain BILL-005 semantics.

## Rollback compatibility

The exact previous production commit
`8928f5ad79d85c4cb162914f5079e302b42b3344` already treats `ignored` as terminal.
The tests load its controller, service and repository directly from Git in
memory, then send signed local HTTP deliveries against rows created by corrected
6D on real PostgreSQL. Both outcomes are acknowledged as ignored duplicates with
zero provider calls, zero business mutations and the original event unchanged.
The old code also inserts and processes an ordinary event with the additive
column present, leaving `contractOutcome` NULL. Its explicit column lists remain
structurally compatible.

A runtime rollback leaves migration 086 in place; dropping the column is neither
needed nor part of rollback. The previous runtime does not expose the richer
semantic outcome in its HTTP response, but it does preserve it in the database
and never reprocesses the ignored row.

The superseded candidate `d281fe68...` was not deployed and requires no production
backfill of its incompatible status values or raw namespace. This correction is
left uncommitted on that candidate for audit.

## Validation and scope

`scripts/tests/saas-billing-contract-outcomes.test.js` uses a disposable schema on
loopback PostgreSQL with independent connections, real signed local HTTP and
mocked provider reads. Test-only decisions enter the same internal event runner
used by production. Runtime HTTP callers cannot inject those decisions.

The A–W matrix covers both outcomes, SQL/COMMIT failure, retry, duplicates,
concurrency, processed transition protection, auth rejection, durable recovery
and exact preservation of BILL-006A contracts. Extra checks cover lost commit
acknowledgement, speculative SQL rollback, unresolved legacy identity, failed
marker failure, forged raw metadata, invalid detail shapes and event-ID mismatch.
P/Q cover collisions and full raw preservation for both outcomes; R covers legacy
ignored; S/T execute the exact old runtime; U checks migration/schema and rollback
compatibility; V/W enforce reason/detail allowlists.
Database triggers count committed subscription and tenant writes.

Regression suites: diagnostics read-only (BILL-001), signature enforcement
(BILL-002), durable provisioning (BILL-003/004), webhook retry (BILL-005), immutable
contract unit and PostgreSQL suites (BILL-006A). The existing 101-test baseline is
run with assertions unchanged together with the corrected outcome suite. The
three existing PostgreSQL suites only add migration 086 to their fixture setup.

The corrected tests are rerun against isolated local PostgreSQL; prior results
from the superseded candidate are not used as validation. Production is read only
at `/__build`; all SQL for validation uses disposable local schemas.

Corrected regression result: **136 PASS / 0 FAIL / 0 SKIP** (101 existing plus
35 corrected outcome tests, including their suite container). Syntax checks pass
for the seven changed JS files and the existing controller; `git diff --check`
passes. The three baseline PostgreSQL fixture changes only load migration 086.

No commit, push, deployment, real provider call, production DB write/migration,
financial validation, authorized-payment routing change, BILL-007 or BILL-008 change.
