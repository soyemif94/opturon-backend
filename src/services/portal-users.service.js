const { createHash, randomBytes } = require('crypto');
const { hashSync, compareSync } = require('bcryptjs');
const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  getClinicPortalAccountConfigById,
  updateClinicPortalPrimaryUserIdById,
  provisionCleanClinicForExternalTenant
} = require('../repositories/tenant.repository');
const {
  listPortalUsersByClinicId,
  listPortalUsersForManagementByClinicId,
  listPortalUsersForOpturonAdmin,
  createPortalUser,
  updatePortalUserAccountRootById,
  updatePortalUserCredentialsById,
  updatePortalUserClinicById,
  updatePortalUserProfileById,
  updatePortalUserRole,
  deletePortalUserById,
  findAnyPortalUserByEmail,
  findAnyPortalUserByEmailAndClinicId,
  findPortalUserByEmail,
  findPortalUserByEmailAndTenantId,
  findPortalUserById
} = require('../repositories/portal-users.repository');
const {
  createPortalUserInvitation,
  revokePendingPortalUserInvitationsByUserId,
  listLatestPortalUserInvitationsByClinicId,
  findPortalInvitationByTokenHash,
  markPortalInvitationAccepted
} = require('../repositories/portal-user-invitations.repository');
const {
  createPortalUserAuditEvent,
  listPortalUserAuditEventsByClinicId
} = require('../repositories/portal-user-audit.repository');
const { updateTenantPolicyByExternalTenantId } = require('./tenant-policy.service');
const {
  normalizePortalUserRole,
  isOperationalPortalAssigneeRole
} = require('../utils/portal-users');

const ALLOWED_ROLES = new Set(['owner', 'manager', 'seller', 'viewer']);
const PORTAL_USERS_LIMIT_KEY = 'tenant_portal_users';
const INVITATION_TOKEN_BYTES = 32;
const INVITATION_EXPIRES_IN_HOURS = 168;

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeRole(value) {
  const normalized = normalizePortalUserRole(value);
  return ALLOWED_ROLES.has(normalized) ? normalized : null;
}

function normalizeAccountScope(value) {
  return String(value || '').trim().toLowerCase() === 'opturon_admin' ? 'opturon_admin' : 'client';
}

function normalizeAuditActorId(value) {
  const safeValue = normalizeString(value);
  return safeValue || null;
}

function hashInvitationToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function generateInvitationToken() {
  return randomBytes(INVITATION_TOKEN_BYTES).toString('hex');
}

