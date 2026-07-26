const { query } = require('../src/db/client');
const { updateTenantPolicyByExternalTenantId } = require('../src/services/tenant-policy.service');

function parseArgs(argv) {
  return argv.reduce(
    (acc, arg) => {
      if (arg === '--apply') acc.apply = true;
      if (arg.startsWith('--tenant-id=')) acc.tenantIds.push(arg.slice('--tenant-id='.length).trim());
      return acc;
    },
    { apply: false, tenantIds: [] }
  );
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

async function listCandidates(tenantIds) {
  const params = [];
  let tenantFilter = '';
  if (tenantIds.length) {
    params.push(tenantIds);
    tenantFilter = `AND c."externalTenantId" = ANY($${params.length}::text[])`;
  }

  const result = await query(
    `
      WITH product_stats AS (
        SELECT p."clinicId" AS clinic_id,
               COUNT(*) FILTER (WHERE p."deletedAt" IS NULL) AS active_total,
               COUNT(*) FILTER (
                 WHERE p."deletedAt" IS NULL
                   AND COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') <> 'lot_based'
               ) AS active_base,
               COUNT(*) FILTER (
                 WHERE p."deletedAt" IS NULL
                   AND COALESCE(p.metadata->'catalog'->>'inventoryTrackingMode', 'legacy') = 'lot_based'
               ) AS active_lot
        FROM products p
        GROUP BY p."clinicId"
      )
      SELECT c.id,
             c."externalTenantId" AS "tenantId",
             c.settings,
             COALESCE(c.settings->'portal'->>'accountScope', 'client') AS "accountScope",
             COALESCE(ps.active_total, 0) AS "activeTotal",
             COALESCE(ps.active_base, 0) AS "activeBase",
             COALESCE(ps.active_lot, 0) AS "activeLot"
      FROM clinics c
      LEFT JOIN product_stats ps ON ps.clinic_id = c.id
      WHERE NULLIF(TRIM(COALESCE(c."externalTenantId", '')), '') IS NOT NULL
        AND COALESCE(c.settings->'portal'->>'accountScope', 'client') <> 'opturon_admin'
        AND (COALESCE(ps.active_base, 0) > 0 OR COALESCE(ps.active_lot, 0) > 0)
        ${tenantFilter}
      ORDER BY c."externalTenantId" ASC
    `,
    params
  );

  return result.rows.map((row) => {
    const portal = row.settings && typeof row.settings === 'object' ? row.settings.portal || {} : {};
    const policy = portal && typeof portal.policy === 'object' ? portal.policy : {};
    const capabilities = Array.isArray(policy.capabilities) ? unique(policy.capabilities.map((item) => String(item || '').trim().toLowerCase())) : [];
    const enabledModules = policy.enabledModules && typeof policy.enabledModules === 'object' ? policy.enabledModules : {};
    return {
      clinicId: row.id,
      tenantId: row.tenantId,
      accountScope: String(row.accountScope || 'client'),
      activeTotal: Number(row.activeTotal || 0),
      activeBase: Number(row.activeBase || 0),
      activeLot: Number(row.activeLot || 0),
      policyVersion: Number(policy.policyVersion || 0) || null,
      capabilities,
      enabledModules,
      visibleByLegacyCompatibility: enabledModules.inventory !== false,
      hasInventorySignals: Number(row.activeBase || 0) > 0 || Number(row.activeLot || 0) > 0,
      needsInventoryModuleFlag: enabledModules.inventory === false,
      eligible:
        String(row.accountScope || 'client') === 'client' &&
        (Number(row.activeBase || 0) > 0 || Number(row.activeLot || 0) > 0) &&
        (!capabilities.includes('inventory') || enabledModules.inventory === false)
    };
  });
}

async function normalizeTenant(tenant) {
  const nextCapabilities = unique([...tenant.capabilities, 'inventory']);
  return updateTenantPolicyByExternalTenantId(
    tenant.tenantId,
    {
      capabilities: nextCapabilities,
      enabledModules: {
        ...tenant.enabledModules,
        inventory: true
      }
    },
    {
      mode: 'admin',
      actorUserId: null,
      actorRole: 'system',
      actorScope: 'opturon_admin',
      action: 'tenant_policy_inventory_capability_normalized',
      source: 'scripts/normalize-inventory-capability-policy.js'
    }
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tenantIds = unique(options.tenantIds);
  const candidates = await listCandidates(tenantIds);
  const eligible = candidates.filter((tenant) => tenant.eligible);
  const alreadyAligned = candidates.filter((tenant) => !tenant.eligible && tenant.capabilities.includes('inventory'));
  const skipped = candidates.filter((tenant) => !tenant.eligible && !tenant.capabilities.includes('inventory'));

  console.log(
    JSON.stringify({
      mode: options.apply ? 'apply' : 'dry-run',
      scopedTenants: tenantIds.length || 'all-with-inventory-signals',
      candidates: candidates.length,
      eligible: eligible.length,
      alreadyAligned: alreadyAligned.length,
      skipped: skipped.length
    })
  );

      for (const tenant of candidates) {
    console.log(
      JSON.stringify({
        tenantId: tenant.tenantId,
        activeTotal: tenant.activeTotal,
        activeBase: tenant.activeBase,
        activeLot: tenant.activeLot,
        accountScope: tenant.accountScope,
        policyVersion: tenant.policyVersion,
        visibleByLegacyCompatibility: tenant.visibleByLegacyCompatibility,
        hasInventorySignals: tenant.hasInventorySignals,
        needsInventoryModuleFlag: tenant.needsInventoryModuleFlag,
        hasInventoryCapability: tenant.capabilities.includes('inventory'),
        enabledModules: tenant.enabledModules,
        action: tenant.eligible
          ? options.apply
            ? 'normalize'
            : 'would_normalize'
          : tenant.capabilities.includes('inventory') && tenant.enabledModules.inventory !== false
            ? 'already_aligned'
            : 'skip'
      })
    );
  }

  if (!options.apply) return;

  for (const tenant of eligible) {
    const result = await normalizeTenant(tenant);
    console.log(
      JSON.stringify({
        tenantId: tenant.tenantId,
        ok: result.ok === true,
        idempotent: result.idempotent === true,
        capabilities: result.policy?.capabilities || [],
        enabledModules: result.policy?.enabledModules || {}
      })
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
