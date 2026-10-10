const assert = require('assert');
const path = require('path');

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

const state = {
  tenantId: 'tenant-a',
  clinicId: 'clinic-a',
  channelId: 'channel-a',
  phoneNumberId: 'phone-a',
  wabaId: 'waba-a',
  context: null,
  settings: {},
  webhookRows: [],
  messages: [],
  jobs: [],
  failures: [],
  handoffOpenCount: 0,
  handoffBlockedCount: 0,
  coexistenceRows: [],
  queries: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function activeContext() {
  return {
    ok: true,
    tenantId: state.tenantId,
    clinic: {
      id: state.clinicId,
      name: 'Tenant A'
    },
    channel: {
      id: state.channelId,
      clinicId: state.clinicId,
      provider: 'whatsapp_cloud',
      phoneNumberId: state.phoneNumberId,
      wabaId: state.wabaId,
      displayPhoneNumber: '+54 9 291 566-5793',
      verifiedName: 'Opturon',
      status: 'active',
      connectionMode: 'API_ONLY',
      accessToken: 'secret-token'
    },
    onboarding: {
      botEnabled: true
    },
    reason: 'resolved'
  };
}

function resetScenario({ withChannel = true } = {}) {
  state.context = withChannel
    ? activeContext()
    : {
        ok: true,
        tenantId: state.tenantId,
        clinic: {
          id: state.clinicId,
          name: 'Tenant A'
        },
        channel: null,
        onboarding: {
          botEnabled: false
        },
        reason: 'mapped_clinic_without_whatsapp_channel'
      };
  state.settings = {
    bot: {
      mode: 'hybrid',
      config: {
        name: 'Alma',
        greetingMessage: 'Hola, soy Alma.',
        fallbackMessage: 'No te entendi bien.'
      },
      transferConfig: {
        alias: 'hidden-but-present'
      }
    }
  };
  state.webhookRows = [];
  state.messages = [];
  state.jobs = [];
  state.failures = [];
  state.handoffOpenCount = 0;
  state.handoffBlockedCount = 0;
  state.coexistenceRows = [];
  state.queries = [];
}

function countRows(rows) {
  return { rows: [{ total: rows.length }] };
}

async function fakeQuery(text, params) {
  const sql = String(text || '').replace(/\s+/g, ' ').trim();
  state.queries.push({ sql, params });

  if (sql.startsWith('SELECT settings FROM clinics')) {
    assert.strictEqual(params[0], state.clinicId);
    return { rows: [{ settings: clone(state.settings) }] };
  }

  if (sql.includes('FROM webhook_events') && sql.includes('COUNT(*)')) {
    assert.deepStrictEqual(params[0], [state.phoneNumberId, '5492915665793']);
    return countRows(state.webhookRows);
  }

  if (sql.includes('FROM webhook_events')) {
    assert.deepStrictEqual(params[0], [state.phoneNumberId, '5492915665793']);
    return { rows: state.webhookRows.slice(0, 1).map(clone) };
  }

  if (sql.includes('FROM conversation_messages') && sql.includes('COUNT(*)') && sql.includes("m.direction = 'inbound'")) {
    assert.deepStrictEqual(params, [state.clinicId, state.channelId]);
    return countRows(state.messages.filter((item) => item.direction === 'inbound'));
  }

  if (sql.includes('FROM conversation_messages') && sql.includes('COUNT(*)') && sql.includes("m.direction = 'outbound'")) {
    assert.deepStrictEqual(params, [state.clinicId, state.channelId]);
    return countRows(state.messages.filter((item) => item.direction === 'outbound'));
  }

  if (sql.includes('FROM conversation_messages') && sql.includes("m.direction = 'inbound'")) {
    assert.deepStrictEqual(params, [state.clinicId, state.channelId]);
    return { rows: state.messages.filter((item) => item.direction === 'inbound').slice(0, 1).map(clone) };
  }

  if (sql.includes('FROM conversation_messages') && sql.includes("m.direction = 'outbound'")) {
    assert.deepStrictEqual(params, [state.clinicId, state.channelId]);
    return { rows: state.messages.filter((item) => item.direction === 'outbound').slice(0, 1).map(clone) };
  }

  if (sql.includes('FROM jobs') && sql.includes('"lastError" IS NOT NULL')) {
    assert.deepStrictEqual(params, [state.clinicId, state.channelId]);
    return { rows: state.jobs.filter((item) => item.lastError).slice(0, 1).map(clone) };
  }

  if (sql.includes('FROM jobs')) {
    assert.deepStrictEqual(params, [state.clinicId, state.channelId]);
    return { rows: state.jobs.slice(0, 1).map(clone) };
  }

  if (sql.includes('FROM inbound_failures')) {
    assert.strictEqual(params[0], state.phoneNumberId);
    return { rows: state.failures.slice(0, 1).map(clone) };
  }

  if (sql.includes('FROM handoff_requests')) {
    assert.strictEqual(params[0], state.clinicId);
    return {
      rows: [
        {
          openCount: state.handoffOpenCount,
          blockedConversationCount: state.handoffBlockedCount
        }
      ]
    };
  }

  if (sql.includes('FROM whatsapp_coexistence_channel_state')) {
    assert.deepStrictEqual(params, [state.clinicId, state.channelId]);
    return { rows: state.coexistenceRows.slice(0, 1).map(clone) };
  }

  if (sql.includes('INSERT INTO whatsapp_coexistence_channel_state')) {
    state.coexistenceRows = [{
      clinicId: params[0], channelId: params[1], isOnBizApp: params[2], platformType: params[3],
      coexistenceStatus: params[4], historySyncStatus: 'not_requested', contactsSyncStatus: 'not_requested'
    }];
    return { rows: [] };
  }

  if (sql.startsWith('UPDATE channels SET status')) return { rows: [] };

  throw new Error(`Unexpected query: ${sql}`);
}

mockModule('src/db/client.js', { query: fakeQuery });
mockModule('src/services/portal-context.service.js', {
  resolvePortalTenantContext: async (tenantId) => {
    assert.strictEqual(tenantId, state.tenantId);
    return clone(state.context);
  }
});
mockModule('src/repositories/whatsapp-onboarding.repository.js', {
  findWhatsAppChannelByClinicAndPhoneNumberId: async (clinicId, phoneNumberId) => {
    assert.strictEqual(clinicId, state.clinicId);
    assert.strictEqual(phoneNumberId, state.phoneNumberId);
    return { ...state.context.channel, accessToken: 'secret-token' };
  }
});
mockModule('src/whatsapp/whatsapp-graph.client.js', {
  request: async () => { throw new Error('unexpected_graph_client_call'); }
});

const { getPortalWhatsAppStatus } = require(modulePath('src/services/portal-whatsapp-status.service.js'));

async function testTenantWithoutChannel() {
  resetScenario({ withChannel: false });
  const result = await getPortalWhatsAppStatus(state.tenantId);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.channel.connected, false);
  assert.strictEqual(result.channel.phoneNumberId, null);
  assert.strictEqual(result.webhook.events24h, 0);
  assert.strictEqual(result.messages.inbound24h, 0);
  assert.strictEqual(result.jobs.lastConversationReply, null);
}

