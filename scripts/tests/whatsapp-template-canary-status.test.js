const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileOrderCustomerNotificationStatuses } = require('../../src/services/order-customer-notification-status.service');

function payload(status) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'phone-a' }, statuses: [{ id: 'wamid.canary', status, timestamp: '1787360000' }]
  } }] }] };
}

test('webhook status updates the exact tenant/channel Canary attempt', async () => {
  const observed = [];
  const stats = await reconcileOrderCustomerNotificationStatuses(payload('delivered'), { dependencies: {
    findChannelByPhoneNumberId: async () => ({ id: 'channel-a', clinicId: 'clinic-a' }),
    reconcileStatus: async () => null,
    updateConversationDelivery: async () => null,
    reconcileOperationalStatus: async () => null,
    aggregateOperationalInstance: async () => null,
    reconcileCanaryStatus: async (input) => { observed.push(input); return { id: 'attempt-a' }; }
  } });
  assert.equal(stats.canaryMatched, 1);
  assert.deepEqual(observed[0], { clinicId: 'clinic-a', channelId: 'channel-a', providerMessageId: 'wamid.canary',
    status: 'delivered', occurredAt: new Date(1787360000 * 1000).toISOString(), failureMetadata: null });
});

test('unmatched status remains ignored and never invents delivery', async () => {
  const stats = await reconcileOrderCustomerNotificationStatuses(payload('read'), { dependencies: {
    findChannelByPhoneNumberId: async () => ({ id: 'channel-a', clinicId: 'clinic-a' }),
    reconcileStatus: async () => null, updateConversationDelivery: async () => null, reconcileOperationalStatus: async () => null,
    aggregateOperationalInstance: async () => null, reconcileCanaryStatus: async () => null
  } });
  assert.equal(stats.matched, 0); assert.equal(stats.ignored, 1);
});
