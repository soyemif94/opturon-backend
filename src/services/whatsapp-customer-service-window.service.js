const DEFAULT_WINDOW_HOURS = 24;

function toTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function evaluateCustomerServiceWindow({
  lastInboundAt,
  now = new Date(),
  windowHours = DEFAULT_WINDOW_HOURS
} = {}) {
  const nowMs = toTimestamp(now);
  const inboundMs = toTimestamp(lastInboundAt);
  const safeWindowHours = Number(windowHours);

  if (nowMs === null || inboundMs === null || !Number.isFinite(safeWindowHours) || safeWindowHours <= 0) {
    return {
      allowed: false,
      status: 'FREEFORM_NOT_ALLOWED',
      reason: inboundMs === null ? 'no_real_inbound' : 'invalid_window_input',
      lastInboundAt: inboundMs === null ? null : new Date(inboundMs).toISOString(),
      expiresAt: null
    };
  }

  if (inboundMs > nowMs) {
    return {
      allowed: false,
      status: 'FREEFORM_NOT_ALLOWED',
      reason: 'inbound_timestamp_in_future',
      lastInboundAt: new Date(inboundMs).toISOString(),
      expiresAt: null
    };
  }

  const expiresAtMs = inboundMs + safeWindowHours * 60 * 60 * 1000;
  // Meta's customer service window closes exactly 24 hours after the last inbound.
  const allowed = nowMs < expiresAtMs;
  return {
    allowed,
    status: allowed ? 'open' : 'closed',
    reason: allowed ? 'real_inbound_within_window' : 'customer_service_window_expired',
    lastInboundAt: new Date(inboundMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString()
  };
}

module.exports = {
  DEFAULT_WINDOW_HOURS,
  evaluateCustomerServiceWindow
};
