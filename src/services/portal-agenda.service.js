const { DateTime } = require('luxon');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findPortalContactById } = require('../repositories/contact.repository');
const { getClinic } = require('../repositories/calendar.repository');
const {
  listAgendaItemsByClinicAndRange,
  findAgendaItemById,
  listTimedAgendaConflicts,
  createAgendaItem,
  updateAgendaItemById,
  deleteAgendaItemById
} = require('../repositories/agenda-items.repository');

const ALLOWED_TYPES = new Set(['note', 'follow_up', 'task', 'appointment', 'blocked', 'availability']);
const ALLOWED_STATUSES = new Set(['pending', 'confirmed', 'done', 'reschedule', 'cancelled']);
const TIMED_TYPES = new Set(['appointment', 'blocked', 'availability']);
const ALLOWED_COMMERCIAL_ACTION_TYPES = new Set(['visit', 'demo', 'follow_up']);
const ALLOWED_COMMERCIAL_OUTCOMES = new Set([
  'interested',
  'not_interested',
  'proposal_requested',
  'follow_up_later',
  'future_demo',
  'won'
]);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNullableId(value) {
  const safeValue = normalizeString(value);
  return safeValue || null;
}

function resolveTimezone(timezone) {
  const safe = normalizeString(timezone) || 'America/Argentina/Buenos_Aires';
  return DateTime.now().setZone(safe).isValid ? safe : 'America/Argentina/Buenos_Aires';
}

function normalizeCommercialActionType(value) {
  const safe = normalizeString(value).toLowerCase();
  return ALLOWED_COMMERCIAL_ACTION_TYPES.has(safe) ? safe : null;
}

function normalizeCommercialOutcome(value) {
  const safe = normalizeString(value).toLowerCase();
  return ALLOWED_COMMERCIAL_OUTCOMES.has(safe) ? safe : null;
}

function normalizeAgendaMeta(payload = {}) {
  return {
    conversationId: normalizeNullableId(payload.conversationId),
    assignedUserId: normalizeNullableId(payload.assignedUserId),
    assignedUserName: normalizeString(payload.assignedUserName) || null,
    commercialActionType: normalizeCommercialActionType(payload.commercialActionType),
    commercialOutcome: normalizeCommercialOutcome(payload.commercialOutcome),
    origin: normalizeString(payload.origin) || null,
    location: normalizeString(payload.location) || null,
    resultNote: normalizeString(payload.resultNote) || null,
    nextStepNote: normalizeString(payload.nextStepNote) || null,
    nextActionAt: payload.nextActionAt ? String(payload.nextActionAt).trim() : null
  };
}

function buildReason(reason, detail = null, extra = null) {
  return {
    ok: false,
    reason,
    detail,
    ...(extra || {})
  };
}

function normalizeDateInput(value) {
  const safe = normalizeString(value);
  if (!safe) return null;
  const parsed = DateTime.fromISO(safe, { zone: 'utc' });
  return parsed.isValid ? parsed.toISODate() : null;
}

function normalizeRange(from, to, timezone) {
  const zone = resolveTimezone(timezone);
  const fromDate = normalizeDateInput(from);
  const toDate = normalizeDateInput(to);

  if (fromDate && toDate) {
    return { fromDate, toDate };
  }

  const now = DateTime.now().setZone(zone);
  const monthStart = now.startOf('month');
  const monthEnd = now.endOf('month');
  return {
    fromDate: fromDate || monthStart.toISODate(),
    toDate: toDate || monthEnd.toISODate()
  };
}

function normalizeAvailabilityRange(query = {}, timezone) {
  const safeDate = normalizeDateInput(query.date);
  if (safeDate) {
    return { fromDate: safeDate, toDate: safeDate };
  }

  return normalizeRange(query.from, query.to, timezone);
}

function getTimeWindowBounds(timeWindow) {
  const normalized = normalizeString(timeWindow).toLowerCase();
  if (normalized === 'morning') return { start: '09:00', end: '12:00' };
  if (normalized === 'afternoon') return { start: '14:00', end: '18:00' };
  if (normalized === 'evening') return { start: '18:00', end: '20:00' };
  return null;
}

