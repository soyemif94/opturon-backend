# BILL-005: webhook retry semantics

Base: `309cdadf961a6af5528f79be3d4e7d1357cbbb80`. Backend only; no migration.

## Previous failure

`POST /api/webhooks/mercadopago` validates the signature in
`mercadopago.controller.js`, normalizes the payload, then invokes
`processMercadoPagoWebhook` in `saas-billing.service.js`. Events and subscriptions
are stored by `saas-subscriptions.repository.js`.

Previously, an event was inserted as `received` before provider lookups. Any
`dedupeKey` conflict returned duplicate success, including a previous `failed`
event. The controller's processing catch returned HTTP 200 and the exception
message. Subscription and tenant updates already shared a transaction, but
`processed` was written separately after its commit. A missing clinic was also
silently skipped. Thus both failed attempts and incomplete completion tracking
could be acknowledged as success.

## HTTP and result contract

| Class | HTTP | Meaning |
| --- | --- | --- |
| PROCESSED_SUCCESSFULLY | 200 | Business state and processed marker committed together |
| ALREADY_PROCESSED | 200 | Locked event is durably processed or intentionally ignored |
| REJECTED_AUTH | 401 | Missing, invalid, malformed or unverifiable signature; no processor access |
| IGNORED_UNSUPPORTED_EVENT | 200 | Existing unsupported-topic behavior, with durable ignored marker |
| RETRYABLE_PROCESSING_FAILURE | 503 | Provider, DB, mapping, missing tenant, incomplete response or unexpected processing failure |
| PERMANENT_NON_RETRYABLE_FAILURE | 200, ignored | Existing authenticated invalid-JSON behavior only; unchanged |

The generic retry response is `{ "success": false, "error": "webhook_processing_failed" }`.
No provider body, SQL, stack, token or raw exception is returned or logged by the
webhook failure paths. Provider errors, including 4xx, are conservatively retryable;
this block introduces no permanent billing/provider failure classification.
Logging failures do not change authentication or committed processing outcomes.

[Mercado Pago's webhook documentation](https://www.mercadopago.com.ar/developers/en/docs/zero-dollar-auth/additional-content/your-integrations/notifications/webhooks)
describes HTTP 200/201 as acknowledgement. The handler sends 503 on incomplete
processing so that acknowledgement is not falsely issued.

## Event lifecycle and concurrency

1. Register the event using the existing unique dedupe key and `received` state.
   Registration is durable before provider work; an insert conflict alone is
   never evidence of completion.
2. Lock that event with PostgreSQL `FOR UPDATE`, shared across runtime processes.
   Only `processed` and `ignored` are terminal. `received`, `failed` or a recovered
   `processing` row can be attempted again. No in-memory mutex or lease is used.
3. Change to `processing` within the transaction and establish a savepoint.
4. Fetch provider data, resolve the subscription, lock the subscription then
   the clinic, and update billing and the fresh tenant snapshot.
5. Set `processed` in that same transaction and commit before returning success.
6. On failure, roll back to the savepoint, removing all business and completion
   writes. Set `failed` with a generic error while still owning the event lock,
   then commit and return 503. If even this fails, the full transaction rolls
   back; the prior nonterminal event remains eligible for retry.

Transitions: `received|failed -> processing -> processed|ignored|failed`.
`processing` is normally transaction-local. A disconnected process releases its
database locks and rolls back its incomplete transaction. Retrying a completed
event does not fetch provider objects or repeat business mutation. Concurrent
deliveries serialize at the unique index and/or row lock; after a failed owner,
the next delivery may process the same event successfully.

Database locks inside the processing transaction have a 5-second wait limit.
Each provider GET has an 8-second processing deadline; a late GET response is
discarded without continuing into business mutation. This does not cancel the
underlying read request. Provider work holds the event transaction open, but no
subscription/clinic row lock is acquired until provider reads finish.

## Atomicity and limits

Subscription update, tenant policy/lifecycle/snapshot and event completion are
atomic for each new successful attempt. Failure in the tenant write or in the
completion marker rolls back all business changes. A lost commit acknowledgement
or HTTP response may return 503, but a later delivery sees `processed` and safely
returns 200. No destructive provider operation occurs in the webhook processor.

Old `failed`/`received` records may come from the previous commit-to-marker gap;
the implementation cannot infer whether those historical business updates once
committed. A subsequent delivery reconciles their provider state again. There
is no backfill, automatic replay worker or production data repair in this block.
The existing dedupe identity algorithm, amount/currency mapping and different-event
ordering remain unchanged. BILL-006, BILL-007 and BILL-008 remain open.

## Validation

`scripts/tests/saas-billing-webhook-retry.test.js` requires an explicitly supplied
loopback `BILLING_TEST_DATABASE_URL`, user `billing_test`, no password. It creates
and removes only a random test schema. PostgreSQL independent connections exercise
real unique constraints, row locks, savepoints and commits. Transactional test
triggers count committed subscription and tenant updates rather than merely
counting attempted calls. Provider access is mocked and external fetches blocked.

Run with existing dependencies and a local PostgreSQL test instance:

```powershell
$env:BILLING_TEST_DATABASE_URL='postgresql://billing_test@127.0.0.1:55439/postgres'
node --test scripts/tests/saas-billing-webhook-retry.test.js scripts/tests/saas-billing-durable-provisioning.test.js scripts/tests/mercado-pago-diagnostics-readonly.test.js scripts/tests/mercado-pago-webhook-signature-enforcement.test.js
```

The matrix covers signed success, auth rejection, provider/SQL/commit failures,
same-identity retry, completed duplicate, simultaneous success/failure deliveries,
early failure, intentional ignore, durable subscription recovery, both payment
and preapproval tenant-write rollback, completion-write failure, failure-marker
write failure, lost commit acknowledgement, response/logging failure and late GET
completion. No production DB, live webhook or real Mercado Pago call is used.
