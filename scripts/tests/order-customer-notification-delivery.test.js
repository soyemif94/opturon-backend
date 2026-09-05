const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  processOrderCustomerNotification,
  recoverOrderCustomerNotificationInbox,
  processAvailableOrderCustomerNotifications,
  classifySendFailure
} = require('../../src/services/order-customer-notification-processor.service');
const {
  formatOrderCustomerSummary
} = require('../../src/services/order-customer-summary-formatter.service');
const {
  buildOrderCustomerNotificationSnapshot
} = require('../../src/services/order-customer-notifications.service');
const {
  evaluateCustomerServiceWindow
} = require('../../src/services/whatsapp-customer-service-window.service');
const {
  reconcileOrderCustomerNotificationStatuses
} = require('../../src/services/order-customer-notification-status.service');
const {
  CAPABILITY_STATUSES,
  buildTenantCapabilitySnapshot,
  resolveCapability
} = require('../../src/services/capability-resolver.service');

const root = path.resolve(__dirname, '..', '..');
const NOW = '2026-08-10T12:00:00.000Z';
const IDS = Object.freeze({
  clinicA: '11111111-1111-1111-1111-111111111111',
  clinicB: '11111111-1111-1111-1111-222222222222',
  contactA: '22222222-2222-2222-2222-222222222222',
  contactB: '22222222-2222-2222-2222-333333333333',
  channelA: '33333333-3333-3333-3333-333333333333',
  channelA2: '33333333-3333-3333-3333-444444444444',
  channelB: '33333333-3333-3333-3333-555555555555',
  conversationA: '44444444-4444-4444-4444-444444444444',
  conversationA2: '44444444-4444-4444-4444-555555555555',
  orderA: '55555555-5555-5555-5555-555555555555',
  notificationA: '66666666-6666-6666-6666-666666666666'
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function buildSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    notificationType: 'order_summary',
    orderId: IDS.orderA,
    clinicId: IDS.clinicA,
    contactId: IDS.contactA,
    conversationId: IDS.conversationA,
    currency: 'ARS',
    items: [
      {
        description: 'Resina epoxi',
        sku: 'RES-1',
        variant: 'Transparente',
        quantity: 2,
        unitPrice: 1000,
        lineSubtotal: 2000,
        taxRate: 21,
        taxAmount: 420,
        lineTotal: 2420
      }
    ],
    subtotal: 2000,
    tax: 420,
    total: 2420,
    payment: { status: 'pending', method: null, destination: null },
    finalizedAt: '2026-08-10T10:00:00.000Z',
    finalizationVersion: 1,
    ...overrides
  };
}