function toUtcDateTime(date, time, timezone) {
  const safeDate = normalizeDateInput(date);
  const safeTime = normalizeString(time);
  if (!safeDate || !safeTime) return null;

  const parsed = DateTime.fromISO(`${safeDate}T${safeTime}`, { zone: resolveTimezone(timezone) });
  if (!parsed.isValid) return null;
  return parsed.toUTC().toISO();
}

function formatAgendaItem(item, timezone) {
  const safeTimezone = resolveTimezone(timezone);
  const startAt = item.startAt ? DateTime.fromISO(String(item.startAt), { zone: 'utc' }).setZone(safeTimezone) : null;
  const endAt = item.endAt ? DateTime.fromISO(String(item.endAt), { zone: 'utc' }).setZone(safeTimezone) : null;

  return {
    ...item,
    startTime: startAt ? startAt.toFormat('HH:mm') : null,
    endTime: endAt ? endAt.toFormat('HH:mm') : null,
    contactId: item.contactId || null,
    contact: item.contact || null,
    conversationId: item.conversationId || null,
    assignedUserId: item.assignedUserId || null,
    assignedUserName: item.assignedUserName || null,
    commercialActionType: item.commercialActionType || null,
    commercialOutcome: item.commercialOutcome || null,
    origin: item.origin || null,
    location: item.location || null,
    resultNote: item.resultNote || null,
    nextStepNote: item.nextStepNote || null,
    nextActionAt: item.nextActionAt || null
  };
}

function iterateDateRange(fromDate, toDate, timezone) {
  const zone = resolveTimezone(timezone);
  const start = DateTime.fromISO(fromDate, { zone }).startOf('day');
  const end = DateTime.fromISO(toDate, { zone }).startOf('day');
  const dates = [];
  let cursor = start;

  while (cursor <= end) {
    dates.push(cursor.toISODate());
    cursor = cursor.plus({ days: 1 });
  }

  return dates;
}

function toLocalWindow(item, timezone) {
  if (!item || !item.startAt || !item.endAt) return null;

  const start = DateTime.fromISO(String(item.startAt), { zone: 'utc' }).setZone(timezone);
  const end = DateTime.fromISO(String(item.endAt), { zone: 'utc' }).setZone(timezone);
  if (!start.isValid || !end.isValid) return null;

  return {
    id: item.id,
    type: item.type,
    title: item.title,
    date: start.toISODate(),
    startTime: start.toFormat('HH:mm'),
    endTime: end.toFormat('HH:mm'),
    startAt: start.toUTC().toISO(),
    endAt: end.toUTC().toISO(),
    startMinutes: start.hour * 60 + start.minute,
    endMinutes: end.hour * 60 + end.minute,
    contact: item.contact || null
  };
}

