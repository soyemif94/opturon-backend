'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const reverse = require('../../src/services/whatsapp-wrong-tenant-targeted-reverse.service');

function flag(name, fallback = '') {
  const item = process.argv.find((value) => value.startsWith(`--${name}=`));
  return item ? item.slice(name.length + 3) : fallback;
}

async function run() {
  if (flag('mode', 'PREFLIGHT').toUpperCase() !== 'PREFLIGHT') throw new Error('only_PREFLIGHT_supported');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_required');
  const forwardPath = path.resolve(flag('forward-manifest'));
  const forwardSha = flag('forward-manifest-sha256').toLowerCase();
  const forwardRaw = fs.readFileSync(forwardPath, 'utf8');
  if (reverse.sha256(forwardRaw) !== forwardSha) throw new Error('forward_manifest_checksum_mismatch');
  const forward = JSON.parse(forwardRaw);
  const t0Reverse = new Date().toISOString();
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const database = await reverse.databaseIdentity(client);
    const activityCutoff = '2026-08-22T08:31:10.090Z';
    const state = await reverse.collectCurrentState(client, forward, activityCutoff);
    const blockers = reverse.validateState(state, forward);
    const canonical = state.channels.find((row) => row.id === reverse.IDS.canonicalChannelId);
    const legacy = state.channels.find((row) => row.id === reverse.IDS.legacyChannelId);
    const manifest = {
      manifestVersion: 1,
      phase: 'PRE_REVERSE_TARGETED',
      generatedAtUtc: t0Reverse,
      t0Reverse,
      incorrectApplyAtUtc: '2026-08-22T08:29:50.9857068Z',
      postApplyActivityCutoffUtc: activityCutoff,
      database: { identifierSha256: database.identifier, version: database.version, provider: 'Render PostgreSQL' },
      identities: reverse.IDS,
      forwardManifest: { file: path.basename(forwardPath), sha256: forwardSha },
      channels: state.channels.map(({ credentialFingerprint, ...row }) => row),
      credentialFingerprints: { canonical: canonical.credentialFingerprint, legacy: legacy.credentialFingerprint },
      counts: state.counts,
      postT0Activity: state.drift,
      contactMapping: forward.contactMapping,
      cloneIds: forward.contactMapping.filter((row) => row.kind === 'MINIMAL_CLONE').map((row) => row.targetId),
      collision: { sourceId: reverse.IDS.collisionSourceId, targetId: reverse.IDS.collisionTargetId },
      cloneSafety: state.clones,
      restore: reverse.buildRestoreRows(forward),
      template: state.template,
      immutableFingerprints: state.fingerprints,
      uniqueness: state.uniqueness,
      constraints: state.constraints,
      constraintFingerprint: reverse.sha256(state.constraints),
      backup: {
        renderPostgresId: flag('render-postgres-id'), exportId: flag('export-id'),
        exportAvailable: flag('export-available').toLowerCase() === 'true',
        pitrStatus: flag('pitr-status'), pitrStartsAt: flag('pitr-starts-at'), restorePerformed: false
      },
      blockers,
      readyForTargetedReverseApply: blockers.length === 0 && flag('export-available').toLowerCase() === 'true' && flag('pitr-status') === 'AVAILABLE'
    };
    if (!manifest.backup.exportAvailable) manifest.blockers.push('fresh_logical_export_unavailable');
    if (manifest.backup.pitrStatus !== 'AVAILABLE') manifest.blockers.push('pitr_unavailable');
    manifest.blockers = [...new Set(manifest.blockers)];
    manifest.readyForTargetedReverseApply = manifest.blockers.length === 0;
    const outputDir = path.resolve(flag('output-dir', '.render/whatsapp-ownership-reverse'));
    fs.mkdirSync(outputDir, { recursive: true });
    const stamp = t0Reverse.replace(/[:.]/g, '-');
    const manifestPath = path.join(outputDir, `PRE_REVERSE_MANIFEST.${stamp}.json`);
    const raw = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(manifestPath, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const checksum = reverse.sha256(raw);
    fs.writeFileSync(`${manifestPath}.sha256`, `${checksum}  ${path.basename(manifestPath)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await client.query('ROLLBACK');
    return { manifestPath, checksum, manifest };
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
}

if (require.main === module) run().then((result) => {
  process.stdout.write(`${JSON.stringify({ manifestPath: result.manifestPath, checksum: result.checksum,
    counts: result.manifest.counts, postT0Activity: result.manifest.postT0Activity,
    backup: result.manifest.backup, blockers: result.manifest.blockers }, null, 2)}\n`);
  process.stdout.write(`READY_FOR_TARGETED_REVERSE_APPLY=${result.manifest.readyForTargetedReverseApply}\n`);
}).catch((error) => { process.stderr.write(`PRE_REVERSE_FAILED=${error.message}\nREADY_FOR_TARGETED_REVERSE_APPLY=false\n`); process.exitCode = 1; });

module.exports = { flag, run };
