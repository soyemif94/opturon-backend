const { withTransaction } = require('../db/client');
const { createTenantPolicyAuditEvent } = require('../repositories/tenant-policy-audit.repository');

const ALLOWED_TENANT_LIFECYCLE_STATUSES = new Set(['pending', 'active', 'suspended', 'archived', 'cancelled']);

function normalizeString(value) {
  return String(value || '').trim();
}

function parseSettings(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function lifecycleAuditAction(status) {
  if (status === 'suspended') return 'CLIENT_SUSPENDED';
  if (status === 'active') return 'CLIENT_REACTIVATED';
  if (status === 'archived' || status === 'cancelled') return 'CLIENT_ARCHIVED';
  return 'CLIENT_LIFECYCLE_UPDATED';
}

async function updateTenantLifecycleStatus(input, dependencies = {}) {
  const tenantId = normalizeString(input && input.tenantId);
  const nextStatus = normalizeString(input && input.status).toLowerCase();
  const expectedCurrentStatus = normalizeString(input && input.expectedCurrentStatus).toLowerCase() || null;
  const reason = normalizeString(input && input.reason);
  if (!tenantId) return { ok: false, reason: 'missing_tenant_id', status: 400 };
  if (!ALLOWED_TENANT_LIFECYCLE_STATUSES.has(nextStatus)) {
    return { ok: false, reason: 'invalid_tenant_lifecycle_status', status: 400 };
  }
  if (!reason) return { ok: false, reason: 'tenant_lifecycle_reason_required', status: 400 };

  const runTransaction = dependencies.withTransaction || withTransaction;
  const createAudit = dependencies.createTenantPolicyAuditEvent || createTenantPolicyAuditEvent;
  return runTransaction(async (client) => {
    const currentResult = await client.query(
      `SELECT id, "externalTenantId", settings
       FROM clinics
       WHERE "externalTenantId" = $1
       FOR UPDATE`,
      [tenantId]
    );
    const clinic = currentResult.rows[0] || null;
    if (!clinic) return { ok: false, reason: 'tenant_not_found', status: 404 };

    const settings = parseSettings(clinic.settings);
    const portal = settings.portal && typeof settings.portal === 'object' ? { ...settings.portal } : {};
    const lifecycle = portal.lifecycle && typeof portal.lifecycle === 'object' ? { ...portal.lifecycle } : {};
    const currentStatus = normalizeString(lifecycle.status).toLowerCase() || 'active';
    if (expectedCurrentStatus && currentStatus !== expectedCurrentStatus) {
      return {
        ok: false,
        reason: 'tenant_lifecycle_state_mismatch',
        status: 409,
        currentStatus
      };
    }

    const changedAt = new Date().toISOString();
    const nextLifecycle = {
      ...lifecycle,
      status: nextStatus,
      lastChangedAt: changedAt,
      lastChangedReason: reason,
      lastChangedBy: normalizeString(input && input.actorLabel) || 'explicit_lifecycle_operation'
    };
    const nextSettings = {
      ...settings,
      portal: {
        ...portal,
        lifecycle: nextLifecycle
      }
    };
    const updatedResult = await client.query(
      `UPDATE clinics
       SET settings = $2::jsonb,
           "updatedAt" = NOW()
       WHERE id = $1::uuid
       RETURNING id, "externalTenantId", settings, "updatedAt"`,
      [clinic.id, JSON.stringify(nextSettings)]
    );
    const updated = updatedResult.rows[0];

    const audit = await createAudit({
      clinicId: clinic.id,
      tenantId,
      actorUserId: input && input.actorUserId || null,
      actorRole: input && input.actorRole || null,
      actorScope: input && input.actorScope || null,
      action: lifecycleAuditAction(nextStatus),
      beforeSnapshot: { lifecycle, billing: portal.billing || null },
      afterSnapshot: { lifecycle: nextLifecycle, billing: portal.billing || null },
      metadata: {
        reason,
        source: normalizeString(input && input.source) || 'tenant_lifecycle_service'
      }
    }, client);

    return {
      ok: true,
      tenantId,
      previousStatus: currentStatus,
      lifecycleStatus: nextStatus,
      billing: portal.billing || null,
      audit,
      updatedAt: updated && updated.updatedAt || null
    };
  });
}

module.exports = {
  ALLOWED_TENANT_LIFECYCLE_STATUSES,
  updateTenantLifecycleStatus,
  __internal: {
    lifecycleAuditAction
  }
};
