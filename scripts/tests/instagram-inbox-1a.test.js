const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..', '..');

function modulePath(relativePath) {
  return path.join(rootDir, relativePath);
}

function mockModule(relativePath, exportsValue) {
  const fullPath = modulePath(relativePath);
  require.cache[fullPath] = {
    id: fullPath,
    filename: fullPath,
    loaded: true,
    exports: exportsValue
  };
}

function clearModule(relativePath) {
  delete require.cache[modulePath(relativePath)];
}

const state = {
  clinicId: 'clinic-1',
  instagramChannel: {
    id: 'channel-ig-1',
    clinicId: 'clinic-1',
    type: 'instagram',
    provider: 'instagram_graph',
    externalId: 'ig-business-1',
    externalPageId: 'page-1',
    instagramUserId: 'ig-business-1',
    instagramUsername: 'opturon.qa',
    status: 'active'
  },
  whatsappChannel: {
    id: 'channel-wa-1',
    clinicId: 'clinic-1',
    type: 'whatsapp',
    provider: 'whatsapp_cloud',
    phoneNumberId: 'phone-1',
    status: 'active'
  },
  contacts: new Map(),
  conversations: new Map(),
  insertedMessageIds: new Set(),
  inboundMessages: [],
  jobs: []
};

function resetState() {
  state.contacts = new Map();
  state.conversations = new Map();
  state.insertedMessageIds = new Set();
  state.inboundMessages = [];
  state.jobs = [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

mockModule('src/repositories/tenant.repository.js', {
  findInstagramChannelByExternalId: async (externalId) =>
    externalId === state.instagramChannel.externalId ? clone(state.instagramChannel) : null,
  findInstagramChannelByPageId: async (pageId) =>
    pageId === state.instagramChannel.externalPageId ? clone(state.instagramChannel) : null,
  findChannelByPhoneNumberId: async (phoneNumberId) =>
    phoneNumberId === state.whatsappChannel.phoneNumberId ? clone(state.whatsappChannel) : null
});

mockModule('src/repositories/contact.repository.js', {
  upsertContact: async ({ clinicId, waId, phone, name }) => {
    const key = `${clinicId}:${waId}`;
    if (!state.contacts.has(key)) {
      state.contacts.set(key, {
        id: `contact-${state.contacts.size + 1}`,
        clinicId,
        waId,
        phone,
        name
      });
    }
    return clone(state.contacts.get(key));
  }
});

mockModule('src/db/client.js', {
  withTransaction: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) })
});

mockModule('src/conversations/conversation.repo.js', {
  findInboundMessageByProviderId: async (waMessageId) => {
    const row = state.inboundMessages.find((message) => message.waMessageId === waMessageId);
    return row ? clone(row) : null;
  },
  upsertConversation: async ({ waFrom, waTo, clinicId, channelId, contactId }) => {
    const key = `${clinicId}:${channelId}:${waFrom}:${waTo}`;
    if (!state.conversations.has(key)) {
      state.conversations.set(key, {
        id: `conversation-${state.conversations.size + 1}`,
        waFrom,
        waTo,
        clinicId,
        channelId,
        contactId
      });
    }
    return clone(state.conversations.get(key));
  },
  insertInboundMessage: async (record) => {
    if (!record.waMessageId) return { inserted: false, row: null, reason: 'missing_waMessageId' };
    if (state.insertedMessageIds.has(record.waMessageId)) {
      return {
        inserted: false,
        row: state.inboundMessages.find((message) => message.waMessageId === record.waMessageId) || null,
        reason: 'duplicate_waMessageId'
      };
    }

    const row = {
      id: `message-${state.inboundMessages.length + 1}`,
      ...record,
      createdAt: new Date().toISOString()
    };
    state.insertedMessageIds.add(record.waMessageId);
    state.inboundMessages.push(row);
    return { inserted: true, row: clone(row), reason: 'inserted' };
  },
  enqueueJob: async (type, payload) => {
    const row = { id: `job-${state.jobs.length + 1}`, type, payload };
    state.jobs.push(row);
    return clone(row);
  }
});

