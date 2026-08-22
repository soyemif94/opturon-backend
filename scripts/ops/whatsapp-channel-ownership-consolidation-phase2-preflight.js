const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { buildSnapshot } = require('./whatsapp-channel-ownership-consolidation-phase1b-dry-run');
const { analyzeWhatsAppOnlySnapshot } = require('../../src/services/whatsapp-channel-ownership-whatsapp-only.service');
const {
  IDS, APPROVED_PRE_APPLY_COUNTS, sha256, buildContactMapping, collectSafetyState, safetyBlockers, collectPreApplyCounts
} = require('../../src/services/whatsapp-channel-ownership-phase2.service');

const TABLE_SCOPES = Object.freeze({
  contacts: '"clinicId"=$2::uuid',
  conversations: '"channelId"=$1::uuid',
  conversation_messages: '"conversationId" IN (SELECT id FROM conversations WHERE "channelId"=$1::uuid)',
  messages: '"channelId"=$1::uuid',
  conversation_events: '"conversationId" IN (SELECT id FROM conversations WHERE "channelId"=$1::uuid)',
  handoff_requests: '"conversationId" IN (SELECT id FROM conversations WHERE "channelId"=$1::uuid)',
  agenda_items: '"conversationId" IN (SELECT id FROM conversations WHERE "channelId"=$1::uuid)',
  leads: '"channelId"=$1::uuid',
  appointments: '"channelId"=$1::uuid',
  jobs: '"channelId"=$1::uuid',
  whatsapp_templates: '"channelId"=$1::uuid',
  operational_alert_rules: '"channelId"=$1::uuid',
  operational_alert_deliveries: '"channelId"=$1::uuid',
  order_customer_notifications: '"channelId"=$1::uuid',
  orders: `"clinicId"=$2::uuid AND ("conversationId" IN (SELECT id FROM conversations WHERE "channelId"=$1::uuid)
    OR "contactId" IN (SELECT DISTINCT "contactId" FROM conversations WHERE "channelId"=$1::uuid))`,
  order_items: `"orderId" IN (SELECT id FROM orders WHERE "clinicId"=$2::uuid AND ("conversationId" IN
    (SELECT id FROM conversations WHERE "channelId"=$1::uuid) OR "contactId" IN
    (SELECT DISTINCT "contactId" FROM conversations WHERE "channelId"=$1::uuid)))`,
  invoices: `"clinicId"=$2::uuid AND ("contactId" IN (SELECT DISTINCT "contactId" FROM conversations WHERE "channelId"=$1::uuid)
    OR "orderId" IN (SELECT id FROM orders WHERE "clinicId"=$2::uuid AND ("conversationId" IN
    (SELECT id FROM conversations WHERE "channelId"=$1::uuid) OR "contactId" IN
    (SELECT DISTINCT "contactId" FROM conversations WHERE "channelId"=$1::uuid))))`,
  payments: `"clinicId"=$2::uuid AND ("contactId" IN (SELECT DISTINCT "contactId" FROM conversations WHERE "channelId"=$1::uuid)
    OR "invoiceId" IN (SELECT id FROM invoices WHERE "clinicId"=$2::uuid AND ("contactId" IN
    (SELECT DISTINCT "contactId" FROM conversations WHERE "channelId"=$1::uuid) OR "orderId" IN
    (SELECT id FROM orders WHERE "clinicId"=$2::uuid AND "contactId" IN
    (SELECT DISTINCT "contactId" FROM conversations WHERE "channelId"=$1::uuid)))))`,
  payment_allocations: `"paymentId" IN (SELECT id FROM payments WHERE "clinicId"=$2::uuid AND "contactId" IN
    (SELECT DISTINCT "contactId" FROM conversations WHERE "channelId"=$1::uuid)) OR "invoiceId" IN
    (SELECT id FROM invoices WHERE "clinicId"=$2::uuid AND "contactId" IN
    (SELECT DISTINCT "contactId" FROM conversations WHERE "channelId"=$1::uuid))`,
  inventory_lot_allocations: `"orderId" IN (SELECT id FROM orders WHERE "clinicId"=$2::uuid AND "contactId" IN
    (SELECT DISTINCT "contactId" FROM conversations WHERE "channelId"=$1::uuid))`,
  whatsapp_template_canary_attempts: '"channelId"=$1::uuid',
  channel_onboarding_sessions: '"channelId"=$1::uuid'
});

function options() {
  const get = (name, fallback = '') => {
    const value = process.argv.find((item) => item.startsWith(`--${name}=`));
    return value ? value.slice(name.length + 3) : fallback;
  };
  const mode = get('mode', 'PREFLIGHT').toUpperCase();
  if (mode !== 'PREFLIGHT') throw new Error('Only --mode=PREFLIGHT is supported. This command is read-only.');
  return { mode, outputDir: path.resolve(get('output-dir', '.render/whatsapp-ownership-phase2')) };
}

