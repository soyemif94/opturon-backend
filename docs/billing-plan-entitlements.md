# BILL-008 plan catalog and entitlements

## Canonical source

`src/services/plan-catalog.js` is the server-side source for public plan DTOs, billing definitions, profile resolution, and the closed capability registry. Public plans are `core`, `growth`, `distribution`, and `enterprise`. The capability registry is version 1 and contains 29 boolean capabilities plus `bot.tier` (`none | standard | advanced | custom`). `custom_integrations` and `custom_workflows` are deliberately absent: the inspected product has no implemented integration-adapter or custom-workflow entitlement surface.

Profiles are flattened when the catalog loads. Growth inherits Core; Distribution inherits Growth; Enterprise inherits Distribution. Contracts for new canonical plans record `entitlementProfileVersion: 1`. Existing immutable contracts without that field continue through the BILL-007 legacy lifecycle mapping; their permissions come only from the explicit frozen `legacy_090` profile, never from a plan-name guess.

## Entitlement precedence

1. A missing, unknown, malformed, or unsupported profile fails closed.
2. An inactive, reversed, archived, deleted, unactivated, or `suspended_for_nonpayment` BILL-007 lifecycle removes paid capabilities while retaining the contract and stored profile.
3. An activated billing profile supplies the base capability set. A `legacy_090` profile is accepted only when its version, marker, full closed capability shape, and value types validate.
4. Existing `portal.policy.enabledModules` flags can turn a capability off. They cannot turn one on. For frozen legacy profiles, the prior capability list further restricts the modules that older strict backend gates required.
5. Bot access also requires an active WhatsApp Cloud channel belonging to the same clinic, `bot.enabled`, and the strict boolean `settings.botActive === true`. Every Bot tool checks its own capability set against freshly read tenant settings; there is no entitlement cache.

Manual Inbox/WhatsApp remains independent from Bot activation. Bot catalog/order access requires the corresponding AI flag and product module. Inventory data and inventory actions require both `bot.ai_inventory` and `inventory`; customer-history context requires `bot.ai_customer_history`. Payments, agenda, loyalty, automations, and custom instructions have separate tool checks.

## Legacy backfill

Migration `090_canonical_plan_entitlements.sql` is local-only in this change. It does not run provider requests or alter production. For valid object-shaped settings without a stored entitlement profile, it writes a complete explicit `legacy_090` snapshot based on the prior module/capability rules, keeps existing settings and policy data, preserves explicit Bot-off preferences, and does not advance existing BILL-007 entitlement revisions. Malformed root settings are left untouched and resolve to no paid access. Malformed capability containers are treated as empty. An ambiguous label such as `empresa` is recorded as legacy provenance and never selects Distribution or Enterprise capabilities.

The old billing codes and amounts remain available for historical contracts: `inicial` = ARS 40,600/month, `crecimiento` = ARS 68,600/month, and `empresa` = ARS 208,600/month. `inicial`/`crecimiento` are still historical billing identifiers; the old `empresa` lifecycle label is retained only for immutable BILL-007 matching, not entitlement authorization. New Core/Growth definitions retain the first two current amounts. Distribution and Enterprise have no authorized provider amount and new subscription creation fails closed until commercial pricing is decided. The USD 29/49/79 values seen in visual references are not used.

`PRICE_DECISION_REQUIRED=true`: decide the public display price, amount, currency, billing cadence, and provider charge authority for Distribution and Enterprise, and confirm the Core/Growth commercial labels and retained ARS amounts before presenting the values as final.

## Guards and client contract

The existing authenticated tenant context returns normalized `policy.entitlements`, its restrictive `enabledModules` projection, and `botEnabled`. Existing frontend policy/navigation code can continue using that projection; backend module middleware remains authoritative. Backend routes guard Inbox, CRM/contacts, pipeline, agenda, catalog, orders, receipts, payments, cash, loyalty, automations, inventory, purchases, suppliers, seller assignment/reporting, operational alerts, WhatsApp/Instagram connection, and advanced user-permission writes. Existing role checks remain in force after entitlement checks.

`GET /api/public/plans` returns `{ plans: [...] }` from `publicPlanCatalog()` and only exposes `key`, `displayName`, `description`, `pricingMode`, `amount`, `currency`, `billingCadence`, `highlights`, `recommended`, and `ctaMode`. It has a five-minute public cache. The Home can consume canonical plan keys directly; this task does not change the frontend repository or checkout.

Tenant Bot settings accept only the existing mode/config fields plus strict boolean `botActive`; unknown fields such as entitlement profiles, tier, plan, or capabilities are rejected before writes. The client BFF resolves the tenant from its authenticated workspace session before making the server-to-server backend request. A Bot preference never changes the profile.

## Local release gates

Run the complete `scripts/tests/saas-billing*.test.js` and `scripts/tests/mercado-pago*.test.js` suites with the local PostgreSQL test URL, plus the affected policy, portal module-gate, and Bot-settings tests. No production migration, deploy, push, real Mercado Pago mutation, or checkout action is part of BILL-008.
