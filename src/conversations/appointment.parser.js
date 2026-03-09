function pad2(value) {
  return String(value).padStart(2, '0');
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTime(text) {
  const normalized = normalizeText(text);

  const withSeparator = normalized.match(/(?:^|\s)(\d{1,2})[:.](\d{2})(?=\s|$)/);
  if (withSeparator) {
    const hour = Number(withSeparator[1]);
    const minute = Number(withSeparator[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${pad2(hour)}:${pad2(minute)}`;
    }
  }

  const compact = normalized.match(/(?:^|\s)(\d{3,4})(?=\s|$)/);
  if (compact) {
    const digits = compact[1];
    const hourPart = digits.length === 3 ? digits.slice(0, 1) : digits.slice(0, 2);
    const minutePart = digits.length === 3 ? digits.slice(1) : digits.slice(2);
    const hour = Number(hourPart);
    const minute = Number(minutePart);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${pad2(hour)}:${pad2(minute)}`;
    }
  }

  return null;
}

function parseWeekday(text) {
  const normalized = normalizeText(text);
  const weekdayMap = [
    { key: 'monday', label: 'lunes', aliases: ['lunes'] },
    { key: 'tuesday', label: 'martes', aliases: ['martes'] },
    { key: 'wednesday', label: 'miercoles', aliases: ['miercoles'] },
    { key: 'thursday', label: 'jueves', aliases: ['jueves'] },
    { key: 'friday', label: 'viernes', aliases: ['viernes'] },
    { key: 'saturday', label: 'sabado', aliases: ['sabado'] },
    { key: 'sunday', label: 'domingo', aliases: ['domingo'] }
  ];

  for (const item of weekdayMap) {
    for (const alias of item.aliases) {
      if (new RegExp(`(?:^|\\s)${alias}(?:\\s|$)`, 'i').test(normalized)) {
        return { key: item.key, label: item.label };
      }
    }
  }

  return null;
}

function parseDateISO(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/(?:^|\s)(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?(?=\s|$)/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = match[3] ? Number(match[3]) : new Date().getFullYear();
  if (year < 100) year += 2000;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseTimeWindow(text) {
  const normalized = normalizeText(text);
  if (/(manana|temprano)/.test(normalized)) return { key: 'morning', label: 'mañana' };
  if (/\btarde\b/.test(normalized)) return { key: 'afternoon', label: 'tarde' };
  if (/\bnoche\b/.test(normalized)) return { key: 'evening', label: 'noche' };
  return null;
}

function dateISOToDisplay(dateISO) {
  const match = String(dateISO || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateISO;
  return `${match[3]}/${match[2]}`;
}

function baseDisplayText({ dateISO, weekdayLabel }) {
  if (dateISO) return dateISOToDisplay(dateISO);
  if (weekdayLabel) return weekdayLabel;
  return 'fecha';
}

function parseAppointmentText(text) {
  const raw = String(text || '').trim();
  const time = parseTime(raw);
  const weekday = parseWeekday(raw);
  const dateISO = parseDateISO(raw);
  const timeWindow = parseTimeWindow(raw);

  const hasDayOrDate = !!(weekday || dateISO);
  const hasTime = !!time;
  const hasTimeWindow = !!timeWindow;

  if (!hasDayOrDate) {
    return {
      ok: false,
      parsed: null,
      displayText: null,
      hasDayOrDate: false,
      hasTime: false,
      hasTimeWindow: false
    };
  }

  const parsed = {};
  if (dateISO) parsed.dateISO = dateISO;
  if (weekday) parsed.weekday = weekday.key;
  if (time) parsed.time = time;
  if (timeWindow) parsed.timeWindow = timeWindow.key;

  const base = baseDisplayText({
    dateISO,
    weekdayLabel: weekday ? weekday.label : null
  });

  let displayText = base;
  if (time) displayText = `${base} a las ${time}`;
  else if (timeWindow) displayText = `${base} por la ${timeWindow.label}`;

  return {
    ok: true,
    parsed,
    displayText,
    hasDayOrDate,
    hasTime,
    hasTimeWindow
  };
}

module.exports = {
  parseAppointmentText
};
