# BILL-008 plan catalog and entitlements

## Canonical source

`src/services/plan-catalog.js` is the server-side source for public plan DTOs, billing definitions, profile resolution, and the closed capability registry. Public plans are `core`, `growth`, `distribution`, and `enterprise`. The capability registry is version 1 and contains 29 boolean capabilities plus `bot.tier` (`none | standard | advanced | custom`). `custom_integrations` and `custom_workflows` are deliberately absent: the inspected product has no implemented integration-adapter or custom-workflow entitlement surface.

Profiles are flattened when the catalog loads. Growth inherits Core; Distribution inherits Growth; Enterprise inherits Distribution. Contracts for new canonical plans record `entitlementProfileVersion: 1`. Existing immutable contracts without that field continue through the BILL-007 legacy lifecycle mapping; their permissions come only from the explicit frozen `legacy_090` profile, never from a plan-name guess.

Corrected release matrix: Core and Growth have `bot.enabled=false` and `bot.tier=none`; Growth retains WhatsApp, Instagram, unified Inbox, CRM and manual responses. Distribution includes the Advanced Bot; Enterprise includes the Custom Bot. This correction is made before BILL-008 has shipped, so profile v1 is the release candidate contract.

## Entitlement precedence

1. A missing, unknown, malformed, or unsupported profile fails closed.
2. An inactive, reversed, archived, deleted, unactivated, or `suspended_for_nonpayment` BILL-007 lifecycle removes paid capabilities while retaining the contract and stored profile.
3. An activated billing profile supplies the base capability set. A `legacy_090` profile is accepted only when its version, marker, full closed capability shape, and value types validate.
4. An Opturon-authorized add-on may add only its fixed capabilities to an eligible active plan. Tenant settings and request payloads are never a source of commercial grants.
5. Existing `portal.policy.enabledModules` flags can turn a capability off. They cannot turn one on. For frozen legacy profiles, the prior capability list further restricts the modules that older strict backend gates required.
6. Bot access also requires an active WhatsApp Cloud channel belonging to the same clinic, `bot.enabled`, and the strict boolean `settings.botActive === true`. Every Bot tool checks its own capability set against freshly read tenant settings and active commercial grants; there is no entitlement cache.

Manual Inbox/WhatsApp remains independent from Bot activation. Bot catalog/order access requires the corresponding AI flag and product module. Inventory data and inventory actions require both `bot.ai_inventory` and `inventory`; customer-history context requires `bot.ai_customer_history`. Payments, agenda, loyalty, automations, and custom instructions have separate tool checks.

## Legacy backfill

Migration `090_canonical_plan_entitlements.sql` is local-only in this change. It does not run provider requests or alter production. For valid object-shaped settings without a stored entitlement profile, it writes a complete explicit `legacy_090` snapshot based on the prior module/capability rules, keeps existing settings and policy data, preserves explicit Bot-off preferences, and does not advance existing BILL-007 entitlement revisions. Malformed root settings are left untouched and resolve to no paid access. Malformed capability containers are treated as empty. An ambiguous label such as `empresa` is recorded as legacy provenance and never selects Distribution or Enterprise capabilities.

Migration `091_opturon_commercial_entitlement_events.sql` creates a tenant-scoped append-only event log. The only prepared grant is `bot_standard`, eligible for an active Growth profile and granting Bot standard, catalog AI and orders AI. Grant/revoke operations revalidate the active Opturon admin actor, require a reason, and record actor, tenant, action and time. There is no tenant route or checkout for this grant. It is an internal entitlement decision, not proof of payment; any future paid add-on must apply BILL-006/BILL-007 financial effects before granting. Suspension removes the add-on's effective capabilities without deleting its audit history. No production tenant counts were queried; existing tenants retain their explicit `legacy_090` snapshot and are not remapped by legacy plan label.

The old billing codes and amounts remain available for historical contracts: `inicial` = ARS 40,600/month, `crecimiento` = ARS 68,600/month, and `empresa` = ARS 208,600/month. `inicial`/`crecimiento` are still historical billing identifiers; the old `empresa` lifecycle label is retained only for immutable BILL-007 matching, not entitlement authorization. New Core/Growth definitions retain the first two current amounts. Distribution and Enterprise have no authorized provider amount and new subscription creation fails closed until commercial pricing is decided. The USD 29/49/79 values seen in visual references are not used.

