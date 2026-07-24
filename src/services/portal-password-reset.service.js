const { createHash, randomBytes } = require('crypto');
const { hashSync } = require('bcryptjs');
const { withTransaction } = require('../db/client');
const {
  findResettablePortalUserByEmail,
  createPortalPasswordResetToken,
  revokePendingPortalPasswordResetTokensByUserId,
  findPortalPasswordResetTokenByHash,
  consumePortalPasswordResetTokenById,
  revokePortalPasswordResetTokenByHash
} = require('../repositories/portal-password-reset.repository');
const { updatePortalUserCredentialsById } = require('../repositories/portal-users.repository');
const { createPortalUserAuditEvent } = require('../repositories/portal-user-audit.repository');

const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MINUTES = 30;

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function hashToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function isEligiblePortalResetUser(user) {
  if (!user) return false;
  if (String(user.active) !== 'true' && user.active !== true) return false;
  if (normalizeString(user.accountScope).toLowerCase() === 'opturon_admin') return false;
  return true;
}

async function requestPortalPasswordReset(email, options = {}) {
  const safeEmail = normalizeEmail(email);
  const includeDelivery = options.includeDelivery === true;

  if (!safeEmail) {
    return { ok: true, delivery: null };
  }

  return withTransaction(async (client) => {
    const user = await findResettablePortalUserByEmail(safeEmail, client);
    if (!isEligiblePortalResetUser(user)) {
      return { ok: true, delivery: null };
    }

    await revokePendingPortalPasswordResetTokensByUserId(user.id, client);

    const plainToken = randomBytes(RESET_TOKEN_BYTES).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000).toISOString();
    await createPortalPasswordResetToken(
      {
        userId: user.id,
        tokenHash: hashToken(plainToken),
        expiresAt,
        metadata: {
          requestedForEmail: user.email,
          requestedFrom: options.requestedFrom || 'portal_auth_forgot_password'
        }
      },
      client
    );

    await createPortalUserAuditEvent(
      {
        tenantId: user.tenantId,
        clinicId: user.clinicId,
        actorUserId: null,
        targetUserId: user.id,
        action: 'tenant_portal_password_reset_requested',
        payload: {
          targetUserId: user.id,
          email: user.email,
          expiresAt
        }
      },
      client
    );

    return {
      ok: true,
      delivery: includeDelivery
        ? {
            email: user.email,
            token: plainToken,
            expiresAt
          }
        : null
    };
  });
}

async function validatePortalPasswordResetToken(token) {
  const safeToken = normalizeString(token);
  if (!safeToken || safeToken.length < 20) {
    return { ok: true, valid: false };
  }

  const record = await findPortalPasswordResetTokenByHash(hashToken(safeToken));
  if (!record) return { ok: true, valid: false };
  if (!isEligiblePortalResetUser(record)) return { ok: true, valid: false };
  if (record.consumedAt) return { ok: true, valid: false };

  const expiresAtMs = new Date(record.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
    return { ok: true, valid: false };
  }

  return { ok: true, valid: true };
}

async function resetPortalPassword(token, password) {
  const safeToken = normalizeString(token);
  const safePassword = String(password || '');
  if (!safeToken || safeToken.length < 20 || safePassword.length < 8) {
    return { ok: false, reason: 'invalid_or_expired_reset_token' };
  }

  return withTransaction(async (client) => {
    const record = await findPortalPasswordResetTokenByHash(hashToken(safeToken), client);
    if (!record || !isEligiblePortalResetUser(record)) {
      return { ok: false, reason: 'invalid_or_expired_reset_token' };
    }
    if (record.consumedAt) {
      return { ok: false, reason: 'invalid_or_expired_reset_token' };
    }

    const expiresAtMs = new Date(record.expiresAt).getTime();
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      return { ok: false, reason: 'invalid_or_expired_reset_token' };
    }

    const consumed = await consumePortalPasswordResetTokenById(record.id, client);
    if (!consumed) {
      return { ok: false, reason: 'invalid_or_expired_reset_token' };
    }

    const updatedUser = await updatePortalUserCredentialsById(
      {
        userId: record.userId,
        clinicId: record.clinicId,
        passwordHash: hashSync(safePassword, 10),
        active: true
      },
      client
    );
    if (!updatedUser) {
      return { ok: false, reason: 'invalid_or_expired_reset_token' };
    }

    await revokePendingPortalPasswordResetTokensByUserId(record.userId, client);
    await createPortalUserAuditEvent(
      {
        tenantId: record.tenantId,
        clinicId: record.clinicId,
        actorUserId: null,
        targetUserId: record.userId,
        action: 'tenant_portal_password_reset_completed',
        payload: {
          targetUserId: record.userId,
          email: record.email
        }
      },
      client
    );

    return { ok: true };
  });
}

async function invalidatePortalPasswordResetToken(token) {
  const safeToken = normalizeString(token);
  if (!safeToken || safeToken.length < 20) {
    return { ok: true, invalidated: false };
  }

  const revoked = await revokePortalPasswordResetTokenByHash(hashToken(safeToken));
  return {
    ok: true,
    invalidated: Boolean(revoked)
  };
}

module.exports = {
  requestPortalPasswordReset,
  validatePortalPasswordResetToken,
  resetPortalPassword,
  invalidatePortalPasswordResetToken
};
