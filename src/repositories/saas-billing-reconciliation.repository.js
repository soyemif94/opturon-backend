const { randomUUID } = require('crypto');
const AUTO_RECONCILE_STATES = Object.freeze(['payment_pending', 'payment_in_process',
  'authorized_invoice_not_found', 'invoice_payment_pending']);
const MAX_ATTEMPTS = 12;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const LEASE_MS = 60000;

async function enqueueReconciliation(client, input, reason) {
  if (!AUTO_RECONCILE_STATES.includes(reason)) return null;
  const result = await client.query(`INSERT INTO saas_billing_reconciliations
    (provider,"resourceId","sourceEventId",status,reason,"nextAttemptAt")
    VALUES ('mercado_pago',$1,$2,'pending',$3,clock_timestamp()+interval '5 minutes')
    ON CONFLICT (provider,"resourceId") DO NOTHING RETURNING id`, [input.resourceId, input.id, reason]);
  return result.rows[0]?.id || null;
}
async function claimReconciliation(client) {
  const selected = await client.query(`SELECT * FROM saas_billing_reconciliations
    WHERE (status='pending' AND "nextAttemptAt" <= clock_timestamp())
       OR (status='processing' AND "leaseExpiresAt" <= clock_timestamp())
    ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT 1`);
  const job = selected.rows[0];
  if (!job) return null;
  if (job.leaseId) await client.query(`UPDATE saas_billing_reconciliation_runs SET status='stale',
    reason='lease_expired',"completedAt"=clock_timestamp() WHERE "reconciliationId"=$1 AND "leaseId"=$2 AND status='processing'`, [job.id, job.leaseId]);
  const age = await client.query(`SELECT clock_timestamp()-$1::timestamptz >= interval '48 hours' AS exhausted`, [job.createdAt]);
  if (job.attempts >= MAX_ATTEMPTS || age.rows[0].exhausted) {
    await client.query(`UPDATE saas_billing_reconciliations SET status='manual_review',reason='reconciliation_exhausted',
      "leaseId"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=clock_timestamp() WHERE id=$1`, [job.id]);
    return null;
  }
  const leaseId = randomUUID(); const runId = randomUUID();
  const result = await client.query(`UPDATE saas_billing_reconciliations SET status='processing',attempts=attempts+1,
    "leaseId"=$2,"leaseExpiresAt"=clock_timestamp()+interval '60 seconds',"updatedAt"=clock_timestamp()
    WHERE id=$1 RETURNING *`, [job.id, leaseId]);
  await client.query(`INSERT INTO saas_billing_reconciliation_runs
    (id,"reconciliationId",kind,"leaseId",status) VALUES ($1,$2,'automatic',$3,'processing')`, [runId, job.id, leaseId]);
  return { ...result.rows[0], runId };
}
async function lockReconciliationClaim(client, claim) {
  const result = await client.query(`SELECT * FROM saas_billing_reconciliations WHERE id=$1 AND status='processing'
    AND "leaseId"=$2 AND "leaseExpiresAt">clock_timestamp() FOR UPDATE`, [claim.id, claim.leaseId]);
  return result.rows[0] || null;
}
async function completeReconciliation(client, claim, { status, reason, retry = false }) {
  const delay = Math.min(5 * 60 * 1000 * 2 ** claim.attempts, 6 * 60 * 60 * 1000);
  const age = await client.query(`SELECT clock_timestamp()-$1::timestamptz >= interval '48 hours' AS exhausted`, [claim.createdAt]);
  const exhausted = retry && (claim.attempts >= MAX_ATTEMPTS || age.rows[0].exhausted);
  const jobStatus = exhausted ? 'manual_review' : retry ? 'pending' : status === 'completed' ? 'completed'
    : status === 'manual_review' ? 'manual_review' : 'terminal';
  const finalReason = exhausted ? 'reconciliation_exhausted' : reason;
  const result = await client.query(`UPDATE saas_billing_reconciliations SET status=$3,reason=$4,
    "nextAttemptAt"=clock_timestamp()+($5::bigint * interval '1 millisecond'),"leaseId"=NULL,"leaseExpiresAt"=NULL,
    "updatedAt"=clock_timestamp() WHERE id=$1 AND "leaseId"=$2 AND status='processing'
    AND "leaseExpiresAt">clock_timestamp() RETURNING id`,
  [claim.id, claim.leaseId, jobStatus, finalReason, delay]);
  if (!result.rowCount) throw new Error('billing_reconciliation_claim_lost');
  const run = await client.query(`UPDATE saas_billing_reconciliation_runs SET status=$3,reason=$4,"completedAt"=clock_timestamp()
    WHERE id=$1 AND "leaseId"=$2 AND status='processing' RETURNING id`,
  [claim.runId, claim.leaseId, exhausted ? 'manual_review' : status, finalReason]);
  if (!run.rowCount) throw new Error('billing_reconciliation_run_lost');
}
module.exports = { AUTO_RECONCILE_STATES, MAX_ATTEMPTS, MAX_AGE_MS, LEASE_MS,
  enqueueReconciliation, claimReconciliation, lockReconciliationClaim, completeReconciliation };
