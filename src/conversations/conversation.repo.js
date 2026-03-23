const { query } = require('../db/client');
const crypto = require('crypto');
const { resolveWeekdayToDateISO } = require('./weekday.resolver');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function upsertConversation({ waFrom, waTo, clinicId, channelId, contactId }, client = null) {
  const byOwner = await dbQuery(
    client,
    `SELECT id, "clinicId", "channelId", "contactId", "waFrom", "waTo", status, stage, state, context,
            "lastInboundAt", "lastOutboundAt", "createdAt", "updatedAt"
     FROM conversations
     WHERE "clinicId" = $1 AND "channelId" = $2 AND "contactId" = $3
     LIMIT 1`,
    [clinicId, channelId, contactId]
  );

  if (byOwner.rows[0]) {
    const updated = await dbQuery(
      client,
      `UPDATE conversations
       SET "waFrom" = $2,
           "waTo" = $3,
           "lastInboundAt" = NOW(),
           "updatedAt" = NOW()
       WHERE id = $1
       RETURNING id, "clinicId", "channelId", "contactId", "waFrom", "waTo", status, stage, state, context,
                 "lastInboundAt", "lastOutboundAt", "createdAt", "updatedAt"`,
      [byOwner.rows[0].id, waFrom, waTo]
    );
    return updated.rows[0];
  }

  try {
    const inserted = await dbQuery(
      client,
      `INSERT INTO conversations (
        "clinicId", "channelId", "contactId", "waFrom", "waTo",
        status, stage, state, context, "lastInboundAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, 'open', 'new', 'NEW', '{}'::jsonb, NOW(), NOW())
      ON CONFLICT ("clinicId", "channelId", "contactId")
      DO UPDATE SET
        "waFrom" = EXCLUDED."waFrom",
        "waTo" = EXCLUDED."waTo",
        "lastInboundAt" = NOW(),
        "updatedAt" = NOW()
      RETURNING id, "clinicId", "channelId", "contactId", "waFrom", "waTo", status, stage, state, context,
                "lastInboundAt", "lastOutboundAt", "createdAt", "updatedAt"`,
      [clinicId, channelId, contactId, waFrom, waTo]
    );

    return inserted.rows[0];
  } catch (error) {
    if (error && error.code === '23505') {
      const byPair = await dbQuery(
        client,
        `SELECT c.id, c."clinicId", c."channelId", c."contactId", c."waFrom", c."waTo", c.status, c.stage, c.state, c.context,
                c."lastInboundAt", c."lastOutboundAt", c."createdAt", c."updatedAt",
                cl."externalTenantId" AS "clinicExternalTenantId",
                ct."waId" AS "contactWaId"
         FROM conversations c
         LEFT JOIN clinics cl ON cl.id = c."clinicId"
         LEFT JOIN contacts ct ON ct.id = c."contactId"
         WHERE c."channelId" = $1
           AND c."waFrom" = $2
           AND c."waTo" = $3
         LIMIT 1`,
        [channelId, waFrom, waTo]
      );

      const existing = byPair.rows[0] || null;
      if (
        existing &&
        existing.clinicId === clinicId &&
        existing.channelId === channelId &&
        existing.contactId === contactId
      ) {
        return existing;
      }

      const canRepairSameWorkspaceOwner =
        existing &&
        existing.channelId === channelId &&
        (
          existing.clinicId === clinicId ||
          !existing.clinicExternalTenantId
        );

      if (canRepairSameWorkspaceOwner) {
        const repaired = await dbQuery(
          client,
          `UPDATE conversations
           SET "clinicId" = $2,
               "channelId" = $3,
               "contactId" = $4,
               "waFrom" = $5,
               "waTo" = $6,
               "lastInboundAt" = NOW(),
               "updatedAt" = NOW()
           WHERE id = $1
           RETURNING id, "clinicId", "channelId", "contactId", "waFrom", "waTo", status, stage, state, context,
                     "lastInboundAt", "lastOutboundAt", "createdAt", "updatedAt"`,
          [existing.id, clinicId, channelId, contactId, waFrom, waTo]
        );

        return repaired.rows[0] || existing;
      }

      const conflictError = new Error('conversation_pair_already_mapped_to_other_owner');
      conflictError.code = 'CONVERSATION_CROSS_OWNER_CONFLICT';
      conflictError.details = {
        waFrom,
        waTo,
        clinicId,
        channelId,
        contactId,
        existingConversationId: existing ? existing.id : null,
        existingClinicId: existing ? existing.clinicId : null,
        existingChannelId: existing ? existing.channelId : null,
        existingContactId: existing ? existing.contactId : null,
        existingClinicExternalTenantId: existing ? existing.clinicExternalTenantId || null : null,
        existingContactWaId: existing ? existing.contactWaId || null : null
      };
      throw conflictError;
    }

    throw error;
  }
}

