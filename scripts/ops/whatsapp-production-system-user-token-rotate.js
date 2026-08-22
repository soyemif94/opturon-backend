const { once } = require('events');
const {
  ROTATION_TARGET,
  ROTATION_CONFIRMATION,
  validateMetaCredential,
  getSystemUserTokenRotationPreflight,
  rotateSystemUserToken
} = require('../../src/services/whatsapp-system-user-token-rotation.service');
const { closePool } = require('../../src/db/client');
const rotationRepository = require('../../src/repositories/whatsapp-system-user-token-rotation.repository');
const { query } = require('../../src/db/client');
const { listPortalWhatsAppTemplates } = require('../../src/services/portal-whatsapp-templates.service');
const { getCanaryWorkspace } = require('../../src/services/portal-whatsapp-template-canary.service');
const { listPortalConversations } = require('../../src/services/portal-inbox.service');

function mode() {
  const item = process.argv.find((value) => value.startsWith('--mode='));
  return item ? item.slice('--mode='.length).trim().toUpperCase() : '';
}

async function readStdinJson() {
  let body = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { body += chunk; });
  if (!process.stdin.readableEnded) await once(process.stdin, 'end');
  return JSON.parse(body || '{}');
}

function writeResult(value) {
  process.stdout.write(`ROTATION_RESULT_JSON=${JSON.stringify(value)}\n`);
}

async function run() {
  const selectedMode = mode();
  if (selectedMode === 'PREFLIGHT') {
    writeResult(await getSystemUserTokenRotationPreflight(ROTATION_TARGET.tenantId));
    return;
  }
  if (selectedMode === 'ROTATE') {
    const payload = await readStdinJson();
    if (String(payload.confirmation || '') !== ROTATION_CONFIRMATION) {
      throw new Error('rotation_confirmation_invalid');
    }
    writeResult(await rotateSystemUserToken(ROTATION_TARGET.tenantId, payload));
    return;
  }
  if (selectedMode === 'VERIFY') {
    const preflight = await getSystemUserTokenRotationPreflight(ROTATION_TARGET.tenantId);
    const persisted = await rotationRepository.readPersistedCredential(ROTATION_TARGET);
    try {
      const meta = await validateMetaCredential(persisted.accessToken);
      const [templateDb, routingDb, templates, canary, inbox, sourceInbox] = await Promise.all([
        query(
          `SELECT id, "clinicId", "channelId", "wabaId", "metaTemplateName", language, status, category, "lastSyncedAt"
             FROM whatsapp_templates
            WHERE "channelId" = $1::uuid
              AND "metaTemplateName" = 'inventory_lot_expiring_v1'
              AND language = 'es_AR'
            ORDER BY "updatedAt" DESC`,
          [ROTATION_TARGET.channelId]
        ),
        query(
          `SELECT
             COUNT(*) FILTER (WHERE "channelId" = $1::uuid)::int AS "canonicalConversations",
             COUNT(*) FILTER (WHERE "channelId" = $2::uuid)::int AS "legacyConversations",
             COUNT(*) FILTER (WHERE "channelId" = $1::uuid AND "clinicId" <> $3::uuid)::int AS "crossTenantCanonicalConversations"
           FROM conversations`,
          [ROTATION_TARGET.channelId, ROTATION_TARGET.legacyChannelId, ROTATION_TARGET.clinicId]
        ),
        listPortalWhatsAppTemplates(ROTATION_TARGET.tenantId),
        getCanaryWorkspace(ROTATION_TARGET.tenantId),
        listPortalConversations(ROTATION_TARGET.tenantId),
        listPortalConversations('tenant_1772601586508_w1e4fs')
      ]);
      const templateRows = templateDb.rows.map((row) => ({
        id: row.id,
        clinicId: row.clinicId,
        channelId: row.channelId,
        wabaId: row.wabaId,
        name: row.metaTemplateName,
        language: row.language,
        status: row.status,
        category: row.category,
        lastSyncedAt: row.lastSyncedAt
      }));
      writeResult({
        ok: true,
        target: ROTATION_TARGET,
        credentialFingerprint: persisted.credentialFingerprint,
        ownershipConfirmed: preflight.ownershipConfirmed,
        meta,
        templateDb: templateRows,
        routingDb: routingDb.rows[0],
        services: {
          templatesOk: templates.ok === true,
          templatesCount: Array.isArray(templates.templates) ? templates.templates.length : 0,
          canaryOk: canary.ok === true,
          canaryTemplateCount: Array.isArray(canary.templates) ? canary.templates.length : 0,
          canaryAttemptCount: Array.isArray(canary.attempts) ? canary.attempts.length : 0,
          inboxOk: inbox.ok === true,
          inboxSelectedChannelId: inbox.channel && inbox.channel.id,
          inboxConversationCount: Array.isArray(inbox.conversations) ? inbox.conversations.length : 0,
          sourceInboxOk: sourceInbox.ok === true,
          sourceSelectedChannelId: sourceInbox.channel && sourceInbox.channel.id,
          sourceContainsCanonical: Array.isArray(sourceInbox.conversations)
            ? sourceInbox.conversations.some((item) => item.channelId === ROTATION_TARGET.channelId)
            : null
        }
      });
    } finally {
      persisted.accessToken = null;
    }
    return;
  }
  throw new Error('mode_must_be_PREFLIGHT_ROTATE_or_VERIFY');
}

run()
  .catch((error) => {
    process.stderr.write(`ROTATION_HELPER_FAILED=${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await closePool(); }
    catch { process.exitCode = 1; }
  });
