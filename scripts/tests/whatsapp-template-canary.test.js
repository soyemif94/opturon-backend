const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const actualCanaryRepo = require(path.join(root, 'src/repositories/whatsapp-template-canary.repository.js'));

function fixture(overrides = {}) {
  const template = { id: '10000000-0000-4000-8000-000000000001', clinicId: '20000000-0000-4000-8000-000000000001',
    channelId: '30000000-0000-4000-8000-000000000001', wabaId: 'waba-a', metaTemplateName: 'hello_customer',
    templateKey: 'hello', language: 'es_AR', category: 'UTILITY', status: 'approved',
    definition: { provider: { components: [{ type: 'BODY', text: 'Hola {{1}}' }] } } };
  const recipient = { id: '40000000-0000-4000-8000-000000000001', clinicId: template.clinicId, name: 'QA', phoneE164: '+5491112345678', active: true, consentStatus: 'granted' };
  const attempt = { id: '50000000-0000-4000-8000-000000000001', clinicId: template.clinicId, channelId: template.channelId,
    templateId: template.id, recipientId: recipient.id, actorId: '60000000-0000-4000-8000-000000000001', status: 'processing',
    templateName: template.metaTemplateName, language: template.language, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const state = { sends: 0, inserts: 0, updates: [] };
  return { template, recipient, attempt, state, ...overrides };
}

function loadService(fx) {
  const modules = {
    'src/services/portal-context.service.js': { resolvePortalTenantContext: async () => ({ ok: true, tenantId: 'tenant-a', clinic: { id: fx.template.clinicId }, channel: { id: fx.template.channelId } }) },
    'src/repositories/tenant.repository.js': { findChannelByIdAndClinicId: async () => ({ id: fx.template.channelId, clinicId: fx.template.clinicId, provider: 'whatsapp_cloud', status: 'active', accessToken: 'server-secret', phoneNumberId: 'phone-a', wabaId: 'waba-a', displayPhoneNumber: '+541100000000' }) },
    'src/repositories/whatsapp-templates.repository.js': { listWhatsAppTemplatesByClinicId: async () => [fx.template, ...(fx.extraTemplates || [])], findWhatsAppTemplateByIdAndScope: async () => fx.templateResult === undefined ? fx.template : fx.templateResult },
    'src/repositories/operational-alert-recipients.repository.js': { listOperationalAlertRecipients: async () => [fx.recipient], findOperationalAlertRecipientById: async () => fx.recipientResult === undefined ? fx.recipient : fx.recipientResult },
    'src/repositories/whatsapp-template-canary.repository.js': {
      findByIdempotencyKey: async () => fx.existing || null,
      createAttempt: async () => ({ created: true, row: { ...fx.attempt } }),
      updateAttempt: async (_id, _clinicId, patch) => { fx.state.updates.push(patch); return { ...fx.attempt, ...patch }; },
      listRecent: async () => [],
      withTransaction: async (work) => work({ query: async () => ({ rows: [] }) })
    },
    'src/repositories/contact.repository.js': { upsertContact: async () => ({ id: '70000000-0000-4000-8000-000000000001' }) },
    'src/conversations/conversation.repo.js': { upsertOutboundConversation: async () => ({ id: '80000000-0000-4000-8000-000000000001' }), insertOutboundMessage: async () => { fx.state.inserts += 1; if (fx.inboxError) throw fx.inboxError; return { row: { id: '90000000-0000-4000-8000-000000000001' } }; } },
    'src/whatsapp/whatsapp.service.js': { sendChannelScopedMessage: async () => { fx.state.sends += 1; if (fx.sendError) throw fx.sendError; return { messageId: 'wamid.canary' }; } },
    'src/utils/logger.js': { logInfo() {}, logWarn() {} }
  };
  for (const [relative, exports] of Object.entries(modules)) {
    const filename = path.join(root, relative);
    require.cache[require.resolve(filename)] = { id: filename, filename, loaded: true, exports };
  }
  const filename = path.join(root, 'src/services/portal-whatsapp-template-canary.service.js');
  delete require.cache[require.resolve(filename)];
  return require(filename);
}

const payload = (fx) => ({ templateId: fx.template.id, recipientId: fx.recipient.id, variables: { 'body.1': 'Emi' }, idempotencyKey: 'canary-key-1234567890' });
const actor = { id: '60000000-0000-4000-8000-000000000001' };

test('tenant/WABA listing excludes templates from another channel', async () => {
  const fx = fixture();
  fx.extraTemplates = [{ ...fx.template, id: 'other', channelId: 'other-channel' }];
  const result = await loadService(fx).getCanaryWorkspace('tenant-a');
  assert.equal(result.templates.length, 1);
});
test('template inexistente is rejected before provider call', async () => {
  const fx = fixture({ templateResult: null }); const result = await loadService(fx).sendCanary('tenant-a', payload(fx), actor);
  assert.equal(result.reason, 'whatsapp_template_not_found'); assert.equal(fx.state.sends, 0);
});
test('template not approved is rejected', async () => {
  const fx = fixture(); fx.template.status = 'pending'; const result = await loadService(fx).sendCanary('tenant-a', payload(fx), actor);
  assert.equal(result.reason, 'whatsapp_template_not_sendable');
});
test('missing variables are rejected', async () => {
  const fx = fixture(); const result = await loadService(fx).sendCanary('tenant-a', { ...payload(fx), variables: {} }, actor);
  assert.equal(result.reason, 'whatsapp_template_variables_missing');
});
test('recipient without consent is rejected', async () => {
  const fx = fixture(); fx.recipient.consentStatus = 'pending'; const result = await loadService(fx).sendCanary('tenant-a', payload(fx), actor);
  assert.equal(result.reason, 'whatsapp_canary_recipient_not_authorized');
});
test('valid send calls provider once and persists Inbox once', async () => {
  const fx = fixture(); const result = await loadService(fx).sendCanary('tenant-a', payload(fx), actor);
  assert.equal(result.ok, true); assert.equal(fx.state.sends, 1); assert.equal(fx.state.inserts, 1); assert.equal(result.attempt.providerMessageId, 'wamid.canary');
});
test('existing idempotency key never calls provider again', async () => {
  const fx = fixture(); fx.existing = { ...fx.attempt, status: 'sent', providerMessageId: 'wamid.existing' };
  const result = await loadService(fx).sendCanary('tenant-a', payload(fx), actor);
  assert.equal(result.replayed, true); assert.equal(fx.state.sends, 0);
});
test('Meta error persists failed coherently', async () => {
  const error = new Error('Graph rejected'); error.graphStatus = 400;
  const fx = fixture({ sendError: error }); const result = await loadService(fx).sendCanary('tenant-a', payload(fx), actor);
  assert.equal(result.reason, 'whatsapp_canary_send_failed'); assert.equal(fx.state.updates.at(-1).status, 'failed');
});
test('Graph acceptance plus Inbox failure is unknown_delivery and not retryable automatically', async () => {
  const fx = fixture({ inboxError: new Error('db unavailable') }); const result = await loadService(fx).sendCanary('tenant-a', payload(fx), actor);
  assert.equal(result.reason, 'whatsapp_canary_delivery_unknown'); assert.equal(fx.state.updates.at(-1).status, 'unknown_delivery'); assert.equal(fx.state.sends, 1);
});
test('template parser preserves component order and builds Graph parameters', () => {
  const domain = require(path.join(root, 'src/whatsapp/whatsapp-template-canary-domain.js'));
  const fx = fixture(); const result = domain.buildTemplatePayload(fx.template, { 'body.1': 'Emi' });
  assert.deepEqual(result.components[0].parameters, [{ type: 'text', text: 'Emi' }]); assert.equal(result.preview[0].text, 'Hola Emi');
});
test('recent audit query qualifies every attempt column across the recipient join', () => {
  const qualified = actualCanaryRepo._internals.qualifyColumns('a');
  assert.match(qualified, /^a\.id/); assert.match(qualified, /a\."templateName"/); assert.match(qualified, /a\.status/); assert.match(qualified, /a\."createdAt"/);
  assert.doesNotMatch(qualified, /,\s+"/);
});
test('webhook status service contains Canary reconciliation after existing pipelines', () => {
  const source = fs.readFileSync(path.join(root, 'src/services/order-customer-notification-status.service.js'), 'utf8');
  assert.match(source, /reconcileCanaryStatus/); assert.match(source, /canaryMatched/);
});
test('migration and routes enforce tenant keys, idempotency and backend permission gates', () => {
  const migration = fs.readFileSync(path.join(root, 'db/migrations/077_whatsapp_template_canary_attempts.sql'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  assert.match(migration, /UNIQUE \("clinicId", "idempotencyKey"\)/); assert.match(migration, /fk_whatsapp_template_canary_channel_tenant/);
  assert.match(routes, /requireWhatsAppCanaryRead/); assert.match(routes, /requireWhatsAppCanaryWrite/);
  const conversations = fs.readFileSync(path.join(root, 'src/conversations/conversation.repo.js'), 'utf8');
  assert.match(conversations, /upsertOutboundConversation[\s\S]*?"lastInboundAt"[\s\S]*?NULL/);
});