async function insertInboundMessage(record, client = null) {
  const waMessageId = record && record.waMessageId ? String(record.waMessageId).trim() : '';
  if (!waMessageId) {
    return { inserted: false, row: null, reason: 'missing_waMessageId' };
  }

  try {
    const result = await dbQuery(
      client,
      `INSERT INTO conversation_messages (
        "conversationId", direction, "waMessageId", "from", "to", type, text, raw
      ) VALUES ($1, 'inbound', $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING id, "conversationId", "waMessageId", "createdAt"`,
      [
        record.conversationId,
        waMessageId,
        record.from || null,
        record.to || null,
        record.type || 'text',
        record.text || null,
        JSON.stringify(record.raw || {})
      ]
    );

    await dbQuery(
      client,
      `UPDATE conversations
       SET "lastInboundAt" = NOW(), "updatedAt" = NOW()
       WHERE id = $1`,
      [record.conversationId]
    );

    return { inserted: true, row: result.rows[0] };
  } catch (error) {
    if (error && error.code === '23505') {
      const existing = await dbQuery(
        client,
        `SELECT id, "conversationId", "waMessageId", "createdAt"
         FROM conversation_messages
         WHERE "waMessageId" = $1
         LIMIT 1`,
        [waMessageId]
      );
      return { inserted: false, row: existing.rows[0] || null, reason: 'duplicate_waMessageId' };
    }
    throw error;
  }
}

async function insertOutboundMessage(record, client = null) {
  const waMessageId = record && record.waMessageId ? String(record.waMessageId).trim() : null;

  try {
    const result = await dbQuery(
      client,
      `INSERT INTO conversation_messages (
        "conversationId", direction, "waMessageId", "from", "to", type, text, raw
      ) VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING id, "conversationId", "waMessageId", "createdAt"`,
      [
        record.conversationId,
        waMessageId,
        record.from || null,
        record.to || null,
        record.type || 'text',
        record.text || null,
        JSON.stringify(record.raw || {})
      ]
    );

    await dbQuery(
      client,
      `UPDATE conversations
       SET "lastOutboundAt" = NOW(), "updatedAt" = NOW()
       WHERE id = $1`,
      [record.conversationId]
    );

    return { inserted: true, row: result.rows[0] || null };
  } catch (error) {
    if (error && error.code === '23505' && waMessageId) {
      const existing = await dbQuery(
        client,
        `SELECT id, "conversationId", "waMessageId", "createdAt"
         FROM conversation_messages
         WHERE "waMessageId" = $1
         LIMIT 1`,
        [waMessageId]
      );
      return { inserted: false, row: existing.rows[0] || null, reason: 'duplicate_waMessageId' };
    }
    throw error;
  }
}

async function getConversationById(id, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "channelId", "contactId", "waFrom", "waTo", status, stage, state, context,
            "lastInboundAt", "lastOutboundAt", "createdAt", "updatedAt"
     FROM conversations
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getConversationByIdAndClinicId(id, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "channelId", "contactId", "waFrom", "waTo", status, stage, state, context,
            "lastInboundAt", "lastOutboundAt", "createdAt", "updatedAt"
     FROM conversations
     WHERE id = $1
       AND "clinicId" = $2
     LIMIT 1`,
    [id, clinicId]
  );
  return result.rows[0] || null;
}

async function getMessageById(id, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "conversationId", direction, "waMessageId", "from", "to", type, text, raw, "createdAt"
     FROM conversation_messages
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

async function hasNewerInboundMessage(conversationId, messageId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT 1
     FROM conversation_messages current_message
     INNER JOIN conversation_messages newer_message
       ON newer_message."conversationId" = current_message."conversationId"
      AND newer_message.direction = 'inbound'
      AND newer_message."createdAt" > current_message."createdAt"
     WHERE current_message.id = $1
       AND current_message."conversationId" = $2
       AND current_message.direction = 'inbound'
     LIMIT 1`,
    [messageId, conversationId]
  );

  return result.rowCount > 0;
}

async function findAutomationOutboundByInboundMessageId(conversationId, inboundMessageId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "conversationId", direction, "waMessageId", "from", "to", type, text, raw, "createdAt"
     FROM conversation_messages
     WHERE "conversationId" = $1
       AND direction = 'outbound'
       AND raw->'automation'->>'inboundMessageId' = $2
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [conversationId, inboundMessageId]
  );

  return result.rows[0] || null;
}

async function updateConversationState({ conversationId, state, contextPatch = null }, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE conversations
     SET
       state = COALESCE($2, state),
       context = CASE
         WHEN $3::jsonb IS NULL THEN context
         ELSE context || $3::jsonb
       END,
       "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, state, context`,
    [conversationId, state || null, contextPatch ? JSON.stringify(contextPatch) : null]
  );
  return result.rows[0] || null;
}

async function updateConversationStateForClinic({ conversationId, clinicId, state, contextPatch = null }, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE conversations
     SET
       state = COALESCE($3, state),
       context = CASE
         WHEN $4::jsonb IS NULL THEN context
         ELSE context || $4::jsonb
       END,
       "updatedAt" = NOW()
     WHERE id = $1
       AND "clinicId" = $2
     RETURNING id, state, context`,
    [conversationId, clinicId, state || null, contextPatch ? JSON.stringify(contextPatch) : null]
  );
  return result.rows[0] || null;
}

async function updateConversationStatusForClinic({ conversationId, clinicId, status }, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE conversations
     SET
       status = $3,
       "updatedAt" = NOW()
     WHERE id = $1
       AND "clinicId" = $2
     RETURNING id, status, "updatedAt"`,
    [conversationId, clinicId, status]
  );
  return result.rows[0] || null;
}

