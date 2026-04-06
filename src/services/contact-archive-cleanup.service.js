const { pool } = require('../db/client');
const { deleteArchivedContactsByIds, listArchivedContactCleanupCandidates } = require('../repositories/contact.repository');
const { logInfo, logWarn } = require('../utils/logger');

const CONTACT_ARCHIVE_RETENTION_DAYS = 15;
const CONTACT_ARCHIVE_CLEANUP_BATCH_SIZE = 100;
const CONTACT_ARCHIVE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CONTACT_ARCHIVE_CLEANUP_LOCK_KEY = 135001;

let cleanupRunning = false;
let lastCleanupAt = 0;

function isProtectedCandidate(candidate) {
  return [
    candidate.hasConversations,
    candidate.hasOrders,
    candidate.hasInvoices,
    candidate.hasPayments,
    candidate.hasLoyalty,
    candidate.hasLeads,
    candidate.hasAppointments,
    candidate.hasHandoffs,
    candidate.hasAgendaItems
  ].some(Boolean);
}

function listProtectionReasons(candidate) {
  const reasons = [];
  if (candidate.hasConversations) reasons.push('conversations');
  if (candidate.hasOrders) reasons.push('orders');
  if (candidate.hasInvoices) reasons.push('invoices');
  if (candidate.hasPayments) reasons.push('payments');
  if (candidate.hasLoyalty) reasons.push('loyalty');
  if (candidate.hasLeads) reasons.push('leads');
  if (candidate.hasAppointments) reasons.push('appointments');
  if (candidate.hasHandoffs) reasons.push('handoffs');
  if (candidate.hasAgendaItems) reasons.push('agenda_items');
  return reasons;
}

async function runArchivedContactCleanup({ workerId = null, force = false } = {}) {
  if (cleanupRunning) {
    return { ok: true, skipped: true, reason: 'cleanup_already_running' };
  }

  const now = Date.now();
  if (!force && lastCleanupAt && now - lastCleanupAt < CONTACT_ARCHIVE_CLEANUP_INTERVAL_MS) {
    return {
      ok: true,
      skipped: true,
      reason: 'cleanup_interval_not_elapsed',
      lastCleanupAt: new Date(lastCleanupAt).toISOString()
    };
  }

  cleanupRunning = true;
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    const lockResult = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [CONTACT_ARCHIVE_CLEANUP_LOCK_KEY]);
    lockAcquired = lockResult.rows[0] && lockResult.rows[0].locked === true;

    if (!lockAcquired) {
      return { ok: true, skipped: true, reason: 'cleanup_lock_not_acquired' };
    }

    const candidates = await listArchivedContactCleanupCandidates(
      CONTACT_ARCHIVE_RETENTION_DAYS,
      CONTACT_ARCHIVE_CLEANUP_BATCH_SIZE,
      client
    );

    const eligible = candidates.filter((candidate) => !isProtectedCandidate(candidate));
    const protectedCandidates = candidates.filter(isProtectedCandidate);
    const deleted = await deleteArchivedContactsByIds(
      eligible.map((candidate) => candidate.id),
      CONTACT_ARCHIVE_RETENTION_DAYS,
      client
    );

    const result = {
      ok: true,
      skipped: false,
      workerId,
      retentionDays: CONTACT_ARCHIVE_RETENTION_DAYS,
      batchSize: CONTACT_ARCHIVE_CLEANUP_BATCH_SIZE,
      evaluated: candidates.length,
      eligible: eligible.length,
      deleted: deleted.length,
      skippedBySafety: protectedCandidates.length,
      deletedIds: deleted.map((candidate) => candidate.id),
      skippedSamples: protectedCandidates.slice(0, 10).map((candidate) => ({
        id: candidate.id,
        clinicId: candidate.clinicId,
        reasons: listProtectionReasons(candidate)
      }))
    };

    lastCleanupAt = now;
    logInfo('contact_archive_cleanup_completed', result);
    return result;
  } catch (error) {
    logWarn('contact_archive_cleanup_failed', {
      workerId,
      error: error.message
    });
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [CONTACT_ARCHIVE_CLEANUP_LOCK_KEY]);
      } catch (error) {
        logWarn('contact_archive_cleanup_unlock_failed', {
          workerId,
          error: error.message
        });
      }
    }
    client.release();
    cleanupRunning = false;
  }
}

async function maybeRunArchivedContactCleanup({ workerId = null } = {}) {
  try {
    return await runArchivedContactCleanup({ workerId });
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      reason: 'cleanup_failed',
      error: error.message
    };
  }
}

module.exports = {
  CONTACT_ARCHIVE_RETENTION_DAYS,
  runArchivedContactCleanup,
  maybeRunArchivedContactCleanup
};
