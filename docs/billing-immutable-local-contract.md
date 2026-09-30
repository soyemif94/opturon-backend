# BILL-006A: immutable local billing expectation

Base: `411fd57c38121032e3a1b00ede107b22351df5f1`. Backend only, no migration.
This block establishes local evidence. It does not enforce provider financial
validation, change event routing, or add webhook rejection/review outcomes.

## Version 1

Every newly inserted subscription reservation contains both the existing
`metadata.plan` and this `metadata.contract` object:

```json
{
  "version": 1,
  "source": "backend_plan_catalog",
  "planCode": "inicial",
  "amount": "40600.00",
  "currency": "ARS",
  "frequency": 1,
  "frequencyType": "months",
  "billingInterval": "monthly",
  "capturedAt": "2026-09-29T00:00:00.000Z",
  "subscriptionId": "00000000-0000-4000-8000-000000000001",
  "clinicId": "00000000-0000-4000-8000-000000000002",
  "externalTenantId": "example-tenant",
  "externalReference": "opturon:example-tenant:00000000-0000-4000-8000-000000000001",
  "profile": "ordinary_recurring"
}
```

The example identity/timestamp are illustrative, never defaults. Amount, currency
and plan come from the validated backend catalogue selection. IDs/reference come
from the generated subscription ID and the clinic resolved under the existing
tenant lock. Frontend amount/currency/metadata/reference overrides are not used.

`captureLocalBillingContract` runs inside transaction A of
`createSaasSubscriptionForTenant`, after checking existing blocking subscriptions
and before `insertSaasSubscription`. Reservation and contract commit together,
before the durable provider claim and before any create request. Invalid local
expectations throw before INSERT/provider access. BILL-003/004 retry and recovery
semantics are unchanged. Existing reservations are not backfilled or assigned a
new expectation on retry.

## Exact representation

`canonicalizeContractAmount` accepts decimal strings and finite JS numbers whose
decimal spelling has at most two fractional digits. It produces a positive
fixed-scale string compatible with NUMERIC(12,2): `0.01` through
`9999999999.99`. Integer/fraction splitting and BigInt zero detection avoid
floating multiplication, rounding, tolerance comparisons and binary equality.
Leading zeros and surrounding whitespace normalize harmlessly. Signs, scientific
strings, separators, malformed input, nonpositive values and excess precision
(including a third trailing zero) are rejected. JS numbers have already been
parsed by their caller; the helper cannot recover discarded source precision.
New catalogue prices currently use exact integers. Decimal strings are the
preferred representation for any future fractional catalogue price.

Currency must be explicit, trimmed, uppercased and recognized by the Node runtime's
`Intl.supportedValuesOf('currency')` list. Missing/invalid currency returns no
expectation; it never defaults to ARS. The provider-facing compatibility request
continues using the existing numeric amount/currency fields.

## Application-level immutability

`updateSaasSubscriptionById` strips the top-level `contract` key in its atomic SQL
metadata merge. Replacement, null deletion and attempted backfill are ignored;
other object keys keep their previous shallow-merge behavior. Non-object patches
are ignored to prevent JSONB array/scalar concatenation from destroying the
metadata object. There is no read/modify/write race: the existing row value is
preserved inside the UPDATE, including concurrent or stale patches.

Capture is INSERT-only. There is no contract-change API or generic update escape
hatch. This protects all runtime metadata updates found in the repository/service
audit. It is not a SQL trigger and does not protect against manual DB writes or
old application binaries. Raw provider snapshots remain at
`metadata.mercadoPagoPreapproval`, `metadata.mercadoPagoPayment` and the existing
webhook snapshot keys. A nested provider `metadata.contract` is observed data,
never the root local contract.

## Mutable compatibility columns: deliberately preserved

`amount/currency` remain provider-mutable during 6A. The source audit found:

| Reader/writer | Existing behavior retained |
| --- | --- |
| Repository INSERT | Backend expected values at reservation |
| Repository row mapper / list / detail | Numeric amount and currency exposed to callers |
| Creation provider-result persistence | Maps provider amount/currency into columns |
| Cancel/pause/reactivate and refresh | Same preapproval patch updates columns |
| Payment and preapproval webhook branches | Same provider mapping and lifecycle |
| Tenant billing snapshot | Copies the columns into clinic portal settings |
| Admin list/detail/create/action responses | Returns the repository subscription |
| Authorization email | Formats these columns as the monthly amount |
| Create request after durable claim | Sends these compatibility values as before |

