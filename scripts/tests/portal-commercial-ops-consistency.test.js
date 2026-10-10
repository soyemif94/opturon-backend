const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const modulePath = (relativePath) => path.join(rootDir, relativePath);

const state = {
  tenantId: 'tenant-a',
  clinicId: 'clinic-a',
  conversationId: 'conversation-a',
  conversation: null,
  events: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function reset() {
  state.tenantId = 'tenant-a';
  state.clinicId = 'clinic-a';
  state.conversationId = 'conversation-a';
  state.events = [];
  state.conversation = {
    id: state.conversationId,
    clinicId: state.clinicId,
    contactId: 'contact-a',
    channelId: 'channel-a',
    assignedSellerUserId: 'seller-a',
    leadStatus: 'NEW',
    nextActionAt: null,
    nextActionNote: null,
    context: {},
    status: 'open',
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z'
  };
}

const users = {
  'clinic-a:seller-a': { id: 'seller-a', clinicId: 'clinic-a', name: 'Seller A', role: 'seller' },
  'clinic-a:seller-b': { id: 'seller-b', clinicId: 'clinic-a', name: 'Seller B', role: 'seller' },
  'clinic-a:supervisor-a': { id: 'supervisor-a', clinicId: 'clinic-a', name: 'Supervisor A', role: 'manager' },
  'clinic-b:seller-b': { id: 'seller-b', clinicId: 'clinic-b', name: 'Seller B', role: 'seller' }
};

function mockModule(relativePath, exportsValue) {
  const fullPath = modulePath(relativePath);
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports: exportsValue };
}

const client = { query: async () => ({ rows: [], rowCount: 0 }) };
mockModule('src/db/client.js', {
  query: async () => ({ rows: [], rowCount: 0 }),
  withTransaction: async (fn) => fn(client)
});
mockModule('src/repositories/contact.repository.js', {
  findContactByIdAndClinicId: async () => null,
  upsertContact: async () => null
});
mockModule('src/repositories/conversation-events.repository.js', {
  addEvent: async (event) => {
    const stored = { id: `event-${state.events.length + 1}`, ...clone(event), createdAt: new Date().toISOString() };
    state.events.push(stored);
    return stored;
  },
  listEvents: async (clinicId, conversationId) =>
    state.events.filter((event) => event.clinicId === clinicId && event.conversationId === conversationId).reverse()
});
mockModule('src/repositories/portal-users.repository.js', {
  findPortalUserByIdAndClinicId: async (userId, clinicId) => clone(users[`${clinicId}:${userId}`] || null),
  findPortalUserByNameAndClinicId: async () => null,
  listPortalUsersByClinicId: async () => []
});
mockModule('src/repositories/orders.repository.js', {
  findLatestOrderByConversationId: async () => null,
  findOrderById: async () => null
});
mockModule('src/repositories/tenant.repository.js', { findChannelByIdAndClinicId: async () => null });
mockModule('src/repositories/handoff.repository.js', {
  getOpenHandoff: async () => null,
  resolveOpenHandoffByConversation: async () => null
});
mockModule('src/conversations/conversation.repo.js', {
  getConversationByIdAndClinicId: async (conversationId, clinicId) =>
    conversationId === state.conversationId && clinicId === state.conversation.clinicId ? clone(state.conversation) : null,
  getConversationCommercialStateForUpdate: async ({ conversationId, clinicId }, tx) => {
    assert.strictEqual(tx, client, 'commercial writes use a transaction client');
    return conversationId === state.conversationId && clinicId === state.conversation.clinicId ? clone(state.conversation) : null;
  },
  assignConversationSellerForClinic: async ({ conversationId, clinicId, sellerUserId, expectedSellerUserId, contextPatch }) => {
    if (conversationId !== state.conversationId || clinicId !== state.conversation.clinicId) return null;
    if ((state.conversation.assignedSellerUserId || null) !== (expectedSellerUserId || null)) return null;
    state.conversation.assignedSellerUserId = sellerUserId;
    state.conversation.context = { ...state.conversation.context, ...contextPatch };
    state.conversation.updatedAt = new Date().toISOString();
    return clone(state.conversation);
  },
  updateConversationFollowUpForClinic: async ({ conversationId, clinicId, patch }) => {
    if (conversationId !== state.conversationId || clinicId !== state.conversation.clinicId) return null;
    Object.assign(state.conversation, patch, { updatedAt: new Date().toISOString() });
    return clone(state.conversation);
  },
  replaceConversationStateForClinic: async () => null,
  updateConversationStatusForClinic: async () => null,
  updateConversationLeadStatusForClinic: async () => null,
  reassignConversationChannelForClinic: async () => null,
  listConversationMessagesByClinicId: async () => []
});
mockModule('src/repositories/order-closure.repository.js', { invalidatePendingForMessage: async () => 0, invalidatePendingForHumanSend: async () => 0 });
mockModule('src/repositories/order-amendment.repository.js', { invalidateForMessage: async () => 0, invalidateForHumanSend: async () => 0 });
mockModule('src/conversations/human-takeover.service.js', {
  TAKEOVER_SOURCES: {},
  buildTakeoverContextPatch: () => ({}),
  buildResumeContextPatch: () => ({}),
  activateHumanTakeover: async () => ({})
});
mockModule('src/integrations/instagram/instagram.service.js', { sendInstagramTextMessage: async () => ({}) });
mockModule('src/whatsapp/whatsapp.service.js', { sendChannelScopedMessage: async () => ({}) });
mockModule('src/whatsapp/whatsapp-graph.client.js', { request: async () => ({ ok: false }) });
mockModule('src/services/portal-context.service.js', {
  resolvePortalTenantContext: async (tenantId) => ({
    ok: true,
    tenantId,
    clinic: { id: tenantId === 'tenant-a' ? 'clinic-a' : 'clinic-b', name: 'Test Clinic' },
    channel: null,
    reason: 'resolved'
  })
});
mockModule('src/utils/logger.js', { logInfo: () => {}, logWarn: () => {} });
mockModule('src/utils/portal-users.js', { isOperationalPortalAssigneeRole: () => true });
mockModule('src/services/handoff-summary.service.js', { getOwnedHandoffSummary: () => null });
mockModule('src/integrations/instagram/instagram-profile.service.js', {
  formatInstagramUsername: () => null,
  normalizeInstagramProfileSnapshot: () => ({})
});
mockModule('src/services/whatsapp-customer-service-window.service.js', { evaluateCustomerServiceWindow: () => ({}) });

