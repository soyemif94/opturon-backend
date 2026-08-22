const crypto = require('crypto');
const { query, withTransaction } = require('../db/client');
const { maybeDecryptSecret, maybeEncryptSecret } = require('../utils/secret-crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function safeChannel(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    provider: row.provider,
    wabaId: row.wabaId,
    phoneNumberId: row.phoneNumberId,
    status: row.status
  };
}

async function readRotationState(target, client = null) {
  const db = client || { query };
  const channels = await db.query(
    `SELECT id, "clinicId", provider, "wabaId", "phoneNumberId", status, "accessToken"
       FROM channels
      WHERE id = ANY($1::uuid[])
      ORDER BY id`,
    [[target.channelId, target.legacyChannelId]]
  );
  const canonicalRow = channels.rows.find((row) => row.id === target.channelId) || null;
  const legacyRow = channels.rows.find((row) => row.id === target.legacyChannelId) || null;
  const owners = await db.query(
    `SELECT id, "clinicId", status
       FROM channels
      WHERE provider = 'whatsapp_cloud'
        AND "phoneNumberId" = $1
        AND LOWER(COALESCE(status, '')) = 'active'
      ORDER BY id`,
    [target.phoneNumberId]
  );
  const credential = canonicalRow ? maybeDecryptSecret(canonicalRow.accessToken) : null;
  return {
    canonical: safeChannel(canonicalRow),
    legacy: safeChannel(legacyRow),
    activeOwners: owners.rows.map((row) => ({ id: row.id, clinicId: row.clinicId, status: row.status })),
    credentialPresent: Boolean(credential),
    credentialFingerprint: credential ? sha256(credential) : null
  };
}

function assertTargetState(state, target) {
  const channel = state.canonical;
  if (!channel) throw new Error('canonical_channel_not_found');
  if (channel.id !== target.channelId) throw new Error('canonical_channel_id_drift');
  if (channel.clinicId !== target.clinicId) throw new Error('canonical_clinic_id_drift');
  if (channel.provider !== target.provider) throw new Error('canonical_provider_drift');
  if (channel.wabaId !== target.wabaId) throw new Error('canonical_waba_id_drift');
  if (channel.phoneNumberId !== target.phoneNumberId) throw new Error('canonical_phone_number_id_drift');
  if (String(channel.status || '').toLowerCase() !== 'active') throw new Error('canonical_status_drift');
  if (!state.legacy || state.legacy.id !== target.legacyChannelId) throw new Error('legacy_channel_not_found');
  if (String(state.legacy.status || '').toLowerCase() !== 'inactive') throw new Error('legacy_channel_not_inactive');
  if (state.activeOwners.length !== 1 || state.activeOwners[0].id !== target.channelId) {
    throw new Error('phone_number_active_owner_conflict');
  }
  if (!state.credentialPresent || !state.credentialFingerprint) throw new Error('canonical_credential_missing');
  return state;
}

async function rotateCredentialOnly(target, nextToken, validatePersistedCredential) {
  return withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`whatsapp-token-rotation:${target.channelId}`]);
    await client.query(
      `SELECT id
         FROM channels
        WHERE id = ANY($1::uuid[])
           OR (provider = 'whatsapp_cloud' AND "phoneNumberId" = $2)
        FOR UPDATE`,
      [[target.channelId, target.legacyChannelId], target.phoneNumberId]
    );
    const pre = assertTargetState(await readRotationState(target, client), target);
    const nextFingerprint = sha256(nextToken);
    if (pre.credentialFingerprint === nextFingerprint) throw new Error('credential_fingerprint_unchanged');

    const encryptedToken = maybeEncryptSecret(nextToken);
    const updated = await client.query(
      `UPDATE channels
          SET "accessToken" = $2
        WHERE id = $1::uuid
          AND "clinicId" = $3::uuid
          AND provider = $4
          AND "wabaId" = $5
          AND "phoneNumberId" = $6
          AND LOWER(COALESCE(status, '')) = 'active'
      RETURNING id, "clinicId", provider, "wabaId", "phoneNumberId", status, "accessToken"`,
      [target.channelId, encryptedToken, target.clinicId, target.provider, target.wabaId, target.phoneNumberId]
    );
    if (updated.rowCount !== 1) throw new Error('credential_rotation_guard_failed');

    const persistedToken = maybeDecryptSecret(updated.rows[0].accessToken, { allowLegacy: false });
    if (!persistedToken || sha256(persistedToken) !== nextFingerprint) {
      throw new Error('persisted_credential_decrypt_assertion_failed');
    }
    if (typeof validatePersistedCredential === 'function') {
      await validatePersistedCredential(persistedToken);
    }

    const post = assertTargetState(await readRotationState(target, client), target);
    if (post.credentialFingerprint !== nextFingerprint) throw new Error('credential_post_fingerprint_mismatch');
    return { pre, post };
  });
}

async function readPersistedCredential(target) {
  const result = await query(
    `SELECT id, "clinicId", provider, "wabaId", "phoneNumberId", status, "accessToken"
       FROM channels
      WHERE id = $1::uuid
        AND "clinicId" = $2::uuid
        AND provider = $3
        AND "wabaId" = $4
        AND "phoneNumberId" = $5
        AND LOWER(COALESCE(status, '')) = 'active'
      LIMIT 1`,
    [target.channelId, target.clinicId, target.provider, target.wabaId, target.phoneNumberId]
  );
  const row = result.rows[0] || null;
  if (!row) throw new Error('persisted_credential_channel_guard_failed');
  const accessToken = maybeDecryptSecret(row.accessToken, { allowLegacy: false });
  if (!accessToken) throw new Error('persisted_credential_decrypt_failed');
  return { channel: safeChannel(row), accessToken, credentialFingerprint: sha256(accessToken) };
}

module.exports = {
  sha256,
  readRotationState,
  assertTargetState,
  rotateCredentialOnly,
  readPersistedCredential
};