function buildHarness(overrides = {}) {
  const clinicA = {
    id: IDS.clinicA,
    externalTenantId: 'tenant-a',
    settings: {
      orderCustomerNotificationEnabled: true,
      orderCustomerNotification: { templateLanguage: 'es_AR' },
      bot: {}
    },
    ...(overrides.clinic || {})
  };
  const contactA = {
    id: IDS.contactA,
    clinicId: IDS.clinicA,
    waId: '5491112345678',
    phone: '5491112345678',
    name: 'Maria',
    status: 'active',
    archivedAt: null,
    deletedAt: null,
    optedOut: false,
    ...(overrides.contact || {})
  };
  const channelA = {
    id: IDS.channelA,
    clinicId: IDS.clinicA,
    provider: 'whatsapp_cloud',
    type: 'whatsapp',
    status: 'active',
    phoneNumberId: 'phone-a',
    displayPhoneNumber: '5491100000000',
    wabaId: 'waba-a',
    accessToken: 'fixture-channel-token-a',
    ...(overrides.channel || {})
  };
  const conversationA = {
    id: IDS.conversationA,
    clinicId: IDS.clinicA,
    channelId: IDS.channelA,
    contactId: IDS.contactA,
    waFrom: '5491112345678',
    waTo: '5491100000000',
    status: 'open',
    lastInboundAt: '2026-08-10T11:00:00.000Z',
    ...(overrides.conversation || {})
  };
  const orderA = {
    id: IDS.orderA,
    clinicId: IDS.clinicA,
    contactId: IDS.contactA,
    conversationId: IDS.conversationA,
    status: 'confirmed',
    finalizedAt: '2026-08-10T10:00:00.000Z',
    finalizationVersion: 1,
    ...(overrides.order || {})
  };
  const notificationA = {
    id: IDS.notificationA,
    clinicId: IDS.clinicA,
    orderId: IDS.orderA,
    contactId: IDS.contactA,
    conversationId: IDS.conversationA,
    channelId: null,
    notificationType: 'order_summary',
    finalizationVersion: 1,
    idempotencyKey: `order_summary:${IDS.clinicA}:${IDS.orderA}:v1`,
    status: 'sending',
    resultCode: null,
    snapshot: buildSnapshot(),
    attemptCount: 1,
    availableAt: NOW,
    lockedAt: NOW,
    lockedBy: 'worker-a',
    leaseExpiresAt: '2026-08-10T12:02:00.000Z',
    graphRequestStartedAt: null,
    providerMessageId: null,
    errorMetadata: {},
    ...(overrides.notification || {})
  };

  const state = {
    clinics: [clinicA, ...(overrides.extraClinics || [])],
    contacts: [...(overrides.omitDefaultContact ? [] : [contactA]), ...(overrides.extraContacts || [])],
    channels: [channelA, ...(overrides.extraChannels || [])],
    conversations: [conversationA, ...(overrides.extraConversations || [])],
    orders: [orderA, ...(overrides.extraOrders || [])],
    notifications: new Map([[notificationA.id, clone(notificationA)]]),
    inboundAt: new Map([[conversationA.id, overrides.lastInboundAt === undefined
      ? '2026-08-10T11:00:00.000Z'
      : overrides.lastInboundAt]]),
    template: overrides.template || null,
    graphCalls: [],
    graphBoundaryCalls: [],
    events: [],
    leaseRecoveries: [],
    sendQueue: Array.isArray(overrides.sendQueue) ? [...overrides.sendQueue] : [],
    inbox: [],
    inboxFailuresRemaining: Number(overrides.inboxFailures || 0),
    scopeCalls: []
  };

  const deps = {
    findOrderById: async (orderId, clinicId) => {
      state.scopeCalls.push(['order', orderId, clinicId]);
      return clone(state.orders.find((item) => item.id === orderId && item.clinicId === clinicId) || null);
    },
    getClinicById: async (clinicId) => clone(state.clinics.find((item) => item.id === clinicId) || null),
    findContactByIdAndClinicId: async (contactId, clinicId) => {
      state.scopeCalls.push(['contact', contactId, clinicId]);
      return clone(state.contacts.find((item) => item.id === contactId && item.clinicId === clinicId) || null);
    },
    listWhatsAppChannelsByClinicId: async (clinicId) => {
      state.scopeCalls.push(['channels', clinicId]);
      return clone(state.channels.filter((item) => item.clinicId === clinicId && item.provider === 'whatsapp_cloud'));
    },
    getConversationByIdAndClinicId: async (conversationId, clinicId) => clone(
      state.conversations.find((item) => item.id === conversationId && item.clinicId === clinicId) || null
    ),
    listConversationsByContactIdAndClinicId: async (contactId, clinicId) => clone(
      state.conversations.filter((item) => item.contactId === contactId && item.clinicId === clinicId)
    ),
    findLastInboundAtForConversationScope: async ({ conversationId, clinicId, channelId, contactId }) => {
      const conversation = state.conversations.find((item) => (
        item.id === conversationId &&
        item.clinicId === clinicId &&
        item.channelId === channelId &&
        item.contactId === contactId
      ));
      return conversation ? state.inboundAt.get(conversationId) || null : null;
    },
    findApprovedUtilityOrderSummaryTemplate: async ({ clinicId, channelId, wabaId, language }) => {
      const template = state.template;
      return template &&
        template.clinicId === clinicId &&
        template.channelId === channelId &&
        template.wabaId === wabaId &&
        template.language === language
        ? clone(template)
        : null;
    },
    updateRouting: async (notificationId, clinicId, patch) => {
      const current = state.notifications.get(notificationId);
      if (!current || current.clinicId !== clinicId || current.status !== 'sending' || current.lockedBy !== patch.lockedBy) {
        return null;
      }
      current.conversationId = patch.conversationId;
      current.channelId = patch.channelId;
      return clone(current);
    },
    markGraphRequestStarted: async (notificationId, clinicId, patch) => {
      if (overrides.graphBoundaryError) throw overrides.graphBoundaryError;
      const current = state.notifications.get(notificationId);
      if (
        !current ||
        current.clinicId !== clinicId ||
        current.status !== 'sending' ||
        current.lockedBy !== patch.lockedBy ||
        !current.leaseExpiresAt ||
        new Date(current.leaseExpiresAt).getTime() <= new Date(NOW).getTime() ||
        current.graphRequestStartedAt ||
        current.providerMessageId
      ) {
        return null;
      }
      current.graphRequestStartedAt = patch.startedAt;
      state.graphBoundaryCalls.push({ notificationId, clinicId, ...clone(patch) });
      state.events.push('graph_boundary_committed');
      return clone(current);
    },
    updateStatus: async (notificationId, clinicId, patch) => {
      const current = state.notifications.get(notificationId);
      if (!current || current.clinicId !== clinicId) return null;
      if (patch.expectedLockedBy && current.lockedBy !== patch.expectedLockedBy) return null;
      if (patch.status === 'sent' && overrides.failSentPersistenceOnce) {
        overrides.failSentPersistenceOnce = false;
        throw new Error('simulated_sent_state_persistence_failure');
      }
      current.status = patch.status;
      if (Object.prototype.hasOwnProperty.call(patch, 'resultCode')) current.resultCode = patch.resultCode;
      if (Object.prototype.hasOwnProperty.call(patch, 'providerMessageId')) current.providerMessageId = patch.providerMessageId;
      if (Object.prototype.hasOwnProperty.call(patch, 'lastError')) current.lastError = patch.lastError;
      if (Object.prototype.hasOwnProperty.call(patch, 'availableAt')) current.availableAt = patch.availableAt;
      if (patch.sentAt) current.sentAt = patch.sentAt;
      if (patch.deliveredAt) current.deliveredAt = patch.deliveredAt;
      if (patch.readAt) current.readAt = patch.readAt;
      if (patch.errorMetadata) current.errorMetadata = { ...(current.errorMetadata || {}), ...clone(patch.errorMetadata) };
      if (patch.status !== 'sending') {
        current.lockedAt = null;
        current.lockedBy = null;
        current.leaseExpiresAt = null;
      }
      return clone(current);
    },
    mergeMetadata: async (notificationId, clinicId, metadata) => {
      const current = state.notifications.get(notificationId);
      if (!current || current.clinicId !== clinicId) return null;
      if (overrides.statusBeforeMetadataMerge) {
        current.status = overrides.statusBeforeMetadataMerge;
        overrides.statusBeforeMetadataMerge = null;
      }
      current.errorMetadata = { ...(current.errorMetadata || {}), ...clone(metadata) };
      return clone(current);
    },
    sendChannelScopedMessage: async (payload, context) => {
      const current = state.notifications.get(IDS.notificationA);
      assert.ok(current.graphRequestStartedAt, 'Graph must not run before the durable boundary is persisted.');
      state.events.push('graph_request');
      state.graphCalls.push({ payload: clone(payload), context: clone(context) });
      const next = state.sendQueue.length ? state.sendQueue.shift() : { messageId: `wamid-${state.graphCalls.length}`, status: 200 };
      if (next instanceof Error) throw next;
      return clone(next);
    },
    insertOutboundMessage: async (record) => {
      if (state.inboxFailuresRemaining > 0) {
        state.inboxFailuresRemaining -= 1;
        throw new Error('simulated_inbox_failure');
      }
      const existing = state.inbox.find((item) => item.waMessageId === record.waMessageId);
      if (existing) return { inserted: false, row: clone(existing), reason: 'duplicate_waMessageId' };
      const row = { id: `inbox-${state.inbox.length + 1}`, ...clone(record), createdAt: NOW };
      state.inbox.push(row);
      return { inserted: true, row: clone(row) };
    },
    listInboxRecovery: async (limit) => Array.from(state.notifications.values())
      .filter((item) => (
        ['sent', 'delivered', 'read', 'unknown_delivery'].includes(item.status) &&
        item.providerMessageId &&
        !state.inbox.some((message) => (
          message.waMessageId === item.providerMessageId && message.conversationId === item.conversationId
        ))
      ))
      .slice(0, limit)
      .map(clone),
    claimNotifications: async ({ workerId, limit, maxAttempts = 5 }) => {
      for (const current of state.notifications.values()) {
        if (
          current.status !== 'sending' ||
          !current.leaseExpiresAt ||
          new Date(current.leaseExpiresAt).getTime() > new Date(NOW).getTime()
        ) {
          continue;
        }

        if (current.providerMessageId) {
          current.status = 'sent';
          current.resultCode = current.resultCode || 'graph_accepted_inbox_pending';
          current.sentAt = current.sentAt || current.graphRequestStartedAt || NOW;
          state.leaseRecoveries.push('provider_message_known');
        } else if (current.graphRequestStartedAt) {
          current.status = 'unknown_delivery';
          current.resultCode = 'lease_expired_post_graph_ambiguous';
          state.leaseRecoveries.push('post_graph_ambiguous');
        } else {
          current.status = 'failed_retryable';
          current.resultCode = 'lease_expired_pre_graph_retryable';
          current.availableAt = NOW;
          state.leaseRecoveries.push('pre_graph_retryable');
        }
        current.lockedBy = null;
        current.lockedAt = null;
        current.leaseExpiresAt = null;
      }

      for (const current of state.notifications.values()) {
        if (
          current.status === 'failed_retryable' &&
          current.attemptCount >= maxAttempts &&
          new Date(current.availableAt).getTime() <= new Date(NOW).getTime()
        ) {
          current.status = 'failed_permanent';
          current.resultCode = 'retry_attempts_exhausted';
        }
      }

      const claimed = [];
      for (const current of state.notifications.values()) {
        if (claimed.length >= limit) break;
        if (!['pending', 'failed_retryable'].includes(current.status)) continue;
        if (new Date(current.availableAt).getTime() > new Date(NOW).getTime()) continue;
        current.status = 'sending';
        current.resultCode = null;
        current.attemptCount += 1;
        current.lockedBy = workerId;
        current.lockedAt = NOW;
        current.leaseExpiresAt = '2026-08-10T12:02:00.000Z';
        current.graphRequestStartedAt = null;
        claimed.push(clone(current));
      }
      return claimed;
    }
  };

  return { state, deps, notification: clone(notificationA) };
}