async function testChannelSummaryWithoutSecrets() {
  resetScenario();
  const result = await getPortalWhatsAppStatus(state.tenantId);

  assert.strictEqual(result.channel.connected, true);
  assert.strictEqual(result.channel.provider, 'whatsapp_cloud');
  assert.strictEqual(result.channel.phoneNumberId, state.phoneNumberId);
  assert.strictEqual(result.channel.wabaId, state.wabaId);
  assert.ok(!Object.prototype.hasOwnProperty.call(result.channel, 'accessToken'));
  assert.strictEqual(result.botRuntime.enabled, true);
}

async function testCoexistenceStatusRequiresCanonicalProviderFields() {
  resetScenario();
  state.context.channel.connectionMode = 'COEXISTENCE';
  state.coexistenceRows = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.hostname, 'graph.facebook.com');
    assert.equal(requestUrl.pathname, '/v25.0/phone-a');
    assert.equal(requestUrl.searchParams.get('fields'), 'is_on_biz_app,platform_type');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer secret-token');
    return { ok: true, status: 200, text: async () => JSON.stringify({ is_on_biz_app: true, platform_type: 'CLOUD_API' }) };
  };
  let result;
  try { result = await getPortalWhatsAppStatus(state.tenantId); }
  finally { global.fetch = originalFetch; }
  assert.strictEqual(result.channel.connected, true);
  assert.deepStrictEqual(result.coexistence, {
    status: 'active', isOnBizApp: true, platformType: 'CLOUD_API', phoneLast4: '5793',
    historySyncStatus: 'not_requested', contactsSyncStatus: 'not_requested',
    historyPhase: null, historyChunkOrder: null, historyProgress: null, historyStartedAt: null,
    historyUpdatedAt: null, contactsUpdatedAt: null, lastWebhookAt: null, lastEchoAt: null, lastAccountEvent: null
  });
  assert.ok(!JSON.stringify(result).includes('secret-token'));
}