The only other runtime SQL reader of `saas_subscriptions`, the partners repository,
reads status/plan/metadata but not amount/currency. Runtime INSERT and metadata
UPDATE are centralized in the billing repository; claim/reconciliation SQL only
changes provisioning fields. Preserving these consumers avoids a billing/UI/email
semantic change in 6A. Later provider validation must use the resolver's expectation,
not these columns. BILL-007 policy assignment and BILL-008 catalogue values/names
are unchanged.

## Pure resolver

`resolveLocalBillingContract(subscription)` has no DB, catalogue or provider access.
It returns `{ status, source, reasons, contract }`. Non-KNOWN results have a null
contract. Known results contain a new frozen canonical object, never an alias of
the caller's metadata. The resolver is exported for later phases and is not wired
into webhook decisions in 6A.

Priority and rules:

1. If an own `metadata.contract` key exists, it is the only candidate. Unsupported
   version/source, incomplete or invalid expected fields/capture timestamp/profile
   produce UNKNOWN; there is no fallback to a weaker legacy snapshot. Version 1
   must match local plan and subscription/clinic/tenant/reference identity. Identity
   or plan contradictions produce CONFLICT. Supported interval/profile is monthly,
   1 month, ordinary recurring. Mutable row amount/currency and `metadata.plan` do
   not override an otherwise valid native contract.
2. Otherwise, legacy KNOWN requires a complete `metadata.plan` with a supported
   code matching the row, nonempty label, valid positive decimal amount, explicit
   recognized currency, local monthly interval, `billingModel=pending_link`, valid
   local subscription/clinic UUIDs and exact backend-generated reference
   `opturon:<externalTenantId>:<subscriptionId>`.
3. Those structural provenance checks identify the audited snapshot-producing
   generation (`57e6dec` onward). The initial generation (`82d4f23`) accepted input
   prices and did not store this plan snapshot. No historical deployment timestamp,
   present catalogue price or remote preapproval is invented as evidence.
4. Missing snapshot/identity/currency, malformed amount, unsupported interval or
   unproven legacy generation => UNKNOWN. Different plan codes or contradictory
   local identity/reference => CONFLICT. Representation-only trim/case/decimal
   differences normalize where appropriate. A differing mutable row amount or
   currency is not contractual contradiction: the audited code permits that drift.
5. The legacy projection uses `source=legacy_metadata_plan`, `version=0` and
   `capturedAt=null`. This is an in-memory description of evidence, not a stored
   version-1 contract or fabricated capture time. It is never backfilled.

UNKNOWN and CONFLICT do not alter billing or lifecycle. No automatic legacy repair,
new event state, provider comparison, invoice routing, price upgrade or downgrade
is included.

## Validation

Run with existing dependencies and an explicitly local test PostgreSQL instance:

```powershell
$env:BILLING_TEST_DATABASE_URL='postgresql://billing_test@127.0.0.1:55439/postgres'
node --test scripts/tests/saas-billing-contract.test.js scripts/tests/saas-billing-contract-postgres.test.js scripts/tests/mercado-pago-diagnostics-readonly.test.js scripts/tests/mercado-pago-webhook-signature-enforcement.test.js scripts/tests/saas-billing-durable-provisioning.test.js scripts/tests/saas-billing-webhook-retry.test.js
```

The new SQL suite requires loopback, the billing_test role and no password, creates
only a random disposable schema and removes it on completion. Provider methods are
mocked and external fetch is forbidden. Independent connections observe the committed
expectation before the mock provider request and exercise concurrent creation and
metadata updates. Cases A-T cover the requested creation, resolver and immutability
matrix. Additional pure tests cover exact decimal bounds, currency, provenance,
identity and invalid-native fallback protection.

Validation: 92/92 PASS (64 existing regression tests plus 28 new, including the
SQL parent test); node --check for affected CommonJS files; git diff --check.
No TypeScript build/typecheck applies to these CommonJS files. No real Mercado Pago
requests, production DB operations, migration, deployment or merge.
