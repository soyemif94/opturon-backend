const path = require('path');
const { withTransaction, closePool, query } = require('../src/db/client');
const { provisionCleanClinicForExternalTenant, updateClinicPortalPrimaryUserIdById } = require('../src/repositories/tenant.repository');
const { createPortalUserAuditEvent } = require('../src/repositories/portal-user-audit.repository');

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function slugifyTenantToken(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function buildDeterministicTenantId(user) {
  const safeName = slugifyTenantToken(user.name) || slugifyTenantToken(String(user.email || '').split('@')[0]) || 'cliente';
  const safeUserIdSuffix = String(user.id || '').slice(0, 8).toLowerCase() || 'portalusr';
  return `tenant_${safeName}_${safeUserIdSuffix}`;
}

function parseArg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => String(arg || '').startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

async function loadPortalOwnerRepairState(email, client = null) {
  const safeEmail = normalizeEmail(email);
  const userResult = await (client || { query }).query(
    `SELECT su.id,
            su."clinicId" AS clinic_id,
            su.email,
            su.name,
            su.role,
            su.active,
            su."accountType" AS account_type,
            su."accountRootUserId" AS account_root_user_id,
            CASE WHEN su."passwordHash" IS NOT NULL AND su."passwordHash" <> '' THEN true ELSE false END AS has_password_hash,
            c.name AS clinic_name,
            c.timezone,
            c."externalTenantId" AS tenant_id,
            COALESCE(c.settings #>> '{portal,accountScope}', c.settings #>> '{accountScope}', 'client') AS account_scope
     FROM staff_users su
     INNER JOIN clinics c ON c.id = su."clinicId"
     WHERE LOWER(su.email) = LOWER($1)
       AND su."accountType" = 'client_portal'
     LIMIT 2`,
    [safeEmail]
  );

  if (userResult.rows.length !== 1) {
    return {
      ok: false,
      reason: userResult.rows.length > 1 ? 'multiple_users_found' : 'user_not_found'
    };
  }

  const user = userResult.rows[0];
  const activityResult = await (client || { query }).query(
    `SELECT
       (SELECT COUNT(*)::INT FROM conversations WHERE "assignedSellerUserId" = $1) AS conversations_assigned,
       (SELECT COUNT(*)::INT FROM orders WHERE "sellerUserId" = $1) AS orders_seller,
       (SELECT COUNT(*)::INT FROM staff_users WHERE "accountRootUserId" = $1 AND id <> $1) AS rooted_users`,
    [user.id]
  );
  const activity = activityResult.rows[0] || {
    conversations_assigned: 0,
    orders_seller: 0,
    rooted_users: 0
  };

  const invitationsResult = await (client || { query }).query(
    `SELECT id,
            "clinicId" AS clinic_id,
            "tenantId" AS tenant_id,
            "acceptedAt" AS accepted_at,
            "revokedAt" AS revoked_at
     FROM portal_user_invitations
     WHERE "userId" = $1
     ORDER BY "createdAt" DESC`,
    [user.id]
  );

  const sameClinicUsersResult = await (client || { query }).query(
    `SELECT id, email, role, active
     FROM staff_users
     WHERE "clinicId" = $1
     ORDER BY "createdAt" ASC`,
    [user.clinic_id]
  );

  return {
    ok: true,
    user,
    invitations: invitationsResult.rows,
    sameClinicUsers: sameClinicUsersResult.rows,
    activity,
    deterministicTenantId: buildDeterministicTenantId(user)
  };
}

async function repairMisplacedPortalOwner(options) {
  const safeEmail = normalizeEmail(options.email);
  if (!safeEmail) {
    return { ok: false, reason: 'missing_email' };
  }

  const preview = await loadPortalOwnerRepairState(safeEmail);
  if (!preview.ok) return preview;

  const user = preview.user;
  const blockingActivity =
    Number(preview.activity.conversations_assigned || 0) > 0 ||
    Number(preview.activity.orders_seller || 0) > 0 ||
    Number(preview.activity.rooted_users || 0) > 0;

  if (user.account_type !== 'client_portal' || String(user.role || '').toLowerCase() !== 'owner') {
    return { ok: false, reason: 'unsupported_user_shape', preview };
  }

  if (blockingActivity) {
    return { ok: false, reason: 'user_has_related_activity', preview };
  }

  const targetTenantId = preview.deterministicTenantId;
  const currentAccountScope = String(user.account_scope || '').toLowerCase();
  const alreadyRepaired = String(user.account_scope || '').toLowerCase() === 'client'
    && String(user.tenant_id || '').trim() === targetTenantId;

  if (!alreadyRepaired && currentAccountScope !== 'opturon_admin') {
    return { ok: false, reason: 'unsupported_current_scope', preview };
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      alreadyRepaired,
      preview: {
        email: user.email,
        userId: user.id,
        currentClinicId: user.clinic_id,
        currentTenantId: user.tenant_id,
        currentAccountScope: user.account_scope,
        targetTenantId,
        hasPasswordHash: user.has_password_hash === true,
        acceptedInvitationIds: preview.invitations.filter((item) => item.accepted_at).map((item) => item.id),
        sameClinicUsers: preview.sameClinicUsers.map((item) => ({
          id: item.id,
          email: item.email,
          role: item.role,
          active: item.active
        })),
        blockingActivity: preview.activity
      }
    };
  }

  return withTransaction(async (client) => {
    const current = await loadPortalOwnerRepairState(safeEmail, client);
    if (!current.ok) return current;
    const currentUser = current.user;
    const currentScope = String(currentUser.account_scope || '').toLowerCase();

    if (currentScope === 'client' && String(currentUser.tenant_id || '').trim() === targetTenantId) {
      return {
        ok: true,
        alreadyRepaired: true,
        email: currentUser.email,
        userId: currentUser.id,
        tenantId: currentUser.tenant_id,
        clinicId: currentUser.clinic_id
      };
    }

    if (currentScope !== 'opturon_admin') {
      return { ok: false, reason: 'unsupported_current_scope' };
    }

    const targetClinic = await provisionCleanClinicForExternalTenant(
      {
        externalTenantId: targetTenantId,
        name: currentUser.name || currentUser.email,
        timezone: currentUser.timezone || 'America/Buenos_Aires'
      },
      client
    );

    const targetUsersResult = await client.query(
      `SELECT id
       FROM staff_users
       WHERE "clinicId" = $1
         AND id <> $2
       LIMIT 1`,
      [targetClinic.id, currentUser.id]
    );
    if (targetUsersResult.rows.length > 0) {
      return { ok: false, reason: 'target_clinic_already_has_other_users' };
    }

    await client.query(
      `UPDATE staff_users
       SET "clinicId" = $2,
           "accountRootUserId" = $1,
           "updatedAt" = NOW()
       WHERE id = $1`,
      [currentUser.id, targetClinic.id]
    );

    await updateClinicPortalPrimaryUserIdById(targetClinic.id, currentUser.id, client);

    await client.query(
      `UPDATE portal_user_invitations
       SET "clinicId" = $2,
           "tenantId" = $3,
           "updatedAt" = NOW()
       WHERE "userId" = $1`,
      [currentUser.id, targetClinic.id, targetTenantId]
    );

    await createPortalUserAuditEvent(
      {
        tenantId: targetTenantId,
        clinicId: targetClinic.id,
        actorUserId: null,
        targetUserId: currentUser.id,
        action: 'tenant_portal_user_repaired',
        payload: {
          targetUserId: currentUser.id,
          email: currentUser.email,
          previousClinicId: current.user.clinic_id,
          previousTenantId: current.user.tenant_id,
          previousAccountScope: current.user.account_scope,
          repairKind: 'move_misplaced_owner_to_client_tenant'
        }
      },
      client
    );

    return {
      ok: true,
      alreadyRepaired: false,
      email: currentUser.email,
      userId: currentUser.id,
      tenantId: targetTenantId,
      clinicId: targetClinic.id
    };
  });
}

async function main() {
  const email = parseArg('email');
  const apply = process.argv.includes('--apply');
  const dryRun = !apply;

  const result = await repairMisplacedPortalOwner({ email, dryRun });
  console.log(JSON.stringify(result, null, 2));

  await closePool();
  if (!result.ok) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    try {
      await closePool();
    } catch {}
    process.exit(1);
  });
}

module.exports = {
  buildDeterministicTenantId,
  loadPortalOwnerRepairState,
  repairMisplacedPortalOwner
};
