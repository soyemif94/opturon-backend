const { DateTime } = require('luxon');
const { query, withTransaction } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function toUtcIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (DateTime.isDateTime(value)) return value.toUTC().toISO();
  return DateTime.fromISO(String(value), { zone: 'utc' }).toISO();
}

async function getClinic(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, timezone, settings
     FROM clinics
     WHERE id = $1
     LIMIT 1`,
    [clinicId]
  );

  return result.rows[0] || null;
}

async function getOrCreateCalendarRules(clinicId, client = null) {
  const clinic = await getClinic(clinicId, client);
  if (!clinic) {
    throw new Error('Clinic not found');
  }

  const timezone = clinic.timezone || 'America/Argentina/Buenos_Aires';
  const result = await dbQuery(
    client,
    `INSERT INTO calendar_rules (
      "clinicId", timezone, "slotMinutes", "leadTimeMinutes", "workDays", "workHours", "breakHours", "updatedAt"
    ) VALUES (
      $1, $2, 30, 60, '[1,2,3,4,5]'::jsonb, '{"start":"09:00","end":"18:00"}'::jsonb, '{"start":"13:00","end":"14:00"}'::jsonb, NOW()
    )
    ON CONFLICT ("clinicId")
    DO UPDATE SET "updatedAt" = NOW()
    RETURNING id, "clinicId", timezone, "slotMinutes", "leadTimeMinutes", "workDays", "workHours", "breakHours"`,
    [clinicId, timezone]
  );

  return result.rows[0];
}

function parseTimeToMinutes(value, fallback) {
  const text = String(value || fallback || '00:00');
  const parts = text.split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1] || 0);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return 0;
  return hh * 60 + mm;
}

function buildSlotCandidates(rules, fromUTC, toUTC) {
  const timezone = rules.timezone || 'America/Argentina/Buenos_Aires';
  const slotMinutes = Math.max(5, Number(rules.slotMinutes) || 30);
  const workDays = Array.isArray(rules.workDays) ? rules.workDays.map(Number) : [1, 2, 3, 4, 5];
  const workHours = rules.workHours || { start: '09:00', end: '18:00' };
  const breakHours = rules.breakHours || { start: '13:00', end: '14:00' };

  const startMinute = parseTimeToMinutes(workHours.start, '09:00');
  const endMinute = parseTimeToMinutes(workHours.end, '18:00');
  const breakStart = parseTimeToMinutes(breakHours.start, '13:00');
  const breakEnd = parseTimeToMinutes(breakHours.end, '14:00');

  const from = DateTime.fromISO(String(fromUTC), { zone: 'utc' });
  const to = DateTime.fromISO(String(toUTC), { zone: 'utc' });

  const firstLocalDay = from.setZone(timezone).startOf('day');
  const lastLocalDay = to.setZone(timezone).endOf('day');
  const slots = [];

  for (let day = firstLocalDay; day <= lastLocalDay; day = day.plus({ days: 1 })) {
    const weekday = day.weekday;
    if (!workDays.includes(weekday)) {
      continue;
    }

    for (let minute = startMinute; minute + slotMinutes <= endMinute; minute += slotMinutes) {
      const slotEndMinute = minute + slotMinutes;
      const overlapsBreak = minute < breakEnd && slotEndMinute > breakStart;
      if (overlapsBreak) {
        continue;
      }

      const slotStartLocal = day.plus({ minutes: minute });
      const slotEndLocal = day.plus({ minutes: slotEndMinute });

      const slotStartUtc = slotStartLocal.toUTC();
      const slotEndUtc = slotEndLocal.toUTC();

      if (slotStartUtc < from || slotEndUtc > to) {
        continue;
      }

      slots.push({
        startsAt: slotStartUtc.toISO(),
        endsAt: slotEndUtc.toISO()
      });
    }
  }

  return slots;
}

async function ensureSlotsForDateRange(clinicId, fromUTC, toUTC, client = null) {
  const txRunner = async (txClient) => {
    const rules = await getOrCreateCalendarRules(clinicId, txClient);
    const candidates = buildSlotCandidates(rules, fromUTC, toUTC);

    if (candidates.length === 0) {
      return { generated: 0, rules };
    }

    let generated = 0;
    for (const candidate of candidates) {
      const result = await dbQuery(
        txClient,
        `INSERT INTO calendar_slots (
          "clinicId", "startsAt", "endsAt", status, "updatedAt"
        ) VALUES ($1, $2, $3, 'available', NOW())
        ON CONFLICT ("clinicId", "startsAt", "endsAt")
        DO NOTHING
        RETURNING id`,
        [clinicId, candidate.startsAt, candidate.endsAt]
      );

      if (result.rows[0]) {
        generated += 1;
      }
    }

    return { generated, rules };
  };

  if (client) {
    return txRunner(client);
  }

  return withTransaction(txRunner);
}

async function listAvailableSlots(clinicId, fromUTC, toUTC, limit = 5, client = null) {
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "startsAt", "endsAt", status, "heldUntil", "heldByConversationId", "bookedByLeadId"
     FROM calendar_slots
     WHERE "clinicId" = $1
       AND "startsAt" >= $2
       AND "startsAt" <= $3
       AND (
         status = 'available'
         OR (status = 'held' AND "heldUntil" < NOW())
       )
     ORDER BY "startsAt" ASC
     LIMIT $4`,
    [clinicId, toUtcIso(fromUTC), toUtcIso(toUTC), safeLimit]
  );

  return result.rows;
}

