# WhatsApp channel ownership consolidation — Phase 1

## Scope and hard boundary

This phase is design and dry-run only. The production runner supports only `--mode=DRY_RUN`, opens a `REPEATABLE READ READ ONLY` transaction, and always rolls it back. It has no apply mode and must never receive an access token.

Canonical identifiers:

- source channel: `7f86db7a-0b3f-4aeb-9546-d0f2f921456a`
- source clinic: `8e117b14-7c5c-44fb-a4a4-ac86eb6c5074`
- target clinic: `a335961a-75c3-443b-a35f-5cc8dd243b1d`
- legacy target channel: `b3ef8ab5-4610-4571-a91b-e34d10b98dfa`

The source channel remains the canonical channel because it owns the real Meta assets and historic operational references. No third channel is created.

## Production dry-run findings

Direct source-channel dependencies:

| Domain | Rows | Planned treatment |
|---|---:|---|
| conversations | 77 | Preserve IDs and channelId; change tenant ownership after contact mapping |
| messages | 43 | Preserve providerMessageId and conversationId; change clinicId |
| leads | 23 | Preserve IDs; change clinicId with conversation/contact mapping |
| jobs | 782 | Preserve history; migrate only with zero runnable or leased jobs |
| appointments | 1 | Preserve ID; validate conversation/contact/lead/slot closure |
| whatsapp_templates | 1 | Preserve channelId, WABA and template identity |
| operational_alert_rules | 1 | Move the complete rule/recipient/instance/delivery graph |
| order_customer_notifications | 1 | Move with order/contact/conversation closure |
| canary attempts | 0 | No current rows |

Indirect dependencies discovered from PostgreSQL metadata and relation traversal:

- 1,804 `conversation_messages`
- 117 `conversation_events`
- 11 `handoff_requests`
- 11 `agenda_items` by contact, 9 also by conversation
- 77 contacts affected by the source channel
- 37 orders related through affected contacts, 30 also linked to affected conversations
- 16 invoices related through affected contacts
- 9 payments related through affected contacts
- order items and notification/order composite tenant FKs
- one operational-alert rule-recipient relation

The commercial closure is recursive: moving an order can pull order items, invoices, payment allocations and inventory allocations. Therefore a channel-only clinicId update is unsafe.

The one `order_customer_notifications` row also has immutable tenant identity: `trg_order_customer_notification_snapshot_immutable` rejects a clinicId change. Its channelId is nullable, but detaching it would weaken historical ownership. The future policy must explicitly choose and test an archival/relink design without disabling this trigger.

Legacy target channel dependencies:

- one conversation
- five jobs
- ten `conversation_messages` through the legacy conversation

The legacy record must be retained and eventually set to `inactive`; its historical conversation and jobs remain attached to that legacy channel unless a separately approved history merge is designed.

## Application routing and tenant scope

- Inbound webhook routing resolves an active channel globally by Phone Number ID and then derives its clinic.
- Conversation ingestion uses the same Phone Number ID resolution path.
- Inbox reads and writes re-resolve a channel by the composite logical scope `(channelId, clinicId)`.
- Template sync and Canary require matching `clinicId`, `channelId` and WABA; changing only the channel owner would make existing template rows invisible until their tenant scope is migrated.
- Jobs, operational alerts and order notifications carry both clinicId and channelId, and several database constraints enforce the composite channel/tenant relationship.
- `webhook_events` and `inbound_failures` have no clinicId/channelId ownership column; their phone/WAMID history remains immutable while future routing follows the canonical channel.

These paths make the final ordering mandatory: migrate child scopes first where constraints allow, move the canonical channel under deferred/validated FK handling in the dedicated migration, and validate routing before commit.

## Collision analysis

| Domain | Source | Target | Collisions | Decision |
|---|---:|---:|---:|---|
| Contacts | 77 | 1 | 1 exact normalized-phone match | Merge source contact `751ae358-3663-4e6d-a0d3-31e16cd03f08` into existing target contact `18418399-c961-4800-8749-819b00560438`; no PII is logged |
| Conversations | 77 | 1 | 0 parallel active pairs | Preserve source conversation IDs |
| `messages` | 43 | 0 | 0 providerMessageId | Preserve IDs and idempotency values |
| `conversation_messages` | 1,804 | 10 | 0 WAMID | Follow preserved conversation IDs; no direct tenant column |
| Leads | 23 | 0 | 0 | Preserve IDs; update composite tenant ownership |
| Jobs | 782 | 68 | 0 key collision observed | 759 done and 23 failed; no runnable jobs. Preserve all rows |
| Templates | 1 | 0 | 0 name/language | Preserve WABA/channel scope |
| Appointments | 1 | 0 | 0 | No slot or lead reference on the affected appointment |
| Alert rules | 1 | 0 | 0 event/version | Move rule and its one recipient relation together |
| Order notifications | 1 | 0 | 0 idempotency key | Preserve notification; referenced order closure requires a separate ownership decision |
| Canary | 0 | 0 | 0 | No action |

