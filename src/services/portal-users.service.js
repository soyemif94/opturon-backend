const { hashSync, compareSync } = require('bcryptjs');
const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  listPortalUsersByClinicId,
  createPortalUser,
  findPortalUserByEmail
} = require('../repositories/portal-users.repository');

const ALLOWED_ROLES = new Set(['owner', 'manager', 'editor', 'viewer']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeRole(value) {
  const normalized = normalizeString(value).toLowerCase();
  return ALLOWED_ROLES.has(normalized) ? normalized : null;
}

async function listPortalUsers(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const users = await listPortalUsersByClinicId(context.clinic.id);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    users
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
    const user = await withTransaction((client) =>
      createPortalUser(
        {
          clinicId: context.clinic.id,
          name,
          email,
          passwordHash: hashSync(password, 10),
          role
        },
        client
      )
    );

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      user
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return { ok: false, tenantId: context.tenantId, reason: 'duplicate_user_email' };
    }
    throw error;
  }
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

module.exports = {
  listPortalUsers,
  invitePortalUser,
  authenticatePortalUser
};