function formatMinutes(minuteValue) {
  const hours = Math.floor(minuteValue / 60);
  const minutes = minuteValue % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function buildWindowShape(date, startMinutes, endMinutes) {
  return {
    date,
    startTime: formatMinutes(startMinutes),
    endTime: formatMinutes(endMinutes)
  };
}

function hasExplicitAvailability(days) {
  return Array.isArray(days) && days.some((day) => Array.isArray(day.availability) && day.availability.length > 0);
}

function subtractWindows(baseWindows, occupiedWindows) {
  return baseWindows.flatMap((baseWindow) => {
    let fragments = [{ startMinutes: baseWindow.startMinutes, endMinutes: baseWindow.endMinutes }];

    occupiedWindows.forEach((occupied) => {
      fragments = fragments.flatMap((fragment) => {
        if (occupied.endMinutes <= fragment.startMinutes || occupied.startMinutes >= fragment.endMinutes) {
          return [fragment];
        }

        const nextFragments = [];
        if (occupied.startMinutes > fragment.startMinutes) {
          nextFragments.push({
            startMinutes: fragment.startMinutes,
            endMinutes: occupied.startMinutes
          });
        }
        if (occupied.endMinutes < fragment.endMinutes) {
          nextFragments.push({
            startMinutes: occupied.endMinutes,
            endMinutes: fragment.endMinutes
          });
        }
        return nextFragments;
      });
    });

    return fragments.filter((fragment) => fragment.endMinutes > fragment.startMinutes);
  });
}

function buildAvailabilityDaySnapshot(date, items, timezone) {
  const activeItems = items.filter((item) => item.status !== 'cancelled');
  const formattedItems = activeItems.map((item) => formatAgendaItem(item, timezone));
  const availability = formattedItems.filter((item) => item.type === 'availability');
  const blocked = formattedItems.filter((item) => item.type === 'blocked');
  const appointments = formattedItems.filter((item) => item.type === 'appointment');
  const informational = formattedItems.filter((item) => item.type === 'note' || item.type === 'follow_up' || item.type === 'task');

  const availabilityWindows = activeItems
    .filter((item) => item.type === 'availability')
    .map((item) => toLocalWindow(item, timezone))
    .filter(Boolean);
  const occupiedWindows = activeItems
    .filter((item) => item.type === 'appointment' || item.type === 'blocked')
    .map((item) => toLocalWindow(item, timezone))
    .filter(Boolean);

  const hasExplicitAvailability = availabilityWindows.length > 0;
  const bookableWindows = hasExplicitAvailability
    ? subtractWindows(availabilityWindows, occupiedWindows).map((window) => buildWindowShape(date, window.startMinutes, window.endMinutes))
    : [];

  return {
    date,
    policy: hasExplicitAvailability ? 'explicit_availability' : 'implicit_open',
    availability,
    blocked,
    appointments,
    informational,
    occupiedWindows: occupiedWindows.map((window) => ({
      date,
      type: window.type,
      title: window.title,
      startTime: window.startTime,
      endTime: window.endTime
    })),
    bookableWindows,
    summary: {
      availabilityCount: availability.length,
      blockedCount: blocked.length,
      appointmentCount: appointments.length,
      informationalCount: informational.length,
      bookableWindowCount: bookableWindows.length
    }
  };
}

function hasAnyTimeInput(payload) {
  return Boolean(
    (payload && payload.startAt) ||
      (payload && payload.endAt) ||
      (payload && payload.startTime) ||
      (payload && payload.endTime)
  );
}

function validateTimingRules({ type, startAt, endAt, payload }) {
  if ((payload && payload.startTime && !startAt) || (payload && payload.endTime && !endAt)) {
    return buildReason('invalid_agenda_time');
  }

  if (startAt && endAt && DateTime.fromISO(endAt) < DateTime.fromISO(startAt)) {
    return buildReason('invalid_agenda_time_range');
  }

  if (TIMED_TYPES.has(type) && (!startAt || !endAt)) {
    return buildReason('missing_agenda_time_range');
  }

  if (!TIMED_TYPES.has(type) && hasAnyTimeInput(payload) && (!startAt || !endAt)) {
    return buildReason('invalid_agenda_time_range');
  }

  return { ok: true };
}

function validateCreatePayload(payload, timezone) {
  const date = normalizeDateInput(payload && payload.date);
  const type = normalizeString(payload && payload.type).toLowerCase();
  const title = normalizeString(payload && payload.title);
  const description = normalizeString(payload && payload.description) || null;
  const status = normalizeString(payload && payload.status).toLowerCase() || 'pending';
  const contactId = normalizeNullableId(payload && payload.contactId);
  const startAt = payload && payload.startAt ? String(payload.startAt).trim() : toUtcDateTime(date, payload && payload.startTime, timezone);
  const endAt = payload && payload.endAt ? String(payload.endAt).trim() : toUtcDateTime(date, payload && payload.endTime, timezone);

  if (!date) return buildReason('invalid_agenda_date');
  if (!ALLOWED_TYPES.has(type)) return buildReason('invalid_agenda_type');
  if (!title) return buildReason('missing_agenda_title');
  if (!ALLOWED_STATUSES.has(status)) return buildReason('invalid_agenda_status');
  const timingValidation = validateTimingRules({ type, startAt, endAt, payload });
  if (!timingValidation.ok) return timingValidation;

  return {
    ok: true,
    value: {
      date,
      startAt: startAt || null,
      endAt: endAt || null,
      contactId,
      type,
      title,
      description,
      status,
      ...normalizeAgendaMeta(payload)
    }
  };
}

function validatePatchPayload(payload, timezone) {
  const patch = {};

  if (Object.prototype.hasOwnProperty.call(payload || {}, 'date')) {
    const date = normalizeDateInput(payload.date);
    if (!date) return buildReason('invalid_agenda_date');
    patch.date = date;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'type')) {
    const type = normalizeString(payload.type).toLowerCase();
    if (!ALLOWED_TYPES.has(type)) return buildReason('invalid_agenda_type');
    patch.type = type;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'title')) {
    const title = normalizeString(payload.title);
    if (!title) return buildReason('missing_agenda_title');
    patch.title = title;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'description')) {
    patch.description = normalizeString(payload.description) || null;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'contactId')) {
    patch.contactId = normalizeNullableId(payload.contactId);
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'status')) {
    const status = normalizeString(payload.status).toLowerCase();
    if (!ALLOWED_STATUSES.has(status)) return buildReason('invalid_agenda_status');
    patch.status = status;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'conversationId')) {
    patch.conversationId = normalizeNullableId(payload.conversationId);
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'assignedUserId')) {
    patch.assignedUserId = normalizeNullableId(payload.assignedUserId);
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'assignedUserName')) {
    patch.assignedUserName = normalizeString(payload.assignedUserName) || null;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'commercialActionType')) {
    patch.commercialActionType = normalizeCommercialActionType(payload.commercialActionType);
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'commercialOutcome')) {
    patch.commercialOutcome = normalizeCommercialOutcome(payload.commercialOutcome);
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'origin')) {
    patch.origin = normalizeString(payload.origin) || null;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'location')) {
    patch.location = normalizeString(payload.location) || null;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'resultNote')) {
    patch.resultNote = normalizeString(payload.resultNote) || null;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'nextStepNote')) {
    patch.nextStepNote = normalizeString(payload.nextStepNote) || null;
  }
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'nextActionAt')) {
    patch.nextActionAt = payload.nextActionAt ? String(payload.nextActionAt).trim() : null;
  }

  const baseDate = patch.date || normalizeDateInput(payload && payload.date) || null;
  if (Object.prototype.hasOwnProperty.call(payload || {}, 'startAt')) {
    patch.startAt = payload.startAt ? String(payload.startAt).trim() : null;
  } else if (Object.prototype.hasOwnProperty.call(payload || {}, 'startTime')) {
    patch.startAt = payload.startTime ? toUtcDateTime(baseDate, payload.startTime, timezone) : null;
    if (payload.startTime && !patch.startAt) return buildReason('invalid_agenda_time');
  }

  if (Object.prototype.hasOwnProperty.call(payload || {}, 'endAt')) {
    patch.endAt = payload.endAt ? String(payload.endAt).trim() : null;
  } else if (Object.prototype.hasOwnProperty.call(payload || {}, 'endTime')) {
    patch.endAt = payload.endTime ? toUtcDateTime(baseDate, payload.endTime, timezone) : null;
    if (payload.endTime && !patch.endAt) return buildReason('invalid_agenda_time');
  }

  return { ok: true, value: patch };
}

