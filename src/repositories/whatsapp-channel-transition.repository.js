const { query, withTransaction } = require('../db/client');
const { maybeDecryptSecret, maybeEncryptSecret } = require('../utils/secret-crypto');

function dbQuery(client, sql, params) {
  return client && typeof client.query === 'function' ? client.query(sql, params) : query(sql, params);
}

function mapTransition(row) {
  if (!row) return null;
  return {
    ...row,
    snapshot: row.snapshot && typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot,
    accessToken: row.accessToken ? maybeDecryptSecret(row.accessToken) : null
  };
}

async function findTransitionChannelContext(externalTenantId) {
  const result = await query(
    `SELECT c.id AS "clinicId", c."externalTenantId", c.settings,
            ch.id AS "channelId", ch.provider, ch."phoneNumberId", ch."wabaId",
            ch."connectionMode", ch.status AS "channelStatus", ch."displayPhoneNumber",
            ch."verifiedName", ch."connectionSource", ch."connectionMetadata", ch."accessToken"
     FROM clinics c
     JOIN channels ch ON ch."clinicId" = c.id AND ch.provider = 'whatsapp_cloud'
     WHERE c."externalTenantId" = $1
     ORDER BY (LOWER(COALESCE(ch.status, '')) = 'active') DESC, ch."createdAt" ASC
     LIMIT 2`,
    [externalTenantId]
  );
  if (result.rows.length !== 1) return null;
  return mapTransition(result.rows[0]);
}

async function prepareWhatsAppChannelTransition({ clinicId, channelId, externalTenantId, snapshot }) {
  try {
    return await withTransaction(async (client) => {
    const current = await client.query(
      `SELECT ch.id AS "channelId", ch."clinicId", ch."phoneNumberId", ch."wabaId",
              ch."connectionMode", ch.status AS "channelStatus", c."externalTenantId"
       FROM channels ch JOIN clinics c ON c.id = ch."clinicId"
       WHERE ch.id = $1::uuid AND ch."clinicId" = $2::uuid
         AND c."externalTenantId" = $3
       FOR UPDATE OF ch, c`,
      [channelId, clinicId, externalTenantId]
    );
    if (!current.rows[0]) return { ok: false, reason: 'transition_channel_not_found' };

    const existing = await client.query(
      `SELECT * FROM whatsapp_channel_transitions
       WHERE "channelId" = $1::uuid
         AND status IN ('prepared', 'cloud_api_disconnected', 'business_app_ready', 'coexistence_onboarding', 'rollback_pending')
       ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`,
      [channelId]
    );
    if (existing.rows[0]) return { ok: true, replayed: true, transition: mapTransition(existing.rows[0]) };

    const inserted = await client.query(
      `INSERT INTO whatsapp_channel_transitions
         ("clinicId", "channelId", "originalWabaId", "originalPhoneNumberId",
          "originalNormalizedPhone", "originalConnectionMode", "targetMode", status, snapshot)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'API_ONLY', 'COEXISTENCE', 'prepared', $6::jsonb)
       RETURNING *`,
      [clinicId, channelId, current.rows[0].wabaId, current.rows[0].phoneNumberId,
        snapshot.normalizedPhone, JSON.stringify(snapshot)]
    );
    return { ok: true, replayed: false, transition: mapTransition(inserted.rows[0]) };
    });
  } catch (error) {
    if (String(error && error.code || '') !== '23505') throw error;
    const winner = await query(
      `SELECT * FROM whatsapp_channel_transitions
       WHERE "clinicId" = $1::uuid AND "channelId" = $2::uuid
         AND status IN ('prepared', 'cloud_api_disconnected', 'business_app_ready', 'coexistence_onboarding', 'rollback_pending')
       ORDER BY "createdAt" DESC LIMIT 1`,
      [clinicId, channelId]
    );
    if (!winner.rows[0]) throw error;
    return { ok: true, replayed: true, transition: mapTransition(winner.rows[0]) };
  }
}

async function findActiveWhatsAppChannelTransitionByClinicId(clinicId, client = null) {
  const result = await dbQuery(client,
    `SELECT * FROM whatsapp_channel_transitions
     WHERE "clinicId" = $1::uuid
       AND status IN ('prepared', 'cloud_api_disconnected', 'business_app_ready', 'coexistence_onboarding', 'rollback_pending')
     ORDER BY "createdAt" DESC LIMIT 2`, [clinicId]);
  return result.rows.length === 1 ? mapTransition(result.rows[0]) : null;
}

