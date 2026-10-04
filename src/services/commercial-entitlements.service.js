const { query } = require('../db/client');
const { COMMERCIAL_ADDONS } = require('./plan-catalog');
const { resolveEffectiveEntitlements } = require('./effective-entitlements');
const { findPortalActorContext } = require('./portal-active-tenant.service');

function dbQuery(client, text, params) {
  return client && typeof client.query === 'function' ? client.query(text, params) : query(text, params);
}

function normalizeString(value) { return String(value || '').trim(); }
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizeString(value));
}

async function listActiveCommercialEntitlementKeys(clinicId, client = null) {
  if (!isUuid(clinicId)) return [];
  const result = await dbQuery(client, `
    SELECT entitlement_key, action
    FROM (
      SELECT DISTINCT ON (entitlement_key) entitlement_key, action
      FROM tenant_commercial_entitlement_events
      WHERE clinic_id = $1::uuid
      ORDER BY entitlement_key, id DESC
    ) latest
    WHERE action = 'granted'
  `, [clinicId]);
  return result.rows.map(row => row.entitlement_key).filter(key => Object.hasOwn(COMMERCIAL_ADDONS, key));
}

async function recordCommercialEntitlementEvent({ clinicId, entitlementKey, action, actorUserId, reason }, client = null) {
  const safeClinicId = normalizeString(clinicId);
  const safeActorId = normalizeString(actorUserId);
  const safeReason = normalizeString(reason);
  if (!isUuid(safeClinicId)) return { ok: false, reason: 'invalid_clinic_id' };
  if (!Object.hasOwn(COMMERCIAL_ADDONS, entitlementKey)) return { ok: false, reason: 'unknown_commercial_entitlement' };
  if (!['granted', 'revoked'].includes(action)) return { ok: false, reason: 'invalid_commercial_entitlement_action' };
  if (!isUuid(safeActorId)) return { ok: false, reason: 'opturon_admin_required' };
  const actor = await findPortalActorContext(safeActorId);
  if (!actor || actor.isAdmin !== true || actor.accountScope !== 'opturon_admin') {
    return { ok: false, reason: 'opturon_admin_required' };
  }
  if (!safeReason || safeReason.length > 1000) return { ok: false, reason: 'valid_audit_reason_required' };

  if (action === 'granted') {
    const target = await dbQuery(client, 'SELECT settings FROM clinics WHERE id = $1::uuid LIMIT 1', [safeClinicId]);
    const entitlements = resolveEffectiveEntitlements(target.rows[0]?.settings);
    if (!target.rows[0]) return { ok: false, reason: 'tenant_not_found' };
    if (entitlements.state !== 'active' || !COMMERCIAL_ADDONS[entitlementKey].eligiblePlanKeys.includes(entitlements.planKey)) {
      return { ok: false, reason: 'commercial_entitlement_plan_ineligible' };
    }
  }

  const result = await dbQuery(client, `
    INSERT INTO tenant_commercial_entitlement_events
      (clinic_id, entitlement_key, action, actor_user_id, reason)
    SELECT id, $2, $3, $4::uuid, $5
    FROM clinics
    WHERE id = $1::uuid
    RETURNING id, clinic_id AS "clinicId", entitlement_key AS "entitlementKey",
      action, actor_user_id AS "actorUserId", reason, created_at AS "createdAt"
  `, [safeClinicId, entitlementKey, action, safeActorId, safeReason]);
  if (!result.rows[0]) return { ok: false, reason: 'tenant_not_found' };
  return { ok: true, event: result.rows[0] };
}

function grantCommercialEntitlement(input, client = null) {
  return recordCommercialEntitlementEvent({ ...input, action: 'granted' }, client);
}
function revokeCommercialEntitlement(input, client = null) {
  return recordCommercialEntitlementEvent({ ...input, action: 'revoked' }, client);
}

module.exports = { listActiveCommercialEntitlementKeys, grantCommercialEntitlement, revokeCommercialEntitlement };
