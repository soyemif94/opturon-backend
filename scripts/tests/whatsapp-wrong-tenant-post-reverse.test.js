'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');

test('tenant routes retain global fail-closed internal authentication', () => {
  const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  assert.match(routes, /router\.use\(\s*'\/tenants\/:tenantId',\s*requirePortalInternalAuth,\s*applyPortalActiveTenant/s);
  assert.doesNotMatch(routes, /requireWrongTenantMaintenance/);
});

test('incident maintenance is removed from inbound and outbound paths', () => {
  const outbound = fs.readFileSync(path.join(root, 'src/whatsapp/whatsapp.service.js'), 'utf8');
  const webhook = fs.readFileSync(path.join(root, 'src/controllers/webhook.controller.js'), 'utf8');
  assert.doesNotMatch(outbound, /WHATSAPP_OWNERSHIP_MAINTENANCE|isMaintainedChannel/);
  assert.doesNotMatch(webhook, /WHATSAPP_OWNERSHIP_MAINTENANCE|payloadTargetsMaintainedPhone/);
});

test('archived Inbox preserves historical soft-deleted contacts without widening active Inbox', () => {
  const source = fs.readFileSync(path.join(root, 'src/services/portal-inbox.service.js'), 'utf8');
  assert.match(source, /visibility === 'archived'[\s\S]*contactVisibilityClause/);
  assert.match(source, /visibility === 'archived'\s*\? ''\s*:\s*`AND COALESCE\(ct\.status, 'active'\) <> 'deleted'`/s);
  assert.match(source, /\$\{contactVisibilityClause\}/);
});
