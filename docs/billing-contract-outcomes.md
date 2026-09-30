# BILL-006D: durable contract outcomes

Base and production SHA verified before implementation:
`8928f5ad79d85c4cb162914f5079e302b42b3344`.

## Existing event model

`saas_subscription_events` (migration 050) already provides:

| Purpose | Existing field |
| --- | --- |
| Processing state | `processingStatus TEXT`, without an enum/check constraint |
| Existing states | `received`, `processing`, `processed`, `ignored`, `failed` |
| Reason / result metadata | `processingError TEXT`, `raw JSONB` |
| Delivery identity | `dedupeKey TEXT`, unique index |
| Original notification | `raw JSONB` |
| Subscription | `subscriptionId UUID`, nullable foreign key |
| Provider resource / topic | `resourceId TEXT`, `topic TEXT` |
| Timestamps | `createdAt`, `updatedAt` |

No migration is needed or included. No subscription metadata or tenant policy
fields are used to store event outcomes.

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

`received|failed -> processing -> processed|ignored|failed|contract_rejected|manual_review`.

A recovered `processing` row retains BILL-005 retry behavior. `processed` and
`ignored` remain authoritative; they cannot be downgraded by ordinary redelivery.
The two new terminal outcomes cannot reenter processing through that path.
Explicit operator reconciliation is not implemented.

On an internal semantic result, the executor rolls back its business savepoint
before persisting the result. This also discards speculative subscription/tenant
SQL if a future caller inadvertently issued it before returning the decision.
The resulting transaction commits only the event state and safe result metadata.
The write requires the locked event still to be `processing` with an object raw
payload; missing rows or incompatible raw data fail retryably.

One SQL statement sets `processingStatus`, `processingError = reasonCode`,
resolved `subscriptionId`, `updatedAt`, and `raw._opturonBillingOutcome`:

```text
version, processingStatus, eventId, subscriptionId, reasonCode,
details, resource, resourceId, topic, recordedAt
```

`recordedAt` and `updatedAt` share PostgreSQL's transaction timestamp. Event and
subscription identifiers and timestamp are filled by persistence, not accepted
as arbitrary result metadata. The original notification fields remain present;
the reserved `_opturonBillingOutcome` namespace is overwritten by server output.
Raw data alone never determines processing state or a decision.

After successful COMMIT: HTTP **200**, with `outcome: CONTRACT_REJECTED` or
`outcome: MANUAL_REVIEW`; neither is reported as processed. Duplicates include
`duplicate: true` and the same outcome. Logs distinguish both outcomes as well.
Reason/details remain in the event for operator inspection, not in the HTTP body.

SQL/write failure: savepoint rollback, durable `failed`, HTTP **503**. If writing
`failed` or COMMIT itself fails, the full attempt rolls back and the earlier
nonterminal row can retry. Lost COMMIT acknowledgement may return 503 while the
terminal state was actually committed; redelivery then deduplicates to 200.
Existing provider/network/DB failures retain BILL-005 semantics.

## Validation and scope

`scripts/tests/saas-billing-contract-outcomes.test.js` uses a disposable schema on
loopback PostgreSQL with independent connections, real signed local HTTP and
mocked provider reads. Test-only decisions enter the same internal event runner
used by production. Runtime HTTP callers cannot inject those decisions.

The A–O matrix covers both outcomes, SQL/COMMIT failure, retry, duplicates,
concurrency, processed transition protection, auth rejection, durable recovery
and exact preservation of BILL-006A contracts. Extra checks cover lost commit
acknowledgement, speculative SQL rollback, unresolved legacy identity, failed
marker failure, forged raw metadata, invalid detail shapes and event-ID mismatch.
Database triggers count committed subscription and tenant writes.

Regression suites: diagnostics read-only (BILL-001), signature enforcement
(BILL-002), durable provisioning (BILL-003/004), webhook retry (BILL-005), immutable
contract unit and PostgreSQL suites (BILL-006A). The existing 101-test baseline is
run unchanged together with the new outcome suite.

Result: **128 PASS / 0 FAIL / 0 SKIP** (101 existing + 27 new, including the
PostgreSQL suite container). The focused new suite passed independently as well.
All five affected JavaScript files passed `node --check`; `git diff --check`
passed. Production was read only at `/__build`; all SQL executed for validation
used the local disposable test schemas.

No migration, deployment, real provider call, production DB write, financial
validation, authorized-payment routing change, BILL-007 or BILL-008 change.
