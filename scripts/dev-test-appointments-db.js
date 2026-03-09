const crypto = require('crypto');
const { query, closePool } = require('../src/db/client');
const {
  createAppointmentFromConversation,
  listAppointmentsCalendar,
  suggestNextAvailableSlots,
  suggestSlotsForTimeWindow
} = require('../src/conversations/conversation.repo');

function toDateIso(date) {
  return date.toISOString().slice(0, 10);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

async function selectBaseConversation() {
  const result = await query(
    `SELECT
       c.id AS "conversationId",
       c."clinicId",
       c."channelId",
       c."contactId",
       c.context,
       ct."waId",
       ct.name
     FROM conversations c
     LEFT JOIN contacts ct ON ct.id = c."contactId"
     WHERE c."clinicId" IS NOT NULL
       AND c."channelId" IS NOT NULL
       AND c."contactId" IS NOT NULL
     ORDER BY c."updatedAt" DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function main() {
  const checks = {
    dbOk: false,
    createdFirst: false,
    conflictSecond: false,
    listedFound: false,
    weekdayCreated: false,
    weekdayStartAtSet: false,
    weekdayTimeWindowNoStartAt: false,
    conflictSuggestions: false,
    timeWindowSuggestions: false,
    timeWindowWithinBounds: false,
    timeWindowSkipsOccupied: false
  };

  let created = {
    appointmentId: null,
    startAt: null,
    endAt: null
  };
  let listedCount = 0;
  let weekdayResult = {
    appointmentId: null,
    resolvedHint: null,
    startAt: null
  };

  try {
    await query('SELECT 1 AS ok');
    checks.dbOk = true;

    const base = await selectBaseConversation();
    if (!base) {
      throw new Error('No conversation with clinic/channel/contact found. Seed data first.');
    }

    const now = new Date();
    const apptDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const randomSlot = Math.floor(Math.random() * 48); // 00:00..23:30
    const hh = Math.floor(randomSlot / 2);
    const mm = randomSlot % 2 === 0 ? 0 : 30;
    const dateISO = toDateIso(apptDate);
    const time = `${pad2(hh)}:${pad2(mm)}`;
    const displayText = `${dateISO} ${time}`;

    const candidate = {
      displayText,
      rawText: displayText,
      parsed: {
        dateISO,
        time,
        timeWindow: null
      }
    };

    const payload = {
      clinicId: base.clinicId,
      channelId: base.channelId,
      conversationId: base.conversationId,
      contactId: base.contactId,
      waId: base.waId || '5492915275449',
      patientName: (base.context && base.context.name) || base.name || 'Test User',
      candidate,
      source: 'human_panel'
    };

    const first = await createAppointmentFromConversation(payload);
    checks.createdFirst = !!(first && first.created && first.row && first.row.id);
    if (checks.createdFirst) {
      created = {
        appointmentId: first.row.id,
        startAt: first.row.startAt || null,
        endAt: first.row.endAt || null
      };
    }

    const second = await createAppointmentFromConversation(payload);
    checks.conflictSecond = !!(second && second.created === false && second.conflict === true);
    const suggestions = await suggestNextAvailableSlots({
      clinicId: base.clinicId,
      startAt: created.startAt,
      count: 3,
      stepMinutes: 30,
      maxLookaheadDays: 7
    });
    checks.conflictSuggestions = Array.isArray(suggestions) && suggestions.length > 0
      ? suggestions.every((slot) => slot.startAt !== created.startAt)
      : false;

    const twDate = toDateIso(new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000));
    const occupiedCandidate = {
      displayText: `${twDate} 14:00`,
      rawText: `${twDate} 14:00`,
      parsed: {
        dateISO: twDate,
        time: '14:00'
      }
    };
    const occupied = await createAppointmentFromConversation({
      ...payload,
      candidate: occupiedCandidate
    });
    const occupiedStartAt = occupied && occupied.row ? occupied.row.startAt : null;

    const timeWindowSuggestions = await suggestSlotsForTimeWindow({
      clinicId: base.clinicId,
      dateISO: twDate,
      timeWindow: 'afternoon',
      count: 3,
      stepMinutes: 30
    });

    checks.timeWindowSuggestions = Array.isArray(timeWindowSuggestions) && timeWindowSuggestions.length >= 1;
    checks.timeWindowWithinBounds = checks.timeWindowSuggestions
      ? timeWindowSuggestions.every((slot) => {
          const dt = new Date(slot.startAt);
          const local = new Date(dt.getTime() - 3 * 60 * 60 * 1000);
          const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
          return minutes >= 14 * 60 && minutes < 18 * 60;
        })
      : false;
    checks.timeWindowSkipsOccupied = checks.timeWindowSuggestions
      ? (!occupiedStartAt || timeWindowSuggestions.every((slot) => slot.startAt !== occupiedStartAt))
      : false;

    const weekdaySlot = (randomSlot + 3) % 48;
    const weekdayHh = Math.floor(weekdaySlot / 2);
    const weekdayMm = weekdaySlot % 2 === 0 ? 0 : 30;
    const weekdayTime = `${pad2(weekdayHh)}:${pad2(weekdayMm)}`;

    const weekdayCandidate = {
      displayText: `lunes ${weekdayTime}`,
      rawText: `lunes ${weekdayTime}`,
      parsed: {
        weekday: 'monday',
        time: weekdayTime
      }
    };

    const weekdayPayload = {
      ...payload,
      candidate: weekdayCandidate
    };

    const weekdayFirst = await createAppointmentFromConversation(weekdayPayload);
    checks.weekdayCreated = !!(weekdayFirst && weekdayFirst.created && weekdayFirst.row && weekdayFirst.row.id);
    checks.weekdayStartAtSet = !!(weekdayFirst && weekdayFirst.row && weekdayFirst.row.startAt);
    weekdayResult = {
      appointmentId: weekdayFirst && weekdayFirst.row ? weekdayFirst.row.id : null,
      resolvedHint:
        weekdayFirst && weekdayFirst.row && weekdayFirst.row.requestedText
          ? String(weekdayFirst.row.requestedText)
          : null,
      startAt: weekdayFirst && weekdayFirst.row ? weekdayFirst.row.startAt || null : null
    };

    const weekdayWindowCandidate = {
      displayText: 'lunes por la tarde',
      rawText: 'lunes tarde',
      parsed: {
        weekday: 'monday',
        timeWindow: 'afternoon'
      }
    };

    const weekdayWindowFirst = await createAppointmentFromConversation({
      ...payload,
      candidate: weekdayWindowCandidate
    });
    checks.weekdayTimeWindowNoStartAt = !!(
      weekdayWindowFirst &&
      weekdayWindowFirst.created &&
      weekdayWindowFirst.row &&
      !weekdayWindowFirst.row.startAt
    );

    const from = `${dateISO}T00:00:00.000Z`;
    const to = `${dateISO}T23:59:59.999Z`;
    const listed = await listAppointmentsCalendar({
      from,
      to,
      clinicId: base.clinicId
    });

    listedCount = listed.length;
    const found = listed.find((item) => {
      if (created.appointmentId && item.id === created.appointmentId) return true;
      return (item.requestedText || '') === displayText;
    });
    checks.listedFound = !!found;

    const success = Object.values(checks).every(Boolean);
    const output = {
      success,
      checks,
      created,
      weekdayResult,
      suggestionsPreview: suggestions ? suggestions.slice(0, 3) : [],
      timeWindowSuggestionsPreview: timeWindowSuggestions ? timeWindowSuggestions.slice(0, 3) : [],
      listedCount,
      listedPreview: listed.slice(0, 3).map((item) => ({
        id: item.id,
        clinicId: item.clinicId,
        startAt: item.startAt,
        endAt: item.endAt,
        requestedText: item.requestedText,
        status: item.status,
        source: item.source
      }))
    };

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!success) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        {
          success: false,
          checks,
          created,
          weekdayResult,
          listedCount,
          error: error.message
        },
        null,
        2
      )}\n`
    );
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
