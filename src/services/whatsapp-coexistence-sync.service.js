const { query } = require('../db/client');
const env = require('../config/env');
const coexistenceRepository = require('../repositories/whatsapp-coexistence.repository');
const {
  classifyAccountUpdate,
  digits,
  iterateHistoryMessages,
  iterateStateSyncContacts,
  normalizeSyncProgress
} = require('../webhooks/whatsapp-coexistence');
const { logInfo, logWarn } = require('../utils/logger');

function hasHistoryError(value) {
  const chunks = Array.isArray(value && value.history) ? value.history
    : value && value.history && typeof value.history === 'object' ? [value.history] : [];
  return chunks.flatMap((chunk) => Array.isArray(chunk && chunk.errors) ? chunk.errors : []).length > 0;
}

function historyDeclined(value) {
  const chunks = Array.isArray(value && value.history) ? value.history
    : value && value.history && typeof value.history === 'object' ? [value.history] : [];
  const text = chunks.flatMap((chunk) => Array.isArray(chunk && chunk.errors) ? chunk.errors : [])
    .map((item) => `${item && item.title || ''} ${item && item.message || ''}`.toLowerCase())
    .join(' ');
  return /turn(ed)?\s+off|declin|not\s+share|disabled\s+by\s+the\s+business/.test(text);
}

function historyExpired(value) {
  const chunks = Array.isArray(value && value.history) ? value.history
    : value && value.history && typeof value.history === 'object' ? [value.history] : [];
  const text = chunks.flatMap((chunk) => Array.isArray(chunk && chunk.errors) ? chunk.errors : [])
    .map((item) => `${item && item.title || ''} ${item && item.message || ''}`.toLowerCase())
    .join(' ');
  return /expir|outside.{0,20}(window|time)|window.{0,20}(closed|expired)|too late/.test(text);
}

async function resolveHistoricalContact(client, event, phone) {
  return coexistenceRepository.upsertHistoryContact(client, {
    clinicId: event.clinicId,
    phone,
    name: null
  });
}

async function processHistory(event, client) {
  const value = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const progress = normalizeSyncProgress(value);
  if (hasHistoryError(value)) {
    const syncStatus = historyDeclined(value) ? 'declined' : historyExpired(value) ? 'expired' : 'failed';
    await client.query(
      `UPDATE whatsapp_coexistence_channel_state SET "historySyncStatus" = $3,
         "historyStartedAt" = COALESCE("historyStartedAt", NOW()), "historyUpdatedAt" = NOW(), "updatedAt" = NOW()
       WHERE "clinicId" = $1 AND "channelId" = $2`,
      [event.clinicId, event.channelId, syncStatus]
    );
    return { imported: 0, duplicates: 0, syncStatus };
  }

  let imported = 0;
  let duplicates = 0;
  const businessNumber = digits(event.displayPhoneNumber);
  for (const message of iterateHistoryMessages(value, event)) {
    const contact = await resolveHistoricalContact(client, event, message.customerIdentity);
    if (!contact || !contact.id) continue;
    const conversation = await coexistenceRepository.findOrCreateHistoricalConversation(client, {
      clinicId: event.clinicId,
      channelId: event.channelId,
      contactId: contact.id,
      customerIdentity: message.customerIdentity,
      businessNumber
    });
    if (!conversation || !conversation.id) continue;
    const row = await coexistenceRepository.insertHistoricalMessage(client, {
      ...message,
      conversationId: conversation.id,
      raw: {
        source: 'history_import',
        actor: message.direction === 'outbound' ? 'human_whatsapp_business_app' : 'customer',
        historyStatus: message.historyStatus,
        mediaUnavailable: message.mediaUnavailable
      }
    });
    if (row) imported += 1;
    else duplicates += 1;
  }

  const nextStatus = progress.complete ? 'completed' : 'syncing';
  await client.query(
    `UPDATE whatsapp_coexistence_channel_state SET
       "historySyncStatus" = CASE WHEN "historySyncStatus" IN ('declined', 'failed') THEN "historySyncStatus" ELSE $3 END,
       "historyLastPhase" = COALESCE($4, "historyLastPhase"),
       "historyLastChunkOrder" = CASE WHEN $5::integer IS NULL THEN "historyLastChunkOrder"
         ELSE GREATEST(COALESCE("historyLastChunkOrder", -1), $5::integer) END,
       "historyProgress" = CASE WHEN $6::numeric IS NULL THEN "historyProgress"
         ELSE GREATEST(COALESCE("historyProgress", 0), $6::numeric) END,
       "historyStartedAt" = COALESCE("historyStartedAt", NOW()), "historyUpdatedAt" = NOW(), "updatedAt" = NOW()
     WHERE "clinicId" = $1 AND "channelId" = $2`,
    [event.clinicId, event.channelId, nextStatus, progress.phase, progress.chunkOrder, progress.progress]
  );
  logInfo('whatsapp_coexistence_history_chunk_processed', {
    tenantId: event.clinicId,
    channelId: event.channelId,
    imported,
    duplicates,
    phase: progress.phase,
    chunkOrder: progress.chunkOrder,
    progress: progress.progress,
    status: nextStatus
  });
  return { imported, duplicates, syncStatus: nextStatus };
}