async function findWhatsAppChannelTransitionById(transitionId, client = null) {
  const result = await dbQuery(client,
    `SELECT t.*, ch."phoneNumberId" AS "channelPhoneNumberId", ch."wabaId" AS "channelWabaId",
            ch."connectionMode" AS "channelConnectionMode", ch.status AS "channelStatus",
            ch."displayPhoneNumber", ch."verifiedName", ch."accessToken", c."externalTenantId"
     FROM whatsapp_channel_transitions t
     JOIN channels ch ON ch.id = t."channelId" AND ch."clinicId" = t."clinicId"
     JOIN clinics c ON c.id = t."clinicId"
     WHERE t.id = $1::uuid LIMIT 1`, [transitionId]);
  return mapTransition(result.rows[0] || null);
}

async function listWhatsAppChannelTransitionsForClinic(clinicId) {
  const result = await query(
    `SELECT t.id, t."clinicId", t."channelId", t."originalWabaId", t."originalPhoneNumberId",
            t."originalNormalizedPhone", t."originalConnectionMode", t."targetMode", t.status,
            t."candidatePhoneNumberId", t."candidateWabaId", t."currentPhoneNumberId", t."currentWabaId", t."failureCode", t."snapshot",
            t."createdAt", t."updatedAt", t."completedAt", ch."phoneNumberId" AS "channelPhoneNumberId",
            ch."wabaId" AS "channelWabaId", ch."connectionMode" AS "channelConnectionMode",
            ch.status AS "channelStatus"
     FROM whatsapp_channel_transitions t
     JOIN channels ch ON ch.id = t."channelId" AND ch."clinicId" = t."clinicId"
     WHERE t."clinicId" = $1::uuid ORDER BY t."createdAt" DESC LIMIT 10`, [clinicId]);
  return result.rows;
}

async function advanceWhatsAppChannelTransition({ transitionId, expectedStatuses, nextStatus, failureCode = null }) {
  return withTransaction(async (client) => {
    const locked = await client.query(
      `SELECT * FROM whatsapp_channel_transitions WHERE id = $1::uuid FOR UPDATE`, [transitionId]);
    const transition = locked.rows[0];
    if (!transition) return { ok: false, reason: 'transition_not_found' };
    if (transition.status === nextStatus) return { ok: true, replayed: true, transition: mapTransition(transition) };
    if (!expectedStatuses.includes(transition.status)) return { ok: false, reason: 'transition_state_conflict' };
    const next = await client.query(
      `UPDATE whatsapp_channel_transitions SET status = $2, "failureCode" = $3,
         "updatedAt" = NOW(), "completedAt" = CASE WHEN $2 IN ('completed', 'rolled_back', 'failed') THEN NOW() ELSE NULL END
       WHERE id = $1::uuid RETURNING *`, [transitionId, nextStatus, failureCode]);
    const channelStatus = nextStatus === 'prepared' ? null
      : ['completed', 'rolled_back'].includes(nextStatus) ? 'active'
        : nextStatus === 'failed' ? 'reconnect_required' : 'transitioning';
    if (channelStatus) {
      await client.query(
        `UPDATE channels SET status = $2, "updatedAt" = NOW()
         WHERE id = $1::uuid AND "clinicId" = $3::uuid`,
        [transition.channelId, channelStatus, transition.clinicId]);
    }
    return { ok: true, replayed: false, transition: mapTransition(next.rows[0]) };
  });
}

async function recordWhatsAppChannelTransitionCandidate({ transitionId, phoneNumberId, wabaId }) {
  const result = await query(
    `UPDATE whatsapp_channel_transitions SET "candidatePhoneNumberId" = $2,
       "candidateWabaId" = $3, "updatedAt" = NOW()
     WHERE id = $1::uuid AND status IN ('business_app_ready', 'coexistence_onboarding')
       AND "originalWabaId" = $3
     RETURNING id, status, "candidatePhoneNumberId", "candidateWabaId"`,
    [transitionId, phoneNumberId, wabaId]
  );
  return result.rows[0] || null;
}