async function reassignConversationChannelForClinic({ conversationId, clinicId, channelId, waTo = null }, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE conversations
     SET
       "channelId" = $3,
       "waTo" = COALESCE($4, "waTo"),
       "updatedAt" = NOW()
     WHERE id = $1
       AND "clinicId" = $2
     RETURNING id, "clinicId", "channelId", "contactId", "waFrom", "waTo", status, stage, state, context,
               "lastInboundAt", "lastOutboundAt", "createdAt", "updatedAt"`,
    [conversationId, clinicId, channelId, waTo]
  );
  return result.rows[0] || null;
}

async function enqueueJob(type, payload, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO jobs ("clinicId", "channelId", type, payload, status, attempts, "maxAttempts", "runAt", "updatedAt")
     VALUES ($1, $2, $3, $4::jsonb, 'queued', 0, 10, NOW(), NOW())
     RETURNING id, type, status, "runAt"`,
    [payload.clinicId, payload.channelId, type, JSON.stringify(payload || {})]
  );
  return result.rows[0] || null;
}

async function listConversations(limit = 50, client = null) {
  const parsedLimit = Number.isInteger(Number(limit)) ? Number(limit) : 50;
  const safeLimit = Math.max(1, Math.min(200, parsedLimit));

  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "channelId", "contactId", "waFrom", "waTo", status, stage, state, context,
            "lastInboundAt", "lastOutboundAt", "createdAt", "updatedAt"
     FROM conversations
     ORDER BY "updatedAt" DESC
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows;
}

async function listConversationMessages(conversationId, limit = 100, client = null) {
  const parsedLimit = Number.isInteger(Number(limit)) ? Number(limit) : 100;
  const safeLimit = Math.max(1, Math.min(500, parsedLimit));

  const result = await dbQuery(
    client,
    `SELECT id, "conversationId", direction, "waMessageId", "from", "to", type, text, raw, "createdAt"
     FROM conversation_messages
     WHERE "conversationId" = $1
     ORDER BY "createdAt" ASC
     LIMIT $2`,
    [conversationId, safeLimit]
  );
  return result.rows;
}

async function listConversationMessagesByClinicId(conversationId, clinicId, limit = 100, client = null) {
  const parsedLimit = Number.isInteger(Number(limit)) ? Number(limit) : 100;
  const safeLimit = Math.max(1, Math.min(500, parsedLimit));

  const result = await dbQuery(
    client,
    `SELECT m.id, m."conversationId", m.direction, m."waMessageId", m."from", m."to", m.type, m.text, m.raw, m."createdAt"
     FROM conversation_messages m
     INNER JOIN conversations c ON c.id = m."conversationId"
     WHERE m."conversationId" = $1
       AND c."clinicId" = $2
     ORDER BY m."createdAt" ASC
     LIMIT $3`,
    [conversationId, clinicId, safeLimit]
  );
  return result.rows;
}

async function getLastMessagesForAi(conversationId, limit = 10, client = null) {
  const parsedLimit = Number.isInteger(Number(limit)) ? Number(limit) : 10;
  const safeLimit = Math.max(1, Math.min(50, parsedLimit));

  const result = await dbQuery(
    client,
    `SELECT *
     FROM (
       SELECT id, "conversationId", direction, "waMessageId", "from", "to", type, text, raw, "createdAt"
       FROM conversation_messages
       WHERE "conversationId" = $1
       ORDER BY "createdAt" DESC
       LIMIT $2
     ) m
     ORDER BY "createdAt" ASC`,
    [conversationId, safeLimit]
  );

  return result.rows;
}

async function listOutboundAiAudit({ conversationId = null, limit = 20 } = {}, client = null) {
  const parsedLimit = Number.isInteger(Number(limit)) ? Number(limit) : 20;
  const safeLimit = Math.max(1, Math.min(100, parsedLimit));
  const safeConversationId = String(conversationId || '').trim() || null;

  const params = [];
  let idx = 1;
  const where = [`direction = 'outbound'`];

  if (safeConversationId) {
    where.push(`"conversationId" = $${idx}`);
    params.push(safeConversationId);
    idx += 1;
  }

  params.push(safeLimit);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const result = await dbQuery(
    client,
    `SELECT
       "conversationId",
       text,
       "createdAt",
       raw->'ai' AS ai
     FROM conversation_messages
     ${whereSql}
     ORDER BY "createdAt" DESC
     LIMIT $${idx}`,
    params
  );

  return result.rows.map((row) => {
    const ai = row.ai && typeof row.ai === 'object' ? row.ai : {};
    return {
      conversationId: row.conversationId,
      text: row.text || null,
      createdAt: row.createdAt || null,
      ai: {
        enabled: ai.enabled === true,
        attempted: ai.attempted === true,
        used: ai.used === true,
        fallbackUsed: ai.fallbackUsed === true,
        skipReason: ai.skipReason || null,
        model: ai.model || null,
        usage: ai.usage || null
      }
    };
  });
}

async function listAppointmentRequests({ limit = 50, offset = 0 } = {}, client = null) {
  const parsedLimit = Number.isInteger(Number(limit)) ? Number(limit) : 50;
  const parsedOffset = Number.isInteger(Number(offset)) ? Number(offset) : 0;
  const safeLimit = Math.max(1, Math.min(200, parsedLimit));
  const safeOffset = Math.max(0, parsedOffset);

  const result = await dbQuery(
    client,
    `SELECT
       c.id,
       c."clinicId",
       c."channelId",
       c."contactId",
       c.state,
       c.context,
       c."updatedAt",
       ct."waId",
       ct.name
     FROM conversations c
     LEFT JOIN contacts ct ON ct.id = c."contactId"
     WHERE c.context->>'appointmentStatus' = 'requested'
     ORDER BY COALESCE((c.context->>'appointmentRequestedAt')::timestamptz, c."updatedAt") DESC
     LIMIT $1 OFFSET $2`,
    [safeLimit, safeOffset]
  );

  return result.rows;
}