async function resolveAgendaContact(clinicId, contactId) {
  const safeContactId = normalizeNullableId(contactId);
  if (!safeContactId) {
    return { ok: true, contactId: null };
  }

  const contact = await findPortalContactById(clinicId, safeContactId);
  if (!contact) {
    return buildReason('contact_not_found');
  }

  return { ok: true, contactId: contact.id };
}

async function ensureTimedAgendaConsistency(clinicId, payload, options = {}) {
  const nextType = normalizeString(payload && payload.type).toLowerCase();
  const startAt = payload && payload.startAt ? String(payload.startAt).trim() : null;
  const endAt = payload && payload.endAt ? String(payload.endAt).trim() : null;
  const excludeItemId = options.excludeItemId || null;

  if (!TIMED_TYPES.has(nextType) || !startAt || !endAt) {
    return { ok: true };
  }

  if (nextType === 'availability') {
    return { ok: true };
  }

  const conflicts = await listTimedAgendaConflicts(
    clinicId,
    {
      startAt,
      endAt,
      excludeItemId,
      conflictTypes: ['appointment', 'blocked']
    }
  );

  if (!conflicts.length) {
    return { ok: true };
  }

  return buildReason('agenda_time_conflict', null, {
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, 3).map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      startAt: item.startAt,
      endAt: item.endAt
    }))
  });
}