function buildInvitationExpiryDate() {
  return new Date(Date.now() + INVITATION_EXPIRES_IN_HOURS * 60 * 60 * 1000);
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

function buildProvisionedTenantId({ name, email }) {
  const emailLocalPart = normalizeEmail(email).split('@')[0] || '';
  const base = slugifyTenantToken(name) || slugifyTenantToken(emailLocalPart) || 'cliente';
  const suffix = Date.now().toString(36);
  return `tenant_${base}_${suffix}`;
}

function countSubaccounts(users) {
  return (Array.isArray(users) ? users : []).filter((user) => String(user && user.accountKind ? user.accountKind : '') !== 'primary').length;
}

function countPrimaryAccounts(users) {
  return (Array.isArray(users) ? users : []).filter((user) => String(user && user.accountKind ? user.accountKind : '') === 'primary').length;
}

function buildPortalUsersMeta(users, limitConfig, primaryPortalUserId = null) {
  const subaccountCount = countSubaccounts(users);
  const primaryAccountCount = countPrimaryAccounts(users);
  const unlimitedSubaccounts = Boolean(limitConfig && limitConfig.unlimitedSubaccounts);
  const subaccountLimit = unlimitedSubaccounts ? null : Number(limitConfig && limitConfig.subaccountLimit) || 0;
  const remainingSubaccounts = unlimitedSubaccounts ? null : Math.max(0, subaccountLimit - subaccountCount);

  return {
    subaccountCount,
    primaryAccountCount,
    primaryPortalUserId: primaryPortalUserId || null,
    subaccountLimit,
    remainingSubaccounts,
    futureLimitKey: PORTAL_USERS_LIMIT_KEY,
    limitScope: unlimitedSubaccounts ? 'opturon_admin' : 'subaccounts',
    limitApplies: !unlimitedSubaccounts,
    accountScope: limitConfig && limitConfig.accountScope ? limitConfig.accountScope : 'client',
    unlimitedSubaccounts,
    limitSource: limitConfig && limitConfig.source ? limitConfig.source : 'default_env'
  };
}

function normalizePortalUserRecord(user, primaryPortalUserId) {
  const safePrimaryId = String(primaryPortalUserId || '').trim();
  return {
    ...user,
    accountKind: safePrimaryId && String(user.id) === safePrimaryId ? 'primary' : 'subaccount',
    isOperationalAssignee: isOperationalPortalAssigneeRole(user.role)
  };
}

function resolvePortalUserInvitationStatus(user, invitation) {
  if (user && user.active === true) return 'active';
  if (!invitation) return 'invited';
  if (invitation.acceptedAt) return 'active';
  if (invitation.revokedAt) return 'invited';
  const expiresAtMs = new Date(invitation.expiresAt).getTime();
  if (!Number.isNaN(expiresAtMs) && expiresAtMs <= Date.now()) {
    return 'expired';
  }
  return 'pending';
}

function enrichPortalUserRecord(user, primaryPortalUserId, invitation = null) {
  const normalized = normalizePortalUserRecord(user, primaryPortalUserId);
  return {
    ...normalized,
    invitationStatus: resolvePortalUserInvitationStatus(user, invitation),
    invitationExpiresAt: invitation ? invitation.expiresAt : null,
    invitationSentAt: invitation ? invitation.createdAt : null
  };
}

function normalizeAdminPortalUserRecord(user) {
  return {
    ...user,
    accountKind: String(user.role || '').toLowerCase() === 'owner' ? 'primary' : 'subaccount',
    isOperationalAssignee: isOperationalPortalAssigneeRole(user.role)
  };
}

function filterClientScopedPortalUsers(users, accountConfig) {
  const currentUsers = Array.isArray(users) ? users : [];
  if (!accountConfig || accountConfig.accountScope !== 'client' || !accountConfig.primaryPortalUserId) {
    return currentUsers;
  }

  const rootId = String(accountConfig.primaryPortalUserId);
  const scopedUsers = currentUsers.filter((user) => {
    return normalizeString(user.accountRootUserId) === rootId;
  });

  if (scopedUsers.length > 0) {
    return scopedUsers;
  }

  // Keep client-scoped workspaces operable if legacy root pointers became orphaned.
  return currentUsers;
}

function assertRootBelongsToClinic(users, accountConfig, clinicId) {
  const rootId = normalizeString(accountConfig && accountConfig.primaryPortalUserId);
  if (!rootId) return;
  const rootUser = (Array.isArray(users) ? users : []).find((user) => String(user.id) === rootId);
  if (!rootUser || String(rootUser.clinicId) !== String(clinicId)) {
    const error = new Error('portal_user_account_root_invalid');
    error.code = 'PORTAL_USER_ACCOUNT_ROOT_INVALID';
    throw error;
  }
}

function countOwners(users) {
  return (Array.isArray(users) ? users : []).filter((user) => String(user && user.role ? user.role : '').toLowerCase() === 'owner').length;
}

async function resolvePrimaryPortalUserId(clinicId, users, client = null) {
  const config = await getClinicPortalAccountConfigById(clinicId, client);
  const currentUsers = Array.isArray(users) ? users : [];
  const explicitPrimaryId = String(config.primaryPortalUserId || '').trim() || null;
  const explicitPrimaryExists = explicitPrimaryId
    ? currentUsers.some((user) => String(user.id) === explicitPrimaryId)
    : false;

  if (explicitPrimaryExists) {
    return {
      primaryPortalUserId: explicitPrimaryId,
      subaccountLimit: config.subaccountLimit,
      unlimitedSubaccounts: config.unlimitedSubaccounts,
      accountScope: config.accountScope,
      limitSource: config.limitSource,
      source: 'clinic_settings'
    };
  }

  const ownerUser = currentUsers.find((user) => String(user.role || '').toLowerCase() === 'owner') || null;
  const firstPortalUser = ownerUser || currentUsers[0] || null;
  const inferredPrimaryId = firstPortalUser ? String(firstPortalUser.id) : null;

  if (inferredPrimaryId) {
    await updateClinicPortalPrimaryUserIdById(clinicId, inferredPrimaryId, client);
  }

  return {
    primaryPortalUserId: inferredPrimaryId,
    subaccountLimit: config.subaccountLimit,
    unlimitedSubaccounts: config.unlimitedSubaccounts,
    accountScope: config.accountScope,
    limitSource: config.limitSource,
    source: inferredPrimaryId ? (ownerUser ? 'backfilled_owner' : 'backfilled_first_portal_user') : 'none'
  };
}

async function listPortalUsers(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const currentUsers = await listPortalUsersForManagementByClinicId(context.clinic.id);
  const accountConfig = await resolvePrimaryPortalUserId(context.clinic.id, currentUsers);
  const latestInvitations = await listLatestPortalUserInvitationsByClinicId(context.clinic.id);
  const invitationsByUserId = new Map(
    (Array.isArray(latestInvitations) ? latestInvitations : []).map((invitation) => [String(invitation.userId), invitation])
  );

  if (accountConfig.accountScope === 'opturon_admin') {
    const users = (await listPortalUsersForOpturonAdmin()).map((user) =>
      enrichPortalUserRecord(user, user.role === 'owner' ? user.id : accountConfig.primaryPortalUserId, invitationsByUserId.get(String(user.id)) || null)
    );
    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      users,
      activity: await listPortalUserAuditEventsByClinicId(context.clinic.id, 10),
      meta: buildPortalUsersMeta(
        users,
        {
          subaccountLimit: accountConfig.subaccountLimit,
          unlimitedSubaccounts: true,
          accountScope: accountConfig.accountScope,
          source: accountConfig.limitSource
        },
        accountConfig.primaryPortalUserId
      )
    };
  }

  const scopedUsers = filterClientScopedPortalUsers(currentUsers, accountConfig);
  const users = scopedUsers.map((user) =>
    enrichPortalUserRecord(user, accountConfig.primaryPortalUserId, invitationsByUserId.get(String(user.id)) || null)
  );
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    users,
    activity: await listPortalUserAuditEventsByClinicId(context.clinic.id, 10),
    meta: buildPortalUsersMeta(
      users,
      {
        subaccountLimit: accountConfig.subaccountLimit,
        unlimitedSubaccounts: accountConfig.unlimitedSubaccounts,
        accountScope: accountConfig.accountScope,
        source: accountConfig.limitSource
      },
      accountConfig.primaryPortalUserId
    )
  };
}

