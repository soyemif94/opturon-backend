const {
  upsertOperationalAlertWorkerHeartbeat,
  findLatestOperationalAlertWorkerHeartbeat,
  __private__: heartbeatRepositoryPrivate
} = require('../repositories/operational-alert-worker-heartbeats.repository');
const { logWarn } = require('../utils/logger');

const DEFAULT_HEARTBEAT_WRITE_INTERVAL_MS = 30_000;
const DEFAULT_WORKER_STALE_AFTER_MS = 90_000;

function toEpochMilliseconds(value) {
  const date = value instanceof Date ? value : new Date(value);
  const epoch = date.getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

function resolveNow(value) {
  const resolved = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(resolved.getTime())) {
    throw new Error('operational_alert_worker_heartbeat_now_invalid');
  }
  return resolved;
}

function resolvePositiveDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function summarizeWorkerHeartbeatError(error) {
  const code = error && typeof error.code === 'string' ? error.code.trim().slice(0, 80) : '';
  const message = error && error.message ? error.message : String(error || 'worker_poll_failed');
  const summary = code && message && !message.startsWith(code)
    ? `${code}: ${message}`
    : (code || message || 'worker_poll_failed');
  return heartbeatRepositoryPrivate.sanitizeLastError(summary) || 'worker_poll_failed';
}

function deriveOperationalAlertWorkerHealth(heartbeat, options = {}) {
  if (!heartbeat) return 'unknown';

  const now = resolveNow(options.now);
  const staleAfterMs = resolvePositiveDuration(
    options.staleAfterMs,
    DEFAULT_WORKER_STALE_AFTER_MS
  );
  const timestamps = [
    heartbeat.lastPollStartedAt,
    heartbeat.lastPollCompletedAt,
    heartbeat.lastSuccessfulPollAt,
    heartbeat.updatedAt
  ]
    .map(toEpochMilliseconds)
    .filter((value) => value !== null);

  if (timestamps.length === 0) return 'unknown';
  const lastSeenAt = Math.max(...timestamps);
  if (now.getTime() - lastSeenAt > staleAfterMs) return 'stale';
  if (heartbeat.lastError) return 'error';
  if (heartbeat.lastSuccessfulPollAt) return 'healthy';
  return 'unknown';
}

function serializeWorkerHeartbeat(heartbeat, health) {
  if (!heartbeat) {
    return {
      workerId: null,
      lastPollStartedAt: null,
      lastPollCompletedAt: null,
      lastSuccessfulPollAt: null,
      lastError: null,
      updatedAt: null,
      health
    };
  }

  return {
    workerId: heartbeat.workerId,
    lastPollStartedAt: heartbeat.lastPollStartedAt || null,
    lastPollCompletedAt: heartbeat.lastPollCompletedAt || null,
    lastSuccessfulPollAt: heartbeat.lastSuccessfulPollAt || null,
    lastError: heartbeat.lastError || null,
    updatedAt: heartbeat.updatedAt || null,
    health
  };
}

async function getOperationalAlertWorkerHealth(options = {}, dependencies = {}) {
  const findLatestHeartbeat = dependencies.findLatestHeartbeat || findLatestOperationalAlertWorkerHeartbeat;
  const heartbeat = await findLatestHeartbeat(options.client || null);
  const health = deriveOperationalAlertWorkerHealth(heartbeat, options);
  return serializeWorkerHeartbeat(heartbeat, health);
}

/**
 * A non-blocking, process-local reporter for the existing worker loop.  It
 * serializes writes and swallows persistence failures so heartbeat telemetry
 * never changes scheduling or delivery behavior.
 */
function createOperationalAlertWorkerHeartbeatReporter(options = {}) {
  const workerId = heartbeatRepositoryPrivate.normalizeWorkerId(options.workerId);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const writeIntervalMs = resolvePositiveDuration(
    options.writeIntervalMs,
    DEFAULT_HEARTBEAT_WRITE_INTERVAL_MS
  );
  const upsertHeartbeat = options.upsertHeartbeat || upsertOperationalAlertWorkerHeartbeat;
  const warn = options.logWarn || logWarn;

  let lastQueuedAtMs = null;
  let hasQueuedPollStart = false;
  let hasQueuedSuccessfulPoll = false;
  let hasRecordedError = false;
  let pendingPollStartedAt = null;
  let lastWrite = Promise.resolve(null);

  function enqueue(patch, force = false, at = resolveNow(now())) {
    const atMs = at.getTime();
    const shouldCoalesce = !force
      && lastQueuedAtMs !== null
      && atMs >= lastQueuedAtMs
      && atMs - lastQueuedAtMs < writeIntervalMs;
    if (shouldCoalesce) {
      return { queued: false, coalesced: true };
    }

    lastQueuedAtMs = atMs;
    const heartbeat = {
      workerId,
      ...patch,
      updatedAt: at.toISOString()
    };
    lastWrite = lastWrite.then(async () => {
      try {
        const saved = await upsertHeartbeat(heartbeat);
        if (Object.prototype.hasOwnProperty.call(patch, 'lastSuccessfulPollAt')) {
          hasRecordedError = false;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'lastError') && patch.lastError) {
          hasRecordedError = true;
        }
        return saved;
      } catch (error) {
        // A failed telemetry write must make the next poll eligible to retry,
        // but it must never reject into the worker's functional path.
        lastQueuedAtMs = null;
        try {
          warn('operational_alert_worker_heartbeat_write_failed', {
            workerId,
            error: summarizeWorkerHeartbeatError(error)
          });
        } catch {}
        return null;
      }
    });
    return { queued: true, coalesced: false };
  }

  return {
    markWorkerStarted() {
      const at = resolveNow(now());
      return enqueue({ startedAt: at.toISOString(), lastError: null }, true, at);
    },
    markPollStarted() {
      const at = resolveNow(now());
      pendingPollStartedAt = at.toISOString();
      // Persist the first start immediately. Later starts are folded into the
      // next success/failure write so a 1s poll does not outrun its health
      // timestamp or add a second write every interval.
      const result = hasQueuedPollStart
        ? { queued: false, coalesced: true }
        : enqueue({ lastPollStartedAt: pendingPollStartedAt }, true, at);
      if (result.queued) hasQueuedPollStart = true;
      return result;
    },
    markPollSucceeded() {
      const at = resolveNow(now());
      const result = enqueue(
        {
          lastPollStartedAt: pendingPollStartedAt || at.toISOString(),
          lastPollCompletedAt: at.toISOString(),
          lastSuccessfulPollAt: at.toISOString(),
          lastError: null
        },
        !hasQueuedSuccessfulPoll || hasRecordedError,
        at
      );
      if (result.queued) hasQueuedSuccessfulPoll = true;
      return result;
    },
    markPollFailed(error) {
      const at = resolveNow(now());
      hasRecordedError = true;
      return enqueue(
        {
          lastPollStartedAt: pendingPollStartedAt || at.toISOString(),
          lastPollCompletedAt: at.toISOString(),
          lastError: summarizeWorkerHeartbeatError(error)
        },
        true,
        at
      );
    },
    flush() {
      return lastWrite;
    }
  };
}

module.exports = {
  DEFAULT_HEARTBEAT_WRITE_INTERVAL_MS,
  DEFAULT_WORKER_STALE_AFTER_MS,
  createOperationalAlertWorkerHeartbeatReporter,
  getOperationalAlertWorkerHealth,
  deriveOperationalAlertWorkerHealth,
  __private__: {
    toEpochMilliseconds,
    resolveNow,
    resolvePositiveDuration,
    summarizeWorkerHeartbeatError,
    serializeWorkerHeartbeat
  }
};
