function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseTimeMinutes(time) {
  const match = String(time || '').trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function getLocalDateByOffset(date, tzOffsetMinutes) {
  const base = date instanceof Date ? date : new Date(date);
  const ms = base.getTime() + tzOffsetMinutes * 60 * 1000;
  return new Date(ms);
}

function resolveWeekdayToDateISO({ weekday, baseDate = new Date(), tzOffsetMinutes = -180, time = null } = {}) {
  const weekdayMap = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };

  const targetDow = weekdayMap[String(weekday || '').toLowerCase()];
  if (typeof targetDow !== 'number') {
    return null;
  }

  const localNow = getLocalDateByOffset(baseDate, tzOffsetMinutes);
  const currentDow = localNow.getUTCDay();
  let deltaDays = targetDow - currentDow;
  if (deltaDays < 0) deltaDays += 7;

  const requestedMinutes = parseTimeMinutes(time);
  if (deltaDays === 0 && requestedMinutes !== null) {
    const nowMinutes = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
    if (requestedMinutes <= nowMinutes) {
      deltaDays = 7;
    }
  }

  const resolvedLocal = new Date(localNow.getTime() + deltaDays * 24 * 60 * 60 * 1000);
  const yyyy = resolvedLocal.getUTCFullYear();
  const mm = pad2(resolvedLocal.getUTCMonth() + 1);
  const dd = pad2(resolvedLocal.getUTCDate());
  return `${yyyy}-${mm}-${dd}`;
}

module.exports = {
  resolveWeekdayToDateISO
};