async function getLastInboundTextByConversationIds(conversationIds = [], client = null) {
  const ids = Array.isArray(conversationIds) ? conversationIds.filter(Boolean) : [];
  if (!ids.length) return {};

  const result = await dbQuery(
    client,
    `SELECT DISTINCT ON ("conversationId")
       "conversationId",
       text,
       "createdAt"
     FROM conversation_messages
     WHERE direction = 'inbound'
       AND "conversationId" = ANY($1::uuid[])
     ORDER BY "conversationId", "createdAt" DESC`,
    [ids]
  );

  return result.rows.reduce((acc, row) => {
    acc[row.conversationId] = {
      text: row.text || null,
      createdAt: row.createdAt || null
    };
    return acc;
  }, {});
}

function weekdayToEs(weekday) {
  const map = {
    monday: 'lunes',
    tuesday: 'martes',
    wednesday: 'miercoles',
    thursday: 'jueves',
    friday: 'viernes',
    saturday: 'sabado',
    sunday: 'domingo'
  };
  return map[String(weekday || '').toLowerCase()] || null;
}

function dateIsoToDisplay(dateISO) {
  const match = String(dateISO || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${match[3]}/${match[2]}`;
}

function buildCandidateDisplayFromContext(context) {
  const candidate = context && context.appointmentCandidate ? context.appointmentCandidate : {};
  const parsed = candidate && candidate.parsed ? candidate.parsed : {};

  if (candidate.displayText) return String(candidate.displayText);

  const weekday = weekdayToEs(parsed.weekday);
  const dateDisplay = dateIsoToDisplay(parsed.dateISO);
  const base = weekday || dateDisplay;
  if (!base) return candidate.rawText || null;

  if (parsed.time) return `${base} ${parsed.time}`;
  if (parsed.timeWindow === 'morning') return `${base} mañana`;
  if (parsed.timeWindow === 'afternoon') return `${base} tarde`;
  if (parsed.timeWindow === 'evening') return `${base} noche`;
  return base;
}

async function listInboxAppointments(
  {
    statuses,
    q,
    limit = 25,
    offset = 0,
    sort = 'requestedAt',
    order = 'desc',
    includeTotal = true,
    clinicId = null,
    channelId = null,
    hasTime = null,
    timeWindow = null,
    needsHumanAction = null,
    priority = null
  } = {},
  client = null
) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeStatuses = Array.isArray(statuses) && statuses.length
    ? statuses.map((s) => String(s || '').trim()).filter(Boolean)
    : ['requested', 'reschedule_proposed'];

  const sortRaw = String(sort || 'requestedAt');
  const safeSort = sortRaw === 'updatedAt' || sortRaw === 'priority' ? sortRaw : 'requestedAt';
  const safeOrder = String(order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const qTrimmed = String(q || '').trim();
  const hasQ = qTrimmed.length >= 2;
  const safeClinicId = String(clinicId || '').trim() || null;
  const safeChannelId = String(channelId || '').trim() || null;
  const safeIncludeTotal = includeTotal !== false;
  const safeHasTime = typeof hasTime === 'boolean' ? hasTime : null;
  const safeNeedsHumanAction = typeof needsHumanAction === 'boolean' ? needsHumanAction : null;
  const safeTimeWindow = Array.isArray(timeWindow)
    ? timeWindow.map((w) => String(w || '').trim()).filter(Boolean)
    : null;
  const safePriority = Array.isArray(priority)
    ? priority.map((p) => String(p || '').trim().toLowerCase()).filter((p) => ['high', 'normal', 'low'].includes(p))
    : null;

  const params = [];
  let idx = 1;

  const statusExpr = `COALESCE(c.context->>'appointmentStatus','')`;
  const hasTimeExpr = `(c.context->'appointmentCandidate'->'parsed'->>'time') IS NOT NULL`;
  const timeWindowExpr = `(c.context->'appointmentCandidate'->'parsed'->>'timeWindow')`;
  const needsHumanActionExpr = `(${statusExpr} IN ('requested','reschedule_proposed'))`;
  const priorityRankExpr = `CASE
    WHEN ${needsHumanActionExpr} AND (NOT ${hasTimeExpr} OR ${timeWindowExpr} IS NOT NULL) THEN 1
    WHEN ${needsHumanActionExpr} AND ${hasTimeExpr} THEN 2
    ELSE 3
  END`;
  const priorityLabelExpr = `CASE
    WHEN ${priorityRankExpr} = 1 THEN 'high'
    WHEN ${priorityRankExpr} = 2 THEN 'normal'
    ELSE 'low'
  END`;

  const where = [];
  where.push(`${statusExpr} = ANY($${idx}::text[])`);
  params.push(safeStatuses);
  idx += 1;

  if (hasQ) {
    where.push(`(
      COALESCE(c.context->>'name','') ILIKE $${idx}
      OR COALESCE(ct."waId",'') ILIKE $${idx}
      OR COALESCE(last_inbound.text,'') ILIKE $${idx}
    )`);
    params.push(`%${qTrimmed}%`);
    idx += 1;
  }

  if (safeClinicId) {
    where.push(`c."clinicId" = $${idx}`);
    params.push(safeClinicId);
    idx += 1;
  }

  if (safeChannelId) {
    where.push(`c."channelId" = $${idx}`);
    params.push(safeChannelId);
    idx += 1;
  }

  if (safeHasTime !== null) {
    where.push(safeHasTime ? hasTimeExpr : `NOT ${hasTimeExpr}`);
  }

  if (safeTimeWindow && safeTimeWindow.length) {
    where.push(`${timeWindowExpr} = ANY($${idx}::text[])`);
    params.push(safeTimeWindow);
    idx += 1;
  }

  if (safeNeedsHumanAction !== null) {
    where.push(safeNeedsHumanAction ? needsHumanActionExpr : `NOT ${needsHumanActionExpr}`);
  }

  if (safePriority && safePriority.length) {
    where.push(`${priorityLabelExpr} = ANY($${idx}::text[])`);
    params.push(safePriority);
    idx += 1;
  }

  const requestedAtSafeCast = `CASE
    WHEN (c.context->>'appointmentRequestedAt') ~ '^\\d{4}-\\d{2}-\\d{2}T'
    THEN (c.context->>'appointmentRequestedAt')::timestamptz
    ELSE NULL
  END`;

  const requestedAtSortExpr = `COALESCE(${requestedAtSafeCast}, c."updatedAt")`;
  const orderExpr = safeSort === 'updatedAt'
    ? `c."updatedAt"`
    : requestedAtSortExpr;

  params.push(safeLimit);
  const limitParam = `$${idx}`;
  idx += 1;
  params.push(safeOffset);
  const offsetParam = `$${idx}`;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rowsResult = await dbQuery(
    client,
    `SELECT
       c.id,
       c."clinicId",
       c."channelId",
       c."contactId",
       c.context,
       ${requestedAtSortExpr} AS "requestedAtSortKey",
       c."updatedAt",
       ct."waId",
       ct.name,
       last_inbound.text AS "lastInboundText",
       ${hasTimeExpr} AS "hasTimeCalc",
       ${timeWindowExpr} AS "timeWindowCalc",
       ${needsHumanActionExpr} AS "needsHumanActionCalc",
       ${priorityRankExpr} AS "priorityRank",
       FLOOR(EXTRACT(EPOCH FROM (NOW() - ${requestedAtSortExpr})) / 60)::int AS "ageMinutes"
     FROM conversations c
     LEFT JOIN contacts ct ON ct.id = c."contactId"
     LEFT JOIN LATERAL (
       SELECT m.text
       FROM conversation_messages m
       WHERE m."conversationId" = c.id
         AND m.direction = 'inbound'
       ORDER BY m."createdAt" DESC
       LIMIT 1
     ) last_inbound ON TRUE
     ${whereSql}
     ORDER BY ${
       safeSort === 'priority'
         ? `${priorityRankExpr} ASC, ${requestedAtSortExpr} DESC`
         : `${orderExpr} ${safeOrder}`
     }, c."updatedAt" DESC, c.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params
  );

  let total = null;
  if (safeIncludeTotal) {
    const countWhere = [];
    const countParams = [];
    let cidx = 1;
    countWhere.push(`${statusExpr} = ANY($${cidx}::text[])`);
    countParams.push(safeStatuses);
    cidx += 1;

    if (hasQ) {
      countWhere.push(`(
        COALESCE(c.context->>'name','') ILIKE $${cidx}
        OR COALESCE(ct."waId",'') ILIKE $${cidx}
        OR EXISTS (
          SELECT 1
          FROM conversation_messages m
          WHERE m."conversationId" = c.id
            AND m.direction = 'inbound'
            AND COALESCE(m.text,'') ILIKE $${cidx}
          LIMIT 1
        )
      )`);
      countParams.push(`%${qTrimmed}%`);
      cidx += 1;
    }

    if (safeClinicId) {
      countWhere.push(`c."clinicId" = $${cidx}`);
      countParams.push(safeClinicId);
      cidx += 1;
    }

    if (safeChannelId) {
      countWhere.push(`c."channelId" = $${cidx}`);
      countParams.push(safeChannelId);
      cidx += 1;
    }

    if (safeHasTime !== null) {
      countWhere.push(safeHasTime ? hasTimeExpr : `NOT ${hasTimeExpr}`);
    }

    if (safeTimeWindow && safeTimeWindow.length) {
      countWhere.push(`${timeWindowExpr} = ANY($${cidx}::text[])`);
      countParams.push(safeTimeWindow);
      cidx += 1;
    }

    if (safeNeedsHumanAction !== null) {
      countWhere.push(safeNeedsHumanAction ? needsHumanActionExpr : `NOT ${needsHumanActionExpr}`);
    }

    if (safePriority && safePriority.length) {
      countWhere.push(`${priorityLabelExpr} = ANY($${cidx}::text[])`);
      countParams.push(safePriority);
      cidx += 1;
    }

    const countWhereSql = countWhere.length ? `WHERE ${countWhere.join(' AND ')}` : '';
    const countResult = await dbQuery(
      client,
      `SELECT COUNT(*)::int AS total
       FROM conversations c
       LEFT JOIN contacts ct ON ct.id = c."contactId"
       ${countWhereSql}`,
      countParams
    );
    total = countResult.rows[0] ? Number(countResult.rows[0].total) : null;
  }

  const items = rowsResult.rows.map((row) => {
    const context = row.context || {};
    const parsed = context.appointmentCandidate && context.appointmentCandidate.parsed
      ? context.appointmentCandidate.parsed
      : null;
    const status = context.appointmentStatus || null;
    const hasTimeValue = row.hasTimeCalc === true;
    const timeWindowValue = row.timeWindowCalc || (parsed && parsed.timeWindow ? parsed.timeWindow : null);
    const needsHumanActionValue = row.needsHumanActionCalc === true;
    const priorityValue =
      row.priorityRank === 1 ? 'high' : row.priorityRank === 2 ? 'normal' : 'low';
    return {
      conversationId: row.id,
      status,
      requestedAt: row.requestedAtSortKey || row.updatedAt || null,
      updatedAt: row.updatedAt || null,
      name: context.name || row.name || null,
      waId: row.waId || null,
      lastInboundText: row.lastInboundText || null,
      candidateDisplay: buildCandidateDisplayFromContext(context),
      timeWindow: timeWindowValue,
      hasTime: hasTimeValue,
      needsHumanAction: needsHumanActionValue,
      priority: priorityValue,
      priorityRank: Number(row.priorityRank || 3),
      ageMinutes: Number(row.ageMinutes || 0),
      clinicId: row.clinicId,
      channelId: row.channelId,
      contactId: row.contactId
    };
  });

  return {
    items,
    total,
    limit: safeLimit,
    offset: safeOffset
  };
}

