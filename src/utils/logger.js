const SENSITIVE_KEYS = new Set([
  'accessToken',
  'access_token',
  'metaAccessToken',
  'pageAccessToken',
  'authorization',
  'metaCode',
  'token',
  'refreshToken',
  'appSecret',
  'clientSecret'
]);

function sanitizeLogMeta(value, visited = new WeakSet()) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogMeta(item, visited));
  }

  if (typeof value === 'object') {
    if (visited.has(value)) {
      return '[Circular]';
    }
    visited.add(value);
    const sanitized = {};
    for (const [key, item] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_KEYS.has(key) ? '[REDACTED]' : sanitizeLogMeta(item, visited);
    }
    visited.delete(value);
    return sanitized;
  }

  return String(value);
}

function buildLogPayload(level, message, meta = {}) {
  return {
    level,
    message,
    ...sanitizeLogMeta(meta),
    ts: new Date().toISOString()
  };
}

function logInfo(message, meta = {}) {
  console.log(JSON.stringify(buildLogPayload('info', message, meta)));
}

function logWarn(message, meta = {}) {
  console.warn(JSON.stringify(buildLogPayload('warn', message, meta)));
}

function logError(message, meta = {}) {
  console.error(JSON.stringify(buildLogPayload('error', message, meta)));
}

module.exports = { logInfo, logWarn, logError, sanitizeLogMeta };
