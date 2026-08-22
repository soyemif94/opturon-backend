# WhatsApp ownership consolidation Phase2 — operator runbook

Phase2 implements the approved WhatsApp-only move. It does not install a credential, call Meta, send a message, delete a row, disable a trigger/constraint, or move commercial ownership.

## Artifacts and safety gates

- Read-only preflight: `scripts/ops/whatsapp-channel-ownership-consolidation-phase2-preflight.js` accepts only `--mode=PREFLIGHT`.
- Write command: `scripts/ops/whatsapp-channel-ownership-consolidation-phase2-apply.js` accepts only explicit `--mode=APPLY` plus `--execution=COMMIT` or `--execution=ROLLBACK_SIMULATION`.
- The APPLY requires the exact phrase `APPLY_WHATSAPP_OWNERSHIP_MIGRATION`, an exact source channel, target clinic and Phone Number ID, an independently supplied SHA-256 manifest checksum, and `WHATSAPP_OWNERSHIP_WORKERS_PAUSED=CONFIRMED`.
- A stale manifest is rejected by identity, credential fingerprint, active-work and exact count reconciliation. After commit, rerun is rejected because the canonical channel is no longer source-owned.

## Production execution sequence (not executed in Phase2 preflight)

1. Load `DATABASE_URL`, `RENDER_API_KEY` and `RENDER_POSTGRES_ID` into environment variables. Never put their values in command-line arguments or logs.
2. Start a fresh Render logical export with `POST /v1/postgres/dpg-d6n741q4d50c73dan0eg-a/export`; wait until it is available and record its timestamp/checksum in the change record.
3. Record UTC `T0` and confirm Render recovery status remains `AVAILABLE`. T0 must be inside the available recovery window and immediately precede the database transaction.
4. Suspend service `srv-d6n7i5vgi27c73c954t0` using `POST /v1/services/srv-d6n7i5vgi27c73c954t0/suspend`. This is the smallest safe unit because `src/server.js` starts the writer worker in the same process as the API. Maintenance mode alone is insufficient because the process and worker remain alive.
5. Verify Render reports the service suspended. The APPLY independently queries the Render service API and fails unless its state is `suspended`; the environment confirmation alone is insufficient. Meta can retry inbound webhooks after resume. Verify all seven active-work counters are zero.
6. Generate a fresh signed preflight manifest:

   ```powershell
   npm run whatsapp-ownership:phase2:preflight
   ```

7. Set `$manifest` to that fresh file and run the exact APPLY command below. Do not use the example historical manifest from this preflight for a later change window.
8. On PASS, resume with `POST /v1/services/srv-d6n7i5vgi27c73c954t0/resume`, wait for live/healthy, then execute read-only Inbox/template/Canary/webhook smoke checks. On failure, the script rolls back before the process exits; resume after confirming the rollback.

## Exact APPLY command

```powershell
$manifest = 'D:\de 0 a 10k\.render\whatsapp-ownership-phase2\PRE_APPLY_MANIFEST.<fresh-T0>.json'
$manifestSha256 = ((Get-Content -LiteralPath ($manifest + '.sha256') -Raw).Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)[0]).Trim()
$env:WHATSAPP_OWNERSHIP_CONFIRMATION = 'APPLY_WHATSAPP_OWNERSHIP_MIGRATION'
$env:WHATSAPP_OWNERSHIP_WORKERS_PAUSED = 'CONFIRMED'
node .\scripts\ops\whatsapp-channel-ownership-consolidation-phase2-apply.js --mode=APPLY --execution=COMMIT --source-channel-id=7f86db7a-0b3f-4aeb-9546-d0f2f921456a --target-clinic-id=a335961a-75c3-443b-a35f-5cc8dd243b1d --phone-number-id=1070249406167861 --manifest="$manifest" --manifest-sha256=$manifestSha256
Remove-Item Env:\WHATSAPP_OWNERSHIP_CONFIRMATION,Env:\WHATSAPP_OWNERSHIP_WORKERS_PAUSED
```

The command intentionally has no default write mode. The environment contains confirmations, not secrets. `DATABASE_URL` must already be loaded securely and is never printed.

## Locks and transaction

The APPLY opens `SERIALIZABLE`, takes a transaction advisory lock derived from Phone Number ID, locks source/target clinics and canonical/legacy channels `FOR UPDATE`, repeats active-work/count/credential checks, creates a transaction-local contact map, inserts 76 minimal contact representations, and executes the dependent moves/detaches/channel ownership change in one data-modifying CTE. Immediate composite foreign keys are never disabled. Assertions run before commit; any exception produces automatic rollback.

The canonical channel keeps its ID, WABA, Phone Number ID and exact credential ciphertext fingerprint and becomes active under the target clinic. The legacy target row remains present and becomes inactive. The one target collision is retained; consent is merged conservatively with boolean OR. Source contact and commercial history remain.

Commercial rows never change clinic. The 30 linked source orders only lose the nullable operational `conversationId`; their model trigger may refresh `updatedAt`, so the transaction checks an immutable fingerprint excluding only `conversationId` and trigger-managed `updatedAt`. The historical notification remains source-owned, retains immutable snapshot/order/idempotency/version/provider fields, and only loses nullable channel/conversation routing links. Job status, attempts and payload fingerprints must remain unchanged.

## Rollback

- Pre-commit: any failed statement/assertion executes SQL `ROLLBACK`; contact clones and every CTE change disappear atomically.
- Catastrophic post-commit: keep the current database isolated, restore Render PITR at T0 into a separate database, validate the PRE_APPLY manifest counts/IDs/hashes and credential fingerprint against it, then perform a separately approved controlled connection switch. Never restore over the original database and never auto-switch.

The local PRE_APPLY manifest is a reconciliation artifact, not a substitute for a restorable database backup. It contains IDs and aggregate irreversible hashes, no access token or credential ciphertext.
