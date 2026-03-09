function logInfo(message, meta = {}) {
  console.log(JSON.stringify({ level: 'info', message, ...meta, ts: new Date().toISOString() }));
}

function logWarn(message, meta = {}) {
  console.warn(JSON.stringify({ level: 'warn', message, ...meta, ts: new Date().toISOString() }));
}

function logError(message, meta = {}) {
  console.error(JSON.stringify({ level: 'error', message, ...meta, ts: new Date().toISOString() }));
}

module.exports = { logInfo, logWarn, logError };