const service = require(modulePath('src/services/portal-inbox.service.js'));

async function testReassignmentIsAtomicAndDoesNotChangeCommercialStage() {
  reset();
  const result = await service.assignPortalConversationSeller(
    state.tenantId,
    state.conversationId,
    { sellerUserId: 'seller-b' },
    { actorUserId: 'supervisor-a' }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.conversation.assignedSellerUserId, 'seller-b');
  assert.strictEqual(state.conversation.leadStatus, 'NEW', 'assignment must not fabricate commercial activity');
  assert.strictEqual(state.events.length, 1);
  assert.strictEqual(state.events[0].type, 'seller_reassigned');
  assert.strictEqual(state.events[0].data.fromSellerId, 'seller-a');
  assert.strictEqual(state.events[0].data.toSellerId, 'seller-b');
  assert.strictEqual(state.events[0].data.changedBy, 'supervisor-a');
  assert.ok(state.events[0].createdAt, 'assignment history has a database event timestamp');
}

async function testSameSellerRecoveryIsDurableAndDoesNotChangeStage() {
  reset();
  const result = await service.assignPortalConversationSeller(
    state.tenantId,
    state.conversationId,
    { sellerUserId: 'seller-a', startRecovery: true },
    { actorUserId: 'supervisor-a' }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reason, 'recovery_started');
  assert.strictEqual(state.conversation.assignedSellerUserId, 'seller-a');
  assert.strictEqual(state.conversation.leadStatus, 'NEW');
  assert.strictEqual(state.events.length, 1);
  assert.strictEqual(state.events[0].type, 'recovery_started');
  assert.strictEqual(state.events[0].clinicId, 'clinic-a');
  assert.strictEqual(state.events[0].data.sellerId, 'seller-a');
  assert.strictEqual(state.events[0].data.changedBy, 'supervisor-a');
  assert.strictEqual(state.events[0].data.source, 'ops');
  assert.ok(state.events[0].createdAt);
}

async function testSellerCannotReassignAnotherSellerButCanClaimUnassignedLead() {
  reset();
  const forbidden = await service.assignPortalConversationSeller(
    state.tenantId,
    state.conversationId,
    { sellerUserId: 'seller-b' },
    { actorUserId: 'seller-a' }
  );
  assert.strictEqual(forbidden.ok, false);
  assert.strictEqual(forbidden.reason, 'assignment_forbidden');
  assert.strictEqual(state.conversation.assignedSellerUserId, 'seller-a');
  assert.strictEqual(state.events.length, 0);

  state.conversation.assignedSellerUserId = null;
  const claimed = await service.assignPortalConversationSeller(
    state.tenantId,
    state.conversationId,
    { sellerUserId: 'seller-b' },
    { actorUserId: 'seller-b' }
  );
  assert.strictEqual(claimed.ok, true);
  assert.strictEqual(state.conversation.assignedSellerUserId, 'seller-b');
  assert.strictEqual(state.conversation.leadStatus, 'NEW');
  assert.strictEqual(state.events.length, 1);
  assert.strictEqual(state.events[0].type, 'seller_assigned');
}

