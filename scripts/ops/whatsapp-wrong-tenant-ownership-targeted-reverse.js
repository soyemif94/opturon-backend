'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const reverse = require('../../src/services/whatsapp-wrong-tenant-targeted-reverse.service');

function flag(name, fallback = '') {
  const item = process.argv.find((value) => value.startsWith(`--${name}=`));
  return item ? item.slice(name.length + 3).trim() : fallback;
}

async function verifyProductionWorkerSuspended() {
  const token = String(process.env.RENDER_API_KEY || '').trim();
  const serviceId = String(process.env.RENDER_SERVICE_ID || 'srv-d6n7i5vgi27c73c954t0').trim();
  if (!token) throw new Error('RENDER_API_KEY_required_for_worker_verification');
  const response = await fetch(`https://api.render.com/v1/services/${encodeURIComponent(serviceId)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`worker_verification_http_${response.status}`);
  const service = await response.json();
  if (String(service.suspended || '').toLowerCase() !== 'suspended') throw new Error('render_service_not_suspended');
}

async function run() {
  const mode = flag('mode').toUpperCase();
  const execution = flag('execution', mode === 'DRY_RUN' ? 'READ_ONLY' : '').toUpperCase();
  if (!['DRY_RUN', 'APPLY'].includes(mode)) throw new Error('mode_must_be_DRY_RUN_or_APPLY');
  if (mode === 'DRY_RUN' && execution !== 'READ_ONLY') throw new Error('DRY_RUN_is_strictly_read_only');
  if (mode === 'APPLY' && !['ROLLBACK_SIMULATION', 'COMMIT'].includes(execution)) throw new Error('invalid_APPLY_execution');
  if (mode === 'APPLY' && process.env.WHATSAPP_REVERSE_CONFIRMATION !== reverse.CONFIRMATION) throw new Error('literal_confirmation_mismatch');
  if (mode === 'APPLY' && execution === 'COMMIT' && process.env.WHATSAPP_REVERSE_WORKERS_PAUSED !== 'CONFIRMED') throw new Error('workers_pause_not_confirmed');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_required');
  const manifestPath = path.resolve(flag('manifest'));
  const raw = fs.readFileSync(manifestPath, 'utf8');
  if (reverse.sha256(raw) !== flag('manifest-sha256').toLowerCase()) throw new Error('manifest_checksum_mismatch');
  const manifest = JSON.parse(raw);
  if (!manifest.readyForTargetedReverseApply || (manifest.blockers || []).length) throw new Error('manifest_not_ready');
  if (reverse.sha256(manifest.identities) !== reverse.sha256(reverse.IDS)) throw new Error('manifest_identity_mismatch');
  if (mode === 'APPLY' && execution === 'COMMIT') await verifyProductionWorkerSuspended();
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    if (mode === 'DRY_RUN') {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const validation = await reverse.validateManifestAgainstDatabase(client, manifest);
        if (validation.blockers.length) throw new Error(`dry_run_blocked:${validation.blockers.join(',')}`);
        return { mode, execution, counts: validation.state.counts, postT0Activity: validation.state.drift,
          uniqueness: validation.state.uniqueness, blockers: [] };
      } finally { await client.query('ROLLBACK'); }
    }
    return { mode, ...(await reverse.executeReverseTransaction(client, manifest, execution)) };
  } finally { await client.end(); }
}

if (require.main === module) run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`TARGETED_REVERSE_${result.execution}=PASS\n`);
}).catch((error) => { process.stderr.write(`TARGETED_REVERSE_FAILED=${error.message}\n`); process.exitCode = 1; });

module.exports = { flag, verifyProductionWorkerSuspended, run };
