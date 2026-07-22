function normalizeString(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

const DIRECTIONAL_MARKS_PATTERN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const NON_BREAKING_SPACES_PATTERN = /[\u00a0\u202f]/g;

function normalizeParserInput(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(DIRECTIONAL_MARKS_PATTERN, '')
    .replace(NON_BREAKING_SPACES_PATTERN, ' ');
}

function expandYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year)) return null;
  if (value.length === 2) return year >= 70 ? 1900 + year : 2000 + year;
  return year;
}

function parseDateTime(day, month, year, hour, minute, second, meridiem) {
  const yyyy = expandYear(String(year));
  const dd = Number(day);
  const mm = Number(month);
  const rawHour = Number(hour);
  const mi = Number(minute);
  const ss = second === undefined || second === null || second === '' ? 0 : Number(second);
  if (![yyyy, dd, mm, rawHour, mi, ss].every(Number.isInteger)) return null;
  if (yyyy < 2000 || yyyy > 2099 || mm < 1 || mm > 12 || dd < 1 || dd > 31 || mi > 59 || ss > 59) return null;

  let hh = rawHour;
  const normalizedMeridiem = normalizeString(meridiem).toLowerCase();
  if (normalizedMeridiem) {
    if (hh < 1 || hh > 12) return null;
    if (normalizedMeridiem === 'a') {
      hh = hh === 12 ? 0 : hh;
    } else if (normalizedMeridiem === 'p') {
      hh = hh === 12 ? 12 : hh + 12;
    } else {
      return null;
    }
  } else if (hh > 23) {
    return null;
  }

  const date = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, ss));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return null;
  return date.toISOString();
}

function classifySystemMessage(text) {
  const normalized = normalizeString(text).toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('cifrad') || normalized.includes('encrypted')) return 'encryption_notice';
  if (normalized.includes('se elimino este mensaje') || normalized.includes('se eliminó este mensaje') || normalized.includes('this message was deleted')) return 'deleted_message';
  if (normalized.includes('llamada') || normalized.includes('call')) return 'call_notice';
  if (normalized.includes('cambiaste') || normalized.includes('changed') || normalized.includes('añad') || normalized.includes('added') || normalized.includes('salió') || normalized.includes('left')) return 'group_notice';
  return null;
}

function parseMessageLine(line) {
  const bracket = line.match(/^\[(\d{1,2})[/-](\d{1,2})[/-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([apAP])\s*\.?\s*[mM]\s*\.?)?\]\s*(.*)$/);
  if (bracket) {
    return {
      detectedFormat: 'bracketed',
      timestamp: parseDateTime(bracket[1], bracket[2], bracket[3], bracket[4], bracket[5], bracket[6], bracket[7]),
      rest: bracket[8] || ''
    };
  }

  const plain = line.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([apAP])\s*\.?\s*[mM]\s*\.?)?\s+-\s*(.*)$/);
  if (plain) {
    return {
      detectedFormat: 'plain',
      timestamp: parseDateTime(plain[1], plain[2], plain[3], plain[4], plain[5], plain[6], plain[7]),
      rest: plain[8] || ''
    };
  }

  return null;
}

function splitParticipant(rest) {
  const index = String(rest || '').indexOf(':');
  if (index <= 0) return { participant: null, text: normalizeString(rest), systemType: classifySystemMessage(rest) || 'system' };
  return {
    participant: normalizeString(rest.slice(0, index)),
    text: normalizeString(rest.slice(index + 1)),
    systemType: null
  };
}

function buildDateRange(messages) {
  const stamps = messages.map((message) => message.originalTimestamp).filter(Boolean).sort();
  return {
    from: stamps[0] || null,
    to: stamps[stamps.length - 1] || null
  };
}

function parseWhatsAppChatExport(input) {
  const text = normalizeParserInput(input);
  const lines = text.split(/\r?\n/);
  const messages = [];
  const participants = new Set();
  const warnings = [];
  let ignoredLines = 0;
  let detectedFormat = null;

  function pushMessage(message) {
    if (!message || !message.originalTimestamp) return;
    message.index = messages.length;
    messages.push(message);
    if (message.participant) participants.add(message.participant);
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!normalizeString(line)) continue;

    const parsed = parseMessageLine(line);
    if (parsed && parsed.timestamp) {
      if (!detectedFormat) detectedFormat = parsed.detectedFormat;
      const split = splitParticipant(parsed.rest);
      const mediaOmitted = /<multimedia omitido>|<media omitted>/i.test(split.text);
      pushMessage({
        originalTimestamp: parsed.timestamp,
        participant: split.participant,
        text: split.text,
        type: mediaOmitted ? 'media_omitted' : split.systemType ? 'system' : 'text',
        systemType: split.systemType,
        rawLine: line
      });
      continue;
    }

    if (parsed && !parsed.timestamp) {
      ignoredLines += 1;
      warnings.push({ code: 'invalid_timestamp', line: ignoredLines });
      continue;
    }

    const previous = messages[messages.length - 1];
    if (previous && previous.type !== 'system') {
      previous.text = `${previous.text}\n${line}`.trim();
      previous.rawLine = `${previous.rawLine}\n${line}`;
    } else {
      ignoredLines += 1;
    }
  }

  if (!messages.length) warnings.push({ code: 'unrecognized_format' });

  return {
    messages,
    participants: Array.from(participants).sort((a, b) => a.localeCompare(b)),
    dateRange: buildDateRange(messages),
    detectedFormat: detectedFormat || 'unknown',
    ignoredLines,
    warnings
  };
}

module.exports = {
  parseWhatsAppChatExport,
  classifySystemMessage
};