async function testInboxFollowUpAndNoteAreRecordedWithActor() {
  reset();
  const followUpAt = '2026-10-20T17:30:00.000Z';
  const result = await service.patchPortalConversationNextAction(
    state.tenantId,
    state.conversationId,
    { nextActionAt: followUpAt, nextActionNote: 'Llamar y revisar propuesta' },
    { actorUserId: 'supervisor-a' }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.conversation.nextActionAt, followUpAt);
  assert.strictEqual(state.conversation.nextActionNote, 'Llamar y revisar propuesta');
  assert.deepStrictEqual(state.events.map((event) => event.type), [
    'commercial_follow_up_updated',
    'commercial_note_updated'
  ]);
  assert.strictEqual(state.events[0].data.followUpAt, followUpAt);
  assert.strictEqual(state.events[1].data.text, 'Llamar y revisar propuesta');
  assert.ok(state.events.every((event) => event.data.changedBy === 'supervisor-a'));
}

async function testOtherTenantCannotReadOrWriteCommercialState() {
  reset();
  const result = await service.patchPortalConversationNextAction(
    'tenant-b',
    state.conversationId,
    { nextActionAt: '2026-10-20T17:30:00.000Z' },
    { actorUserId: 'supervisor-a' }
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'conversation_not_found');
  assert.strictEqual(state.conversation.nextActionAt, null);
  assert.strictEqual(state.events.length, 0);
}

async function testFollowUpCompletionIsAnAuditedCanonicalTransition() {
  reset();
  state.conversation.nextActionAt = '2026-10-10T10:00:00.000Z';
  state.conversation.nextActionNote = 'Contactar por renovación';
  const result = await service.patchPortalConversationNextAction(
    state.tenantId,
    state.conversationId,
    { completed: true },
    { actorUserId: 'supervisor-a' }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.conversation.nextActionAt, null);
  assert.strictEqual(state.conversation.nextActionNote, 'Contactar por renovación');
  assert.strictEqual(state.events.length, 1);
  assert.strictEqual(state.events[0].type, 'commercial_follow_up_completed');
  assert.strictEqual(state.events[0].data.previousFollowUpAt, '2026-10-10T10:00:00.000Z');
  assert.strictEqual(state.events[0].data.changedBy, 'supervisor-a');
}

function testInboxAndOpsShareTenantScopedCommercialEvents() {
  const source = fs.readFileSync(modulePath('src/services/portal-inbox.service.js'), 'utf8');
  assert.match(source, /event\."clinicId" = c\."clinicId"/);
  assert.match(source, /event\."conversationId" = c\.id/);
  assert.match(source, /commercial\."commercialTimeline" AS "commercialTimeline"/);
  assert.match(source, /commercialActivity\."lastCommercialActivityAt"/);
  assert.match(source, /event\.type IN \('seller_assigned', 'seller_reassigned', 'recovery_started', 'commercial_follow_up_updated', 'commercial_follow_up_completed', 'commercial_note_updated'\)/);
  assert.match(source, /lastCommercialActivityAt: assignment\.events\?\.\[assignment\.events\.length - 1\]\?\.createdAt/);
  assert.match(source, /"nextActionAt" AS "nextActionAt"/);
  assert.match(source, /"assignedSellerUserId" AS "assignedSellerUserId"/);
  const routes = fs.readFileSync(modulePath('src/routes/portal.routes.js'), 'utf8');
  assert.match(routes, /assign-seller', inboxModule, requirePortalCapability\('sellers'\)/);
  const controller = fs.readFileSync(modulePath('src/controllers/portal.controller.js'), 'utf8');
  assert.match(controller, /actorUserId: req\.get\('x-portal-actor-id'\) \|\| null/);
}

(async () => {
  await testReassignmentIsAtomicAndDoesNotChangeCommercialStage();
  await testSameSellerRecoveryIsDurableAndDoesNotChangeStage();
  await testSellerCannotReassignAnotherSellerButCanClaimUnassignedLead();
  await testInboxFollowUpAndNoteAreRecordedWithActor();
  await testFollowUpCompletionIsAnAuditedCanonicalTransition();
  await testOtherTenantCannotReadOrWriteCommercialState();
  testInboxAndOpsShareTenantScopedCommercialEvents();
  console.log('portal-commercial-ops-consistency.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