async function testActivityCalculations() {
  resetScenario();
  state.webhookRows = [
    {
      id: 'webhook-1',
      receivedAt: '2026-06-12T16:42:00Z',
      eventType: 'messages',
      waMessageId: 'wamid-1',
      waFrom: '5492915275449',
      waTo: state.phoneNumberId
    }
  ];
  state.messages = [
    {
      id: 'inbound-1',
      conversationId: 'conversation-a',
      direction: 'inbound',
      waMessageId: 'wamid-1',
      text: 'TEST META DELIVERY 13:42',
      createdAt: '2026-06-12T16:42:01Z'
    },
    {
      id: 'outbound-1',
      conversationId: 'conversation-a',
      direction: 'outbound',
      waMessageId: 'wamid-2',
      text: 'Respuesta',
      createdAt: '2026-06-12T16:42:03Z'
    }
  ];
  state.jobs = [
    {
      id: 'job-1',
      type: 'conversation_reply',
      status: 'done',
      attempts: 1,
      lastError: null,
      createdAt: '2026-06-12T16:42:01Z',
      updatedAt: '2026-06-12T16:42:03Z'
    }
  ];

  const result = await getPortalWhatsAppStatus(state.tenantId);

  assert.strictEqual(result.webhook.lastReceived.id, 'webhook-1');
  assert.strictEqual(result.webhook.events24h, 1);
  assert.strictEqual(result.messages.lastInbound.textPreview, 'TEST META DELIVERY 13:42');
  assert.strictEqual(result.messages.inbound24h, 1);
  assert.strictEqual(result.messages.outbound24h, 1);
  assert.strictEqual(result.jobs.lastConversationReply.status, 'done');
}

async function testHandoffSummary() {
  resetScenario();
  state.handoffOpenCount = 2;
  state.handoffBlockedCount = 2;

  const result = await getPortalWhatsAppStatus(state.tenantId);

  assert.strictEqual(result.handoffs.openCount, 2);
  assert.strictEqual(result.handoffs.blockedConversationCount, 2);
  assert.ok(result.badges.includes('open_handoffs'));
}

async function testBotConfigSummary() {
  resetScenario();
  const result = await getPortalWhatsAppStatus(state.tenantId);

  assert.strictEqual(result.botConfig.botName, 'Alma');
  assert.strictEqual(result.botConfig.hasCustomConfig, true);
  assert.strictEqual(result.botConfig.hasCustomGreeting, true);
  assert.strictEqual(result.botConfig.hasCustomFallback, true);
}

async function testNoJobsOrEventsDoesNotCrash() {
  resetScenario();
  const result = await getPortalWhatsAppStatus(state.tenantId);

  assert.strictEqual(result.webhook.lastReceived, null);
  assert.strictEqual(result.messages.lastInbound, null);
  assert.strictEqual(result.messages.lastOutbound, null);
  assert.strictEqual(result.jobs.lastConversationReply, null);
  assert.ok(result.badges.includes('no_recent_events'));
}

async function run() {
  await testTenantWithoutChannel();
  await testChannelSummaryWithoutSecrets();
  await testCoexistenceStatusRequiresCanonicalProviderFields();
  await testActivityCalculations();
  await testHandoffSummary();
  await testBotConfigSummary();
  await testNoJobsOrEventsDoesNotCrash();
  console.log('portal whatsapp status tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