async function processStateSync(event, client) {
  const value = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const source = Array.isArray(value.state_sync) ? value.state_sync : [];
  let createdOrUpdated = 0;
  let removalsObserved = 0;
  for (const item of iterateStateSyncContacts(value)) {
    if (item.action === 'remove') {
      await coexistenceRepository.markContactRemoved(client, { clinicId: event.clinicId, phone: item.phone });
      removalsObserved += 1;
      continue;
    }
    await coexistenceRepository.upsertHistoryContact(client, {
      clinicId: event.clinicId,
      phone: item.phone,
      name: item.name
    });
    createdOrUpdated += 1;
  }
  const hasProgress = value.metadata && value.metadata.progress !== undefined
    ? Number(value.metadata.progress) : null;
  // State-sync can arrive in multiple chunks. Without an explicit terminal
  // progress marker, keep the durable state conservative instead of declaring
  // a partial import complete.
  const complete = Number.isFinite(hasProgress) && hasProgress >= 100;
  await client.query(
    `UPDATE whatsapp_coexistence_channel_state SET
       "contactsSyncStatus" = CASE WHEN "contactsSyncStatus" IN ('declined', 'failed') THEN "contactsSyncStatus" ELSE $3 END,
       "contactsUpdatedAt" = NOW(), "updatedAt" = NOW()
     WHERE "clinicId" = $1 AND "channelId" = $2`,
    [event.clinicId, event.channelId, complete ? 'completed' : 'syncing']
  );
  logInfo('whatsapp_coexistence_contacts_chunk_processed', {
    tenantId: event.clinicId,
    channelId: event.channelId,
    contactsProcessed: createdOrUpdated,
    removalsObserved,
    status: complete ? 'completed' : 'syncing'
  });
  return { contactsProcessed: createdOrUpdated, removalsObserved, syncStatus: complete ? 'completed' : 'syncing' };
}

async function processAccountUpdate(event, client) {
  const result = classifyAccountUpdate(event.payload);
  if (result.coexistenceStatus) {
    await client.query(
      `UPDATE channels SET status = 'inactive', "updatedAt" = NOW()
       WHERE id = $1 AND "clinicId" = $2 AND provider = 'whatsapp_cloud' AND "wabaId" = $3
         AND "connectionMode" = 'COEXISTENCE'`,
      [event.channelId, event.clinicId, event.wabaId]
    );
    await client.query(
      `UPDATE whatsapp_coexistence_channel_state SET "coexistenceStatus" = $3,
         "lastAccountEvent" = $4, "updatedAt" = NOW()
       WHERE "clinicId" = $1 AND "channelId" = $2`,
      [event.clinicId, event.channelId, result.coexistenceStatus, result.event]
    );
  } else {
    await client.query(
      `UPDATE whatsapp_coexistence_channel_state SET "lastAccountEvent" = $3, "updatedAt" = NOW()
       WHERE "clinicId" = $1 AND "channelId" = $2`,
      [event.clinicId, event.channelId, result.event]
    );
  }
  logWarn('whatsapp_coexistence_account_update_observed', {
    tenantId: event.clinicId,
    channelId: event.channelId,
    event: result.event,
    coexistenceStatus: result.coexistenceStatus || 'unchanged'
  });
  return result;
}

async function processWhatsAppCoexistenceEvent(eventId) {
  return coexistenceRepository.processCoexistenceEvent(eventId, {
    async process(event, client) {
      if (event.field === 'history') return processHistory(event, client);
      if (event.field === 'smb_app_state_sync') return processStateSync(event, client);
      if (event.field === 'account_update') return processAccountUpdate(event, client);
      const error = new Error('unsupported_whatsapp_coexistence_event');
      error.code = 'UNSUPPORTED_COEXISTENCE_EVENT';
      throw error;
    }
  });
}

