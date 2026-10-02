# Bridge tests on the combined BILL-006B + BILL-006C runtime

## Scope and historical evidence

This is a test-only adaptation on `41c5bb75573dc4cb35a01ac2c2b327995cd2fee9`.
Standalone bridge compatibility was validated at
`be5b8f8a7d7b147a5f8a9a69659f4007091e1aee` (25/25 passing).
That commit preserves the original comparison against `ffa90f...`.
The combined runtime must preserve the rollback protocol and enforce 6BC proof;
it must not reproduce the older runtime's weaker Payment association.

## Mapping recorded before editing the suite

All eight historical fixtures intend successful Opturon subscription processing.
They already contain a native immutable `metadata.contract`. Their missing
provider evidence must be supplied only for those intended success cases.
Separate negative cases deliberately omit or contradict evidence.

The complete Payment chain used below is canonical Payment -> authorized-payment
search -> canonical invoice -> canonical preapproval -> native local contract.
It includes matching identities, amount, currency and monthly cadence. All four
provider reads are explicit mocks, and real external requests remain forbidden.

| Failure | Old expectation | Why obsolete or incomplete | New combined-runtime invariant | Fixture change required | Assertion change required |
| --- | --- | --- | --- | --- | --- |
| 1. F: unmarked failed matches exact ffa90f runtime | Exact old result, two provider reads, one subscription and one tenant update | 6C requires invoice evidence; old search was not mocked | Unmarked failed enters 6C, succeeds only with complete proof, applies once | Complete Payment chain | Replace old-runtime equality with ordered canonical reads, successful persisted state, immutable contract, tenant snapshot and terminal deduplication; explicitly no bridge guard |
| 2. G: unmarked received matches exact ffa90f runtime | Same equality starting from received | Same missing search/invoice/cadence/Payment financial fields | Unmarked received cannot bypass any 6C proof | Complete Payment chain | Same combined assertions, plus negative proof controls for received |
| 3. G: unmarked processing matches exact ffa90f runtime | Same equality starting from processing | Same missing evidence; processing is not permission to skip validation | Unmarked processing must pass 6C before business writes | Complete Payment chain | Same combined assertions, plus negative proof controls for processing |
| 4. I: invalid marker fixture retains ordinary historical processing | Malformed UUID proceeds, HTTP 200, two old provider reads, two business updates | False-positive protection is permanent, but old success fixture is incomplete | Malformed UUID never activates guard; normal 6C determines success/review | Complete Payment chain for success; deliberately incomplete negative control | Preserve no-guard assertion; require canonical chain; missing cadence must yield durable review and zero business writes |
| 5. J: invalid marker fixture retains ordinary historical processing | False v20 prefix proceeds like old runtime | Same distinction as I | False prefix cannot intercept or bypass 6C | Complete chain for success; incomplete negative control | Same strict success and review assertions as I |
| 6. Provider payload cannot create an internal marker | Payload processingError does not become internal state; HTTP 200 and business updates | Anti-injection invariant is permanent; incomplete provider mocks cannot prove success | External marker cannot create internal guard state or bypass contract proof | Complete chain for success; contradictory amount negative control | Keep persisted internal error null on success and no guard; contradiction must reject durably with zero business writes |
| 7. N: unmarked BILL-004 reservation recovery remains available | Claim recovers to ready with preapproval binding | Successful ordinary recurring preapproval omitted cadence | Interpretation A: valid claimed reservation recovers only after canonical contract proof | Add frequency=1, frequency_type=months; retain durable claim timestamp and native contract | Keep ready/binding and exactly one update per business row; add missing-cadence review control preserving claim and business rows |
| 8. O: unmarked BILL-005 transient failure retries to one successful application | 503 -> 200 -> duplicate; exactly one business application | After simulated failure cleared, unmocked invoice search still failed | Genuine provider failure remains retryable; same event can succeed only after complete proof; duplicate does no work | Complete chain, explicit transient failures at Payment and search | Keep event identity, failure semantics, mutation counts and duplicate assertions; verify canonical reads and no guard across retries |

## Permanent assertions

Keep marker recognition, closed reason list, marker preservation, failed/received/
processing marked refusal, zero provider calls, zero business/event updates,
terminal preservation, signature ordering, concurrency, and logger-failure safety.
Malformed-marker and provider-payload anti-injection checks remain permanent;
their success expectations now additionally require 6C evidence.

One file is retained with permanent-protocol and combined-compatibility sections.
Splitting would duplicate the isolated PostgreSQL, signed HTTP and mutation-audit
harness without improving separation of responsibilities.

The permanent parser cases, `assertBlocked`, marked-state/topic cases, terminal
cases, signature-ordering case, concurrency case and logger-failure case were
compared textually with HEAD and are unchanged. The provider-call recorder now
also covers search and invoice reads, so the existing zero-call assertions cover
the additional combined-runtime paths. No permanent assertion was removed.

Negative combined cases cover missing native contract, absent provider evidence,
financial contradiction and unrelated Payment with weak matching metadata. Zero
search matches retain the current candidate's retryable semantics; this adaptation
does not resolve pending/zero-match HTTP policy or other runtime architecture work.

## Validation

Use isolated loopback PostgreSQL as `billing_test`, mock provider, and the existing
ten billing test files: diagnostics, signature, durable provisioning, webhook
retry, local contract (unit/PostgreSQL), outcomes, bridge, resource routing and
provider contract. Require zero failures and zero skips. Also check JS syntax,
`git diff --check`, and verify that no runtime or migration file changed.

### Results on 2026-10-02 (uncommitted adaptation)

| Check | Result |
| --- | --- |
| Adapted bridge + combined compatibility | 43 PASS, 0 FAIL, 0 SKIP |
| BILL-006B unchanged | 31 PASS, 0 FAIL, 0 SKIP |
| BILL-006C unchanged | 78 PASS, 0 FAIL, 0 SKIP |
| Full billing regression, fresh test processes and disposable schemas | 288 PASS, 0 FAIL, 0 SKIP |
| `node --check scripts/tests/saas-billing-rollback-bridge.test.js` | PASS |
| `git diff --check` | PASS |
| Runtime / migration changes | NONE |
| Permanent bridge assertions removed | 0 |
| Success fixtures without route-appropriate complete 6C evidence | 0 |

Counts use the Node test runner totals, including parent tests. The bridge file
retains one shared harness and adds 18 negative/retry checks. No test is skipped.

Full regression command (with `BILLING_TEST_DATABASE_URL` set to the isolated
loopback database and `NODE_PATH` pointing to the existing local dependencies):

```powershell
node --test --test-reporter=tap `
  scripts/tests/mercado-pago-diagnostics-readonly.test.js `
  scripts/tests/mercado-pago-webhook-signature-enforcement.test.js `
  scripts/tests/saas-billing-durable-provisioning.test.js `
  scripts/tests/saas-billing-webhook-retry.test.js `
  scripts/tests/saas-billing-contract.test.js `
  scripts/tests/saas-billing-contract-postgres.test.js `
  scripts/tests/saas-billing-contract-outcomes.test.js `
  scripts/tests/saas-billing-rollback-bridge.test.js `
  scripts/tests/saas-billing-resource-routing.test.js `
  scripts/tests/saas-billing-provider-contract.test.js
```

Production was only queried via `/__build` and remained on `be5b8f8...`.
No real provider request, production DB write/migration, commit, push or deploy
was performed. Passing this test adaptation does not authorize a release or
resolve previously identified runtime architecture blockers.