async function persistTransitionChannelRebind({
  transitionId, phoneNumberId, wabaId, accessToken, displayPhoneNumber, verifiedName,
  connectionMode, terminalStatus, connectionMetadata, client = null
}) {
  const persist = async (transactionClient) => {
    const locked = await transactionClient.query(
      `SELECT * FROM whatsapp_channel_transitions WHERE id = $1::uuid FOR UPDATE`, [transitionId]);
    const transition = locked.rows[0];
    if (!transition) return { ok: false, reason: 'transition_not_found' };
    const completion = terminalStatus === 'completed';
    if (completion && transition.status === 'completed' && transition.currentPhoneNumberId === phoneNumberId) {
      return { ok: true, replayed: true, channelId: transition.channelId };
    }
    if (!completion && transition.status === 'rolled_back' && transition.currentPhoneNumberId === phoneNumberId) {
      return { ok: true, replayed: true, channelId: transition.channelId };
    }
    const allowed = completion
      ? ['business_app_ready', 'coexistence_onboarding']
      : ['rollback_pending', 'cloud_api_disconnected', 'business_app_ready', 'coexistence_onboarding', 'completed'];
    if (!allowed.includes(transition.status)) return { ok: false, reason: 'transition_state_conflict' };

    const channelResult = await transactionClient.query(
      `SELECT id, "clinicId", "phoneNumberId", "wabaId" FROM channels
       WHERE id = $1::uuid AND "clinicId" = $2::uuid FOR UPDATE`,
      [transition.channelId, transition.clinicId]
    );
    const channel = channelResult.rows[0];
    if (!channel) return { ok: false, reason: 'transition_channel_not_found' };
    const owner = await transactionClient.query(
      `SELECT id, "clinicId" FROM channels WHERE "phoneNumberId" = $1 AND id <> $2::uuid LIMIT 1 FOR UPDATE`,
      [phoneNumberId, transition.channelId]
    );
    if (owner.rows[0]) return { ok: false, reason: 'phone_number_id_owned_by_another_channel' };

    const oldPhoneNumberId = channel.phoneNumberId;
    await transactionClient.query(
      `UPDATE channels SET "phoneNumberId" = $3, "wabaId" = $4, "accessToken" = $5,
         "displayPhoneNumber" = COALESCE($6, "displayPhoneNumber"),
         "verifiedName" = COALESCE($7, "verifiedName"), "connectionMode" = $8,
         status = 'active', "connectionSource" = 'meta_embedded_signup_transition',
         "connectionMetadata" = $9::jsonb, "updatedAt" = NOW()
       WHERE id = $1::uuid AND "clinicId" = $2::uuid`,
      [transition.channelId, transition.clinicId, phoneNumberId, wabaId,
        accessToken ? maybeEncryptSecret(accessToken) : null, displayPhoneNumber || null,
        verifiedName || null, connectionMode, JSON.stringify(connectionMetadata || {})]
    );

    if (oldPhoneNumberId && oldPhoneNumberId !== phoneNumberId) {
      await transactionClient.query(
        `INSERT INTO whatsapp_channel_phone_aliases
           ("phoneNumberId", "clinicId", "channelId", "transitionId", "wabaId", "expiresAt")
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, NOW() + INTERVAL '7 days')
         ON CONFLICT ("phoneNumberId") DO NOTHING`,
        [oldPhoneNumberId, transition.clinicId, transition.channelId, transition.id, transition.originalWabaId]
      );
      const aliasOwner = await transactionClient.query(
        `SELECT "clinicId", "channelId", "transitionId" FROM whatsapp_channel_phone_aliases WHERE "phoneNumberId" = $1`,
        [oldPhoneNumberId]);
      if (!aliasOwner.rows[0] || aliasOwner.rows[0].channelId !== transition.channelId
        || aliasOwner.rows[0].clinicId !== transition.clinicId) {
        const error = new Error('phone_number_alias_conflict');
        error.code = 'phone_number_alias_conflict';
        throw error;
      }
    }

    const nextStatus = terminalStatus;
    const updated = await transactionClient.query(
      `UPDATE whatsapp_channel_transitions SET status = $2, "currentPhoneNumberId" = $3,
         "currentWabaId" = $4, "failureCode" = NULL, "completedAt" = NOW(), "updatedAt" = NOW()
       WHERE id = $1::uuid RETURNING *`, [transitionId, nextStatus, phoneNumberId, wabaId]);
    return { ok: true, replayed: false, channelId: transition.channelId, transition: mapTransition(updated.rows[0]) };
  };
  return client && typeof client.query === 'function' ? persist(client) : withTransaction(persist);
}

async function findActiveWhatsAppPhoneAlias(phoneNumberId, wabaId = null, client = null) {
  const result = await dbQuery(client,
    `SELECT a."clinicId", a."channelId", a."transitionId", a."phoneNumberId", a."wabaId", a."expiresAt"
     FROM whatsapp_channel_phone_aliases a
     JOIN whatsapp_channel_transitions t ON t.id = a."transitionId" AND t."clinicId" = a."clinicId" AND t."channelId" = a."channelId"
     JOIN channels ch ON ch.id = a."channelId" AND ch."clinicId" = a."clinicId"
     WHERE a."phoneNumberId" = $1 AND a."expiresAt" > NOW()
       AND t.status IN ('completed', 'rolled_back')
       AND ch.status = 'active' AND ch.provider = 'whatsapp_cloud'
       AND ($2::text IS NULL OR a."wabaId" = $2)
     LIMIT 2`, [phoneNumberId, wabaId]);
  return result.rows.length === 1 ? result.rows[0] : null;
}

module.exports = {
  advanceWhatsAppChannelTransition,
  findActiveWhatsAppChannelTransitionByClinicId,
  findActiveWhatsAppPhoneAlias,
  findTransitionChannelContext,
  findWhatsAppChannelTransitionById,
  listWhatsAppChannelTransitionsForClinic,
  persistTransitionChannelRebind,
  prepareWhatsAppChannelTransition,
  recordWhatsAppChannelTransitionCandidate
};