async function runOne(harness) {
  return processOrderCustomerNotification(harness.notification, {
    dependencies: harness.deps,
    now: NOW
  });
}

async function testHappyPathAndWindow() {
  const harness = buildHarness();
  const result = await runOne(harness);
  assert.strictEqual(result.outcome, 'sent');
  assert.strictEqual(harness.state.notifications.get(IDS.notificationA).status, 'sent');
  assert.strictEqual(harness.state.notifications.get(IDS.notificationA).resultCode, 'graph_accepted');
  assert.ok(harness.state.notifications.get(IDS.notificationA).providerMessageId);
  assert.ok(harness.state.notifications.get(IDS.notificationA).graphRequestStartedAt);
  assert.deepStrictEqual(harness.state.events, ['graph_boundary_committed', 'graph_request']);
  assert.strictEqual(harness.state.graphBoundaryCalls.length, 1);
  assert.strictEqual(harness.state.graphCalls.length, 1);
  assert.strictEqual(harness.state.graphCalls[0].payload.templateName, undefined);
  assert.strictEqual(harness.state.inbox.length, 1);
  assert.strictEqual(harness.state.inbox[0].clinicId, IDS.clinicA);
  assert.strictEqual(harness.state.inbox[0].channelId, IDS.channelA);
  assert.strictEqual(harness.state.inbox[0].to, '541112345678');
  assert.strictEqual(harness.state.inbox[0].raw.transactionalNotification.notificationType, 'order_summary');
  assert.strictEqual(evaluateCustomerServiceWindow({ lastInboundAt: '2026-08-09T12:00:00.000Z', now: NOW }).allowed, false);
  assert.strictEqual(evaluateCustomerServiceWindow({ lastInboundAt: '2026-08-09T11:59:59.000Z', now: NOW }).allowed, false);
}

async function testDoubleWorkerClaim() {
  const harness = buildHarness({ notification: { status: 'pending', lockedAt: null, lockedBy: null, leaseExpiresAt: null, attemptCount: 0 } });
  await Promise.all([
    processAvailableOrderCustomerNotifications({ workerId: 'worker-a', limit: 1, dependencies: harness.deps, now: NOW }),
    processAvailableOrderCustomerNotifications({ workerId: 'worker-b', limit: 1, dependencies: harness.deps, now: NOW })
  ]);
  assert.strictEqual(harness.state.graphCalls.length, 1);
  assert.strictEqual(harness.state.inbox.length, 1);
}

