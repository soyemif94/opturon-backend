const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { lifecycleStatusFromSettings, resolveTenantLifecycle } = require('../../src/services/tenant-lifecycle-gate.service');
const { updateTenantLifecycleStatus } = require('../../src/services/tenant-lifecycle.service');

test('lifecycle parser defaults to active and recognizes suspended', () => {
  assert.equal(lifecycleStatusFromSettings({}), 'active');
  assert.equal(lifecycleStatusFromSettings({ portal: { lifecycle: { status: 'suspended' } } }), 'suspended');
  assert.equal(lifecycleStatusFromSettings('{"portal":{"lifecycle":{"status":"active"}}}'), 'active');
});

test('runtime lifecycle resolution fails closed for missing tenant identity', async () => {
  const result = await resolveTenantLifecycle({});
  assert.equal(result.ok, false);
  assert.equal(result.suspended, true);
});

test('runtime lifecycle resolution fails closed for unknown tenant', async () => {
  const result = await resolveTenantLifecycle({ tenantId: 'missing' }, { query: async () => ({ rows: [] }) });
  assert.equal(result.ok, false);
  assert.equal(result.suspended, true);
});

test('manual suspend preserves billing and emits CLIENT_SUSPENDED', async () => {
  const clinic = { id: 'e43804da-94ad-4ccb-b65f-73d760d34955', externalTenantId: 'tenant-a', settings: { portal: { lifecycle: { status: 'active' }, billing: { status: 'canceled', marker: 'keep' } } } };
  let saved;
  let audit;
  const client = { query: async (sql, params) => {
    if (sql.includes('FOR UPDATE')) return { rows: [clinic] };
    saved = JSON.parse(params[1]);
    return { rows: [{ ...clinic, settings: saved, updatedAt: '2026-08-25T00:00:00.000Z' }] };
  } };
  const result = await updateTenantLifecycleStatus({ tenantId: 'tenant-a', status: 'suspended', expectedCurrentStatus: 'active', reason: 'manual QA', actorUserId: 'actor' }, {
    withTransaction: async (fn) => fn(client),
    createTenantPolicyAuditEvent: async (entry) => { audit = entry; return { id: 'audit' }; }
  });
  assert.equal(result.ok, true);
  assert.equal(saved.portal.lifecycle.status, 'suspended');
  assert.deepEqual(saved.portal.billing, { status: 'canceled', marker: 'keep' });
  assert.equal(audit.action, 'CLIENT_SUSPENDED');
});

test('manual reactivation preserves billing and emits CLIENT_REACTIVATED', async () => {
  const clinic = { id: 'e43804da-94ad-4ccb-b65f-73d760d34955', externalTenantId: 'tenant-a', settings: { portal: { lifecycle: { status: 'suspended' }, billing: { status: 'paused' } } } };
  let audit;
  const client = { query: async (sql, params) => sql.includes('FOR UPDATE') ? { rows: [clinic] } : { rows: [{ ...clinic, settings: JSON.parse(params[1]) }] } };
  const result = await updateTenantLifecycleStatus({ tenantId: 'tenant-a', status: 'active', expectedCurrentStatus: 'suspended', reason: 'manual restore' }, {
    withTransaction: async (fn) => fn(client),
    createTenantPolicyAuditEvent: async (entry) => { audit = entry; return {}; }
  });
  assert.equal(result.lifecycleStatus, 'active');
  assert.equal(result.billing.status, 'paused');
  assert.equal(audit.action, 'CLIENT_REACTIVATED');
});

test('invitation persistence uses hashed tokens and existing expiry/revocation fields', () => {
  const migration = read('db/migrations/049_portal_user_invitations_phase1.sql');
  const service = read('src/services/portal-users.service.js');
  assert.match(migration, /"tokenHash" TEXT NOT NULL/);
  assert.match(migration, /"expiresAt" TIMESTAMPTZ NOT NULL/);
  assert.match(migration, /"acceptedAt" TIMESTAMPTZ NULL/);
  assert.match(migration, /"revokedAt" TIMESTAMPTZ NULL/);
  assert.match(service, /createHash\('sha256'\)/);
  assert.doesNotMatch(migration, /token\s+TEXT/i);
});