async function setAppointmentStatus({ conversationId, status, patch = {} }, client = null) {
  const mergedPatch = {
    appointmentStatus: status,
    appointmentUpdatedAt: new Date().toISOString(),
    appointmentUpdatedBy: 'human_panel',
    ...(patch || {})
  };

  return updateConversationState(
    {
      conversationId,
      state: null,
      contextPatch: mergedPatch
    },
    client
  );
}

async function getConversationWithLastMessages(conversationId, limit = 20, client = null) {
  const conversation = await getConversationById(conversationId, client);
  if (!conversation) return null;

  const messages = await listConversationMessages(conversationId, limit, client);
  return { conversation, messages };
}

function buildStartAtFromDateAndTime(dateISO, time, tzOffsetMinutes = -180) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO) || !/^\d{2}:\d{2}$/.test(time)) {
    return null;
  }

  const [yearStr, monthStr, dayStr] = dateISO.split('-');
  const [hourStr, minuteStr] = time.split(':');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute)
  ) {
    return null;
  }

  const utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - tzOffsetMinutes * 60 * 1000;
  const date = new Date(utcMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function buildStartAtFromCandidate(candidate, resolvedDateISO = null) {
  const parsed = candidate && candidate.parsed ? candidate.parsed : {};
  const dateISO = String(parsed.dateISO || resolvedDateISO || '').trim();
  const time = String(parsed.time || '').trim();
  if (!dateISO || !time) {
    return null;
  }
  return buildStartAtFromDateAndTime(dateISO, time, -180);
}

function formatDateArDisplay(date) {
  const dt = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(dt.getTime())) return null;
  const local = new Date(dt.getTime() - 3 * 60 * 60 * 1000);
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(local.getUTCDate()).padStart(2, '0');
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mi = String(local.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatDisplayFromStartAt(startAt) {
  return formatDateArDisplay(startAt);
}

function getTimeWindowBounds(timeWindow) {
  const normalized = String(timeWindow || '').trim().toLowerCase();
  if (normalized === 'morning') return { start: '09:00', end: '12:00' };
  if (normalized === 'afternoon') return { start: '14:00', end: '18:00' };
  if (normalized === 'evening') return { start: '18:00', end: '20:00' };
  return null;
}

function resolveCandidateTiming(candidate) {
  const safeCandidate = candidate && typeof candidate === 'object' ? candidate : {};
  const parsed = safeCandidate.parsed && typeof safeCandidate.parsed === 'object' ? safeCandidate.parsed : {};
  const resolvedDateISO =
    !parsed.dateISO && parsed.weekday
      ? resolveWeekdayToDateISO({
          weekday: parsed.weekday,
          baseDate: new Date(),
          tzOffsetMinutes: -180,
          time: parsed.time || null
        })
      : null;

  const requestedBaseText = String(safeCandidate.displayText || safeCandidate.rawText || '').trim() || null;
  const requestedText =
    requestedBaseText && resolvedDateISO && parsed.weekday && !parsed.dateISO
      ? `${requestedBaseText} (resuelto: ${resolvedDateISO})`
      : requestedBaseText;
  const timeWindow = String(parsed.timeWindow || '').trim() || null;
  const startAtDate = buildStartAtFromCandidate(safeCandidate, resolvedDateISO);
  const startAt = startAtDate ? startAtDate.toISOString() : null;
  const endAt = startAtDate ? new Date(startAtDate.getTime() + 30 * 60 * 1000).toISOString() : null;

  return {
    dateISO: parsed.dateISO || resolvedDateISO || null,
    resolvedDateISO,
    requestedText,
    timeWindow,
    startAt,
    endAt
  };
}

async function createAppointmentFromConversation(
  {
    clinicId,
    channelId,
    conversationId,
    contactId,
    waId,
    patientName,
    candidate,
    source = 'human_panel'
  },
  client = null
) {
  const timing = resolveCandidateTiming(candidate);
  const requestedText = timing.requestedText;
  const timeWindow = timing.timeWindow;
  const startAt = timing.startAt;
  const endAt = timing.endAt;

  try {
    const result = await dbQuery(
      client,
      `INSERT INTO appointments (
        id,
        "clinicId",
        "channelId",
        "conversationId",
        "contactId",
        "waId",
        "patientName",
        status,
        source,
        "requestedText",
        "startAt",
        "endAt",
        "timeWindow",
        "updatedAt"
      ) VALUES (
        $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, 'confirmed', $8, $9, $10::timestamptz, $11::timestamptz, $12, NOW()
      )
      RETURNING id, "clinicId", "channelId", "conversationId", "contactId", "waId", "patientName", status, source, "requestedText", "startAt", "endAt", "timeWindow", "createdAt", "updatedAt"`,
      [
        crypto.randomUUID(),
        clinicId,
        channelId || null,
        conversationId || null,
        contactId || null,
        waId || null,
        patientName || null,
        source || 'human_panel',
        requestedText,
        startAt,
        endAt,
        timeWindow
      ]
    );
    return { created: true, conflict: false, row: result.rows[0] || null };
  } catch (error) {
    if (error && error.code === '23505') {
      return { created: false, conflict: true, row: null };
    }
    throw error;
  }
}

async function createAppointmentFromSuggestion(
  {
    clinicId,
    channelId,
    conversationId,
    contactId,
    waId,
    patientName,
    startAt,
    endAt = null,
    requestedText = null,
    source = 'bot'
  },
  client = null
) {
  const safeStartAt = String(startAt || '').trim();
  if (!safeStartAt) {
    return { created: false, conflict: false, row: null, error: 'missing_startAt' };
  }

  const startDate = new Date(safeStartAt);
  if (Number.isNaN(startDate.getTime())) {
    return { created: false, conflict: false, row: null, error: 'invalid_startAt' };
  }

  const endDate = endAt ? new Date(endAt) : new Date(startDate.getTime() + 30 * 60 * 1000);
  if (Number.isNaN(endDate.getTime())) {
    return { created: false, conflict: false, row: null, error: 'invalid_endAt' };
  }

  const safeRequestedText = String(requestedText || '').trim() || formatDisplayFromStartAt(startDate);

  try {
    const result = await dbQuery(
      client,
      `INSERT INTO appointments (
        id,
        "clinicId",
        "channelId",
        "conversationId",
        "contactId",
        "waId",
        "patientName",
        status,
        source,
        "requestedText",
        "startAt",
        "endAt",
        "timeWindow",
        "updatedAt"
      ) VALUES (
        $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, 'confirmed', $8, $9, $10::timestamptz, $11::timestamptz, NULL, NOW()
      )
      RETURNING id, "clinicId", "channelId", "conversationId", "contactId", "waId", "patientName", status, source, "requestedText", "startAt", "endAt", "timeWindow", "createdAt", "updatedAt"`,
      [
        crypto.randomUUID(),
        clinicId,
        channelId || null,
        conversationId || null,
        contactId || null,
        waId || null,
        patientName || null,
        source || 'bot',
        safeRequestedText,
        startDate.toISOString(),
        endDate.toISOString()
      ]
    );
    return { created: true, conflict: false, row: result.rows[0] || null };
  } catch (error) {
    if (error && error.code === '23505') {
      return { created: false, conflict: true, row: null };
    }
    throw error;
  }
}

async function isSlotAvailable({ clinicId, startAt, excludeAppointmentId = null } = {}, client = null) {
  const safeClinicId = String(clinicId || '').trim();
  const safeStartAt = String(startAt || '').trim();
  const safeExclude = String(excludeAppointmentId || '').trim() || null;

  if (!safeClinicId || !safeStartAt) {
    return false;
  }

  const params = [safeClinicId, safeStartAt];
  let excludeSql = '';
  if (safeExclude) {
    params.push(safeExclude);
    excludeSql = ` AND id <> $3::uuid`;
  }

  const result = await dbQuery(
    client,
    `SELECT 1
     FROM appointments
     WHERE "clinicId" = $1::uuid
       AND "startAt" = $2::timestamptz
       AND status = 'confirmed'
       ${excludeSql}
     LIMIT 1`,
    params
  );

  return result.rows.length === 0;
}

async function suggestNextAvailableSlots(
  { clinicId, startAt, count = 3, stepMinutes = 30, maxLookaheadDays = 7 } = {},
  client = null
) {
  const safeClinicId = String(clinicId || '').trim();
  const baseDate = new Date(startAt);
  if (!safeClinicId || Number.isNaN(baseDate.getTime())) {
    return [];
  }

  const safeCount = Math.max(1, Math.min(10, Number(count) || 3));
  const safeStepMinutes = Math.max(5, Math.min(240, Number(stepMinutes) || 30));
  const safeMaxLookaheadDays = Math.max(1, Math.min(31, Number(maxLookaheadDays) || 7));

  const suggestions = [];
  const now = new Date();
  const lookaheadLimit = new Date(baseDate.getTime() + safeMaxLookaheadDays * 24 * 60 * 60 * 1000);
  let cursor = new Date(baseDate.getTime() + safeStepMinutes * 60 * 1000);

  while (suggestions.length < safeCount && cursor <= lookaheadLimit) {
    if (cursor > now) {
      const available = await isSlotAvailable(
        { clinicId: safeClinicId, startAt: cursor.toISOString(), excludeAppointmentId: null },
        client
      );
      if (available) {
        const endAt = new Date(cursor.getTime() + 30 * 60 * 1000);
        suggestions.push({
          startAt: cursor.toISOString(),
          endAt: endAt.toISOString(),
          displayText: formatDateArDisplay(cursor)
        });
      }
    }
    cursor = new Date(cursor.getTime() + safeStepMinutes * 60 * 1000);
  }

  return suggestions;
}

async function suggestSlotsForTimeWindow(
  { clinicId, dateISO, timeWindow, count = 3, stepMinutes = 30 } = {},
  client = null
) {
  const safeClinicId = String(clinicId || '').trim();
  const safeDateISO = String(dateISO || '').trim();
  const windowBounds = getTimeWindowBounds(timeWindow);
  if (!safeClinicId || !safeDateISO || !windowBounds) {
    return [];
  }

  const safeCount = Math.max(1, Math.min(10, Number(count) || 3));
  const safeStepMinutes = Math.max(5, Math.min(240, Number(stepMinutes) || 30));
  const windowStartMinutes =
    Number(windowBounds.start.slice(0, 2)) * 60 + Number(windowBounds.start.slice(3, 5));
  const windowEndMinutes =
    Number(windowBounds.end.slice(0, 2)) * 60 + Number(windowBounds.end.slice(3, 5));

  const suggestions = [];
  const now = new Date();

  for (let mins = windowStartMinutes; mins + 30 <= windowEndMinutes; mins += safeStepMinutes) {
    if (suggestions.length >= safeCount) break;
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    const startAtDate = buildStartAtFromDateAndTime(safeDateISO, `${hh}:${mm}`, -180);
    if (!startAtDate) continue;
    if (startAtDate <= now) continue;

    const available = await isSlotAvailable(
      { clinicId: safeClinicId, startAt: startAtDate.toISOString(), excludeAppointmentId: null },
      client
    );
    if (!available) continue;

    const endAtDate = new Date(startAtDate.getTime() + 30 * 60 * 1000);
    suggestions.push({
      startAt: startAtDate.toISOString(),
      endAt: endAtDate.toISOString(),
      displayText: formatDateArDisplay(startAtDate)
    });
  }

  return suggestions;
}

async function listAppointmentsCalendar({ from, to, clinicId = null } = {}, client = null) {
  const safeClinicId = String(clinicId || '').trim() || null;
  const fromDate = from ? new Date(from) : new Date();
  const toDate = to ? new Date(to) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new Error('Invalid from/to dates');
  }

  const params = [fromDate.toISOString(), toDate.toISOString()];
  let idx = 3;
  let clinicFilter = '';
  if (safeClinicId) {
    clinicFilter = ` AND "clinicId" = $${idx}::uuid`;
    params.push(safeClinicId);
  }

  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId",
       "channelId",
       "conversationId",
       "contactId",
       "waId",
       "patientName",
       status,
       source,
       "requestedText",
       "startAt",
       "endAt",
       "timeWindow",
       "createdAt",
       "updatedAt"
     FROM appointments
     WHERE ("startAt" IS NULL OR ("startAt" >= $1::timestamptz AND "startAt" <= $2::timestamptz))
     ${clinicFilter}
     ORDER BY "startAt" ASC NULLS LAST, "createdAt" DESC`,
    params
  );

  return result.rows;
}

async function findLatestConfirmedAppointment({ clinicId, waId = null, conversationId = null } = {}, client = null) {
  const safeClinicId = String(clinicId || '').trim();
  const safeWaId = String(waId || '').trim() || null;
  const safeConversationId = String(conversationId || '').trim() || null;
  if (!safeClinicId) return null;

  const params = [safeClinicId];
  const where = [`"clinicId" = $1::uuid`, `status = 'confirmed'`];
  let idx = 2;

  if (safeWaId) {
    where.push(`"waId" = $${idx}`);
    params.push(safeWaId);
    idx += 1;
  }

  if (safeConversationId) {
    where.push(`"conversationId" = $${idx}::uuid`);
    params.push(safeConversationId);
    idx += 1;
  }

  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "conversationId", "waId", status, "startAt", "endAt", "createdAt", "updatedAt"
     FROM appointments
     WHERE ${where.join(' AND ')}
     ORDER BY "startAt" DESC NULLS LAST, "createdAt" DESC
     LIMIT 1`,
    params
  );

  return result.rows[0] || null;
}

