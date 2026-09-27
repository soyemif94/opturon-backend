# Durable SaaS subscription creation

The create endpoint now commits a local `saas_subscriptions` reservation before
calling Mercado Pago. There is no separate attempt table and no dependency on
provider idempotency headers or search consistency.

## Storage and concurrency

`findClinicByExternalTenantId(..., { forUpdate: true })` locks the existing clinic
row during the reservation transaction. All runtime inserts into
`saas_subscriptions` go through `createSaasSubscriptionForTenant`. Inside that lock,
the service checks all non-terminal subscriptions, not just the newest row.
Historical duplicates cause HTTP 409 and are preserved.

The reservation contains its UUID, external reference, validated clinic identity,
payer and backend plan/amount/currency snapshot. A second, committed conditional
UPDATE claims `reserved` as `provider_call_started`. Only the request that receives
and commits this claim may send the provider POST. Network work holds no DB lock.
Independent processes use the same PostgreSQL locks and conditional update.

| Provisioning state | Meaning | Create retry |
| --- | --- | --- |
| NULL | Legacy row; creation outcome not inferred | Reuse a pending checkout with provider ID or HTTP 409; never POST |
| reserved | Local record committed; no call claimed | Claim and resume the same row |
| provider_call_started | Call claimed; may be running or outcome unknown | HTTP 409; never POST again |
| reconciliation_required | Provider call failed or returned an unusable result; outcome may be remote success | HTTP 409; never POST again |
| provider_created | Provider ID/response committed; tenant snapshot unfinished | Finish locally; never POST again |
| ready | Provider response and tenant billing snapshot committed | Reuse pending checkout, otherwise HTTP 409 |

`providerCallStartedAt` records when the claim became durable. Age never makes an
ambiguous attempt safe to retry. There is no automatic reset, expiry or second POST.
Even if persisting `reconciliation_required` fails, `provider_call_started` remains
durable and blocks a retry.

Billing status remains separate: `pending`, `active`, `paused`, `payment_failed`
and `suspended` block another creation. `canceled` permits a future subscription
once provisioning is complete (or for a legacy terminal row). A different plan or
payer conflicts while a non-terminal subscription exists; it is not an upgrade.
No client idempotency key is needed for this tenant-level create invariant.

## Provider response and recovery

The provider response is committed as `provider_created` before updating the tenant
snapshot. A failure in snapshot synchronization can therefore resume locally.
If provider identity persistence fails, the already committed external reference
still correlates the provider object to its local subscription.

The existing verified preapproval webhook first looks up the provider ID, then
the provider's external reference. It now marks managed reservations `ready` in
the same transaction as the provider/status and tenant snapshot updates. Payment
notifications can also recover using their preapproval ID. The signature gate is
unchanged and runs before provider access or DB writes. A webhook that completes
before the original create response is persisted is not overwritten by that stale
create response.

Ambiguous attempts with no subsequent valid webhook require an explicit operational
reconciliation procedure. This change does not implement a reconciliation worker,
provider search, forced reset or manual cancellation of unknown attempts. Do not
delete the reservation or set it back to `reserved` to bypass HTTP 409. The existing
list/detail endpoints expose provisioning state and the claim timestamp for review.

## Future release requirements (not executed by this task)

Apply only `085_saas_subscription_provisioning.sql` before the new runtime serves
billing requests. The existing migration runner supports:

```sh
node src/db/migrate.js --only 085_saas_subscription_provisioning.sql
```

The migration adds two nullable columns and a state check. It does not backfill,
delete, merge, reset provider IDs, or add a partial unique index. Historical
duplicates and legacy NULL provider IDs do not prevent it from applying. The
existing clinic/tenant indexes support lookup. No duplicate-data preflight is
required for this additive migration; verify the exact migration is applied before
enabling the updated create endpoint.

Drain old runtime instances before accepting new subscription creates: older code
does not participate in reservation locking. The guarantee applies to the updated
create flow, not manual SQL writers or an older binary running concurrently.

No production DB credentials or duplicate counts were queried in this task.
BILL-005 (webhook failure acknowledgement), BILL-006 (amount/currency contracts),
BILL-007 (pending plan assignment), and BILL-008 (plan catalogue drift) remain open.

## Tests

```sh
node --test scripts/tests/saas-billing-durable-provisioning.test.js
node --test scripts/tests/mercado-pago-diagnostics-readonly.test.js scripts/tests/mercado-pago-webhook-signature-enforcement.test.js
```

The provisioning suite uses real repository SQL and migrations, HTTP controllers,
signature verification, and mocked provider calls. Default storage is PGlite.
For native PostgreSQL concurrency testing, point `BILLING_TEST_DATABASE_URL` at a
disposable PostgreSQL instance on `127.0.0.1`, owned by the test-only `billing_test`
role with no password. The suite creates and drops only its generated test schema.
It rejects other hosts/users and does not read `DATABASE_URL`. Six concurrent HTTP
requests assert one reservation, one provider POST and one live subscription.