`PRICE_DECISION_REQUIRED=true`: decide the public display price, amount, currency, billing cadence, and provider charge authority for Distribution and Enterprise, and confirm the Core/Growth commercial labels and retained ARS amounts before presenting the values as final.

## Guards and client contract

The existing authenticated tenant context returns normalized `policy.entitlements`, its restrictive `enabledModules` projection, and `botEnabled`. Existing frontend policy/navigation code can continue using that projection; backend module middleware remains authoritative. Backend routes guard Inbox, CRM/contacts, pipeline, agenda, catalog, orders, receipts, payments, cash, loyalty, automations, inventory, purchases, suppliers, seller assignment/reporting, operational alerts, WhatsApp/Instagram connection, and advanced user-permission writes. Existing role checks remain in force after entitlement checks.

`GET /api/public/plans` returns `{ plans: [...] }` from `publicPlanCatalog()` and only exposes `key`, `displayName`, `description`, `pricingMode`, `amount`, `currency`, `billingCadence`, `highlights`, `recommended`, and `ctaMode`. It has a five-minute public cache. The Home can consume canonical plan keys directly; this task does not change the frontend repository or checkout.

Tenant Bot settings accept only the existing mode/config fields plus strict boolean `botActive`; unknown fields such as entitlement profiles, tier, plan, or capabilities are rejected before writes. The client BFF resolves the tenant from its authenticated workspace session before making the server-to-server backend request. A Bot preference never changes the profile.

## Current AI runtime audit (repository evidence)

The worker's commercial AI Assist is text-only OpenAI Chat Completions (`src/services/ai-assist.service.js`). Provider source is `AI_ASSIST_PROVIDER` (default `openai`; other provider values are rejected); model source is `AI_ASSIST_MODEL`, then `OPENAI_MODEL`, then `gpt-4o-mini`. Its enable switch is `AI_ASSIST_ENABLED` (default false), with clinic allow/deny lists and a required API key. The actual deployment environment override is not present in repository source, so only the code default can be stated as the current model here. The worker uses this for constrained classification on selected paths; the main conversation reply path also has a deterministic authoritative reply path.

Other text-only OpenAI references are `src/services/ai.service.js` and `src/services/response.service.js` (OpenAI SDK using `OPENAI_MODEL`, default `gpt-4o-mini`, with heuristic/template fallback), and `src/ai/openai.client.js` used by the debug controller (Chat Completions, `OPENAI_MODEL`, default `gpt-4o-mini`). Those SDK services have no explicit output-token cap or timeout at their call sites. No Responses, Assistants, Realtime, speech-to-text, text-to-speech, audio endpoint, or alternate voice-provider implementation was found; worker “voice” configuration controls textual presentation such as name/tone/treatment.

AI Assist limits are `AI_ASSIST_MAX_CALLS_PER_CONVERSATION` (default 50, counts successes and failures) and `AI_ASSIST_MAX_MONTHLY_CALLS` (default 2,000 per clinic, counts successes and failures). `AI_ASSIST_SUGGESTED_PROD_MAX_CALLS_PER_CONVERSATION` defaults to 15 but is diagnostic only, not enforced. AI Assist sends `max_tokens: 320` and times out after 8 seconds by default. Its events store provider, model, sanitized usage and latency; estimated cost is null. Limits are event-count checks, not an atomic reservation; no separate per-minute limiter or automatic provider/model retry is implemented. Provider failure returns to the safe current worker flow rather than switching models. The debug helper has `max_tokens: 220` and a 15-second timeout. No model, prompt architecture, memory or reasoning behavior was changed in this task.

## Local release gates

Run the complete `scripts/tests/saas-billing*.test.js` and `scripts/tests/mercado-pago*.test.js` suites with the local PostgreSQL test URL, plus the affected policy, portal module-gate, and Bot-settings tests. No production migration, deploy, push, real Mercado Pago mutation, or checkout action is part of BILL-008.