mockModule('src/utils/logger.js', {
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {}
});

clearModule('src/conversations/conversation.service.js');
const { processInboundMessages } = require(modulePath('src/conversations/conversation.service.js'));

function buildInstagramPayload(mid = 'ig-mid-1') {
  return {
    object: 'instagram',
    entry: [
      {
        id: 'page-1',
        messaging: [
          {
            sender: { id: 'ig-user-1' },
            recipient: { id: 'ig-business-1' },
            timestamp: Date.now(),
            message: {
              mid,
              text: 'Hola desde Instagram'
            }
          }
        ]
      }
    ]
  };
}

function buildWhatsAppPayload(id = 'wamid-1') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'phone-1', display_phone_number: '5491111111111' },
              contacts: [{ wa_id: '5491199999999', profile: { name: 'Cliente WA' } }],
              messages: [{ id, from: '5491199999999', type: 'text', text: { body: 'Hola' } }]
            }
          }
        ]
      }
    ]
  };
}

async function testInstagramInboundCreatesMessageAndDoesNotEnqueueReply() {
  resetState();
  const result = await processInboundMessages({
    body: buildInstagramPayload(),
    headers: {},
    requestId: 'test-instagram'
  });

  assert.deepStrictEqual(result, {
    received: 1,
    enqueued: 0,
    duplicates: 0,
    unrouted: 0,
    ignoredMissingWaMessageId: 0
  });
  assert.strictEqual(state.inboundMessages.length, 1);
  assert.strictEqual(state.inboundMessages[0].waMessageId, 'ig-mid-1');
  assert.strictEqual(state.inboundMessages[0].from, 'ig-user-1');
  assert.strictEqual(state.jobs.length, 0);
}

async function testInstagramInboundDedupeByMid() {
  resetState();
  await processInboundMessages({ body: buildInstagramPayload('ig-mid-duplicate'), headers: {}, requestId: 'first' });
  const result = await processInboundMessages({ body: buildInstagramPayload('ig-mid-duplicate'), headers: {}, requestId: 'second' });

  assert.strictEqual(result.received, 1);
  assert.strictEqual(result.duplicates, 1);
  assert.strictEqual(result.enqueued, 0);
  assert.strictEqual(state.inboundMessages.length, 1);
  assert.strictEqual(state.jobs.length, 0);
}

async function testWhatsAppInboundStillEnqueuesReply() {
  resetState();
  const result = await processInboundMessages({
    body: buildWhatsAppPayload(),
    headers: {},
    requestId: 'test-whatsapp'
  });

  assert.strictEqual(result.received, 1);
  assert.strictEqual(result.enqueued, 1);
  assert.strictEqual(result.duplicates, 0);
  assert.strictEqual(state.jobs.length, 1);
  assert.strictEqual(state.jobs[0].type, 'conversation_reply');
}

function testInboxSourceExposesChannelFilteringAndReadOnlyGuard() {
  const serviceSource = fs.readFileSync(modulePath('src/services/portal-inbox.service.js'), 'utf8');
  const controllerSource = fs.readFileSync(modulePath('src/controllers/portal.controller.js'), 'utf8');

  assert.match(serviceSource, /function normalizeInboxChannelFilter/);
  assert.match(serviceSource, /ch\.type AS "channelType"/);
  assert.match(serviceSource, /channelFilterClause/);
  assert.match(serviceSource, /conversation_channel_read_only/);
  assert.match(controllerSource, /req\.query\.channel/);
  assert.match(controllerSource, /listPortalConversations\(tenantId, \{ visibility, channel \}\)/);
}

async function run() {
  await testInstagramInboundCreatesMessageAndDoesNotEnqueueReply();
  await testInstagramInboundDedupeByMid();
  await testWhatsAppInboundStillEnqueuesReply();
  testInboxSourceExposesChannelFilteringAndReadOnlyGuard();
  console.log('instagram-inbox-1a.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
