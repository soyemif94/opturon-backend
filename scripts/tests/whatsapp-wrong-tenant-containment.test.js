'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const maintenance = require(path.join(root, 'src/services/whatsapp-incident-maintenance.service'));

function responseRecorder() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('tenant-scoped portal routes share a fail-closed auth boundary before maintenance', () => {
  const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  assert.match(
    routes,
    /router\.use\(\s*'\/tenants\/:tenantId',\s*requirePortalInternalAuth,\s*requireWrongTenantMaintenance,\s*applyPortalActiveTenant/s
  );
  for (const endpoint of ['context', 'conversations', 'contacts', 'agenda']) {
    assert.match(routes, new RegExp(`'/tenants/:tenantId/${endpoint}`));
  }
});

test('wrong target is explicitly unavailable after authentication', () => {
  const res = responseRecorder();
  let continued = false;
  maintenance.requireWrongTenantMaintenance(
    { params: { tenantId: maintenance.INCIDENT.wrongTenantId } },
    res,
    () => { continued = true; }
  );
  assert.equal(continued, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { success: false, error: 'whatsapp_ownership_maintenance' });
  assert.equal(res.headers['Retry-After'], '300');
});

test('other tenants are not affected by the focal maintenance gate', () => {
  const res = responseRecorder();
  let continued = false;
  maintenance.requireWrongTenantMaintenance(
    { params: { tenantId: 'tenant_unrelated' } },
    res,
    () => { continued = true; }
  );
  assert.equal(continued, true);
  assert.equal(res.statusCode, null);
});

test('canonical channel and phone are blocked; legacy and unrelated channels are not', () => {
  assert.equal(maintenance.isMaintainedChannel({ channelId: maintenance.INCIDENT.channelId }), true);
  assert.equal(maintenance.isMaintainedChannel({ phoneNumberId: maintenance.INCIDENT.phoneNumberId }), true);
  assert.equal(maintenance.isMaintainedChannel({
    channelId: 'b3ef8ab5-4610-4571-a91b-e34d10b98dfa',
    phoneNumberId: '1063597556834198',
    clinicId: maintenance.INCIDENT.wrongClinicId
  }), false);
  assert.equal(maintenance.isMaintainedChannel({ channelId: 'other', phoneNumberId: 'other' }), false);
});

test('Meta webhook targeting canonical phone is detected before persistence', () => {
  const payload = {
    entry: [{ changes: [{ value: { metadata: { phone_number_id: maintenance.INCIDENT.phoneNumberId } } }] }]
  };
  assert.equal(maintenance.payloadTargetsMaintainedPhone(payload), true);
  assert.equal(maintenance.payloadTargetsMaintainedPhone({
    entry: [{ changes: [{ value: { metadata: { phone_number_id: '1063597556834198' } } }] }]
  }), false);
});

test('outbound and inbound code paths enforce maintenance before external or persistent work', () => {
  const outbound = fs.readFileSync(path.join(root, 'src/whatsapp/whatsapp.service.js'), 'utf8');
  const webhook = fs.readFileSync(path.join(root, 'src/controllers/webhook.controller.js'), 'utf8');
  const inbound = fs.readFileSync(path.join(root, 'src/conversations/conversation.service.js'), 'utf8');

  assert.ok(outbound.indexOf('isMaintainedChannel({') < outbound.indexOf('graphClient.buildMessagesEndpointUrl'));
  assert.ok(webhook.indexOf('payloadTargetsMaintainedPhone(payload)') < webhook.indexOf('await observeAndAutoReply'));
  assert.match(webhook, /WHATSAPP_OWNERSHIP_MAINTENANCE[\s\S]*Retry-After[\s\S]*status\(503\)/);
  assert.match(inbound, /WHATSAPP_OWNERSHIP_MAINTENANCE[\s\S]*throw error/);
});