test('resend and copy rotate token, revoke previous token and enforce cooldown', () => {
  const service = read('src/services/portal-users.service.js');
  assert.match(service, /ADMIN_INVITATION_ROTATION_COOLDOWN_MS/);
  assert.match(service, /revokePendingPortalUserInvitationsByUserId\(latest\.userId/);
  assert.match(service, /INVITATION_RESENT/);
  assert.match(service, /INVITATION_LINK_ROTATED/);
  assert.match(service, /invitation_rotation_cooldown/);
});

test('cancel revokes without deleting and audits actor action', () => {
  const service = read('src/services/portal-users.service.js');
  const body = service.slice(service.indexOf('async function cancelClientOwnerInvitation'), service.indexOf('async function authenticatePortalUser'));
  assert.match(body, /revokePendingPortalUserInvitationsByUserId/);
  assert.match(body, /INVITATION_CANCELLED/);
  assert.doesNotMatch(body, /delete/i);
});

test('admin invitation and lifecycle routes require an authenticated admin actor', () => {
  const routes = read('src/routes/admin.routes.js');
  assert.match(routes, /invitations\/:action\(resend\|copy\|cancel\)',\s*requireAdminInternalActor/);
  assert.match(routes, /lifecycle\/:action\(suspend\|reactivate\)',\s*requireAdminInternalActor/);
  assert.match(routes, /router\.get\('\/tenants', requireAdminInternalActor/);
});

test('suspended portal gate provides admin bypass and fail-closed error', () => {
  const middleware = read('src/middlewares/portal-tenant-lifecycle.middleware.js');
  assert.match(middleware, /actor && actor\.isAdmin/);
  assert.match(middleware, /tenant_lifecycle_unavailable/);
  assert.match(middleware, /status\(423\)/);
  assert.match(middleware, /tenant_suspended/);
});

test('inbound is persisted before reply enqueue and suspended reply is blocked in worker', () => {
  const inbound = read('src/conversations/conversation.service.js');
  assert.ok(inbound.indexOf('insertInboundMessage') < inbound.indexOf("enqueueJob('conversation_reply'"));
  const worker = read('src/worker.js');
  assert.match(worker, /conversation_reply_tenant_lifecycle_blocked/);
  assert.match(worker, /resolveTenantLifecycle\(\{ clinicId: conversation\.clinicId \}\)/);
});

test('operational alerts are skipped for suspended tenants before delivery', () => {
  const eventProcessor = read('src/services/operational-alert-event-processor.service.js');
  const deliveryProcessor = read('src/services/operational-alert-delivery-processor.service.js');
  assert.match(eventProcessor, /tenant_suspended/);
  assert.match(deliveryProcessor, /tenant_suspended/);
  assert.ok(deliveryProcessor.indexOf("lifecycleStatusFromSettings(clinic.settings)") < deliveryProcessor.indexOf('sendChannelScopedMessage(sendPayload'));
});

test('order customer outbound notifications are blocked for suspended tenants', () => {
  const processor = read('src/services/order-customer-notification-processor.service.js');
  assert.match(processor, /tenant_suspended/);
  assert.ok(processor.indexOf('lifecycleStatusFromSettings(clinic.settings)') < processor.indexOf('sendChannelScopedMessage(sendPayload'));
});

test('billing service remains decoupled from lifecycle transitions', () => {
  const billing = read('src/services/saas-billing.service.js');
  assert.doesNotMatch(billing, /updateTenantLifecycleStatus|CLIENT_SUSPENDED|CLIENT_REACTIVATED/);
});