async function ensureReservationWithinAvailability(clinicId, date, startAt, endAt, timezone) {
  if (!clinicId || !date || !startAt || !endAt) {
    return { ok: true };
  }

  const items = await listAgendaItemsByClinicAndRange(clinicId, date, date);
  const availabilityWindows = items
    .filter((item) => item.status !== 'cancelled' && item.type === 'availability')
    .map((item) => toLocalWindow(item, timezone))
    .filter(Boolean);

  if (!availabilityWindows.length) {
    return { ok: true };
  }

  const requestedWindow = toLocalWindow({ id: 'requested', type: 'appointment', title: 'requested', startAt, endAt }, timezone);
  if (!requestedWindow) {
    return buildReason('invalid_agenda_time_range');
  }

  const covered = availabilityWindows.some(
    (window) => requestedWindow.startMinutes >= window.startMinutes && requestedWindow.endMinutes <= window.endMinutes
  );

  return covered ? { ok: true } : buildReason('reservation_outside_availability');
}

async function resolveClinicAgendaContext(clinicId, clinic = null) {
  const safeClinicId = normalizeString(clinicId);
  if (!safeClinicId) {
    return buildReason('missing_clinic_id');
  }

  if (clinic && String(clinic.id || '').trim() === safeClinicId) {
    return {
      ok: true,
      clinic: {
        ...clinic,
        timezone: resolveTimezone(clinic.timezone)
      }
    };
  }

  const resolvedClinic = await getClinic(safeClinicId);
  if (!resolvedClinic) {
    return buildReason('clinic_not_found');
  }

  return {
    ok: true,
    clinic: {
      ...resolvedClinic,
      timezone: resolveTimezone(resolvedClinic.timezone)
    }
  };
}

async function getClinicAgendaAvailability(clinicId, query = {}, options = {}) {
  const context = await resolveClinicAgendaContext(clinicId, options.clinic);
  if (!context.ok) {
    return context;
  }

  const range = normalizeAvailabilityRange(query, context.clinic.timezone);
  const items = await listAgendaItemsByClinicAndRange(context.clinic.id, range.fromDate, range.toDate);
  const itemsByDate = new Map();

  items.forEach((item) => {
    const dateKey = String(item.date || '').trim();
    if (!dateKey) return;
    if (!itemsByDate.has(dateKey)) itemsByDate.set(dateKey, []);
    itemsByDate.get(dateKey).push(item);
  });

  const days = iterateDateRange(range.fromDate, range.toDate, context.clinic.timezone).map((date) =>
    buildAvailabilityDaySnapshot(date, itemsByDate.get(date) || [], context.clinic.timezone)
  );

  return {
    ok: true,
    clinic: context.clinic,
    range,
    days
  };
}

function formatBotSuggestionDisplay(startAtIso, timezone) {
  const local = DateTime.fromISO(String(startAtIso), { zone: 'utc' }).setZone(resolveTimezone(timezone));
  return local.isValid ? local.setLocale('es').toFormat('ccc dd/LL HH:mm') : String(startAtIso || '');
}

function buildSuggestionsFromBookableDay(day, options = {}) {
  const safeDay = day && typeof day === 'object' ? day : null;
  if (!safeDay) return [];

  const timezone = resolveTimezone(options.timezone);
  const stepMinutes = Math.max(5, Math.min(240, Number(options.stepMinutes) || 30));
  const durationMinutes = Math.max(5, Math.min(240, Number(options.durationMinutes) || 30));
  const timeWindowBounds = getTimeWindowBounds(options.timeWindow);
  const minStartAt = options.minStartAt
    ? DateTime.fromISO(String(options.minStartAt), { zone: 'utc' }).setZone(timezone)
    : null;

  if (!Array.isArray(safeDay.bookableWindows) || !safeDay.bookableWindows.length) {
    return [];
  }

  return safeDay.bookableWindows.flatMap((window) => {
    const startLocal = DateTime.fromISO(`${safeDay.date}T${window.startTime}`, { zone: timezone });
    const endLocal = DateTime.fromISO(`${safeDay.date}T${window.endTime}`, { zone: timezone });
    if (!startLocal.isValid || !endLocal.isValid || endLocal <= startLocal) {
      return [];
    }

    let cursor = startLocal;
    const suggestions = [];
    while (cursor.plus({ minutes: durationMinutes }) <= endLocal) {
      const candidateEnd = cursor.plus({ minutes: durationMinutes });
      const startMinutes = cursor.hour * 60 + cursor.minute;
      const endMinutes = candidateEnd.hour * 60 + candidateEnd.minute;
      const insideTimeWindow =
        !timeWindowBounds ||
        (startMinutes >= Number(timeWindowBounds.start.slice(0, 2)) * 60 + Number(timeWindowBounds.start.slice(3, 5)) &&
          endMinutes <= Number(timeWindowBounds.end.slice(0, 2)) * 60 + Number(timeWindowBounds.end.slice(3, 5)));
      const afterRequested = !minStartAt || cursor >= minStartAt;

      if (insideTimeWindow && afterRequested && cursor.toUTC() > DateTime.utc()) {
        suggestions.push({
          source: 'agenda',
          dateISO: safeDay.date,
          startAt: cursor.toUTC().toISO(),
          endAt: candidateEnd.toUTC().toISO(),
          displayText: formatBotSuggestionDisplay(cursor.toUTC().toISO(), timezone)
        });
      }

      cursor = cursor.plus({ minutes: stepMinutes });
    }

    return suggestions;
  });
}

