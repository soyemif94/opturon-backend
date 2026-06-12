const { query } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { DEFAULT_BOT_CONFIG, normalizeBotConfig } = require('../utils/bot-config');

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeDigits(value) {
  return normalizeString(value).replace(/\D/g, '');
}

function parseSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  return settings;
}

function summarizeChannel(channel) {
  if (!channel) {
    return {
      connected: false,
      provider: null,
      channelId: null,
      phoneNumberId: null,
      wabaId: null,
      displayPhoneNumber: null,
      verifiedName: null,
      status: null
    };
  }

  const status = normalizeString(channel.status).toLowerCase();
  return {
    connected: normalizeString(channel.provider) === 'whatsapp_cloud' && status === 'active',
    provider: channel.provider || null,
    channelId: channel.id || null,
    phoneNumberId: channel.phoneNumberId || null,
    wabaId: channel.wabaId || null,
    displayPhoneNumber: channel.displayPhoneNumber || null,
    verifiedName: channel.verifiedName || null,
    status: channel.status || null
  };
}

function summarizeBotConfig(settings) {
  const parsedSettings = parseSettings(settings);
  const botSettings = parsedSettings.bot && typeof parsedSettings.bot === 'object' && !Array.isArray(parsedSettings.bot)
    ? parsedSettings.bot
    : {};
  const botConfig = normalizeBotConfig(botSettings.config, DEFAULT_BOT_CONFIG);

  return {
    mode: normalizeString(botSettings.mode) || null,
    botName: botConfig.name || null,
    hasCustomConfig: Boolean(
      botConfig.name ||
        botConfig.greetingMessage ||
        botConfig.fallbackMessage ||
        botConfig.handoffMessage ||
        botConfig.outOfHoursMessage
    ),
    hasCustomGreeting: Boolean(botConfig.greetingMessage),
    hasCustomFallback: Boolean(botConfig.fallbackMessage),
    hasCustomHandoff: Boolean(botConfig.handoffMessage)
  };
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapWebhookRow(row) {
  if (!row) return null;
  return {
    id: row.id || null,
    receivedAt: toIso(row.receivedAt),
    eventType: row.eventType || null,
    waMessageId: row.waMessageId || null,
    waFrom: row.waFrom || null,
    waTo: row.waTo || null
  };
}

function mapMessageRow(row) {
  if (!row) return null;
  return {
    id: row.id || null,
    conversationId: row.conversationId || null,
    direction: row.direction || null,
    waMessageId: row.waMessageId || null,
    textPreview: normalizeString(row.text).slice(0, 160) || null,
    createdAt: toIso(row.createdAt)
  };
}

function mapJobRow(row) {
  if (!row) return null;
  return {
    id: row.id || null,
    type: row.type || null,
    status: row.status || null,
    attempts: Number(row.attempts || 0),
    lastError: row.lastError || null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function mapInboundFailure(row) {
  if (!row) return null;
  return {
    id: row.id || null,
    receivedAt: toIso(row.receivedAt),
    reason: row.reason || null,
    phoneNumberId: row.phoneNumberId || null,
    providerMessageId: row.providerMessageId || null,
    error: row.error ? String(row.error).slice(0, 500) : null
  };
}

function deriveBadges({ channel, counts, handoffSummary }) {
  const badges = [];
  if (channel.connected) badges.push('connected');
  if (!channel.connected) badges.push('not_connected');
  if (counts.webhookEvents24h > 0) badges.push('webhook_recent');
  if (channel.connected && counts.webhookEvents24h === 0) badges.push('no_recent_events');
  if (channel.connected && counts.webhookEvents24h === 0) badges.push('possible_delivery_issue');
  if (handoffSummary.openCount > 0) badges.push('open_handoffs');
  return badges;
}

async function getPortalWhatsAppStatus(tenantId) {
  const safeTenantId = normalizeString(tenantId);
  if (!safeTenantId) {
    return { ok: false, reason: 'missing_tenant_id', tenantId: null };
  }

  const context = await resolvePortalTenantContext(safeTenantId);
  if (!context.ok || !context.clinic || !context.clinic.id) {
    return context;
  }

  const clinicId = context.clinic.id;
  const channel = context.channel || null;
  const channelSummary = summarizeChannel(channel);
  const channelId = channel && channel.id ? channel.id : null;
  const phoneNumberId = channel && channel.phoneNumberId ? channel.phoneNumberId : null;
  const webhookIdentifiers = [
    normalizeString(phoneNumberId),
    normalizeDigits(channel && channel.displayPhoneNumber)
  ].filter(Boolean);

  const [
    clinicResult,
    webhookLatestResult,
    webhookCountResult,
    inboundResult,
    outboundResult,
    inboundCountResult,
    outboundCountResult,
    jobResult,
    inboundFailureResult,
    failedJobResult,
    handoffResult
  ] = await Promise.all([
    query('SELECT settings FROM clinics WHERE id = $1 LIMIT 1', [clinicId]),
    webhookIdentifiers.length
      ? query(
          `SELECT id, "receivedAt", "eventType", "waMessageId", "waFrom", "waTo"
           FROM webhook_events
           WHERE ("waTo" = ANY($1::text[]) OR "waFrom" = ANY($1::text[]))
           ORDER BY "receivedAt" DESC
           LIMIT 1`,
          [webhookIdentifiers]
        )
      : Promise.resolve({ rows: [] }),
    webhookIdentifiers.length
      ? query(
          `SELECT COUNT(*)::int AS total
           FROM webhook_events
           WHERE ("waTo" = ANY($1::text[]) OR "waFrom" = ANY($1::text[]))
             AND "receivedAt" >= NOW() - INTERVAL '24 hours'`,
          [webhookIdentifiers]
        )
      : Promise.resolve({ rows: [{ total: 0 }] }),
    channelId
      ? query(
          `SELECT m.id, m."conversationId", m.direction, m."waMessageId", m.text, m."createdAt"
           FROM conversation_messages m
           JOIN conversations c ON c.id = m."conversationId"
           WHERE c."clinicId" = $1
             AND c."channelId" = $2
             AND m.direction = 'inbound'
           ORDER BY m."createdAt" DESC
           LIMIT 1`,
          [clinicId, channelId]
        )
      : Promise.resolve({ rows: [] }),
    channelId
      ? query(
          `SELECT m.id, m."conversationId", m.direction, m."waMessageId", m.text, m."createdAt"
           FROM conversation_messages m
           JOIN conversations c ON c.id = m."conversationId"
           WHERE c."clinicId" = $1
             AND c."channelId" = $2
             AND m.direction = 'outbound'
           ORDER BY m."createdAt" DESC
           LIMIT 1`,
          [clinicId, channelId]
        )
      : Promise.resolve({ rows: [] }),
    channelId
      ? query(
          `SELECT COUNT(*)::int AS total
           FROM conversation_messages m
           JOIN conversations c ON c.id = m."conversationId"
           WHERE c."clinicId" = $1
             AND c."channelId" = $2
             AND m.direction = 'inbound'
             AND m."createdAt" >= NOW() - INTERVAL '24 hours'`,
          [clinicId, channelId]
        )
      : Promise.resolve({ rows: [{ total: 0 }] }),
    channelId
      ? query(
          `SELECT COUNT(*)::int AS total
           FROM conversation_messages m
           JOIN conversations c ON c.id = m."conversationId"
           WHERE c."clinicId" = $1
             AND c."channelId" = $2
             AND m.direction = 'outbound'
             AND m."createdAt" >= NOW() - INTERVAL '24 hours'`,
          [clinicId, channelId]
        )
      : Promise.resolve({ rows: [{ total: 0 }] }),
    channelId
      ? query(
          `SELECT id, type, status, attempts, "lastError", "createdAt", "updatedAt"
           FROM jobs
           WHERE "clinicId" = $1
             AND "channelId" = $2
             AND type = 'conversation_reply'
           ORDER BY "createdAt" DESC
           LIMIT 1`,
          [clinicId, channelId]
        )
      : Promise.resolve({ rows: [] }),
    phoneNumberId
      ? query(
          `SELECT id, "receivedAt", reason, "phoneNumberId", "providerMessageId", error
           FROM inbound_failures
           WHERE "phoneNumberId" = $1
           ORDER BY "receivedAt" DESC
           LIMIT 1`,
          [phoneNumberId]
        )
      : Promise.resolve({ rows: [] }),
    channelId
      ? query(
          `SELECT id, type, status, attempts, "lastError", "createdAt", "updatedAt"
           FROM jobs
           WHERE "clinicId" = $1
             AND "channelId" = $2
             AND type = 'conversation_reply'
             AND "lastError" IS NOT NULL
           ORDER BY "updatedAt" DESC
           LIMIT 1`,
          [clinicId, channelId]
        )
      : Promise.resolve({ rows: [] }),
    query(
      `SELECT COUNT(*)::int AS "openCount",
              COUNT(DISTINCT "conversationId")::int AS "blockedConversationCount"
       FROM handoff_requests
       WHERE "clinicId" = $1
         AND status IN ('open', 'assigned')`,
      [clinicId]
    )
  ]);

  const counts = {
    webhookEvents24h: Number(webhookCountResult.rows[0] && webhookCountResult.rows[0].total ? webhookCountResult.rows[0].total : 0),
    inboundMessages24h: Number(inboundCountResult.rows[0] && inboundCountResult.rows[0].total ? inboundCountResult.rows[0].total : 0),
    outboundMessages24h: Number(outboundCountResult.rows[0] && outboundCountResult.rows[0].total ? outboundCountResult.rows[0].total : 0)
  };
  const handoffSummary = {
    openCount: Number(handoffResult.rows[0] && handoffResult.rows[0].openCount ? handoffResult.rows[0].openCount : 0),
    blockedConversationCount: Number(
      handoffResult.rows[0] && handoffResult.rows[0].blockedConversationCount
        ? handoffResult.rows[0].blockedConversationCount
        : 0
    ),
    explanation:
      'Si una conversacion esta derivada a humano, el bot no responde hasta cerrar handoff o reactivar bot.'
  };
  const settings = clinicResult.rows[0] ? clinicResult.rows[0].settings : {};
  const botConfig = summarizeBotConfig(settings);
  const botRuntime = {
    enabled: context.onboarding && typeof context.onboarding.botEnabled === 'boolean' ? context.onboarding.botEnabled : null
  };

  return {
    ok: true,
    tenantId: safeTenantId,
    clinicId,
    generatedAt: new Date().toISOString(),
    channel: channelSummary,
    botRuntime,
    webhook: {
      lastReceived: mapWebhookRow(webhookLatestResult.rows[0]),
      events24h: counts.webhookEvents24h
    },
    messages: {
      lastInbound: mapMessageRow(inboundResult.rows[0]),
      lastOutbound: mapMessageRow(outboundResult.rows[0]),
      inbound24h: counts.inboundMessages24h,
      outbound24h: counts.outboundMessages24h
    },
    jobs: {
      lastConversationReply: mapJobRow(jobResult.rows[0])
    },
    errors: {
      lastWebhookError: mapInboundFailure(inboundFailureResult.rows[0]),
      lastJobError: mapJobRow(failedJobResult.rows[0])
    },
    handoffs: handoffSummary,
    botConfig,
    badges: deriveBadges({ channel: channelSummary, counts, handoffSummary })
  };
}

module.exports = {
  getPortalWhatsAppStatus
};