async function invitePortalUser(tenantId, payload, options = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const name = normalizeString(payload && payload.name);
  const email = normalizeEmail(payload && payload.email);
  const role = normalizeRole(payload && payload.role);
  const password = normalizeString(payload && payload.password);
  const tenantName = normalizeString(payload && payload.tenantName);

  if (!name || name.length < 2) return { ok: false, tenantId: context.tenantId, reason: 'invalid_name' };
  if (!email || !email.includes('@')) return { ok: false, tenantId: context.tenantId, reason: 'invalid_email' };
  if (!role) return { ok: false, tenantId: context.tenantId, reason: 'invalid_role' };
  if (password && password.length < 6) return { ok: false, tenantId: context.tenantId, reason: 'invalid_password' };

  const actorUserId = normalizeAuditActorId(options.actorUserId);
  const invitationToken = generateInvitationToken();
  const invitationTokenHash = hashInvitationToken(invitationToken);
  const invitationExpiresAt = buildInvitationExpiryDate();

  try {
    const created = await withTransaction(async (client) => {
      const currentUsers = await listPortalUsersForManagementByClinicId(context.clinic.id, client);
      const accountConfig = await resolvePrimaryPortalUserId(context.clinic.id, currentUsers, client);

      if (accountConfig.accountScope === 'opturon_admin' && role === 'owner') {
        const existingPortalUser = await findAnyPortalUserByEmail(email, client);
        const reusableClientOwner =
          existingPortalUser &&
          normalizeAccountScope(existingPortalUser.accountScope) === 'client' &&
          String(existingPortalUser.role || '').toLowerCase() === 'owner' &&
          existingPortalUser.active === true &&
          String(existingPortalUser.accountRootUserId || '') === String(existingPortalUser.id || '')
            ? existingPortalUser
            : null;

        const provisionedTenantId = reusableClientOwner
          ? String(reusableClientOwner.tenantId || '').trim()
          : buildProvisionedTenantId({ name, email });
        const targetClinic = await provisionCleanClinicForExternalTenant(
          {
            externalTenantId: provisionedTenantId,
            name: tenantName || name,
            timezone: context.clinic.timezone || 'America/Argentina/Buenos_Aires'
          },
          client
        );

        await updateTenantPolicyByExternalTenantId(
          provisionedTenantId,
          {
            operatingProfile: payload && payload.operatingProfile,
            capabilities: payload && payload.capabilities,
            enabledModules: payload && payload.enabledModules,
            displayName: tenantName || name
          },
          {
            client,
            mode: 'admin',
            actorUserId,
            actorRole: 'opturon_admin',
            actorScope: 'opturon_admin',
            action: 'tenant_policy_initialized_on_owner_invite',
            source: 'portal_users_service'
          }
        );

        let createdUser = reusableClientOwner;
        if (!createdUser) {
          createdUser = await createPortalUser(
            {
              clinicId: targetClinic.id,
              name,
              email,
              passwordHash: password ? hashSync(password, 10) : null,
              role,
              active: Boolean(password),
              accountRootUserId: null
            },
            client
          );
        } else {
          if (createdUser.clinicId !== targetClinic.id) {
            createdUser = await updatePortalUserClinicById(
              {
                userId: createdUser.id,
                currentClinicId: createdUser.clinicId,
                nextClinicId: targetClinic.id,
                accountRootUserId: createdUser.id
              },
              client
            ) || createdUser;
          }
          if (name && name !== String(createdUser.name || '').trim()) {
            createdUser = await updatePortalUserProfileById(
              {
                userId: createdUser.id,
                clinicId: targetClinic.id,
                name
              },
              client
            ) || createdUser;
          }
          if (String(createdUser.role || '').toLowerCase() !== 'owner') {
            createdUser = await updatePortalUserRole(
              {
                userId: createdUser.id,
                clinicId: targetClinic.id,
                role: 'owner'
              },
              client
            ) || createdUser;
          }
          if (!password) {
            createdUser = await updatePortalUserCredentialsById(
              {
                userId: createdUser.id,
                clinicId: targetClinic.id,
                passwordHash: null,
                active: false
              },
              client
            ) || createdUser;
          }
        }

        await updateClinicPortalPrimaryUserIdById(targetClinic.id, createdUser.id, client);
        createdUser = await updatePortalUserAccountRootById(
          {
            userId: createdUser.id,
            clinicId: targetClinic.id,
            accountRootUserId: createdUser.id
          },
          client
        ) || createdUser;

        const targetAccountConfig = await getClinicPortalAccountConfigById(targetClinic.id, client);
        const normalizedCreatedUser = normalizePortalUserRecord(createdUser, createdUser.id);
        const targetMeta = buildPortalUsersMeta(
          [normalizedCreatedUser],
          {
            subaccountLimit: targetAccountConfig.subaccountLimit,
            unlimitedSubaccounts: targetAccountConfig.unlimitedSubaccounts,
            accountScope: targetAccountConfig.accountScope,
            source: targetAccountConfig.limitSource
          },
          createdUser.id
        );

        if (!password) {
          await revokePendingPortalUserInvitationsByUserId(createdUser.id, client);
          const invitation = await createPortalUserInvitation(
            {
              clinicId: targetClinic.id,
              tenantId: provisionedTenantId,
              userId: createdUser.id,
              email,
              role,
              tokenHash: invitationTokenHash,
              expiresAt: invitationExpiresAt.toISOString(),
              createdByUserId: actorUserId
            },
            client
          );

          await createPortalUserAuditEvent(
            {
              tenantId: provisionedTenantId,
              clinicId: targetClinic.id,
              actorUserId,
              targetUserId: createdUser.id,
              action: 'tenant_portal_user_invited',
              payload: {
                targetUserId: createdUser.id,
                name: createdUser.name,
                email: createdUser.email,
                role: createdUser.role,
                accountKind: normalizedCreatedUser.accountKind,
                invitationExpiresAt: invitation.expiresAt,
                managedFrom: 'opturon_admin',
                provisionedTenantId,
                reusedClientTenant: Boolean(reusableClientOwner)
              }
            },
            client
          );

          return {
            tenantId: provisionedTenantId,
            clinic: targetClinic,
            user: enrichPortalUserRecord(createdUser, createdUser.id, invitation),
            invitation: {
              token: invitationToken,
              expiresAt: invitation.expiresAt,
              sentAt: invitation.createdAt
            },
            meta: targetMeta
          };
        }

        await createPortalUserAuditEvent(
          {
            tenantId: provisionedTenantId,
            clinicId: targetClinic.id,
            actorUserId,
            targetUserId: createdUser.id,
            action: 'tenant_portal_user_created',
            payload: {
              targetUserId: createdUser.id,
              name: createdUser.name,
              email: createdUser.email,
              role: createdUser.role,
              accountKind: normalizedCreatedUser.accountKind,
              managedFrom: 'opturon_admin',
              provisionedTenantId,
              reusedClientTenant: Boolean(reusableClientOwner)
            }
          },
          client
        );

        return {
          tenantId: provisionedTenantId,
          clinic: targetClinic,
          user: normalizedCreatedUser,
          meta: targetMeta
        };
      }

      assertRootBelongsToClinic(currentUsers, accountConfig, context.clinic.id);
      const scopedCurrentUsers = filterClientScopedPortalUsers(currentUsers, accountConfig);
      const normalizedCurrentUsers = scopedCurrentUsers.map((user) =>
        normalizePortalUserRecord(user, accountConfig.primaryPortalUserId)
      );
      const currentMeta = buildPortalUsersMeta(
        normalizedCurrentUsers,
        {
          subaccountLimit: accountConfig.subaccountLimit,
          unlimitedSubaccounts: accountConfig.unlimitedSubaccounts,
          accountScope: accountConfig.accountScope,
          source: accountConfig.limitSource
        },
        accountConfig.primaryPortalUserId
      );

      const isPrimarySlotTaken = Boolean(accountConfig.primaryPortalUserId);
      if (currentMeta.limitApplies && isPrimarySlotTaken && currentMeta.subaccountCount >= currentMeta.subaccountLimit) {
        return {
          error: 'tenant_subaccount_limit_reached',
          meta: currentMeta
        };
      }

      let targetUser = await findAnyPortalUserByEmailAndClinicId(email, context.clinic.id, client);
      if (targetUser && targetUser.active === true) {
        return {
          error: 'duplicate_user_email'
        };
      }

      if (!targetUser) {
        targetUser = await createPortalUser(
          {
            clinicId: context.clinic.id,
            name,
            email,
            passwordHash: null,
            role,
            active: false,
            accountRootUserId: isPrimarySlotTaken ? accountConfig.primaryPortalUserId : null
          },
          client
        );
      } else {
        if (name && name !== String(targetUser.name || '').trim()) {
          targetUser = await updatePortalUserProfileById(
            {
              userId: targetUser.id,
              clinicId: context.clinic.id,
              name
            },
            client
          ) || targetUser;
        }
        if (role && role !== String(targetUser.role || '').toLowerCase()) {
          targetUser = await updatePortalUserRole(
            {
              userId: targetUser.id,
              clinicId: context.clinic.id,
              role
            },
            client
          ) || targetUser;
        }
        targetUser = await updatePortalUserCredentialsById(
          {
            userId: targetUser.id,
            clinicId: context.clinic.id,
            passwordHash: null,
            active: false
          },
          client
        ) || targetUser;
      }

      const primaryPortalUserId = isPrimarySlotTaken ? accountConfig.primaryPortalUserId : targetUser.id;
      if (!isPrimarySlotTaken && primaryPortalUserId) {
        await updateClinicPortalPrimaryUserIdById(context.clinic.id, primaryPortalUserId, client);
        targetUser = await updatePortalUserAccountRootById(
          {
            userId: targetUser.id,
            clinicId: context.clinic.id,
            accountRootUserId: primaryPortalUserId
          },
          client
        ) || targetUser;
      }

      if (isPrimarySlotTaken && normalizeString(targetUser.accountRootUserId) !== normalizeString(primaryPortalUserId)) {
        targetUser = await updatePortalUserAccountRootById(
          {
            userId: targetUser.id,
            clinicId: context.clinic.id,
            accountRootUserId: primaryPortalUserId
          },
          client
        ) || targetUser;
      }

      await revokePendingPortalUserInvitationsByUserId(targetUser.id, client);
      const invitation = await createPortalUserInvitation(
        {
          clinicId: context.clinic.id,
          tenantId: context.tenantId,
          userId: targetUser.id,
          email,
          role,
          tokenHash: invitationTokenHash,
          expiresAt: invitationExpiresAt.toISOString(),
          createdByUserId: actorUserId
        },
        client
      );

      const scopedNextUsers = scopedCurrentUsers.some((user) => String(user.id) === String(targetUser.id))
        ? scopedCurrentUsers.map((user) => (String(user.id) === String(targetUser.id) ? targetUser : user))
        : [...scopedCurrentUsers, targetUser];
      const normalizedNextUsers = scopedNextUsers.map((user) =>
        normalizePortalUserRecord(user, primaryPortalUserId)
      );
      const normalizedCreatedUser = enrichPortalUserRecord(targetUser, primaryPortalUserId, invitation);

      await createPortalUserAuditEvent(
        {
          tenantId: context.tenantId,
          clinicId: context.clinic.id,
          actorUserId,
          targetUserId: targetUser.id,
          action: 'tenant_portal_user_invited',
          payload: {
            targetUserId: targetUser.id,
            name: targetUser.name,
            email: targetUser.email,
            role: targetUser.role,
            accountKind: normalizedCreatedUser.accountKind,
            invitationExpiresAt: invitation.expiresAt
          }
        },
        client
      );

      return {
        user: normalizedCreatedUser,
        invitation: {
          token: invitationToken,
          expiresAt: invitation.expiresAt,
          sentAt: invitation.createdAt
        },
        meta: buildPortalUsersMeta(
          normalizedNextUsers,
          {
            subaccountLimit: accountConfig.subaccountLimit,
            unlimitedSubaccounts: accountConfig.unlimitedSubaccounts,
            accountScope: accountConfig.accountScope,
            source: accountConfig.limitSource
          },
          primaryPortalUserId
        )
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
      tenantId: created.tenantId || context.tenantId,
      clinic: created.clinic
        ? {
            id: created.clinic.id,
            name: created.clinic.name || null,
            timezone: created.clinic.timezone || null,
            externalTenantId: created.clinic.externalTenantId || null
          }
        : context.clinic,
      user: created.user,
      invitation: created.invitation || null,
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

  const name = normalizeString(payload && payload.name);
  const role = normalizeRole(payload && payload.role);
  const actorUserId = normalizeAuditActorId(payload && payload.actorUserId);
  if (!name && !role) return { ok: false, tenantId: context.tenantId, reason: 'missing_user_patch' };
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'name') && (!name || name.length < 2)) {
    return { ok: false, tenantId: context.tenantId, reason: 'invalid_name' };
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'role') && !role) {
    return { ok: false, tenantId: context.tenantId, reason: 'invalid_role' };
  }

  const user = await withTransaction(async (client) => {
    const current = await listPortalUsersByClinicId(context.clinic.id, client);
    const accountConfig = await resolvePrimaryPortalUserId(context.clinic.id, current, client);

    if (accountConfig.accountScope === 'opturon_admin') {
      const visibleUsers = await listPortalUsersForOpturonAdmin(client);
      const visibleTarget = visibleUsers.find((item) => String(item.id) === String(userId)) || null;
      if (!visibleTarget) return null;

      const target = await findPortalUserById(userId, client);
      if (!target) return null;
      if (role === 'owner' && String(target.role || '').toLowerCase() !== 'owner') {
        return { error: 'invalid_role_for_opturon_admin' };
      }
      const previousRole = target.role;
      const previousName = target.name;
      let updatedUser = target;

      if (name && name !== String(target.name || '').trim()) {
        updatedUser = await updatePortalUserProfileById(
          {
            userId,
            clinicId: target.clinicId,
            name
          },
          client
        ) || updatedUser;
      }

      if (role && role !== String(updatedUser.role || '').toLowerCase()) {
        updatedUser = await updatePortalUserRole(
          {
            userId,
            clinicId: target.clinicId,
            role
          },
          client
        ) || updatedUser;
      }

      if (updatedUser) {
        if (name && name !== previousName) {
          await createPortalUserAuditEvent(
            {
              tenantId: context.tenantId,
              clinicId: target.clinicId,
              actorUserId,
              targetUserId: updatedUser.id,
              action: 'tenant_portal_user_profile_updated',
              payload: {
                targetUserId: updatedUser.id,
                previousName,
                nextName: updatedUser.name,
                managedFrom: 'opturon_admin'
              }
            },
            client
          );
        }
        if (role && role !== String(previousRole || '').toLowerCase()) {
          await createPortalUserAuditEvent(
            {
              tenantId: context.tenantId,
              clinicId: target.clinicId,
              actorUserId,
              targetUserId: updatedUser.id,
              action: 'tenant_portal_user_role_updated',
              payload: {
                targetUserId: updatedUser.id,
                name: updatedUser.name,
                previousRole,
                nextRole: updatedUser.role,
                managedFrom: 'opturon_admin'
              }
            },
            client
          );
        }
      }
      return updatedUser;
    }

    assertRootBelongsToClinic(current, accountConfig, context.clinic.id);
    const scopedCurrent = filterClientScopedPortalUsers(current, accountConfig);
    const target = scopedCurrent.find((item) => String(item.id) === String(userId));
    if (!target) return null;
    const previousRole = target.role;
    const previousName = target.name;

    if (role && target.role === 'owner' && role !== 'owner') {
      if (countOwners(scopedCurrent) <= 1) {
        const error = new Error('cannot_delete_last_owner');
        error.code = 'LAST_OWNER_ROLE_CHANGE';
        throw error;
      }
    }

    let updatedUser = target;
    if (name && name !== String(target.name || '').trim()) {
      updatedUser = await updatePortalUserProfileById(
        {
          userId,
          clinicId: context.clinic.id,
          name
        },
        client
      ) || updatedUser;
    }
    if (role && role !== String(updatedUser.role || '').toLowerCase()) {
      updatedUser = await updatePortalUserRole(
        {
          userId,
          clinicId: context.clinic.id,
          role
        },
        client
      ) || updatedUser;
    }
    if (updatedUser) {
      if (name && name !== previousName) {
        await createPortalUserAuditEvent(
          {
            tenantId: context.tenantId,
            clinicId: context.clinic.id,
            actorUserId,
            targetUserId: updatedUser.id,
            action: 'tenant_portal_user_profile_updated',
            payload: {
              targetUserId: updatedUser.id,
              previousName,
              nextName: updatedUser.name
            }
          },
          client
        );
      }
      if (role && role !== String(previousRole || '').toLowerCase()) {
        await createPortalUserAuditEvent(
          {
            tenantId: context.tenantId,
            clinicId: context.clinic.id,
            actorUserId,
            targetUserId: updatedUser.id,
            action: 'tenant_portal_user_role_updated',
            payload: {
              targetUserId: updatedUser.id,
              name: updatedUser.name,
              previousRole,
              nextRole: updatedUser.role
            }
          },
          client
        );
      }
    }
    return updatedUser;
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

async function assignPrimaryPortalUser(tenantId, userId, options = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeUserId = normalizeString(userId);
  const actorUserId = normalizeAuditActorId(options.actorUserId);
  if (!safeUserId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_user_id' };
  }

  const result = await withTransaction(async (client) => {
    const currentUsers = await listPortalUsersByClinicId(context.clinic.id, client);
    const accountConfig = await getClinicPortalAccountConfigById(context.clinic.id, client);
    assertRootBelongsToClinic(currentUsers, accountConfig, context.clinic.id);
    const scopedCurrentUsers = filterClientScopedPortalUsers(currentUsers, accountConfig);
    const target = scopedCurrentUsers.find((item) => String(item.id) === safeUserId);
    if (!target) return null;
    const previousPrimaryUserId = accountConfig.primaryPortalUserId || null;

    await updateClinicPortalPrimaryUserIdById(context.clinic.id, safeUserId, client);
    for (const user of scopedCurrentUsers) {
      await updatePortalUserAccountRootById(
        {
          userId: user.id,
          clinicId: context.clinic.id,
          accountRootUserId: safeUserId
        },
        client
      );
    }
    const normalizedUsers = scopedCurrentUsers.map((user) => normalizePortalUserRecord({
      ...user,
      accountRootUserId: safeUserId
    }, safeUserId));
    await createPortalUserAuditEvent(
      {
        tenantId: context.tenantId,
        clinicId: context.clinic.id,
        actorUserId,
        targetUserId: safeUserId,
        action: 'tenant_primary_portal_user_changed',
        payload: {
          targetUserId: safeUserId,
          name: target.name,
          previousPrimaryUserId,
          nextPrimaryUserId: safeUserId
        }
      },
      client
    );

    return {
      user: normalizePortalUserRecord(target, safeUserId),
      meta: buildPortalUsersMeta(
        normalizedUsers,
        {
          subaccountLimit: accountConfig.subaccountLimit,
          unlimitedSubaccounts: accountConfig.unlimitedSubaccounts,
          accountScope: accountConfig.accountScope,
          source: accountConfig.limitSource
        },
        safeUserId
      )
    };
  });

  if (!result) {
    return { ok: false, tenantId: context.tenantId, reason: 'user_not_found' };
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    user: result.user,
    meta: result.meta
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

  const actorUserId = normalizeAuditActorId(currentUserId);

  const removed = await withTransaction(async (client) => {
    const current = await listPortalUsersByClinicId(context.clinic.id, client);
    const accountConfig = await resolvePrimaryPortalUserId(context.clinic.id, current, client);

    if (accountConfig.accountScope === 'opturon_admin') {
      const target = await findPortalUserById(userId, client);
      if (!target) return null;
      await createPortalUserAuditEvent(
        {
          tenantId: context.tenantId,
          clinicId: target.clinicId,
          actorUserId,
          targetUserId: target.id,
          action: 'tenant_portal_user_deleted',
          payload: {
            targetUserId: target.id,
            name: target.name,
            email: target.email,
            role: target.role,
            managedFrom: 'opturon_admin'
          }
        },
        client
      );
      return deletePortalUserById(
        {
          userId,
          clinicId: target.clinicId
        },
        client
      );
    }

    assertRootBelongsToClinic(current, accountConfig, context.clinic.id);
    const scopedCurrent = filterClientScopedPortalUsers(current, accountConfig);
    const target = scopedCurrent.find((item) => String(item.id) === String(userId));
    if (!target) return null;

    if (accountConfig.primaryPortalUserId && String(target.id) === String(accountConfig.primaryPortalUserId)) {
      const error = new Error('cannot_delete_primary_account');
      error.code = 'PRIMARY_ACCOUNT_DELETE';
      throw error;
    }

    if (target.role === 'owner') {
      if (countOwners(scopedCurrent) <= 1) {
        const error = new Error('cannot_delete_last_owner');
        error.code = 'LAST_OWNER_DELETE';
        throw error;
      }
    }

    await createPortalUserAuditEvent(
      {
        tenantId: context.tenantId,
        clinicId: context.clinic.id,
        actorUserId,
        targetUserId: target.id,
        action: 'tenant_portal_user_deleted',
        payload: {
          targetUserId: target.id,
          name: target.name,
          email: target.email,
          role: target.role,
          accountKind:
            accountConfig.primaryPortalUserId && String(target.id) === String(accountConfig.primaryPortalUserId)
              ? 'primary'
              : 'subaccount'
        }
      },
      client
    );

    const deleted = await deletePortalUserById(
      {
        userId,
        clinicId: context.clinic.id
      },
      client
    );
    return deleted;
  }).catch((error) => {
    if (error && error.code === 'LAST_OWNER_DELETE') {
      return { error: 'cannot_delete_last_owner' };
    }
    if (error && error.code === 'PRIMARY_ACCOUNT_DELETE') {
      return { error: 'cannot_delete_primary_account' };
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

async function resolvePortalInvitation(token) {
  const safeToken = normalizeString(token);
  if (!safeToken || safeToken.length < 20) {
    return { ok: false, reason: 'invalid_or_expired_invitation' };
  }

  const invitation = await findPortalInvitationByTokenHash(hashInvitationToken(safeToken));
  if (!invitation) {
    return { ok: false, reason: 'invalid_or_expired_invitation' };
  }

  if (invitation.acceptedAt || invitation.revokedAt) {
    return { ok: false, reason: 'invalid_or_expired_invitation' };
  }

  const expiresAtMs = new Date(invitation.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
    return { ok: false, reason: 'invalid_or_expired_invitation' };
  }

  return {
    ok: true,
    invitation: {
      tenantId: invitation.tenantId,
      tenantName: invitation.clinicName || null,
      clinicId: invitation.clinicId,
      userId: invitation.userId,
      email: invitation.email,
      name: invitation.userName || null,
      role: invitation.role,
      expiresAt: invitation.expiresAt
    }
  };
}

async function acceptPortalInvitation(token, password) {
  const safeToken = normalizeString(token);
  const safePassword = String(password || '');
  if (!safeToken || safeToken.length < 20 || safePassword.length < 8) {
    return { ok: false, reason: 'invalid_invitation_acceptance' };
  }

  const invitationHash = hashInvitationToken(safeToken);
  const accepted = await withTransaction(async (client) => {
    const invitation = await findPortalInvitationByTokenHash(invitationHash, client);
    if (!invitation) return { error: 'invalid_or_expired_invitation' };
    if (invitation.acceptedAt || invitation.revokedAt) return { error: 'invalid_or_expired_invitation' };

    const expiresAtMs = new Date(invitation.expiresAt).getTime();
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      return { error: 'invalid_or_expired_invitation' };
    }

    const activatedUser = await updatePortalUserCredentialsById(
      {
        userId: invitation.userId,
        clinicId: invitation.clinicId,
        passwordHash: hashSync(safePassword, 10),
        active: true
      },
      client
    );
    if (!activatedUser) return { error: 'invited_user_not_found' };

    await markPortalInvitationAccepted(invitation.id, client);
    await revokePendingPortalUserInvitationsByUserId(invitation.userId, client);

    await createPortalUserAuditEvent(
      {
        tenantId: invitation.tenantId,
        clinicId: invitation.clinicId,
        actorUserId: invitation.userId,
        targetUserId: invitation.userId,
        action: 'tenant_portal_user_invitation_accepted',
        payload: {
          targetUserId: invitation.userId,
          email: invitation.email,
          role: invitation.role
        }
      },
      client
    );

    return {
      tenantId: invitation.tenantId,
      tenantName: invitation.clinicName || null,
      user: activatedUser
    };
  });

  if (!accepted || accepted.error) {
    return { ok: false, reason: accepted && accepted.error ? accepted.error : 'invalid_or_expired_invitation' };
  }

  return {
    ok: true,
    tenantId: accepted.tenantId,
    tenantName: accepted.tenantName,
    user: {
      id: accepted.user.id,
      email: accepted.user.email,
      name: accepted.user.name,
      role: accepted.user.role
    }
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

  if (normalizeAccountScope(user.accountScope) === 'opturon_admin') {
    return { ok: false, reason: 'portal_admin_scope_requires_staff' };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      tenantId: user.tenantId,
      tenantRole: user.role,
      globalRole: 'client',
      accountScope: normalizeAccountScope(user.accountScope)
    }
  };
}

async function getPortalAuthUserByEmail(email, tenantId = null) {
  const safeEmail = normalizeEmail(email);
  const safeTenantId = normalizeString(tenantId);
  if (!safeEmail) return { ok: false, reason: 'invalid_email' };
  // `staff_users.email` is globally unique, so server-side recovery by email is safe
  // for restoring tenant-scoped sessions that lost `tenantId` in the signed JWT.
  const user = safeTenantId
    ? await findPortalUserByEmailAndTenantId(safeEmail, safeTenantId)
    : await findPortalUserByEmail(safeEmail);
  if (!user || user.active !== true) {
    return { ok: true, user: null };
  }

  if (normalizeAccountScope(user.accountScope) === 'opturon_admin') {
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
      globalRole: 'client',
      accountScope: normalizeAccountScope(user.accountScope)
    }
  };
}

module.exports = {
  listPortalUsers,
  invitePortalUser,
  assignPrimaryPortalUser,
  updatePortalUser,
  deletePortalUser,
  resolvePortalInvitation,
  acceptPortalInvitation,
  authenticatePortalUser,
  getPortalAuthUserByEmail,
  isOperationalPortalAssigneeRole
};
