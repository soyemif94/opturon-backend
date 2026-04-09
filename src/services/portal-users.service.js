const { hashSync, compareSync } = require('bcryptjs');
const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { getClinicPortalSubaccountLimitById } = require('../repositories/tenant.repository');
const {
  countOwnersByClinicId,
  listPortalUsersByClinicId,
  createPortalUser,
  updatePortalUserRole,
  deletePortalUserById,
  findPortalUserByEmail
} = require('../repositories/portal-users.repository');

const ALLOWED_ROLES = new Set(['owner', 'manager', 'seller', 'viewer']);
const PORTAL_USERS_LIMIT_KEY = 'tenant_portal_users';

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeRole(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'editor') return 'seller';
  return ALLOWED_ROLES.has(normalized) ? normalized : null;
}

function countSubaccounts(users) {
  return (Array.isArray(users) ? users : []).filter((user) => String(user && user.role ? user.role : '').toLowerCase() !== 'owner').length;
}

function countPrimaryAccounts(users) {
  return (Array.isArray(users) ? users : []).filter((user) => String(user && user.role ? user.role : '').toLowerCase() === 'owner').length;
}

function buildPortalUsersMeta(users, limitConfig) {
  const subaccountCount = countSubaccounts(users);
  const primaryAccountCount = countPrimaryAccounts(users);
  const subaccountLimit = Number(limitConfig && limitConfig.subaccountLimit) || 0;

  return {
    subaccountCount,
    primaryAccountCount,
    subaccountLimit,
    remainingSubaccounts: Math.max(0, subaccountLimit - subaccountCount),
    futureLimitKey: PORTAL_USERS_LIMIT_KEY,
    limitScope: 'subaccounts',
    limitSource: limitConfig && limitConfig.source ? limitConfig.source : 'default_env'
  };
}

async function listPortalUsers(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const [users, limitConfig] = await Promise.all([
    listPortalUsersByClinicId(context.clinic.id),
    getClinicPortalSubaccountLimitById(context.clinic.id)
  ]);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    users,
    meta: buildPortalUsersMeta(users, limitConfig)
  };
}

async function invitePortalUser(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const name = normalizeString(payload && payload.name);
  const email = normalizeEmail(payload && payload.email);
  const role = normalizeRole(payload && payload.role);
  const password = normalizeString(payload && payload.password);

  if (!name || name.length < 2) return { ok: false, tenantId: context.tenantId, reason: 'invalid_name' };
  if (!email || !email.includes('@')) return { ok: false, tenantId: context.tenantId, reason: 'invalid_email' };
  if (!role) return { ok: false, tenantId: context.tenantId, reason: 'invalid_role' };
  if (!password || password.length < 6) return { ok: false, tenantId: context.tenantId, reason: 'invalid_password' };

  try {
    const created = await withTransaction(async (client) => {
      const [currentUsers, limitConfig] = await Promise.all([
        listPortalUsersByClinicId(context.clinic.id, client),
        getClinicPortalSubaccountLimitById(context.clinic.id, client)
      ]);
      const currentMeta = buildPortalUsersMeta(currentUsers, limitConfig);

      if (role !== 'owner' && currentMeta.subaccountCount >= currentMeta.subaccountLimit) {
        return {
          error: 'tenant_subaccount_limit_reached',
          meta: currentMeta
        };
      }

      const user = await createPortalUser(
        {
          clinicId: context.clinic.id,
          name,
          email,
          passwordHash: hashSync(password, 10),
          role
        },
        client
      );

      return {
        user,
        meta: buildPortalUsersMeta([...currentUsers, user], limitConfig)
      };
    });

    if (created && created.error) {
      return {
        ok: false,
        tenantId: context.tenantId,
        reason: created.error,
        meta: created.meta || null
      };
    }

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      user: created.user,
      meta: created.meta
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return { ok: false, tenantId: context.tenantId, reason: 'duplicate_user_email' };
    }
    throw error;
  }
}

async function updatePortalUser(tenantId, userId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const role = normalizeRole(payload && payload.role);
  if (!role) return { ok: false, tenantId: context.tenantId, reason: 'invalid_role' };

  const user = await withTransaction(async (client) => {
    const current = await listPortalUsersByClinicId(context.clinic.id, client);
    const target = current.find((item) => String(item.id) === String(userId));
    if (!target) return null;

    if (target.role === 'owner' && role !== 'owner') {
      const ownerCount = await countOwnersByClinicId(context.clinic.id, client);
      if (ownerCount <= 1) {
        const error = new Error('cannot_delete_last_owner');
        error.code = 'LAST_OWNER_ROLE_CHANGE';
        throw error;
      }
    }

    return updatePortalUserRole(
      {
        userId,
        clinicId: context.clinic.id,
        role
      },
      client
    );
  }).catch((error) => {
    if (error && error.code === 'LAST_OWNER_ROLE_CHANGE') {
      return { error: 'cannot_delete_last_owner' };
    }
    throw error;
  });

  if (!user) return { ok: false, tenantId: context.tenantId, reason: 'user_not_found' };
  if (user.error) return { ok: false, tenantId: context.tenantId, reason: user.error };

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    user
  };
}

async function deletePortalUser(tenantId, userId, currentUserId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  if (String(userId) === String(currentUserId)) {
    return { ok: false, tenantId: context.tenantId, reason: 'cannot_delete_current_user' };
  }

  const removed = await withTransaction(async (client) => {
    const current = await listPortalUsersByClinicId(context.clinic.id, client);
    const target = current.find((item) => String(item.id) === String(userId));
    if (!target) return null;

    if (target.role === 'owner') {
      const ownerCount = await countOwnersByClinicId(context.clinic.id, client);
      if (ownerCount <= 1) {
        const error = new Error('cannot_delete_last_owner');
        error.code = 'LAST_OWNER_DELETE';
        throw error;
      }
    }

    return deletePortalUserById(
      {
        userId,
        clinicId: context.clinic.id
      },
      client
    );
  }).catch((error) => {
    if (error && error.code === 'LAST_OWNER_DELETE') {
      return { error: 'cannot_delete_last_owner' };
    }
    throw error;
  });

  if (!removed) return { ok: false, tenantId: context.tenantId, reason: 'user_not_found' };
  if (removed.error) return { ok: false, tenantId: context.tenantId, reason: removed.error };

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    userId
  };
}

async function authenticatePortalUser(email, password) {
  const safeEmail = normalizeEmail(email);
  const safePassword = String(password || '');

  if (!safeEmail || !safePassword) {
    return { ok: false, reason: 'invalid_credentials' };
  }

  const user = await findPortalUserByEmail(safeEmail);
  if (!user || !user.passwordHash || user.active !== true) {
    return { ok: false, reason: 'invalid_credentials' };
  }

  let valid = false;
  try {
    valid = compareSync(safePassword, user.passwordHash);
  } catch {
    valid = false;
  }

  if (!valid) {
    return { ok: false, reason: 'invalid_credentials' };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      tenantId: user.tenantId,
      tenantRole: user.role,
      globalRole: 'client'
    }
  };
}

async function getPortalAuthUserByEmail(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) return { ok: false, reason: 'invalid_email' };

  const user = await findPortalUserByEmail(safeEmail);
  if (!user || user.active !== true) {
    return { ok: true, user: null };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      tenantId: user.tenantId,
      tenantRole: user.role,
      globalRole: 'client'
    }
  };
}

module.exports = {
  listPortalUsers,
  invitePortalUser,
  updatePortalUser,
  deletePortalUser,
  authenticatePortalUser,
  getPortalAuthUserByEmail
};