async function holdSlot(clinicId, slotId, conversationId, holdMinutes = 10, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE calendar_slots
     SET status = 'held',
         "heldUntil" = NOW() + make_interval(mins => $4),
         "heldByConversationId" = $3,
         "updatedAt" = NOW()
     WHERE id = $2
       AND "clinicId" = $1
       AND (
         status = 'available'
         OR (status = 'held' AND "heldUntil" < NOW())
       )
     RETURNING id, "clinicId", "startsAt", "endsAt", status, "heldUntil", "heldByConversationId"`,
    [clinicId, slotId, conversationId, Math.max(1, Number(holdMinutes) || 10)]
  );

  return result.rows[0] || null;
}

async function bookHeldSlot(clinicId, slotId, leadId, conversationId, contactId, client = null) {
  const txRunner = async (txClient) => {
    const slotResult = await dbQuery(
      txClient,
      `UPDATE calendar_slots
       SET status = 'booked',
           "heldUntil" = NULL,
           "bookedByLeadId" = $3,
           "updatedAt" = NOW()
       WHERE id = $2
         AND "clinicId" = $1
         AND status = 'held'
         AND "heldByConversationId" = $4
         AND ("heldUntil" IS NULL OR "heldUntil" >= NOW())
       RETURNING id, "clinicId", "startsAt", "endsAt", status, "bookedByLeadId"`,
      [clinicId, slotId, leadId, conversationId]
    );

    const slot = slotResult.rows[0];
    if (!slot) {
      return null;
    }

    const appointmentResult = await dbQuery(
      txClient,
      `INSERT INTO appointments (
        "clinicId", "leadId", "conversationId", "contactId", "slotId", status, "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, 'booked', NOW())
      RETURNING id, "clinicId", "leadId", "conversationId", "contactId", "slotId", status`,
      [clinicId, leadId, conversationId, contactId, slotId]
    );

    return {
      slot,
      appointment: appointmentResult.rows[0]
    };
  };

  if (client) {
    return txRunner(client);
  }

  return withTransaction(txRunner);
}

async function releaseExpiredHolds(clinicId = null, client = null) {
  if (clinicId) {
    const result = await dbQuery(
      client,
      `UPDATE calendar_slots
       SET status = 'available',
           "heldUntil" = NULL,
           "heldByConversationId" = NULL,
           "updatedAt" = NOW()
       WHERE "clinicId" = $1
         AND status = 'held'
         AND "heldUntil" < NOW()
       RETURNING id`,
      [clinicId]
    );

    return result.rowCount;
  }

  const result = await dbQuery(
    client,
    `UPDATE calendar_slots
     SET status = 'available',
         "heldUntil" = NULL,
         "heldByConversationId" = NULL,
         "updatedAt" = NOW()
     WHERE status = 'held'
       AND "heldUntil" < NOW()
     RETURNING id`
  );

  return result.rowCount;
}

async function findBookedAppointmentByConversation(clinicId, conversationId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT a.id, a."clinicId", a."leadId", a."conversationId", a."contactId", a."slotId", a.status, a.reason,
            s."startsAt", s."endsAt"
     FROM appointments a
     JOIN calendar_slots s ON s.id = a."slotId"
     WHERE a."clinicId" = $1
       AND a."conversationId" = $2
       AND a.status = 'booked'
     ORDER BY a."createdAt" DESC
     LIMIT 1`,
    [clinicId, conversationId]
  );

  return result.rows[0] || null;
}

async function cancelAppointment(clinicId, appointmentId, reason = null, client = null) {
  const txRunner = async (txClient) => {
    const appointmentResult = await dbQuery(
      txClient,
      `UPDATE appointments
       SET status = 'cancelled',
           reason = COALESCE($3, reason),
           "updatedAt" = NOW()
       WHERE id = $2
         AND "clinicId" = $1
         AND status = 'booked'
       RETURNING id, "slotId", "conversationId", "leadId", status`,
      [clinicId, appointmentId, reason]
    );

    const appointment = appointmentResult.rows[0];
    if (!appointment) {
      return null;
    }

    await dbQuery(
      txClient,
      `UPDATE calendar_slots
       SET status = 'available',
           "heldUntil" = NULL,
           "heldByConversationId" = NULL,
           "bookedByLeadId" = NULL,
           "updatedAt" = NOW()
       WHERE id = $1`,
      [appointment.slotId]
    );

    return appointment;
  };

  if (client) {
    return txRunner(client);
  }

  return withTransaction(txRunner);
}

async function listAppointments(clinicId, fromUTC, toUTC, client = null) {
  const result = await dbQuery(
    client,
    `SELECT a.id, a."clinicId", a."leadId", a."conversationId", a."contactId", a."slotId", a.status, a.reason,
            a."createdAt", a."updatedAt", s."startsAt", s."endsAt"
     FROM appointments a
     JOIN calendar_slots s ON s.id = a."slotId"
     WHERE a."clinicId" = $1
       AND s."startsAt" >= $2
       AND s."startsAt" <= $3
     ORDER BY s."startsAt" ASC`,
    [clinicId, toUtcIso(fromUTC), toUtcIso(toUTC)]
  );

  return result.rows;
}

module.exports = {
  getOrCreateCalendarRules,
  ensureSlotsForDateRange,
  listAvailableSlots,
  holdSlot,
  bookHeldSlot,
  releaseExpiredHolds,
  findBookedAppointmentByConversation,
  cancelAppointment,
  listAppointments,
  getClinic
};

