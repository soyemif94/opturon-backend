# BILL-006B: Mercado Pago webhook resource routing

Production `/__build` matched the exact implementation base
`ffa90f8352abe2df515f228bdbe34e59959e732c` before work began.
Branch: `fix/billing-authorized-payment-routing`.

## Provider authority

Mercado Pago's [webhook topic and resource table](https://www.mercadopago.com.ar/developers/en/docs/subscriptions/additional-content/your-integrations/notifications/webhooks)
distinguishes `payment` from `subscription_authorized_payment`.
Its [Get invoice data reference](https://www.mercadopago.com.ar/developers/en/reference/online-payments/subscriptions/get-authorized-payment/get)
specifies `GET /authorized_payments/{id}` and includes separate invoice,
preapproval and nested Payment identities. Invoice `status`/`summarized` are
not interpreted as Payment approval in this change.

## Audited mapping at the base

| Topic / condition (in evaluation order) | Existing behavior | BILL-006B |
| --- | --- | --- |
| `subscription_authorized_payment` | `/v1/payments/{resourceId}` then Payment business logic | `/authorized_payments/{resourceId}` then invoice gate |
| `authorized_payment` | Same incorrect Payment path | Same invoice gate, compatibility alias only |
| `payment` | `/v1/payments/{resourceId}`, then optionally `/preapproval/{linkedId}` | Preserved |
| `subscription_preapproval`, `preapproval`, `subscription` | `/preapproval/{resourceId}` | Preserved |
| Any remaining topic with `action.includes('preapproval')` | `/preapproval/{resourceId}` | Preserved; not an official topic declaration |
| `subscription_preapproval_plan` | No explicit branch: ignored unless the action matches the previous condition | Unchanged, out of scope |
| Other topics | Durable ignored event, no fetch | Preserved |

Controller signature verification remains before all processing. Resource extraction
continues to accept `data.id`, a resource URL's final component, `resource_id`,
and flattened `data.id`; normalization and dedupe identity are unchanged.

The codebase's provider reads are defined in `mercado-pago.service.js`:
`getPayment` and `getPreapproval`, with the new `getAuthorizedPayment`. Existing
explicit refresh and preapproval webhook/recovery calls still use `getPreapproval`.
There are no `/preapproval/search` or `/authorized_payments/search` callers.

### Alias provenance and remaining audit limits

The original integration (`82d4f23`) grouped the official invoice topic with
Payment. Commit `e31b863168d9cd59b1d5a5eac82951dea1e50d5d` subsequently added
`authorized_payment` as another condition in that group. No internal producer
for that alias was found in the audited billing source/tests, and the official
topic table does not establish it as a provider topic. The HTTP handler can
receive it, so it cannot be declared unreachable.

Actual production use is **not established** by this source audit. No production
event records were read for this implementation. Runtime necessity therefore
remains unknown; the alias is retained conservatively and routed to invoices.
It is not silently advertised as official Mercado Pago behavior.

## Explicit resource model

`fetchMercadoPagoChargeResource(kind, resourceId)` returns an internal object:

```js
{ kind: 'authorized_payment' /* or 'payment' */, id,
  invoiceId, paymentId, preapprovalId, data }
```

For invoices, `id` and `invoiceId` are the invoice identity; `paymentId` is
optional and comes only from `invoice.payment.id`; `preapprovalId` comes only
from `invoice.preapproval_id` and remains a candidate, not proof of a relationship.
The original response is retained in `data` without coercing amount, currency,
status, summarized, nested payment status or external_reference. Required invoice
identity/status shapes are checked, but no expected financial values or provider
identities are compared. Missing/invalid required fields remain retryable.

For Payments, `invoiceId` is NULL and the existing preapproval-candidate resolver
is unchanged. Only the Payment branch passes `resource.data` into Payment
mapping and subscription application.

`getAuthorizedPayment` reuses `mercadoPagoFetch`: existing credentials/headers,
stage-scope selection, encoding and error taxonomy. Webhook GETs share the
existing eight-second processing deadline. No nested Payment read or invoice
search is needed merely to identify the notified resource, so neither is added.

## Deliberate invoice gate and acknowledgement limit

A well-formed fetched invoice produces an internal ignored result with reason
`authorized_payment_semantics_deferred` and the normalized resource. It never
reaches subscription/tenant lookup or writes, nor preapproval recovery. Only
the existing event registration and `processingStatus = ignored` completion
commit. `contractOutcome` remains NULL; automatic contract rejection and manual
review calls both remain zero.

The unchanged controller returns HTTP 200 with `ignored: true`; it does not
serialize the internal resource/reason. The existing ignored-event log classification
is used. Provider data is not added to HTTP, logs, event raw or subscription metadata.
Only original notification topic/resource/raw are durable; the fetched invoice and
its normalized relation are transient, not a new durable provider snapshot.

**This acknowledges and deduplicates the invoice notification without applying
billing. Redelivery will not replay it after BILL-006C.** Future financial handling
must explicitly consider reconciliation of these ignored notifications. No replay,
reconciliation worker or subscription outcome is introduced in BILL-006B. This is
intentional gating, not a claim of completed charge validation or billing success.

Provider/network failures, 404, incomplete invoice response and timeout retain
BILL-005 `failed` / HTTP 503 behavior. The provider wrapper labels 404 as
`mercadopago_invalid_payload`, but the webhook runner conservatively retries all
provider failures; no new permanent financial classification is made.
Duplicates and concurrent deliveries use the existing PostgreSQL event lock.
The event executor, repository, outcome storage, controller and schema are unchanged.

## Existing correlation risks, unchanged

The generic Payment resolver takes the first nonempty
`metadata.preapproval_id`, `subscription_id`, or `preapproval_id`, then falls back
to `external_reference` / `metadata.external_reference` for a local lookup.
These are existing candidate heuristics, not new relationship proofs. An unmapped
Payment remains retryable without billing mutation. This block neither expands
those heuristics nor guarantees that a coincidentally matching weak field proves
subscription ownership. Strong relationship/financial validation belongs to the
later contract-validation work.

Similarly, the broad preapproval action fallback can route a plan notification
as a preapproval if its action contains that word. It is a preexisting routing
finding outside this invoice/Payment fix; no plan lookup or plan mutation path
is added here. BILL-007 ordering and BILL-008 behavior are unchanged.

## Validation

`scripts/tests/saas-billing-resource-routing.test.js` adds 30 scenarios
(31 runner results including the suite container). It exercises the real provider
service with fetch intercepted in memory, signed local HTTP, disposable PostgreSQL
schemas, and triggers counting committed subscription/tenant writes.

| Required cases | Evidence |
| --- | --- |
| A/B/P | Distinct numeric IDs hit only their respective endpoint; Payment behavior retained |
| C/D | Full original invoice fields and invoice/Payment/preapproval identities preserved |
| E/F | Each provider resource failure is 503/failed, then identical delivery can retry |
| G/H | Processed invoices with pending/rejected/in-process/approved nested Payments and summarized variants never mutate billing |
| I | Malformed objects fail safely; optional payment/reference absence remains supported |
| J | Duplicate and concurrent invoice deliveries deduplicate durably with one fetch |
| K | Invalid signature is 401 before event insertion/provider access |
| L | Existing 6D terminal outcomes bypass fetch and remain intact |
| M | Invoice and generic Payment paths preserve metadata.contract |
| N | Preapproval recovery of a provider_call_started reservation remains functional |
| O | Unrelated Payment causes no accidental subscription or tenant mutation |
| Q | Error, network failure and success expose no mocked secrets/provider body in response, logs or event |

Both resource 404 paths, optional nested identity, alias routing and encoded
invoice identifiers are additionally covered. No existing test assertions were
weakened or changed.

Full billing regression command (existing dependencies, no installation):

```powershell
$env:NODE_PATH='D:\de 0 a 10k\node_modules'
$env:BILLING_TEST_DATABASE_URL='postgresql://billing_test@127.0.0.1:55439/postgres'
node --test scripts/tests/mercado-pago-diagnostics-readonly.test.js scripts/tests/mercado-pago-webhook-signature-enforcement.test.js scripts/tests/saas-billing-durable-provisioning.test.js scripts/tests/saas-billing-webhook-retry.test.js scripts/tests/saas-billing-contract.test.js scripts/tests/saas-billing-contract-postgres.test.js scripts/tests/saas-billing-contract-outcomes.test.js scripts/tests/saas-billing-resource-routing.test.js
```

Result: **167 PASS, 0 FAIL, 0 SKIP** (136 existing + 31 new runner results).
BILL-001/002/003/004/005/006A/006D pass on isolated local PostgreSQL, including
6A reservation guards, contract deletion protection, 6D raw preservation and
previous-runtime compatibility. JavaScript syntax and `git diff --check` pass.
No schema change, production DB write, live Mercado Pago request, deployment,
financial validation, BILL-007 or BILL-008 implementation is part of this change.