async function refreshCoexistenceProviderStatus(channel, requestId = null, fetchImpl = global.fetch) {
  if (!channel || channel.provider !== 'whatsapp_cloud' || channel.connectionMode !== 'COEXISTENCE' ||
      !channel.phoneNumberId || !channel.accessToken) {
    return { observed: false, status: 'unknown' };
  }
  const cached = await query(
    `SELECT "isOnBizApp", "platformType", "coexistenceStatus", "providerStatusCheckedAt"
     FROM whatsapp_coexistence_channel_state WHERE "clinicId" = $1 AND "channelId" = $2 LIMIT 1`,
    [channel.clinicId, channel.id]
  );
  const prior = cached.rows[0] || null;
  const checkedAt = prior && prior.providerStatusCheckedAt ? new Date(prior.providerStatusCheckedAt).getTime() : 0;
  if (checkedAt > 0 && Date.now() - checkedAt < 5 * 60 * 1000) {
    return {
      observed: prior.isOnBizApp !== null || prior.platformType !== null,
      status: prior.coexistenceStatus || 'unknown',
      isOnBizApp: prior.isOnBizApp,
      platformType: prior.platformType,
      cached: true
    };
  }
  const apiVersion = String(env.getWhatsAppGraphVersion() || 'v25.0').trim();
  const providerUrl = new URL(`https://graph.facebook.com/${encodeURIComponent(apiVersion)}/${encodeURIComponent(channel.phoneNumberId)}`);
  providerUrl.searchParams.set('fields', 'is_on_biz_app,platform_type');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let providerStatus = null;
  let data = null;
  try {
    const response = await fetchImpl(providerUrl.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${channel.accessToken}`, Accept: 'application/json' },
      signal: controller.signal
    });
    providerStatus = response.status;
    const body = await response.text();
    if (response.ok && body && body.length <= 32768) {
      try { data = JSON.parse(body); } catch { data = null; }
    }
  } catch {
    data = null;
  } finally {
    clearTimeout(timeout);
  }
  const isOnBizApp = data && typeof data.is_on_biz_app === 'boolean' ? data.is_on_biz_app : null;
  const platformType = data && typeof data.platform_type === 'string' ? data.platform_type.slice(0, 80) : null;
  const status = providerStatus === 401 || providerStatus === 403 ? 'reconnection_required'
    : isOnBizApp === true && platformType === 'CLOUD_API' ? 'active'
      : isOnBizApp === false ? 'disconnected' : 'unknown';
  await query(
    `INSERT INTO whatsapp_coexistence_channel_state
       ("clinicId", "channelId", "isOnBizApp", "platformType", "coexistenceStatus", "providerStatusCheckedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT ("channelId") DO UPDATE SET "isOnBizApp" = EXCLUDED."isOnBizApp",
       "platformType" = EXCLUDED."platformType", "providerStatusCheckedAt" = NOW(), "coexistenceStatus" =
         CASE WHEN whatsapp_coexistence_channel_state."coexistenceStatus" = 'reconnection_required'
           AND EXCLUDED."coexistenceStatus" <> 'active' THEN 'reconnection_required'
           ELSE EXCLUDED."coexistenceStatus" END, "updatedAt" = NOW()`,
    [channel.clinicId, channel.id, isOnBizApp, platformType, status]
  );
  if (status === 'active') {
    // A successful canonical provider read is the only path that can restore
    // an offboarded/inactive coexistence channel to healthy.
    await query(
      `UPDATE channels SET status = 'active', "updatedAt" = NOW()
       WHERE id = $1 AND "clinicId" = $2 AND provider = 'whatsapp_cloud'
         AND "connectionMode" = 'COEXISTENCE' AND "wabaId" = $3 AND "phoneNumberId" = $4`,
      [channel.id, channel.clinicId, channel.wabaId, channel.phoneNumberId]
    );
  } else if (status === 'reconnection_required' || status === 'disconnected') {
    await query(
      `UPDATE channels SET status = 'inactive', "updatedAt" = NOW()
       WHERE id = $1 AND "clinicId" = $2 AND provider = 'whatsapp_cloud'
         AND "connectionMode" = 'COEXISTENCE' AND "wabaId" = $3 AND "phoneNumberId" = $4`,
      [channel.id, channel.clinicId, channel.wabaId, channel.phoneNumberId]
    );
  }
  return { observed: Boolean(data), status, isOnBizApp, platformType, providerStatus, requestId };
}

module.exports = {
  historyExpired,
  processWhatsAppCoexistenceEvent,
  refreshCoexistenceProviderStatus
};
