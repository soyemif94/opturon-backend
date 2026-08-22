const fs = require('fs');
const { Client } = require('pg');
const {
  IDS, sha256, assertApplyGate, verifyWorkerPause, executeApplyTransaction
} = require('../../src/services/whatsapp-channel-ownership-phase2.service');

function flag(name, fallback = '') {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`));
  return value ? value.slice(name.length + 3).trim() : fallback;
}

function parseOptions() {
  return {
    mode: flag('mode').toUpperCase(), execution: flag('execution').toUpperCase(),
    sourceChannelId: flag('source-channel-id'), targetClinicId: flag('target-clinic-id'),
    phoneNumberId: flag('phone-number-id'), manifestPath: flag('manifest'),
    manifestSha256: flag('manifest-sha256').toLowerCase()
  };
}

async function run(options = parseOptions()) {
  assertApplyGate(options);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const raw = fs.readFileSync(options.manifestPath, 'utf8');
  if (sha256(raw) !== options.manifestSha256) throw new Error('manifest_checksum_mismatch');
  const manifest = JSON.parse(raw);
  if (!manifest.readyForProductionApply || manifest.blockers.length) throw new Error('manifest_not_ready');
  if (sha256(manifest.identities) !== sha256(IDS)) throw new Error('manifest_identity_mismatch');
  const manifestAgeMs = Date.now() - Date.parse(manifest.generatedAtUtc);
  if (!Number.isFinite(manifestAgeMs) || manifestAgeMs < 0 || manifestAgeMs > 15 * 60 * 1000) throw new Error('manifest_stale_over_15_minutes');
  await verifyWorkerPause();
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try { return await executeApplyTransaction(client, manifest, options.execution); }
  finally { await client.end(); }
}

if (require.main === module) run().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`PHASE2_${result.execution}=PASS\n`);
}).catch((error) => { process.stderr.write(`APPLY_FAILED=${error.message}\n`); process.exitCode = 1; });

module.exports = { flag, parseOptions, run };