async function suggestClinicAgendaSlots(input = {}, options = {}) {
  const context = await resolveClinicAgendaContext(input.clinicId, options.clinic);
  if (!context.ok) {
    return context;
  }

  const timezone = context.clinic.timezone;
  const safeCount = Math.max(1, Math.min(10, Number(input.count) || 3));
  const safeLookahead = Math.max(1, Math.min(31, Number(input.maxLookaheadDays) || 7));
  const exactStartAt = normalizeString(input.startAt);
  const explicitDate = normalizeDateInput(input.dateISO);
  let range;

  if (exactStartAt) {
    const exactLocal = DateTime.fromISO(exactStartAt, { zone: 'utc' }).setZone(resolveTimezone(timezone));
    if (!exactLocal.isValid) {
      return buildReason('invalid_agenda_time');
    }

    range = {
      fromDate: exactLocal.toISODate(),
      toDate: exactLocal.plus({ days: safeLookahead }).toISODate()
    };
  } else if (explicitDate) {
    range = {
      fromDate: explicitDate,
      toDate: explicitDate
    };
  } else {
    return buildReason('missing_agenda_suggestion_anchor');
  }

  const availability = await getClinicAgendaAvailability(
    context.clinic.id,
    { from: range.fromDate, to: range.toDate },
    { clinic: context.clinic }
  );
  if (!availability.ok) {
    return availability;
  }

  if (!hasExplicitAvailability(availability.days)) {
    return {
      ok: true,
      clinic: context.clinic,
      range: availability.range,
      strategy: 'fallback',
      explicitAvailability: false,
      suggestions: [],
      days: availability.days
    };
  }

  const suggestions = [];
  for (const day of availability.days) {
    const nextSuggestions = buildSuggestionsFromBookableDay(day, {
      timezone,
      timeWindow: input.timeWindow || null,
      stepMinutes: input.stepMinutes,
      durationMinutes: input.durationMinutes,
      minStartAt: exactStartAt || null
    });
    nextSuggestions.forEach((item) => {
      if (suggestions.length < safeCount && !suggestions.some((existing) => existing.startAt === item.startAt)) {
        suggestions.push(item);
      }
    });
    if (suggestions.length >= safeCount) {
      break;
    }
  }

  return {
    ok: true,
    clinic: context.clinic,
    range: availability.range,
    strategy: 'agenda',
    explicitAvailability: true,
    suggestions,
    days: availability.days
  };
}