async function testDurableBoundaryAndLeaseRecovery() {
  const preGraph = buildHarness({
    notification: {
      leaseExpiresAt: '2026-08-10T11:59:00.000Z',
      graphRequestStartedAt: null,
      providerMessageId: null
    }
  });
  await Promise.all([
    processAvailableOrderCustomerNotifications({ workerId: 'worker-b', limit: 1, dependencies: preGraph.deps, now: NOW }),
    processAvailableOrderCustomerNotifications({ workerId: 'worker-c', limit: 1, dependencies: preGraph.deps, now: NOW })
  ]);
  assert.deepStrictEqual(preGraph.state.leaseRecoveries, ['pre_graph_retryable']);
  assert.strictEqual(preGraph.state.graphCalls.length, 1);
  assert.strictEqual(preGraph.state.graphBoundaryCalls.length, 1);
  assert.strictEqual(preGraph.state.notifications.get(IDS.notificationA).status, 'sent');
  assert.notStrictEqual(preGraph.state.notifications.get(IDS.notificationA).status, 'unknown_delivery');

  const postGraph = buildHarness({
    notification: {
      leaseExpiresAt: '2026-08-10T11:59:00.000Z',
      graphRequestStartedAt: '2026-08-10T11:58:59.000Z',
      providerMessageId: null
    }
  });
  await Promise.all([
    processAvailableOrderCustomerNotifications({ workerId: 'worker-b', limit: 1, dependencies: postGraph.deps, now: NOW }),
    processAvailableOrderCustomerNotifications({ workerId: 'worker-c', limit: 1, dependencies: postGraph.deps, now: NOW })
  ]);
  const postGraphStored = postGraph.state.notifications.get(IDS.notificationA);
  assert.deepStrictEqual(postGraph.state.leaseRecoveries, ['post_graph_ambiguous']);
  assert.strictEqual(postGraphStored.status, 'unknown_delivery');
  assert.strictEqual(postGraphStored.resultCode, 'lease_expired_post_graph_ambiguous');
  assert.strictEqual(postGraph.state.graphCalls.length, 0);

  const preBoundaryFailure = new Error('simulated durable boundary persistence failure');
  const preBoundary = buildHarness({ graphBoundaryError: preBoundaryFailure });
  const preBoundaryResult = await runOne(preBoundary);
  const preBoundaryStored = preBoundary.state.notifications.get(IDS.notificationA);
  assert.strictEqual(preBoundaryResult.outcome, 'failed_retryable');
  assert.strictEqual(preBoundaryStored.resultCode, 'processor_failed_before_graph_request');
  assert.strictEqual(preBoundaryStored.graphRequestStartedAt, null);
  assert.strictEqual(preBoundary.state.graphCalls.length, 0);

  const providerKnown = buildHarness({
    notification: {
      channelId: IDS.channelA,
      leaseExpiresAt: '2026-08-10T11:59:00.000Z',
      graphRequestStartedAt: '2026-08-10T11:58:59.000Z',
      providerMessageId: 'wamid-known-before-crash',
      errorMetadata: {
        renderedText: 'Resumen seguro del pedido.',
        recipient: '541112345678'
      }
    }
  });
  await processAvailableOrderCustomerNotifications({ workerId: 'worker-b', limit: 1, dependencies: providerKnown.deps, now: NOW });
  assert.deepStrictEqual(providerKnown.state.leaseRecoveries, ['provider_message_known']);
  assert.strictEqual(providerKnown.state.notifications.get(IDS.notificationA).status, 'sent');
  await processAvailableOrderCustomerNotifications({ workerId: 'worker-c', limit: 1, dependencies: providerKnown.deps, now: NOW });
  assert.strictEqual(providerKnown.state.graphCalls.length, 0);
  assert.strictEqual(providerKnown.state.inbox.length, 1);
  assert.strictEqual(providerKnown.state.notifications.get(IDS.notificationA).resultCode, 'inbox_recovered_without_resend');
}

async function testRetryAndPermanentTaxonomy() {
  const retryError = new Error('service unavailable');
  retryError.graphStatus = 503;
  const retryHarness = buildHarness({ sendQueue: [retryError, { messageId: 'wamid-retry-success', status: 200 }] });
  const first = await runOne(retryHarness);
  assert.strictEqual(first.outcome, 'failed_retryable');
  assert.strictEqual(retryHarness.state.notifications.get(IDS.notificationA).status, 'failed_retryable');
  assert.strictEqual(retryHarness.state.notifications.get(IDS.notificationA).resultCode, 'graph_503_retryable');
  const pending = retryHarness.state.notifications.get(IDS.notificationA);
  pending.availableAt = NOW;
  await processAvailableOrderCustomerNotifications({ workerId: 'worker-b', limit: 1, dependencies: retryHarness.deps, now: NOW });
  assert.strictEqual(retryHarness.state.notifications.get(IDS.notificationA).status, 'sent');
  assert.strictEqual(retryHarness.state.graphCalls.length, 2);
  assert.strictEqual(retryHarness.state.inbox.length, 1);

  const permanentError = new Error('bad request');
  permanentError.graphStatus = 400;
  const permanentHarness = buildHarness({ sendQueue: [permanentError] });
  const permanent = await runOne(permanentHarness);
  assert.strictEqual(permanent.outcome, 'failed_permanent');
  assert.strictEqual(permanentHarness.state.notifications.get(IDS.notificationA).resultCode, 'graph_400_permanent');
  assert.strictEqual(permanentHarness.state.graphCalls.length, 1);
  assert.strictEqual(classifySendFailure({ graphStatus: 400 }, 1, NOW).reason, 'graph_400_permanent');
  for (const graphStatus of [401, 403]) {
    const classified = classifySendFailure({ graphStatus }, 1, NOW);
    assert.strictEqual(classified.status, 'failed_permanent');
    assert.strictEqual(classified.reason, 'whatsapp_channel_configuration_rejected');
  }
  for (const graphStatus of [429, 500, 502, 503, 504]) {
    const classified = classifySendFailure({ graphStatus }, 1, NOW);
    assert.strictEqual(classified.status, 'failed_retryable');
    assert.strictEqual(classified.reason, `graph_${graphStatus}_retryable`);
  }
  assert.strictEqual(classifySendFailure({ graphStatus: 503 }, 5, NOW).reason, 'retry_attempts_exhausted');
  assert.strictEqual(classifySendFailure({ graphStatus: null, code: 'ETIMEDOUT' }, 1, NOW).status, 'unknown_delivery');
}

