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
  tenantId: 'tenant-1',
  clinicId: 'clinic-1',
  conversationId: 'conversation-1',
  channelId: 'channel-1',
  handoffId: 'handoff-1',
  channel: null,
  conversation: null,
  handoff: null,
  events: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildConversation(overrides = {}) {
  return {
    id: state.conversationId,
    clinicId: state.clinicId,
    channelId: state.channelId,
    status: 'closed',
    stage: 'handoff',
    state: 'READY',
    leadStatus: 'IN_CONVERSATION',
    context: {
      portalBotEnabled: false,
      somePreviousState: 'keep-me-out'
    },
    ...overrides
  };
}

function buildHandoff(overrides = {}) {
  return {
    id: state.handoffId,
    clinicId: state.clinicId,
    conversationId: state.conversationId,
    contactId: 'contact-1',
    leadId: 'lead-1',
    status: 'open',
    assignedTo: null,
    reason: 'conversation_menu_human_request',
    ...overrides
  };
}

function resetScenario({ withHandoff = true } = {}) {
  state.channel = {
    id: state.channelId,
    clinicId: state.clinicId,
    provider: 'whatsapp_cloud',
    phoneNumberId: 'phone-1',
    status: 'active',
    accessToken: 'token'
  };
  state.conversation = buildConversation();
  state.handoff = withHandoff ? buildHandoff() : null;
  state.events = [];
}