## Blocking ownership decision

The dry-run cannot safely choose between these policies without product/data-owner authorization:

1. **Full commercial consolidation:** transfer the recursively connected orders, invoices, payments and allocations to the client tenant, resolving every target unique key.
2. **WhatsApp-only consolidation with contact cloning:** clone non-colliding contacts into the target and relink only the WhatsApp graph. Commercial records that directly reference the migrating conversations still require explicit treatment.

Until one policy is selected and its recursive closure is collision-tested, `READY_FOR_MIGRATION=false`.

## Future migration transaction design

The future apply implementation must be a separate command with an explicit approval token and must execute the following sequence in one transaction:

1. `BEGIN ISOLATION LEVEL SERIALIZABLE`.
2. Acquire a transaction-scoped advisory lock derived from the Phone Number ID.
3. `SELECT ... FOR UPDATE` both channels and both clinic rows.
4. Revalidate exact channel IDs, clinic IDs, provider, status, WABA and Phone Number ID.
5. Assert no third channel owns the Phone Number ID and that the global unique constraint remains present.
6. Assert no runnable/leased job and no active Canary attempt exists.
7. Materialize deterministic ID sets for every migration-closure table.
8. Resolve the exact contact collision first; preserve the target contact ID and relink only approved source rows.
9. Apply the approved commercial-history policy and validate all composite tenant FKs before moving the channel.
10. Update tenant-scoped child rows in FK-safe order.
11. Update the canonical source channel to the target clinic, preserving its ID, WABA, Phone Number ID and credential.
12. Mark the legacy target channel `inactive`, without clearing its historical IDs or deleting it.
13. Run all post-migration assertions inside the same transaction.
14. Insert a sanitized audit record containing IDs, counts, policy and migration fingerprint; never credentials or message bodies.
15. `COMMIT` only if every assertion passes; otherwise `ROLLBACK`.

No constraint, cross-tenant guard or uniqueness rule is disabled during this sequence.

## Locks and preconditions

- Serializable transaction plus advisory lock for the Phone Number ID.
- Row locks for source/legacy channels and source/target clinics.
- Exact `updatedAt` precondition captured immediately before the maintenance window.
- Zero third-channel match.
- Source remains `active`, `whatsapp_cloud`, WABA `27184268844495361`, Phone Number ID `1070249406167861`.
- Target remains `client`; source remains `opturon_admin` until migration.
- Legacy channel remains owned by target and has its expected legacy assets.
- Zero runnable jobs, active delivery leases or active Canary attempts.
- Collision counts equal the approved manifest.

## Backup and rollback procedure

Before future apply:

1. Record UTC `T0`, database ID and current channel `updatedAt` values.
2. Confirm the Render database Recovery page shows a PITR window covering `T0`.
3. Trigger a logical export and wait until it is downloadable; record its export ID and checksum after download.
4. Store a signed dry-run manifest containing all affected IDs, per-table counts, collision mappings and invariants.
5. Run apply only after the export and manifest are verified.

Transaction failure uses PostgreSQL rollback and leaves no partial migration. If post-commit validation fails:

1. Stop workers and disable inbound/outbound traffic without changing credentials.
2. Restore a new Render database instance to `T0` using PITR.
3. Run the invariant suite against the recovery instance in isolation.
4. Switch the backend database connection only after reconciliation and explicit approval.
5. Preserve the failed primary for forensic comparison; do not overwrite it in place.

An inverse SQL script is insufficient as the primary rollback because contact merges and recursive commercial ownership can be lossy. PITR plus the signed manifest is the authoritative recovery mechanism.

## Required post-migration assertions

- Exactly one channel owns Phone Number ID `1070249406167861`.
- Canonical source channel belongs to the target clinic and remains active.
- Legacy target channel is inactive and excluded from active routing.
- No approved migration row retains sourceClinicId.
- No FK is orphaned and all composite `(id, clinicId)` relationships agree.
- Conversation count remains 77 and `conversation_messages` remains 1,804.
- No message or conversation disappears.
- providerMessageId/WAMID uniqueness remains valid.
- Inbound phone routing resolves the target tenant.
- Jobs retain status, attempts and payloads; no lease is resurrected.
- Template remains scoped to the real WABA/channel.
- Canary and notification idempotency remain unique.
- Target Inbox shows the migrated graph; source workspace cannot read it.
- Legacy history remains queryable only through authorized historical paths.
- Credential ciphertext/fingerprint is unchanged during ownership migration.

## Dry-run command

```powershell
$env:DATABASE_URL = '<production-url-from-secure-runtime>'
node .\scripts\ops\whatsapp-channel-ownership-consolidation-dry-run.js --mode=DRY_RUN
$env:DATABASE_URL = $null
```

The connection string must come from the secure runtime and must not be placed in command history, committed files or logs.