async function testAmbiguousDeliveryAndInboxRecovery() {
  const timeout = new Error('request timeout after body write');
  timeout.code = 'ETIMEDOUT';
  const timeoutHarness = buildHarness({ sendQueue: [timeout] });
  const timeoutResult = await runOne(timeoutHarness);
  assert.strictEqual(timeoutResult.outcome, 'unknown_delivery');
  assert.strictEqual(timeoutHarness.state.notifications.get(IDS.notificationA).status, 'unknown_delivery');
  assert.strictEqual(timeoutHarness.state.notifications.get(IDS.notificationA).resultCode, 'network_or_timeout_delivery_ambiguous');
  await processAvailableOrderCustomerNotifications({ workerId: 'worker-b', dependencies: timeoutHarness.deps, now: NOW });
  assert.strictEqual(timeoutHarness.state.graphCalls.length, 1);

  const recoveryHarness = buildHarness({ inboxFailures: 1, sendQueue: [{ messageId: 'wamid-inbox-recovery', status: 200 }] });
  const sendResult = await runOne(recoveryHarness);
  assert.strictEqual(sendResult.outcome, 'sent_inbox_pending');
  assert.strictEqual(recoveryHarness.state.notifications.get(IDS.notificationA).resultCode, 'inbox_persistence_pending');
  assert.strictEqual(recoveryHarness.state.graphCalls.length, 1);
  assert.strictEqual(recoveryHarness.state.inbox.length, 0);
  recoveryHarness.state.contacts[0].waId = '5491199999999';
  recoveryHarness.state.contacts[0].phone = '5491199999999';
  const notification = clone(recoveryHarness.state.notifications.get(IDS.notificationA));
  const recovery = await recoverOrderCustomerNotificationInbox(notification, { dependencies: recoveryHarness.deps });
  assert.strictEqual(recovery.recovered, true);
  assert.strictEqual(recoveryHarness.state.graphCalls.length, 1);
  assert.strictEqual(recoveryHarness.state.inbox.length, 1);
  assert.strictEqual(recoveryHarness.state.notifications.get(IDS.notificationA).resultCode, 'inbox_recovered_without_resend');
  assert.strictEqual(recoveryHarness.state.inbox[0].to, '541112345678');

  const monotonicHarness = buildHarness({ statusBeforeMetadataMerge: 'delivered' });
  await runOne(monotonicHarness);
  assert.strictEqual(monotonicHarness.state.notifications.get(IDS.notificationA).status, 'delivered');

  const acceptedButUncertain = buildHarness({
    failSentPersistenceOnce: true,
    sendQueue: [{ messageId: 'wamid-accepted-uncertain', status: 200 }]
  });
  const uncertainResult = await runOne(acceptedButUncertain);
  assert.strictEqual(uncertainResult.outcome, 'unknown_delivery');
  assert.strictEqual(acceptedButUncertain.state.graphCalls.length, 1);
  const uncertainNotification = clone(acceptedButUncertain.state.notifications.get(IDS.notificationA));
  assert.strictEqual(uncertainNotification.providerMessageId, 'wamid-accepted-uncertain');
  assert.strictEqual(uncertainNotification.resultCode, 'graph_accepted_state_uncertain');
  const uncertainRecovery = await recoverOrderCustomerNotificationInbox(uncertainNotification, {
    dependencies: acceptedButUncertain.deps
  });
  assert.strictEqual(uncertainRecovery.recovered, true);
  assert.strictEqual(acceptedButUncertain.state.graphCalls.length, 1);
  assert.strictEqual(acceptedButUncertain.state.inbox.length, 1);
}

async function testContactOrderAndFeaturePolicies() {
  for (const [contactPatch, expectedResultCode] of [
    [{ optedOut: true }, 'skipped_opted_out'],
    [{ status: 'archived', archivedAt: NOW }, 'skipped_contact_unavailable'],
    [{ status: 'deleted', deletedAt: NOW }, 'skipped_contact_unavailable']
  ]) {
    const harness = buildHarness({ contact: contactPatch });
    const result = await runOne(harness);
    assert.strictEqual(result.outcome, 'skipped');
    assert.strictEqual(harness.state.notifications.get(IDS.notificationA).status, 'skipped_no_contact');
    assert.strictEqual(harness.state.notifications.get(IDS.notificationA).resultCode, expectedResultCode);
    assert.strictEqual(harness.state.notifications.get(IDS.notificationA).graphRequestStartedAt, null);
    assert.strictEqual(harness.state.graphCalls.length, 0);
  }

  const missingContact = buildHarness({ omitDefaultContact: true });
  await runOne(missingContact);
  assert.strictEqual(missingContact.state.notifications.get(IDS.notificationA).status, 'skipped_no_contact');
  assert.strictEqual(missingContact.state.notifications.get(IDS.notificationA).resultCode, 'skipped_contact_missing');
  assert.strictEqual(missingContact.state.graphCalls.length, 0);

  const invalidPhone = buildHarness({ contact: { waId: '123', phone: '123' } });
  await runOne(invalidPhone);
  assert.strictEqual(invalidPhone.state.notifications.get(IDS.notificationA).status, 'skipped_no_contact');
  assert.strictEqual(invalidPhone.state.notifications.get(IDS.notificationA).resultCode, 'skipped_invalid_phone');

  const cancelled = buildHarness({ order: { status: 'cancelled' } });
  await runOne(cancelled);
  assert.strictEqual(cancelled.state.notifications.get(IDS.notificationA).status, 'failed_permanent');
  assert.strictEqual(cancelled.state.notifications.get(IDS.notificationA).resultCode, 'skipped_order_not_finalized');
  assert.strictEqual(cancelled.state.notifications.get(IDS.notificationA).graphRequestStartedAt, null);
  assert.strictEqual(cancelled.state.graphCalls.length, 0);

  const invalidSnapshot = buildHarness({
    notification: { snapshot: buildSnapshot({ clinicId: IDS.clinicB }) }
  });
  const invalidSnapshotResult = await runOne(invalidSnapshot);
  assert.strictEqual(invalidSnapshotResult.outcome, 'failed_permanent');
  assert.strictEqual(invalidSnapshot.state.notifications.get(IDS.notificationA).resultCode, 'invalid_notification_snapshot');
  assert.strictEqual(invalidSnapshot.state.graphCalls.length, 0);

  const disabled = buildHarness({ clinic: { settings: { orderCustomerNotificationEnabled: false, bot: {} } } });
  await runOne(disabled);
  assert.strictEqual(disabled.state.notifications.get(IDS.notificationA).status, 'failed_permanent');
  assert.strictEqual(disabled.state.notifications.get(IDS.notificationA).resultCode, 'skipped_feature_disabled');
  assert.strictEqual(disabled.state.graphCalls.length, 0);

  const capabilityDisabled = buildHarness({
    clinic: {
      settings: {
        orderCustomerNotificationEnabled: true,
        portal: {
          policy: {
            policyVersion: 1,
            capabilities: ['orders'],
            enabledModules: { orders: true, inbox: true }
          }
        }
      }
    }
  });
  await runOne(capabilityDisabled);
  assert.strictEqual(capabilityDisabled.state.notifications.get(IDS.notificationA).status, 'failed_permanent');
  assert.strictEqual(capabilityDisabled.state.notifications.get(IDS.notificationA).resultCode, 'skipped_policy');
  assert.strictEqual(capabilityDisabled.state.graphCalls.length, 0);

  const handoff = buildHarness({
    clinic: { settings: { orderCustomerNotificationEnabled: true, bot: { mode: 'disabled' } } },
    conversation: { status: 'needs_human', stage: 'handoff' }
  });
  const handoffResult = await runOne(handoff);
  assert.strictEqual(handoffResult.outcome, 'sent');
  assert.strictEqual(handoff.state.graphCalls.length, 1);
}