async function cancelAppointmentById({ appointmentId } = {}, client = null) {
  const safeAppointmentId = String(appointmentId || '').trim();
  if (!safeAppointmentId) {
    return null;
  }

  const result = await dbQuery(
    client,
    `UPDATE appointments
     SET status = 'cancelled', "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND status = 'confirmed'
     RETURNING id, "clinicId", "conversationId", "waId", status, "startAt", "endAt", "updatedAt"`,
    [safeAppointmentId]
  );

  return result.rows[0] || null;
}

module.exports = {
  upsertConversation,
  insertInboundMessage,
  insertOutboundMessage,
  getConversationById,
  getConversationByIdAndClinicId,
  getMessageById,
  hasNewerInboundMessage,
  findAutomationOutboundByInboundMessageId,
  updateConversationState,
  updateConversationStateForClinic,
  updateConversationStatusForClinic,
  reassignConversationChannelForClinic,
  listAppointmentRequests,
  getLastInboundTextByConversationIds,
  listInboxAppointments,
  setAppointmentStatus,
  createAppointmentFromConversation,
  createAppointmentFromSuggestion,
  isSlotAvailable,
  suggestNextAvailableSlots,
  getTimeWindowBounds,
  suggestSlotsForTimeWindow,
  resolveCandidateTiming,
  listAppointmentsCalendar,
  findLatestConfirmedAppointment,
  cancelAppointmentById,
  getConversationWithLastMessages,
  getLastMessagesForAi,
  listOutboundAiAudit,
  enqueueJob,
  listConversations,
  listConversationMessages,
  listConversationMessagesByClinicId
};