async function platformBackupProof() {
  const token = String(process.env.RENDER_API_KEY || '').trim();
  const postgresId = String(process.env.RENDER_POSTGRES_ID || 'dpg-d6n741q4d50c73dan0eg-a').trim();
  if (!token) return { postgresId, verified: false, recoveryStatus: 'UNVERIFIED', startsAt: null, restoreTarget: 'SEPARATE_DATABASE', blocker: 'RENDER_API_KEY_missing' };
  const response = await fetch(`https://api.render.com/v1/postgres/${encodeURIComponent(postgresId)}/recovery`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Render recovery API failed with HTTP ${response.status}`);
  const body = await response.json();
  const exportResponse = await fetch(`https://api.render.com/v1/postgres/${encodeURIComponent(postgresId)}/export`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (!exportResponse.ok) throw new Error(`Render export API failed with HTTP ${exportResponse.status}`);
  const exports = await exportResponse.json();
  const latestExport = Array.isArray(exports) && exports.length ? exports[0] : null;
  const exportAgeMinutes = latestExport && latestExport.createdAt
    ? Math.max(0, (Date.now() - Date.parse(latestExport.createdAt)) / 60000) : null;
  return {
    postgresId, verified: body.recoveryStatus === 'AVAILABLE', recoveryStatus: body.recoveryStatus || 'UNKNOWN',
    startsAt: body.startsAt || null, checkedAt: new Date().toISOString(), restoreTarget: 'SEPARATE_DATABASE',
    latestLogicalExport: latestExport ? { id: latestExport.id, createdAt: latestExport.createdAt,
      available: Boolean(latestExport.url), ageMinutes: Math.round(exportAgeMinutes * 10) / 10,
      freshWithin30Minutes: Boolean(latestExport.url) && exportAgeMinutes <= 30 } : null,
    t0Requirement: 'Record a fresh UTC T0 after workers stop and immediately before APPLY; PITR cannot target the most recent ~10 minutes.'
  };
}

async function fingerprintTable(client, table, predicate) {
  const secretProjection = table === 'channels' ? `to_jsonb(t)-'accessToken'` : 'to_jsonb(t)';
  const result = (await client.query(`WITH _typed_params AS (SELECT $1::uuid,$2::uuid,$3::uuid)
    SELECT count(*)::int count,
    COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) ids,
    encode(digest(COALESCE(string_agg(encode(digest((${secretProjection})::text,'sha256'),'hex'),'' ORDER BY id),''),'sha256'),'hex') sha256
    FROM ${table} t WHERE ${predicate}`, [IDS.sourceChannelId, IDS.sourceClinicId, IDS.targetClinicId])).rows[0];
  return { count: Number(result.count), ids: result.ids, sha256: result.sha256 };
}

async function createManifest(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const expected = { sourceChannelId: IDS.sourceChannelId, sourceClinicId: IDS.sourceClinicId,
      targetClinicId: IDS.targetClinicId, legacyChannelId: IDS.legacyChannelId };
    const phase1b = analyzeWhatsAppOnlySnapshot(await buildSnapshot(client, expected));
    const safety = await collectSafetyState(client);
    const preApplyCounts = await collectPreApplyCounts(client);
    const mapping = await buildContactMapping(client);
    const identity = (await client.query(`SELECT current_database() database, current_setting('server_version') version,
      encode(digest(current_database() || ':' || inet_server_addr()::text || ':' || inet_server_port()::text,'sha256'),'hex') identifier`)).rows[0];
    const channels = (await client.query(`SELECT id,"clinicId","wabaId","phoneNumberId",status,"createdAt","updatedAt",
      encode(digest(COALESCE("accessToken",''),'sha256'),'hex') "credentialFingerprint"
      FROM channels WHERE id IN ($1::uuid,$2::uuid) ORDER BY id`, [IDS.sourceChannelId, IDS.legacyChannelId])).rows;
    const constraints = (await client.query(`SELECT conrelid::regclass::text table,conname name,contype type,condeferrable deferrable,
      convalidated validated,encode(digest(pg_get_constraintdef(oid),'sha256'),'hex') "definitionSha256"
      FROM pg_constraint WHERE connamespace='public'::regnamespace AND conrelid::regclass::text=ANY($1::text[])
      ORDER BY 1,2`, [Object.keys(TABLE_SCOPES)])).rows;
    const fingerprints = {};
    for (const [table, predicate] of Object.entries(TABLE_SCOPES)) fingerprints[table] = await fingerprintTable(client, table, predicate);
    const detaches = (await client.query(`WITH sc AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid)
      SELECT 'orders' kind,id,"conversationId" "referenceId" FROM orders WHERE "clinicId"=$2::uuid AND "conversationId" IN (SELECT id FROM sc)
      UNION ALL SELECT 'notification_channel',id,"channelId" FROM order_customer_notifications WHERE "clinicId"=$2::uuid AND "channelId"=$1::uuid
      UNION ALL SELECT 'notification_conversation',id,"conversationId" FROM order_customer_notifications WHERE "clinicId"=$2::uuid AND "conversationId" IN (SELECT id FROM sc)
      UNION ALL SELECT 'alert_rule_channel',id,"channelId" FROM operational_alert_rules WHERE "clinicId"=$2::uuid AND "channelId"=$1::uuid
      ORDER BY 1,2`, [IDS.sourceChannelId, IDS.sourceClinicId])).rows;
    const actorReferences = (await client.query(`WITH sc AS (SELECT id FROM conversations WHERE "channelId"=$1::uuid)
      SELECT 'conversation_assignee' kind,id,"assignedSellerUserId" "actorId" FROM conversations WHERE id IN (SELECT id FROM sc) AND "assignedSellerUserId" IS NOT NULL
      UNION ALL SELECT 'conversation_deleter',id,"deletedByUserId" FROM conversations WHERE id IN (SELECT id FROM sc) AND "deletedByUserId" IS NOT NULL
      UNION ALL SELECT 'lead_assignee',id,"assignedTo" FROM leads WHERE "channelId"=$1::uuid AND "assignedTo" IS NOT NULL
      UNION ALL SELECT 'handoff_assignee',id,"assignedTo" FROM handoff_requests WHERE "conversationId" IN (SELECT id FROM sc) AND "assignedTo" IS NOT NULL
      UNION ALL SELECT 'agenda_assignee',id,"assignedUserId" FROM agenda_items WHERE "conversationId" IN (SELECT id FROM sc) AND "assignedUserId" IS NOT NULL
      ORDER BY 1,2`, [IDS.sourceChannelId])).rows;
    const targetPrimary = (await client.query(`SELECT s.id FROM clinics c JOIN staff_users s
      ON s.id=NULLIF(c.settings -> 'portal' ->> 'primaryPortalUserId','')::uuid
      WHERE c.id=$1::uuid AND s."clinicId"=c.id AND s.active=true`, [IDS.targetClinicId])).rows[0] || null;
    const blockers = [...phase1b.blockers, ...safetyBlockers(safety)];
    for (const [key, approved] of Object.entries(APPROVED_PRE_APPLY_COUNTS)) {
      if (Number(preApplyCounts[key]) !== approved) blockers.push(`approved_count_drift:${key}:${preApplyCounts[key]}!=${approved}`);
    }
    if (mapping.length !== 77 || mapping.filter((item) => item.kind === 'MINIMAL_CLONE').length !== 76) blockers.push('contact_mapping_cardinality_changed');
    const backup = await platformBackupProof();
    if (!backup.verified) blockers.push('pitr_not_verified');
    if (!backup.latestLogicalExport || !backup.latestLogicalExport.freshWithin30Minutes) blockers.push('fresh_logical_export_not_verified');
    const source = channels.find((item) => item.id === IDS.sourceChannelId);
    return {
      manifestVersion: 1, phase: 'PHASE2_PRE_APPLY', generatedAtUtc: new Date().toISOString(),
      database: { identifierSha256: identity.identifier, version: identity.version, provider: 'Render PostgreSQL' },
      identities: IDS, channelTimestamps: channels.map(({ credentialFingerprint, ...row }) => row),
      credentialFingerprint: source && source.credentialFingerprint,
      preApplyCounts, safety, constraints, tableFingerprints: fingerprints, detachedReferences: detaches,
      actorReferences, targetPrimaryStaffId: targetPrimary && targetPrimary.id,
      contactMapping: mapping, phase1b: { ready: phase1b.readyForWhatsAppOnlyMigration, blockers: phase1b.blockers },
      backup, workerGate: { strategy: 'Suspend the monolithic opturon-api Render service (web + in-process worker), verify zero active work, run APPLY, resume after commit/rollback.', requiredConfirmation: 'CONFIRMED' },
      blockers: [...new Set(blockers)], readyForProductionApply: blockers.length === 0
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

async function run(config = options()) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const manifest = await createManifest(client);
    fs.mkdirSync(config.outputDir, { recursive: true });
    const stamp = manifest.generatedAtUtc.replace(/[:.]/g, '-');
    const manifestPath = path.join(config.outputDir, `PRE_APPLY_MANIFEST.${stamp}.json`);
    const body = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(manifestPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const checksum = sha256(body);
    const checksumPath = `${manifestPath}.sha256`;
    fs.writeFileSync(checksumPath, `${checksum}  ${path.basename(manifestPath)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { manifest, manifestPath, checksumPath, checksum };
  } finally { await client.end(); }
}

if (require.main === module) run().then((result) => {
  process.stdout.write(`${JSON.stringify({ manifestPath: result.manifestPath, checksumPath: result.checksumPath,
    checksum: result.checksum, preApplyCounts: result.manifest.preApplyCounts, safety: result.manifest.safety,
    backup: result.manifest.backup, blockers: result.manifest.blockers }, null, 2)}\n`);
  process.stdout.write(`READY_FOR_PRODUCTION_APPLY=${result.manifest.readyForProductionApply}\n`);
}).catch((error) => { process.stderr.write(`PREFLIGHT_FAILED=${error.message}\nREADY_FOR_PRODUCTION_APPLY=false\n`); process.exitCode = 1; });

module.exports = { TABLE_SCOPES, options, platformBackupProof, fingerprintTable, createManifest, run };