async function testChannelAndConversationRouting() {
  const noChannel = buildHarness({ channel: { status: 'inactive' } });
  await runOne(noChannel);
  assert.strictEqual(noChannel.state.notifications.get(IDS.notificationA).status, 'failed_permanent');
  assert.strictEqual(noChannel.state.notifications.get(IDS.notificationA).resultCode, 'skipped_no_whatsapp_channel');

  const ambiguous = buildHarness({
    notification: { conversationId: null, snapshot: buildSnapshot({ conversationId: null }) },
    conversation: { channelId: '99999999-9999-9999-9999-999999999999' },
    extraChannels: [{
      id: IDS.channelA2,
      clinicId: IDS.clinicA,
      provider: 'whatsapp_cloud',
      status: 'active',
      phoneNumberId: 'phone-a2',
      wabaId: 'waba-a2',
      accessToken: 'fixture-channel-token-a2'
    }]
  });
  await runOne(ambiguous);
  assert.strictEqual(ambiguous.state.notifications.get(IDS.notificationA).status, 'failed_permanent');
  assert.strictEqual(ambiguous.state.notifications.get(IDS.notificationA).resultCode, 'skipped_ambiguous_channel');

  const noConversation = buildHarness({
    notification: { conversationId: null, snapshot: buildSnapshot({ conversationId: null }) },
    conversation: { channelId: '99999999-9999-9999-9999-999999999999' }
  });
  await runOne(noConversation);
  assert.strictEqual(noConversation.state.notifications.get(IDS.notificationA).status, 'failed_permanent');
  assert.strictEqual(noConversation.state.notifications.get(IDS.notificationA).resultCode, 'skipped_no_conversation');

  const mismatchedRecipient = buildHarness({ conversation: { waFrom: '5491199999999' } });
  await runOne(mismatchedRecipient);
  assert.strictEqual(mismatchedRecipient.state.notifications.get(IDS.notificationA).status, 'failed_permanent');
  assert.strictEqual(mismatchedRecipient.state.notifications.get(IDS.notificationA).resultCode, 'skipped_no_conversation');
  assert.strictEqual(mismatchedRecipient.state.graphCalls.length, 0);
}

async function testWindowAndTemplate() {
  const closed = buildHarness({ lastInboundAt: '2026-08-08T11:00:00.000Z' });
  await runOne(closed);
  assert.strictEqual(closed.state.notifications.get(IDS.notificationA).status, 'failed_permanent');
  assert.strictEqual(closed.state.notifications.get(IDS.notificationA).resultCode, 'skipped_not_configured');
  assert.strictEqual(closed.state.graphCalls.length, 0);

  const template = {
    id: '77777777-7777-7777-7777-777777777777',
    clinicId: IDS.clinicA,
    channelId: IDS.channelA,
    wabaId: 'waba-a',
    templateKey: 'order_summary',
    metaTemplateName: 'opturon_order_summary_fixture',
    language: 'es_AR',
    category: 'UTILITY',
    status: 'approved',
    definition: { components: [{ type: 'BODY', text: '{{1}}' }] },
    metadata: { orderSummaryContract: 'full_text_body_parameter_v1' }
  };
  const configured = buildHarness({ lastInboundAt: '2026-08-08T11:00:00.000Z', template });
  const result = await runOne(configured);
  assert.strictEqual(result.outcome, 'sent');
  assert.strictEqual(configured.state.graphCalls[0].payload.templateName, template.metaTemplateName);
  assert.strictEqual(configured.state.graphCalls[0].payload.components[0].parameters.length, 1);
}

