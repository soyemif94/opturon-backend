const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractSmbMessageEchoes } = require('../../src/webhooks/smb-message-echoes');
const { createSmbMessageEchoProcessor } = require('../../src/conversations/smb-message-echo.service');
const {
  buildTakeoverContextPatch, buildResumeContextPatch, isAutomaticReplyAllowedNow,
  getInboundProcessingJobType, TAKEOVER_SOURCES
} = require('../../src/conversations/human-takeover.service');
const { createTakeoverOperationalProcessor } = require('../../src/conversations/takeover-operational.service');

const channelA = {
  id: 'channel-a', clinicId: 'tenant-a', provider: 'whatsapp_cloud',
  connectionMode: 'COEXISTENCE', status: 'active', phoneNumberId: 'phone-a',
  displayPhoneNumber: '+54 11 8888 0000', wabaId: 'waba-a'
};

function echoFixture(overrides = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: overrides.wabaId || 'waba-a', changes: [{ field: 'smb_message_echoes', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: overrides.phoneNumberId || 'phone-a', display_phone_number: '+54 11 8888 0000' },
      message_echoes: [{
        id: overrides.id || 'wamid.echo-1', timestamp: '1789990000',
        from: overrides.from ?? '541188880000', to: overrides.to ?? '5492911111111',
        type: overrides.type || 'text',
        [overrides.type || 'text']: overrides.content || { body: 'Te confirmo el stock' }
      }]
    } }] }]
  };
}

function fixture(overrides = {}) {
  const state = { messages: new Map(), conversations: new Map(), takeovers: [], jobs: [], resolutions: [] };
  const channels = overrides.channels || { 'phone-a': channelA };
  const process = createSmbMessageEchoProcessor({
    transaction: async (fn) => fn({}),
    findChannel: async (phoneNumberId) => channels[phoneNumberId] || null,
    findMessage: async (id) => state.messages.get(id) || null,
    resolveConversation: async (input) => {
      state.resolutions.push(input);
      const key = `${input.clinicId}:${input.channelId}:${input.providerIdentity}`;
      if (!state.conversations.has(key)) state.conversations.set(key, { id: `conversation-${state.conversations.size + 1}`, context: {} });
      return { conversation: state.conversations.get(key) };
    },
    insertMessage: async (input) => {
      if (state.messages.has(input.waMessageId)) return { inserted: false };
      state.messages.set(input.waMessageId, { ...input, direction: 'outbound' });
      return { inserted: true, row: { id: input.waMessageId } };
    },
    activateTakeover: async (input) => {
      state.takeovers.push(input);
      const conversation = [...state.conversations.values()].find((item) => item.id === input.conversationId);
      conversation.context = { ...conversation.context, ...buildTakeoverContextPatch(conversation.context, input.source, input.at) };
      return { activated: true };
    },
    invalidateCandidate: async () => 0,
    logInfo: () => {}, logWarn: () => {}
  });
  return { state, process };
}

test('explicit parser reads only SMB echoes and validates required identities', () => {
  assert.equal(extractSmbMessageEchoes(echoFixture()).length, 1);
  assert.equal(extractSmbMessageEchoes(echoFixture())[0].text, 'Te confirmo el stock');
  assert.equal(extractSmbMessageEchoes({ ...echoFixture(), object: 'other' }).length, 0);
  assert.equal(extractSmbMessageEchoes(echoFixture({ to: '' }))[0].invalidReason, 'invalid_phone_identity');
});

test('human app echo is outbound in the correct tenant and activates takeover without a bot job', async () => {
  const { state, process } = fixture();
  const result = await process(echoFixture());
  assert.equal(result.persisted, 1);
  const message = state.messages.get('wamid.echo-1');
  assert.equal(message.direction, 'outbound');
  assert.equal(message.raw.actor, 'HUMAN');
  assert.equal(message.raw.source, TAKEOVER_SOURCES.WHATSAPP_BUSINESS_APP);
  assert.equal(message.clinicId, 'tenant-a');
  assert.equal(state.resolutions[0].providerIdentity, '5492911111111');
  assert.equal(state.resolutions[0].direction, 'outbound');
  assert.equal(state.takeovers.length, 1);
  assert.equal(state.conversations.values().next().value.context.portalBotEnabled, false);
  assert.equal(state.jobs.length, 0);
});

test('three delivery attempts create one outbound item and one takeover transition', async () => {
  const { state, process } = fixture();
  for (let i = 0; i < 3; i += 1) await process(echoFixture());
  assert.equal(state.messages.size, 1);
  assert.equal(state.takeovers.length, 1);
  assert.equal(state.jobs.length, 0);
});

test('API_ONLY, mismatched WABA/phone and malformed events fail closed across tenants', async () => {
  const channelB = { ...channelA, id: 'channel-b', clinicId: 'tenant-b', phoneNumberId: 'phone-b', wabaId: 'waba-b' };
  const { state, process } = fixture({ channels: {
    'phone-a': { ...channelA, connectionMode: 'API_ONLY' },
    'phone-b': channelB
  } });
  await process(echoFixture());
  await process(echoFixture({ phoneNumberId: 'phone-b' }));
  await process(echoFixture({ phoneNumberId: 'unknown' }));
  await process(echoFixture({ id: '', to: '' }));
  assert.equal(state.messages.size, 0);
  assert.equal(state.takeovers.length, 0);
  assert.equal(state.resolutions.length, 0);
});

