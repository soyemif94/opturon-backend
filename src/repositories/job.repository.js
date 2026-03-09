const { query, withTransaction } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function enqueueInboundJob({ clinicId, channelId, payload }, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO jobs ("clinicId", "channelId", type, payload, status, attempts, "maxAttempts", "runAt", "updatedAt")
     VALUES ($1, $2, 'PROCESS_INBOUND_MESSAGE', $3::jsonb, 'queued', 0, 10, NOW(), NOW())
     RETURNING id, status`,
    [clinicId, channelId, JSON.stringify(payload || {})]
  );

  return result.rows[0];
}

async function claimJobs({ workerId, limit = 10 }) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `WITH picked AS (
          SELECT id
          FROM jobs
          WHERE status='queued' AND "runAt" <= NOW()
          ORDER BY "createdAt"
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE jobs j
       SET status='processing',
           attempts = j.attempts + 1,
           "lockedAt" = NOW(),
           "lockedBy" = $2,
           "updatedAt" = NOW()
       FROM picked
       WHERE j.id = picked.id
       RETURNING j.id, j."clinicId", j."channelId", j.type, j.payload, j.status, j.attempts, j."maxAttempts", j."runAt"`,
      [limit, workerId]
    );

    return result.rows;
  });
}

async function markJobDone(jobId, client = null) {
  await dbQuery(
    client,
    `UPDATE jobs
     SET status='done', "lockedAt"=NULL, "lockedBy"=NULL, "updatedAt"=NOW()
     WHERE id=$1`,
    [jobId]
  );
}

function normalizeErrorForJob(errorInput) {
  if (errorInput && typeof errorInput === 'object') {
    return {
      message: String(errorInput.message || 'unknown error'),
      graphStatus:
        errorInput.graphStatus !== undefined && errorInput.graphStatus !== null
          ? Number(errorInput.graphStatus)
          : null,
      graphErrorCode:
        errorInput.graphErrorCode !== undefined && errorInput.graphErrorCode !== null
          ? Number(errorInput.graphErrorCode)
          : null,
      graphErrorMessage:
        errorInput.graphErrorMessage !== undefined && errorInput.graphErrorMessage !== null
          ? String(errorInput.graphErrorMessage)
          : null,
      fbtrace_id:
        errorInput.fbtrace_id !== undefined && errorInput.fbtrace_id !== null
          ? String(errorInput.fbtrace_id)
          : null,
      phoneNumberId:
        errorInput.phoneNumberId !== undefined && errorInput.phoneNumberId !== null
          ? String(errorInput.phoneNumberId)
          : null,
      to:
        errorInput.to !== undefined && errorInput.to !== null
          ? String(errorInput.to)
          : null,
      graphUrl:
        errorInput.graphUrl !== undefined && errorInput.graphUrl !== null
          ? String(errorInput.graphUrl)
          : null
    };
  }

  return {
    message: String(errorInput || 'unknown error'),
    graphStatus: null,
    graphErrorCode: null,
    graphErrorMessage: null,
    fbtrace_id: null,
    phoneNumberId: null,
    to: null,
    graphUrl: null
  };
}

function sanitizeErrorToken(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
}

function buildStoredErrorMessage(normalizedError, preferredMessage = null) {
  const baseMessage = sanitizeErrorToken(preferredMessage || normalizedError.message || 'unknown error') || 'unknown error';
  const parts = [baseMessage];
  const fields = [
    ['graphStatus', normalizedError.graphStatus],
    ['graphErrorCode', normalizedError.graphErrorCode],
    ['graphErrorMessage', normalizedError.graphErrorMessage],
    ['fbtrace_id', normalizedError.fbtrace_id],
    ['phoneNumberId', normalizedError.phoneNumberId],
    ['to', normalizedError.to],
    ['graphUrl', normalizedError.graphUrl]
  ];

  fields.forEach(([key, value]) => {
    const safeValue = sanitizeErrorToken(value);
    if (safeValue !== null) {
      parts.push(`${key}=${safeValue}`);
    }
  });

  return parts.join(' | ').slice(0, 2000);
}

async function requeueOrFailJob(job, errorInput, client = null) {
  const normalizedError = normalizeErrorForJob(errorInput);
  const attempts = Number(job.attempts || 0);
  const maxAttempts = Number(job.maxAttempts || 10);
  const isWhatsappSendJob = String(job.type || '') === 'whatsapp_send';
  const isRecipientNotAllowed = normalizedError.graphErrorCode === 131030;

  if (isWhatsappSendJob && isRecipientNotAllowed) {
    const clearMessage = `WhatsApp recipient not allowed for test number (graphErrorCode=131030). Add recipient in Meta API Setup.`;
    await dbQuery(
      client,
      `UPDATE jobs
       SET status='failed', "lastError"=$2, "lockedAt"=NULL, "lockedBy"=NULL, "updatedAt"=NOW()
       WHERE id=$1`,
      [job.id, buildStoredErrorMessage(normalizedError, clearMessage)]
    );
    return { status: 'failed' };
  }

  if (attempts >= maxAttempts) {
    await dbQuery(
      client,
      `UPDATE jobs
       SET status='failed', "lastError"=$2, "lockedAt"=NULL, "lockedBy"=NULL, "updatedAt"=NOW()
       WHERE id=$1`,
      [job.id, buildStoredErrorMessage(normalizedError)]
    );
    return { status: 'failed' };
  }

  const backoffSeconds = Math.min(300, Math.pow(2, attempts));
  const nextRunAt = new Date(Date.now() + backoffSeconds * 1000);

  await dbQuery(
    client,
    `UPDATE jobs
     SET status='queued', "runAt"=$2, "lastError"=$3, "lockedAt"=NULL, "lockedBy"=NULL, "updatedAt"=NOW()
     WHERE id=$1`,
    [job.id, nextRunAt.toISOString(), buildStoredErrorMessage(normalizedError)]
  );

  return { status: 'queued', nextRunAt: nextRunAt.toISOString() };
}

module.exports = {
  enqueueInboundJob,
  claimJobs,
  markJobDone,
  requeueOrFailJob
};