function testFormatterAndTransfer() {
  assert.strictEqual(buildOrderCustomerNotificationSnapshot({
    id: IDS.orderA,
    clinicId: IDS.clinicA,
    contactId: IDS.contactA,
    currency: 'ARS',
    paymentDestinationTypeSnapshot: 'bank',
    items: []
  }).payment.method, 'bank_transfer');
  assert.strictEqual(buildOrderCustomerNotificationSnapshot({
    id: IDS.orderA,
    clinicId: IDS.clinicA,
    contactId: IDS.contactA,
    currency: 'ARS',
    paymentMethod: 'card',
    paymentDestinationTypeSnapshot: 'bank',
    items: []
  }).payment.method, 'card');

  const twentyItems = Array.from({ length: 21 }, (_, index) => ({
    description: `Producto ${index + 1} ${'x'.repeat(180)}`,
    quantity: 1,
    lineTotal: 100 + index
  }));
  const formatted = formatOrderCustomerSummary({ snapshot: buildSnapshot({ items: twentyItems }) });
  assert.ok(formatted.text.length <= 3500);
  assert.strictEqual(formatted.metadata.visibleItemCount, 12);
  assert.match(formatted.text, /\.\.\.y 9 productos mas/);

  const transferSnapshot = buildSnapshot({
    payment: {
      status: 'pending',
      method: 'bank_transfer',
      destination: { id: 'destination-a', name: 'Banco A', type: 'bank' }
    }
  });
  const withTransfer = formatOrderCustomerSummary({
    snapshot: transferSnapshot,
    settings: {
      bot: {
        transferConfig: {
          enabled: true,
          destinationId: 'destination-a',
          alias: 'TIENDA.RESINA',
          cbu: '0000003100000000000001',
          titular: 'Comercio A',
          bank: 'Banco A',
          reference: 'Pedido',
          instructions: 'Enviar comprobante por este chat.'
        }
      }
    }
  });
  assert.match(withTransfer.text, /Alias: TIENDA\.RESINA/);
  assert.match(withTransfer.text, /CBU: 0000003100000000000001/);
  assert.strictEqual(withTransfer.metadata.transferIncluded, true);

  const missingTransfer = formatOrderCustomerSummary({
    snapshot: transferSnapshot,
    settings: { bot: { transferConfig: { enabled: true, titular: 'Comercio A' } } }
  });
  assert.strictEqual(missingTransfer.metadata.transferIncluded, false);
  assert.doesNotMatch(missingTransfer.text, /CVU|Alias:|CBU:/);

  const missingAmounts = formatOrderCustomerSummary({
    snapshot: buildSnapshot({
      items: [{ description: 'Producto sin importes', quantity: null, lineTotal: null }],
      subtotal: null,
      tax: null,
      total: null
    })
  });
  assert.doesNotMatch(missingAmounts.text, /0 x Producto sin importes|Subtotal:|Impuestos:|Total:/);
}

async function testTenantIsolation() {
  const harness = buildHarness({
    extraClinics: [{ id: IDS.clinicB, externalTenantId: 'tenant-b', settings: { orderCustomerNotificationEnabled: true } }],
    extraContacts: [{
      id: IDS.contactB,
      clinicId: IDS.clinicB,
      waId: '5491112345678',
      phone: '5491112345678',
      status: 'active',
      optedOut: false
    }],
    extraChannels: [{
      id: IDS.channelB,
      clinicId: IDS.clinicB,
      provider: 'whatsapp_cloud',
      status: 'active',
      phoneNumberId: 'phone-b',
      wabaId: 'waba-b',
      accessToken: 'fixture-channel-token-b'
    }]
  });
  await runOne(harness);
  assert.strictEqual(harness.state.graphCalls.length, 1);
  assert.strictEqual(harness.state.graphCalls[0].context.credentials.channelId, IDS.channelA);
  assert.ok(harness.state.scopeCalls.every((call) => !call.includes(IDS.clinicB)));
}

function buildStatusPayload(status, errors = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'phone-a' },
          statuses: [{ id: 'wamid-status', status, timestamp: '1786363200', errors }]
        }
      }]
    }]
  };
}

async function testStatusReconciliation() {
  let storedStatus = 'sent';
  let failureMetadata = null;
  const deliveries = [];
  const rank = { sent: 1, delivered: 2, read: 3 };
  const dependencies = {
    findChannelByPhoneNumberId: async () => ({ id: IDS.channelA, clinicId: IDS.clinicA }),
    updateConversationDelivery: async (input) => {
      deliveries.push(input.delivery);
      return null;
    },
    reconcileStatus: async (input) => {
      if (input.status === 'failed') {
        if (storedStatus === 'sent') storedStatus = 'failed_permanent';
        failureMetadata = input.failureMetadata;
      } else if (rank[input.status] >= (rank[storedStatus] || 0)) {
        storedStatus = input.status;
      }
      return { id: IDS.notificationA, status: storedStatus };
    }
  };

  await reconcileOrderCustomerNotificationStatuses(buildStatusPayload('sent'), { dependencies });
  await reconcileOrderCustomerNotificationStatuses(buildStatusPayload('delivered'), { dependencies });
  await reconcileOrderCustomerNotificationStatuses(buildStatusPayload('read'), { dependencies });
  await reconcileOrderCustomerNotificationStatuses(buildStatusPayload('sent'), { dependencies });
  assert.strictEqual(storedStatus, 'read');
  assert.deepStrictEqual(deliveries.slice(0, 4).map((delivery) => delivery.status), ['sent', 'delivered', 'read', 'sent']);

  storedStatus = 'sent';
  await reconcileOrderCustomerNotificationStatuses(buildStatusPayload('failed', [{
    code: 131000,
    title: 'Delivery failed',
    message: 'access_token=super-secret should not survive',
    error_data: { details: 'Bearer token-value' }
  }]), { dependencies });
  assert.strictEqual(storedStatus, 'failed_permanent');
  assert.strictEqual(deliveries[4].status, 'failed');
  assert.doesNotMatch(JSON.stringify(failureMetadata), /super-secret|token-value/);
  assert.match(JSON.stringify(failureMetadata), /redacted/);
}