async function createClinicAgendaBotReservation(payload = {}, options = {}) {
  const context = await resolveClinicAgendaContext(payload.clinicId, options.clinic);
  if (!context.ok) {
    return context;
  }

  const baseDate =
    normalizeDateInput(payload.date) ||
    (payload.startAt
      ? DateTime.fromISO(String(payload.startAt), { zone: 'utc' }).setZone(context.clinic.timezone).toISODate()
      : null);

  const dayAvailability = await getClinicAgendaAvailability(
    context.clinic.id,
    { date: baseDate },
    { clinic: context.clinic }
  );
  if (!dayAvailability.ok) {
    return dayAvailability;
  }

  const validation = validateCreatePayload(
    {
      ...payload,
      date: baseDate,
      type: 'appointment',
      title: normalizeString(payload.title) || normalizeString(payload.patientName) || 'Turno reservado por bot',
      description:
        normalizeString(payload.description) ||
        normalizeString(payload.requestedText) ||
        'Reserva creada por bot sobre disponibilidad de Agenda.',
      status: payload && payload.status ? payload.status : 'pending'
    },
    context.clinic.timezone
  );
  if (!validation.ok) {
    return buildReason(validation.reason, validation.detail, { clinicId: context.clinic.id });
  }

  const contactResolution = await resolveAgendaContact(context.clinic.id, validation.value.contactId);
  if (!contactResolution.ok) {
    return buildReason(contactResolution.reason, contactResolution.detail, { clinicId: context.clinic.id });
  }

  const availabilityCheck = await ensureReservationWithinAvailability(
    context.clinic.id,
    validation.value.date,
    validation.value.startAt,
    validation.value.endAt,
    context.clinic.timezone
  );
  if (!availabilityCheck.ok) {
    return buildReason(availabilityCheck.reason, availabilityCheck.detail, { clinicId: context.clinic.id });
  }

  const consistency = await ensureTimedAgendaConsistency(context.clinic.id, validation.value);
  if (!consistency.ok) {
    return buildReason(consistency.reason, consistency.detail, {
      clinicId: context.clinic.id,
      conflictCount: consistency.conflictCount || 0,
      conflicts: consistency.conflicts || []
    });
  }

  const item = await createAgendaItem({
    clinicId: context.clinic.id,
    ...validation.value,
    type: 'appointment',
    contactId: contactResolution.contactId
  });

  return {
    ok: true,
    clinic: context.clinic,
    reservation: formatAgendaItem(item, context.clinic.timezone)
  };
}

async function listPortalAgendaItems(tenantId, query = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const range = normalizeRange(query.from, query.to, context.clinic.timezone);
  const items = await listAgendaItemsByClinicAndRange(context.clinic.id, range.fromDate, range.toDate);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    range,
    items: items.map((item) => formatAgendaItem(item, context.clinic.timezone))
  };
}

async function getPortalAgendaAvailability(tenantId, query = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const availability = await getClinicAgendaAvailability(context.clinic.id, query, { clinic: context.clinic });
  if (!availability.ok) {
    return availability;
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    range: availability.range,
    days: availability.days
  };
}

