# WhatsApp-only channel ownership consolidation — Phase 1B

## Decision and hard boundary

This phase implements a production-backed **read-only dry-run** for the authorized
`WHATSAPP_ONLY_CLONE_RELINK` policy. It does not contain an apply mode. The runner opens
`REPEATABLE READ READ ONLY`, always rolls back, never reads or prints `accessToken`, and
does not call Meta.

The selected channel strategy is **Option A**: preserve canonical channel
`7f86db7a-0b3f-4aeb-9546-d0f2f921456a` and, during a separately authorized future
migration, relink its ownership from source clinic
`8e117b14-7c5c-44fb-a4a4-ac86eb6c5074` to target clinic
`a335961a-75c3-443b-a35f-5cc8dd243b1d`. This preserves the real WABA
`27184268844495361`, Phone Number ID `1070249406167861`, channel ID and existing
credential ciphertext. No third channel is created.

Option B is less safe here: repurposing the legacy target channel would require moving
the real asset and its credential independently, duplicate WhatsApp history, or leave a
window with a mismatched token. The chosen design instead detaches the small set of
source-commercial operational backlinks and keeps the canonical WhatsApp graph intact.

## Final WhatsApp-only boundary

- **Move/relink:** canonical channel, conversations, conversation messages, message
  records, events, handoffs, Inbox leads, nine conversation-backed agenda rows, the one
  WhatsApp-derived appointment, terminal channel jobs and the approved template.
- **Clone:** 76 non-colliding contacts into target using new manifest-fixed IDs and only
  WhatsApp identity/display fields. All 77 source contacts remain present.
- **Merge/relink:** the one exact phone collision uses the already existing target contact
  ID. Target profile fields remain authoritative; `optedOut` is combined with logical OR.
- **Keep source:** orders, order items, invoices, payments, allocations, the inventory
  alert rule graph, two contact-only agenda rows and the immutable order notification.
- **Detach:** 30 source orders lose only their nullable operational `conversationId`; the
  terminal historical notification loses only nullable `channelId` and `conversationId`;
  the disabled inventory rule loses nullable `channelId`. Source staff references on
  moved history are mapped only when operationally active or detached into the signed
  migration manifest when historical.

## All 11 direct channel references

| Table | Source | Legacy | Class | Final treatment |
|---|---:|---:|---|---|
| `appointments` | 1 | 0 | A MOVE/RELINK | Move with conversation/contact mapping; no slot or lead reference exists |
| `channel_onboarding_sessions` | 0 | 0 | A MOVE/RELINK | Preconditions require zero; move non-secret metadata if future policy expands |
| `conversations` | 77 | 1 | A MOVE/RELINK | Preserve IDs/channel, update clinic and contact mapping |
| `jobs` | 782 | 5 | A MOVE/RELINK | Move terminal WhatsApp audit; preserve payload/status/attempts and never reactivate |
| `leads` | 23 | 0 | A MOVE/RELINK | Required to keep Inbox handoff graph coherent |
| `messages` | 43 | 0 | A MOVE/RELINK | Preserve IDs, provider IDs and raw payload |
| `operational_alert_deliveries` | 0 | 0 | D DETACH/HISTORICAL | Preconditions require zero because the rule stays source |
| `operational_alert_rules` | 1 | 0 | D DETACH/HISTORICAL | Disabled source inventory rule; set nullable channel link to NULL |
| `order_customer_notifications` | 1 | 0 | D DETACH/HISTORICAL | Keep immutable source record; detach nullable routing links |
| `whatsapp_template_canary_attempts` | 0 | 0 | A MOVE/RELINK | Preconditions require zero active attempts |
| `whatsapp_templates` | 1 | 0 | A MOVE/RELINK | Preserve approved template ID and real channel/WABA scope |

## All 22 transitive paths

| Path | Rows | Class | Treatment |
|---|---:|---|---|
| `agenda_items.conversationId` | 9 | A | Move with conversation |
| `appointments.conversationId` | 1 | A | Move with conversation |
| `conversation_events.conversationId` | 117 | A | Move tenant scope, preserve IDs/data |
| `conversation_messages.conversationId` | 1,804 | A | Parent ID is preserved; no row rewrite needed |
| `handoff_requests.conversationId` | 11 | A | Move Inbox handoff graph |
| `leads.conversationId` | 23 | A | Move Inbox lead graph |
| `messages.conversationId` | 43 | A | Move tenant/channel scope |
| `order_customer_notifications.conversationId` | 1 | D | Set nullable historical reference to NULL |
| `orders.conversationId` | 30 | D | Keep order source; set nullable operational reference to NULL |
| `agenda_items.contactId` | 11 | C | Nine are already selected by conversation; remaining two stay source |
| `appointments.contactId` | 1 | A | Relink to target contact mapping |
| `conversations.contactId` | 77 | A | Relink to target contact mapping |
| `handoff_requests.contactId` | 11 | A | Relink to target contact mapping |
| `invoices.contactId` | 16 | C | Keep original source contact and clinic |
| `leads.contactId` | 23 | A | Relink to target contact mapping |
| `order_customer_notifications.contactId` | 1 | C | Original source contact remains |
| `orders.contactId` | 37 | C | Original source contact and clinic remain |
| `payments.contactId` | 9 | C | Original source contact and clinic remain |
| `order_customer_notifications.orderId` | 1 | C | Preserve immutable source order relation |
| `order_items.orderId` | 1 in the notification traversal | C | Preserve source aggregate; full closure contains 38 items |
| `operational_alert_rule_recipients.ruleId` | 1 | D | Preserve source rule/recipient graph outside routing |
| `handoff_requests.leadId` | 9 | A | Follow moved Inbox lead graph |