async function fakeQuery(text, params) {
  const sql = String(text || '').replace(/\s+/g, ' ').trim();

  if (sql.includes('FROM handoff_requests') && sql.includes('status IN (\'open\', \'assigned\')')) {
    const [clinicId, conversationId] = params;
    const isOpen = state.handoff && state.handoff.status && ['open', 'assigned'].includes(state.handoff.status);
    if (clinicId === state.clinicId && conversationId === state.conversationId && isOpen) {
      return { rows: [clone(state.handoff)], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  if (sql.startsWith('UPDATE handoff_requests') && sql.includes('status = \'resolved\'')) {
    const [clinicId, conversationId] = params;
    const isOpen = state.handoff && ['open', 'assigned'].includes(state.handoff.status);
    if (clinicId === state.clinicId && conversationId === state.conversationId && isOpen) {
      state.handoff.status = 'resolved';
      return {
        rows: [
          {
            id: state.handoff.id,
            clinicId: state.handoff.clinicId,
            conversationId: state.handoff.conversationId,
            status: state.handoff.status,
            reason: state.handoff.reason,
            assignedTo: state.handoff.assignedTo
          }
        ],
        rowCount: 1
      };
    }
    return { rows: [], rowCount: 0 };
  }

  if (sql.startsWith('INSERT INTO conversation_events')) {
    const [clinicId, conversationId, type, data] = params;
    const event = {
      id: `event-${state.events.length + 1}`,
      clinicId,
      conversationId,
      type,
      data: JSON.parse(data),
      createdAt: new Date().toISOString()
    };
    state.events.push(event);
    return { rows: [clone(event)], rowCount: 1 };
  }

  if (sql.startsWith('UPDATE conversations') && sql.includes('SET status = \'open\'')) {
    const [conversationId, clinicId, contextJson] = params;
    if (conversationId === state.conversationId && clinicId === state.clinicId) {
      state.conversation.status = 'open';
      state.conversation.stage = 'new';
      state.conversation.state = 'NEW';
      state.conversation.leadStatus = 'NEW';
      state.conversation.context = JSON.parse(contextJson);
      return { rows: [{ id: state.conversationId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  if (sql.startsWith('UPDATE jobs')) {
    return { rows: [], rowCount: 0 };
  }

  throw new Error(`Unexpected query: ${sql}`);
}

mockModule('src/db/client.js', { query: fakeQuery });
mockModule('src/repositories/contact.repository.js', {
  findContactByIdAndClinicId: async () => null,
  upsertContact: async () => null
});
mockModule('src/repositories/portal-users.repository.js', {
  findPortalUserByIdAndClinicId: async () => null,
  findPortalUserByNameAndClinicId: async () => null,
  listPortalUsersByClinicId: async () => []
});
mockModule('src/repositories/orders.repository.js', {
  findLatestOrderByConversationId: async () => null,
  findOrderById: async () => null
});
mockModule('src/repositories/tenant.repository.js', {
  findChannelByIdAndClinicId: async (channelId, clinicId) => {
    if (channelId === state.channelId && clinicId === state.clinicId) {
      return clone(state.channel);
    }
    return null;
  }
});
mockModule('src/conversations/conversation.repo.js', {
  getConversationByIdAndClinicId: async (conversationId, clinicId) => {
    if (conversationId === state.conversationId && clinicId === state.clinicId) {
      return clone(state.conversation);
    }
    return null;
  },
  replaceConversationStateForClinic: async ({ conversationId, clinicId, state: nextState, context }) => {
    assert.strictEqual(conversationId, state.conversationId);
    assert.strictEqual(clinicId, state.clinicId);
    state.conversation.state = nextState;
    state.conversation.context = clone(context);
  },
  updateConversationStatusForClinic: async () => null,
  assignConversationSellerForClinic: async () => null,
  reassignConversationChannelForClinic: async () => null
});
mockModule('src/whatsapp/whatsapp.service.js', {
  sendChannelScopedMessage: async () => ({})
});
mockModule('src/whatsapp/whatsapp-graph.client.js', {
  request: async () => ({ ok: false })
});
mockModule('src/services/portal-context.service.js', {
  resolvePortalTenantContext: async (tenantId) => ({
    ok: true,
    tenantId,
    clinic: {
      id: state.clinicId,
      name: 'Clinic'
    },
    channel: clone(state.channel),
    reason: 'resolved'
  })
});
mockModule('src/utils/logger.js', {
  logInfo: () => {},
  logWarn: () => {}
});
mockModule('src/utils/portal-users.js', {
  isOperationalPortalAssigneeRole: () => true
});

const { patchPortalConversation } = require(modulePath('src/services/portal-inbox.service.js'));
const { getOpenHandoff } = require(modulePath('src/repositories/handoff.repository.js'));

async function testResetConversationClosesOpenHandoff() {
  resetScenario({ withHandoff: true });

  const result = await patchPortalConversation(state.tenantId, state.conversationId, {
    action: 'reset_conversation'
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reason, 'conversation_reset');
  assert.strictEqual(state.conversation.status, 'open');
  assert.strictEqual(state.conversation.stage, 'new');
  assert.strictEqual(state.conversation.state, 'NEW');
  assert.strictEqual(state.conversation.leadStatus, 'NEW');
  assert.strictEqual(state.handoff.status, 'resolved');
  assert.strictEqual(await getOpenHandoff(state.clinicId, state.conversationId), null);
  assert.strictEqual(state.events.length, 1);
  assert.strictEqual(state.events[0].type, 'HANDOFF_RESOLVED');
  assert.strictEqual(state.events[0].data.resolutionReason, 'conversation_reset');
}

async function testToggleBotEnabledTrueClosesOpenHandoff() {
  resetScenario({ withHandoff: true });

  const result = await patchPortalConversation(state.tenantId, state.conversationId, {
    action: 'toggle_bot',
    botEnabled: true
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.conversation.context.portalBotEnabled, true);
  assert.strictEqual(state.handoff.status, 'resolved');
  assert.strictEqual(await getOpenHandoff(state.clinicId, state.conversationId), null);
  assert.strictEqual(state.events.length, 1);
  assert.strictEqual(state.events[0].type, 'HANDOFF_RESOLVED');
  assert.strictEqual(state.events[0].data.resolutionReason, 'bot_reactivated');
}

async function testToggleBotEnabledFalseKeepsOpenHandoff() {
  resetScenario({ withHandoff: true });

  const result = await patchPortalConversation(state.tenantId, state.conversationId, {
    action: 'toggle_bot',
    botEnabled: false
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.conversation.context.portalBotEnabled, false);
  assert.strictEqual(state.handoff.status, 'open');
  assert.ok(await getOpenHandoff(state.clinicId, state.conversationId));
  assert.strictEqual(state.events.length, 0);
}

async function testNoOpenHandoffRegression() {
  resetScenario({ withHandoff: false });

  const resetResult = await patchPortalConversation(state.tenantId, state.conversationId, {
    action: 'reset_conversation'
  });
  assert.strictEqual(resetResult.ok, true);
  assert.strictEqual(state.events.length, 0);
  assert.strictEqual(await getOpenHandoff(state.clinicId, state.conversationId), null);

  const toggleResult = await patchPortalConversation(state.tenantId, state.conversationId, {
    action: 'toggle_bot',
    botEnabled: true
  });
  assert.strictEqual(toggleResult.ok, true);
  assert.strictEqual(state.conversation.context.portalBotEnabled, true);
  assert.strictEqual(state.events.length, 0);
  assert.strictEqual(await getOpenHandoff(state.clinicId, state.conversationId), null);
}

async function run() {
  await testResetConversationClosesOpenHandoff();
  await testToggleBotEnabledTrueClosesOpenHandoff();
  await testToggleBotEnabledFalseKeepsOpenHandoff();
  await testNoOpenHandoffRegression();
  console.log('portal inbox handoff tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