async function createPortalAgendaItem(tenantId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const validation = validateCreatePayload(payload, context.clinic.timezone);
  if (!validation.ok) {
    return buildReason(validation.reason, validation.detail, { tenantId: context.tenantId });
  }

  const contactResolution = await resolveAgendaContact(context.clinic.id, validation.value.contactId);
  if (!contactResolution.ok) {
    return buildReason(contactResolution.reason, contactResolution.detail, { tenantId: context.tenantId });
  }

  const consistency = await ensureTimedAgendaConsistency(context.clinic.id, validation.value);
  if (!consistency.ok) {
    return buildReason(consistency.reason, consistency.detail, {
      tenantId: context.tenantId,
      conflictCount: consistency.conflictCount || 0,
      conflicts: consistency.conflicts || []
    });
  }

  const item = await createAgendaItem({
    clinicId: context.clinic.id,
    ...validation.value,
    contactId: contactResolution.contactId
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    item: formatAgendaItem(item, context.clinic.timezone)
  };
}

async function createPortalAgendaReservation(tenantId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const validation = validateCreatePayload(
    {
      ...payload,
      type: 'appointment',
      status: payload && payload.status ? payload.status : 'pending'
    },
    context.clinic.timezone
  );
  if (!validation.ok) {
    return buildReason(validation.reason, validation.detail, { tenantId: context.tenantId });
  }

  const contactResolution = await resolveAgendaContact(context.clinic.id, validation.value.contactId);
  if (!contactResolution.ok) {
    return buildReason(contactResolution.reason, contactResolution.detail, { tenantId: context.tenantId });
  }

  const availabilityCheck = await ensureReservationWithinAvailability(
    context.clinic.id,
    validation.value.date,
    validation.value.startAt,
    validation.value.endAt,
    context.clinic.timezone
  );
  if (!availabilityCheck.ok) {
    return buildReason(availabilityCheck.reason, availabilityCheck.detail, { tenantId: context.tenantId });
  }

  const consistency = await ensureTimedAgendaConsistency(context.clinic.id, validation.value);
  if (!consistency.ok) {
    return buildReason(consistency.reason, consistency.detail, {
      tenantId: context.tenantId,
      conflictCount: consistency.conflictCount || 0,
      conflicts: consistency.conflicts || []
    });
  }

  const item = await createAgendaItem({
    clinicId: context.clinic.id,
    ...validation.value,
    type: 'appointment',
    contactId: contactResolution.contactId
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    reservation: formatAgendaItem(item, context.clinic.timezone)
  };
}

async function updatePortalAgendaItem(tenantId, itemId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeItemId = normalizeString(itemId);
  if (!safeItemId) {
    return buildReason('missing_agenda_item_id', null, { tenantId: context.tenantId });
  }

  const validation = validatePatchPayload(payload, context.clinic.timezone);
  if (!validation.ok) {
    return buildReason(validation.reason, validation.detail, { tenantId: context.tenantId });
  }

  const existingItem = await findAgendaItemById(context.clinic.id, safeItemId);
  if (!existingItem) {
    return buildReason('agenda_item_not_found', null, { tenantId: context.tenantId });
  }

  const nextPatch = { ...validation.value };
  if (Object.prototype.hasOwnProperty.call(validation.value, 'contactId')) {
    const contactResolution = await resolveAgendaContact(context.clinic.id, validation.value.contactId);
    if (!contactResolution.ok) {
      return buildReason(contactResolution.reason, contactResolution.detail, { tenantId: context.tenantId });
    }
    nextPatch.contactId = contactResolution.contactId;
  }

  const nextShape = {
    type: Object.prototype.hasOwnProperty.call(nextPatch, 'type') ? nextPatch.type : existingItem.type,
    startAt: Object.prototype.hasOwnProperty.call(nextPatch, 'startAt') ? nextPatch.startAt : existingItem.startAt,
    endAt: Object.prototype.hasOwnProperty.call(nextPatch, 'endAt') ? nextPatch.endAt : existingItem.endAt
  };
  const timingValidation = validateTimingRules({
    type: nextShape.type,
    startAt: nextShape.startAt,
    endAt: nextShape.endAt,
    payload: {
      startAt: nextShape.startAt,
      endAt: nextShape.endAt
    }
  });
  if (!timingValidation.ok) {
    return buildReason(timingValidation.reason, timingValidation.detail, { tenantId: context.tenantId });
  }

  const consistency = await ensureTimedAgendaConsistency(context.clinic.id, nextShape, { excludeItemId: safeItemId });
  if (!consistency.ok) {
    return buildReason(consistency.reason, consistency.detail, {
      tenantId: context.tenantId,
      conflictCount: consistency.conflictCount || 0,
      conflicts: consistency.conflicts || []
    });
  }

  if (nextShape.type === 'appointment' && nextShape.startAt && nextShape.endAt) {
    const availabilityCheck = await ensureReservationWithinAvailability(
      context.clinic.id,
      Object.prototype.hasOwnProperty.call(nextPatch, 'date') ? nextPatch.date : existingItem.date,
      nextShape.startAt,
      nextShape.endAt,
      context.clinic.timezone
    );
    if (!availabilityCheck.ok) {
      return buildReason(availabilityCheck.reason, availabilityCheck.detail, { tenantId: context.tenantId });
    }
  }

  const item = await updateAgendaItemById(context.clinic.id, safeItemId, nextPatch);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    item: formatAgendaItem(item, context.clinic.timezone)
  };
}

async function deletePortalAgendaItem(tenantId, itemId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeItemId = normalizeString(itemId);
  if (!safeItemId) {
    return buildReason('missing_agenda_item_id', null, { tenantId: context.tenantId });
  }

  const item = await deleteAgendaItemById(context.clinic.id, safeItemId);
  if (!item) {
    return buildReason('agenda_item_not_found', null, { tenantId: context.tenantId });
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    item: formatAgendaItem(item, context.clinic.timezone)
  };
}

module.exports = {
  listPortalAgendaItems,
  getPortalAgendaAvailability,
  createPortalAgendaItem,
  createPortalAgendaReservation,
  updatePortalAgendaItem,
  deletePortalAgendaItem,
  getClinicAgendaAvailability,
  suggestClinicAgendaSlots,
  createClinicAgendaBotReservation
};