No discovered path is class E. The dry-run fails closed if either catalog changes from
11 direct / 22 transitive paths or a nonzero unclassified dependency appears.

## Production dry-run counts

### WhatsApp domain

| Table | Source | Target before | Move | Clone | Keep source | Collision | Target after |
|---|---:|---:|---:|---:|---:|---:|---:|
| contacts | 77 | 1 | 1 relink | 76 | 77 | 1 | 77 |
| conversations | 77 | 1 | 77 | 0 | 0 | 0 | 78 |
| conversation_messages | 1,804 | 10 | 1,804 by parent | 0 | 0 | 0 | 1,814 |
| messages | 43 | 0 | 43 | 0 | 0 | 0 | 43 |
| conversation_events | 117 | 0 | 117 | 0 | 0 | 0 | 117 |
| handoff_requests | 11 | 0 | 11 | 0 | 0 | 0 | 11 |
| agenda_items | 11 | 1 | 9 | 0 | 2 | 0 | 10 |
| leads | 23 | 0 | 23 | 0 | 0 | 0 | 23 |
| appointments | 1 | 0 | 1 | 0 | 0 | 0 | 1 |
| jobs | 782 | 68 | 782 | 0 | 0 | 0 | 850 |
| whatsapp_templates | 1 | 0 | 1 | 0 | 0 | 0 | 1 |
| operational_alert_rules | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| order_customer_notifications | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| whatsapp_template_canary_attempts | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

The target-before totals include preserved legacy history where applicable. The final 78
target conversations are the 77 canonical-channel conversations plus the one legacy
conversation on the inactive legacy channel.

### Commercial domain

| Table | Keep source | Unexpected dependencies |
|---|---:|---:|
| orders | 37 | 0 |
| order_items | 38 | 0 |
| invoices | 16 | 0 |
| payments | 9 | 0 |
| payment_allocations | 1 | 0 |
| inventory_lot_allocations | 3 | 0 |

The 30 order/conversation links are expected operational detaches, not ownership moves.
No commercial row changes `clinicId`.

## Contact collision and staff mapping

The exact normalized-phone collision remains:

- source contact `751ae358-3663-4e6d-a0d3-31e16cd03f08`
- target contact `18418399-c961-4800-8749-819b00560438`

The WhatsApp identity and display name agree. Source has an email while target does not;
the email is not copied because it is unnecessary to the WhatsApp-only boundary. Neither
contact is opted out. The target ID and target profile remain authoritative, while all
source commercial references continue pointing at the source ID.

The 76 contact clones copy only `waId`, normalized phone/WhatsApp phone, display name,
profile image when present, and the conservative opt-out value. They do not copy tax,
company, notes or other commercial CRM fields.

One active assigned handoff and one assigned active lead require operational reassignment.
The target has two active staff users and a valid active primary user; those active rows map
to that target primary user. One resolved handoff assignee and one soft-deletion actor are
historical source identities: their FK is detached and the preimage is retained only in the
restricted signed migration manifest. No source staff account is cloned into target.

## WhatsApp identity, media and idempotency

- `providerMessageId` collisions against target: 0.
- WAMID collisions against target: 0.
- Conversation-message rows with media references: 83. Raw message/media metadata follows
  the preserved conversation and canonical channel; no blob or media ID is rewritten.
- The global `conversation_messages_waMessageId_key` and tenant-scoped
  `uniq_messages_clinic_provider_msg_id` remain enabled.
- Duplicate inbound delivery remains idempotent after relink because phone routing first
  resolves the target clinic and then looks up the preserved provider ID in that clinic.

## Jobs, template, rule and immutable notification

All 782 source jobs are terminal: 759 `done`, 23 `failed`, zero locks. Types are 779
`conversation_reply` plus three terminal NOOP probes. None of their payload roots references
orders, invoices, payments, inventory lots or allocations. They are relinked as WhatsApp
audit history because `jobs.channelId` is non-nullable; status, attempts, run time, payload
and errors are not changed.

The one template is exactly `inventory_lot_expiring_v1`, `es_AR`, `APPROVED`, `UTILITY`,
WABA `27184268844495361`. It moves with the canonical channel; no duplicate is created.

The one alert rule is disabled, has no lease, and event type `inventory.lot_expiring` proves
it is source-commercial configuration. It and its recipient relation stay source; only its
nullable channel link is detached. There are no deliveries.