test('valid media echo activates takeover; edit and revoke are deferred safely', async () => {
  const { state, process } = fixture();
  await process(echoFixture({ type: 'image', content: { id: 'media-1', caption: 'Producto' } }));
  assert.equal(state.messages.get('wamid.echo-1').type, 'image');
  assert.equal(state.takeovers.length, 1);
  await process(echoFixture({ id: 'wamid.edit', type: 'edit', content: { original_message_id: 'wamid.echo-1' } }));
  await process(echoFixture({ id: 'wamid.revoke', type: 'revoke', content: { original_message_id: 'wamid.echo-1' } }));
  assert.equal(state.messages.size, 1);
  assert.equal(state.jobs.length, 0);
});

test('queued bot reply sees takeover at pre-send read and sends zero messages', async () => {
  let context = { portalBotEnabled: true };
  let sendCount = 0;
  const load = async () => ({ channelId: 'channel-a', context });
  assert.equal(await isAutomaticReplyAllowedNow({ clinicId: 'tenant-a', conversationId: 'conversation-a', channelId: 'channel-a' }, load), true);
  context = { ...context, ...buildTakeoverContextPatch(context, TAKEOVER_SOURCES.WHATSAPP_BUSINESS_APP) };
  if (await isAutomaticReplyAllowedNow({ clinicId: 'tenant-a', conversationId: 'conversation-a', channelId: 'channel-a' }, load)) sendCount += 1;
  assert.equal(sendCount, 0);
  context = { ...context, ...buildResumeContextPatch() };
  assert.equal(await isAutomaticReplyAllowedNow({ clinicId: 'tenant-a', conversationId: 'conversation-a', channelId: 'channel-a' }, load), true);
});

test('customer inbound during takeover reaches context and CRM processing without output', async () => {
  const state = { leads: 0, updates: [], sends: 0 };
  const process = createTakeoverOperationalProcessor({
    upsertLead: async () => { state.leads += 1; },
    processOrder: async () => ({ mutated: false, reason: 'NO_ORDER_OPERATION' }),
    invalidateCandidate: async () => 0,
    updateConversation: async (input) => { state.updates.push(input); return { id: input.conversationId }; }
  });
  await process({ clinicId: 'tenant-a', channelId: 'channel-a', conversationId: 'conversation-a', contactId: 'contact-a', inboundMessageId: 'inbound-a' });
  assert.equal(state.leads, 1);
  assert.equal(state.updates[0].contextPatch.portalLastProcessedInboundMessageId, 'inbound-a');
  assert.equal(state.sends, 0);
  assert.equal(getInboundProcessingJobType({ portalBotEnabled: false }), 'conversation_operational');
  assert.equal(getInboundProcessingJobType({ portalBotEnabled: true }), 'conversation_reply');
});

test('manual Inbox source uses the same canonical ownership and manual resume clears it', () => {
  const paused = buildTakeoverContextPatch({}, TAKEOVER_SOURCES.OPTURON_INBOX);
  assert.equal(paused.portalBotEnabled, false);
  assert.equal(paused.portalBotTakeoverSource, 'OPTURON_INBOX');
  const resumed = { ...paused, ...buildResumeContextPatch() };
  assert.equal(resumed.portalBotEnabled, true);
  assert.equal(resumed.portalBotTakeoverSource, null);
});

test('runtime wiring keeps echoes out of inbound routing and guards every conversational send', () => {
  const root = path.resolve(__dirname, '..', '..');
  const webhook = fs.readFileSync(path.join(root, 'src/controllers/webhook.controller.js'), 'utf8');
  const inbound = fs.readFileSync(path.join(root, 'src/webhooks/meta.webhook.js'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8');
  const portal = fs.readFileSync(path.join(root, 'src/services/portal-inbox.service.js'), 'utf8');
  const orders = fs.readFileSync(path.join(root, 'src/services/portal-orders.service.js'), 'utf8');
  assert.match(webhook, /processSmbMessageEchoes\(payload/);
  assert.match(inbound, /smb_message_echoes'\) continue/);
  assert.ok((worker.match(/isAutomaticReplyAllowedNow\(/g) || []).length >= 4);
  assert.match(worker, /job\.type === 'conversation_operational'/);
  assert.ok(portal.indexOf('sendChannelScopedMessage') < portal.lastIndexOf('activateHumanTakeover'));
  assert.match(portal, /source: TAKEOVER_SOURCES\.OPTURON_INBOX/);
  assert.match(portal, /options\.humanInitiated !== false/);
  assert.match(portal, /humanInitiated && runtimeProvider === 'whatsapp_cloud'/);
  assert.equal((orders.match(/humanInitiated: false/g) || []).length, 2);
});