function testRepositoryMigrationAndCapabilityContracts() {
  const migration = fs.readFileSync(path.join(root, 'db/migrations/073_order_customer_notification_delivery_states.sql'), 'utf8');
  const foundationMigration = fs.readFileSync(path.join(root, 'db/migrations/072_order_customer_notifications_foundation.sql'), 'utf8');
  const repository = fs.readFileSync(path.join(root, 'src/repositories/order-customer-notifications.repository.js'), 'utf8');
  const conversationRepository = fs.readFileSync(path.join(root, 'src/conversations/conversation.repo.js'), 'utf8');
  const controller = fs.readFileSync(path.join(root, 'src/controllers/webhook.controller.js'), 'utf8');
  assert.match(repository, /FOR UPDATE SKIP LOCKED/);
  assert.match(repository, /status IN \('pending', 'failed_retryable'\)/);
  assert.match(repository, /"notificationType" = 'order_summary'/);
  assert.match(repository, /sending_lease_expired_before_graph_request/);
  assert.match(repository, /sending_lease_expired_after_graph_request_started/);
  assert.match(repository, /"graphRequestStartedAt" IS NULL/);
  assert.match(repository, /"graphRequestStartedAt" IS NOT NULL/);
  assert.match(repository, /markOrderCustomerNotificationGraphRequestStarted/);
  assert.match(repository, /"providerMessageId" IS NOT NULL/);
  assert.match(repository, /status = 'unknown_delivery'/);
  assert.match(repository, /status IN \('sent', 'delivered', 'read', 'unknown_delivery'\)/);
  assert.match(repository, /NOT EXISTS \([\s\S]+conversation_messages/);
  assert.match(repository, /WHEN \$4 = 'read'[\s\S]+THEN 'read'/);
  assert.match(repository, /mergeOrderCustomerNotificationMetadata/);
  assert.match(conversationRepository, /CONVERSATION_OUTBOUND_SCOPE_MISMATCH/);
  assert.match(conversationRepository, /c\."clinicId" = \$8::uuid/);
  assert.match(conversationRepository, /c\."channelId" = \$9::uuid/);
  assert.match(conversationRepository, /cm\.raw -> 'message' ->> 'timestamp'/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "resultCode" TEXT NULL/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "graphRequestStartedAt" TIMESTAMPTZ NULL/);
  assert.match(migration, /idx_order_customer_notifications_result_code/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /chk_order_customer_notifications_status/i);
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(migration, /ALTER\s+COLUMN|RENAME\s+(?:COLUMN|CONSTRAINT|TABLE)/i);

  const statusCheck = foundationMigration.match(
    /CONSTRAINT chk_order_customer_notifications_status\s+CHECK \(status IN \(([\s\S]*?)\)\),\s+CONSTRAINT chk_order_customer_notifications_snapshot_object/
  );
  assert.ok(statusCheck, 'The immutable 072 status CHECK must remain discoverable.');
  assert.deepStrictEqual(Array.from(statusCheck[1].matchAll(/'([^']+)'/g), (match) => match[1]), [
    'pending',
    'sending',
    'sent',
    'delivered',
    'read',
    'failed_retryable',
    'failed_permanent',
    'unknown_delivery',
    'skipped_no_contact'
  ]);
  const repositoryStatuses = repository.match(/const NOTIFICATION_STATUSES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(repositoryStatuses, 'Repository lifecycle statuses must remain discoverable.');
  assert.deepStrictEqual(Array.from(repositoryStatuses[1].matchAll(/'([^']+)'/g), (match) => match[1]), [
    'pending',
    'sending',
    'sent',
    'delivered',
    'read',
    'failed_retryable',
    'failed_permanent',
    'unknown_delivery',
    'skipped_no_contact'
  ]);
  assert.match(repository, /"resultCode"/);
  assert.match(repository, /idx_order_customer_notifications_result_code|resultCode/);
  assert.match(controller, /reconcileOrderCustomerNotificationStatuses/);

  const buildTenant = ({ enabled, templateConfigured = false }) => buildTenantCapabilitySnapshot({
    clinic: {
      id: IDS.clinicA,
      settings: {
        orderCustomerNotificationEnabled: enabled,
        portal: {
          policy: {
            policyVersion: 1,
            capabilities: ['orders', 'inbox'],
            enabledModules: { orders: true, inbox: true }
          }
        }
      }
    },
    channels: [{
      id: IDS.channelA,
      clinicId: IDS.clinicA,
      provider: 'whatsapp_cloud',
      status: 'active',
      phoneNumberId: 'phone-a',
      credentialsConfigured: true
    }],
    configuration: { orderSummaryTemplateConfigured: templateConfigured }
  });
  assert.strictEqual(
    resolveCapability({ tenant: buildTenant({ enabled: false }), capability: 'order_customer_notification' }).status,
    CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION
  );
  const enabledTenant = buildTenant({ enabled: true });
  assert.strictEqual(
    resolveCapability({ tenant: enabledTenant, capability: 'order_customer_notification' }).status,
    CAPABILITY_STATUSES.AVAILABLE_NOW
  );
  assert.strictEqual(
    resolveCapability({
      tenant: enabledTenant,
      capability: 'order_customer_notification',
      context: { customerServiceWindowOpen: false }
    }).status,
    CAPABILITY_STATUSES.AVAILABLE_WITH_CONFIGURATION
  );
  assert.strictEqual(
    resolveCapability({
      tenant: buildTenant({ enabled: true, templateConfigured: true }),
      capability: 'order_customer_notification',
      context: { customerServiceWindowOpen: false }
    }).status,
    CAPABILITY_STATUSES.AVAILABLE_NOW
  );
}

Promise.resolve()
  .then(testHappyPathAndWindow)
  .then(testDoubleWorkerClaim)
  .then(testDurableBoundaryAndLeaseRecovery)
  .then(testRetryAndPermanentTaxonomy)
  .then(testAmbiguousDeliveryAndInboxRecovery)
  .then(testContactOrderAndFeaturePolicies)
  .then(testChannelAndConversationRouting)
  .then(testWindowAndTemplate)
  .then(testFormatterAndTransfer)
  .then(testTenantIsolation)
  .then(testStatusReconciliation)
  .then(testRepositoryMigrationAndCapabilityContracts)
  .then(() => {
    console.log('order-customer-notification-delivery.test.js passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