The one order notification is terminal `read`, has no lease marker, and already has a
provider message ID. It stays on the original clinic/order/contact. Only nullable channel and
conversation routing references become NULL. The immutable trigger remains enabled and the
plan does not change `snapshot`, `clinicId`, `orderId`, notification type/version or
idempotency key. It cannot be claimed or resent after detachment.

## Legacy target channel

Channel `b3ef8ab5-4610-4571-a91b-e34d10b98dfa` remains target-owned, becomes `inactive`,
and is never deleted. Its one conversation, ten conversation messages and five jobs remain
unchanged on that channel. Its legacy WABA and Phone Number ID remain historical; active
routing excludes it.

## Webhook routing contract

After the future ownership update, the active channel lookup by Phone Number ID returns the
preserved canonical channel with target `clinicId`. Delivery/read/failed reconciliation also
derives both clinic and channel from that unique phone owner before matching provider IDs.
The focused contract tests cover:

- inbound message extraction and target phone routing;
- sent, delivered, read and failed status routing;
- template-message/Canary status fallback under target scope;
- duplicate provider identity through preserved unique keys;
- unknown WAMID ignored without mutation.

Meta template-approval webhook events are not currently consumed into tenant state by the
application; template sync remains the source of truth. This does not route anything to the
source tenant, but it remains an operational limitation to verify after credential cutover.

## Future atomic apply design

The future apply must be a separate, explicitly approved command and perform:

1. Verify PITR coverage and a completed logical export; load a signed manifest containing
   exact IDs, deterministic clone IDs, counts, row fingerprints and preimage detach data.
2. `BEGIN ISOLATION LEVEL SERIALIZABLE`.
3. Acquire `pg_advisory_xact_lock` from a domain-separated hash of Phone Number ID
   `1070249406167861`.
4. Lock both clinics and both channels `FOR UPDATE`; compare exact IDs, `updatedAt`, scopes,
   status, provider, WABA, Phone Number ID and legacy identity to the manifest.
5. Re-run every collision/count/terminal-state gate. Abort on a new job, lease, canary,
   notification transition, contact collision, phone/WABA owner or catalog dependency.
6. Create a transaction-local contact map and insert the 76 minimal target clones with
   manifest-fixed UUIDs. Map the collision to the existing target contact.
7. Execute one data-modifying CTE statement that, as a single PostgreSQL statement:
   detaches 30 order conversation links; detaches the historical notification and source
   rule; relinks conversations/messages/events/leads/handoffs/agenda/appointment/jobs/template;
   performs approved target-staff mappings; clears historical source-staff FKs; changes the
   canonical channel clinic; and marks the legacy channel inactive.
8. The single statement is mandatory because production has eight relevant immediate,
   non-deferrable composite FKs. A local PostgreSQL-compatible integration test proves the
   child-and-parent transition succeeds at statement end without disabling or altering FKs.
9. Run all post-migration assertions in the same transaction. Insert only a sanitized audit
   fingerprint/count record if an approved audit sink exists; never secrets, PII or bodies.
10. Commit only if every assertion passes. Credential ciphertext and fingerprint must be
    byte-identical before/after; otherwise rollback.

At no point is the real Phone Number ID copied to a second row. The existing
`channels_phoneNumberId_key` remains present and unchanged.

## Post-migration assertions

1. Exactly one channel owns Phone Number ID `1070249406167861`.
2. WABA `27184268844495361` and active phone lookup resolve canonical channel plus target clinic.
3. Inbound and delivery-status routes resolve only target; unknown WAMID makes no write.
4. Target Inbox has 77 canonical conversations and 1,804 associated messages; legacy remains isolated.
5. All 77 source contacts and all source commercial rows still exist.
6. The 37 orders, 16 invoices and 9 payments retain source `clinicId`.
7. The immutable notification fields and snapshot fingerprint are unchanged; routing FKs are NULL.
8. Provider message/WAMID uniqueness and row counts are unchanged.
9. All moved jobs retain exact statuses/attempts/payload fingerprints; no active job exists.
10. Legacy channel is inactive and absent from active lookup.
11. Source admin has no active channel for the productive phone and receives no new row for it.
12. Channel credential ciphertext/fingerprint is unchanged.
13. Every tenant-bearing relation agrees with its parent; no target row references source contact/staff/commercial IDs.

## Rollback

Any precondition or assertion failure rolls back the serializable transaction, including
contact clones and all relinks. There is no intermediate committed owner. If a post-commit
problem is discovered, stop workers/inbound-outbound processing, restore a separate Render
database to the recorded `T0` through PITR, validate the signed manifest against the restored
instance, and switch connection only after explicit approval. Do not attempt an ad-hoc inverse
merge over production.

## Dry-run command

```powershell
$env:DATABASE_URL = '<production-url-from-secure-runtime>'
node .\scripts\ops\whatsapp-channel-ownership-consolidation-phase1b-dry-run.js --mode=DRY_RUN
$env:DATABASE_URL = $null
```

Production result: `READY_FOR_WHATSAPP_ONLY_MIGRATION=true`.

No production write, credential change, Meta request, message send, deploy or cutover was
performed in Phase 1B.
