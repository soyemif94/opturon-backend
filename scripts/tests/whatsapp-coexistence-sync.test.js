const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  classifyAccountUpdate,
  extractCoexistenceChanges,
  extractHistoryMessages,
  extractStateSyncContacts
} = require('../../src/webhooks/whatsapp-coexistence');
const { historyExpired } = require('../../src/services/whatsapp-coexistence-sync.service');

const root = path.resolve(__dirname, '..', '..');

function coexistencePayload(field, value) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-a', changes: [{ field, value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-a', display_phone_number: '+54 11 8888 0000' },
      ...value
    } }] }]
  };
}

test('history imports preserve original order and classify inbound/outbound without triggering business processing', () => {
  const value = {
    history: [{ metadata: { phase: '1', chunk_order: 2, progress: '50' }, threads: [{ id: '5492911111111', messages: [
      { id: 'wamid.old-in', from: '5492911111111', timestamp: '1789990000', type: 'text', text: { body: 'Hola' } },
      { id: 'wamid.old-out', from: '541188880000', to: '5492911111111', timestamp: '1789990001', type: 'text', text: { body: 'Buen día' }, history_context: { status: 'sent' } },
      { id: 'wamid.group', from: '5492911111111-123@g.us', timestamp: '1789990002', type: 'text', text: { body: 'grupo' } }
    ] }] }]
  };
  const rows = extractHistoryMessages(value, { displayPhoneNumber: '+54 11 8888 0000' });
  assert.deepEqual(rows.map((row) => row.direction), ['inbound', 'outbound']);
  assert.deepEqual(rows.map((row) => row.customerIdentity), ['5492911111111', '5492911111111']);
  assert.equal(rows[0].createdAt, new Date(1789990000 * 1000).toISOString());
  assert.equal(rows[1].historyStatus, 'sent');
  assert.equal(rows[0].text, 'Hola');

  const service = fs.readFileSync(path.join(root, 'src/services/whatsapp-coexistence-sync.service.js'), 'utf8');
  const repository = fs.readFileSync(path.join(root, 'src/repositories/whatsapp-coexistence.repository.js'), 'utf8');
  assert.match(service, /source: 'history_import'/);
  assert.doesNotMatch(service, /enqueueInboundJob|enqueue.*conversation_reply|processInboundMessages/);
  assert.match(repository, /"createdAt"\)\s*VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8::jsonb, \$9::timestamptz\)/);
});

test('history event retries have stable content hashes for idempotent event staging', () => {
  const payload = coexistencePayload('history', { history: [{ metadata: { phase: '0' }, threads: [] }] });
  const first = extractCoexistenceChanges(payload)[0];
  const retry = extractCoexistenceChanges(JSON.parse(JSON.stringify(payload)))[0];
  assert.equal(first.field, 'history');
  assert.equal(first.eventHash, retry.eventHash);
  assert.match(first.eventHash, /^[a-f0-9]{64}$/);
});

test('history sync distinguishes provider expiry from declined sharing', () => {
  assert.equal(historyExpired({ history: [{ errors: [{ title: 'History sync expired', message: 'The sync window expired' }] }] }), true);
  assert.equal(historyExpired({ history: [{ errors: [{ title: 'Permission denied', message: 'Access denied' }] }] }), false);
});

test('contact state sync accepts add/remove with canonical phone and contact merge preserves existing CRM names', () => {
  const payload = coexistencePayload('smb_app_state_sync', { state_sync: [
    { type: 'contact', action: 'add', contact: { phone_number: '+54 9 291 111 1111', full_name: 'Contacto App' } },
    { type: 'contact', action: 'remove', contact: { phone_number: '5492912222222' } },
    { type: 'contact', action: 'add', contact: { phone_number: 'invalid', full_name: 'Bad' } },
    { type: 'unsupported', action: 'add', contact: { phone_number: '5492913333333', full_name: 'Skip' } }
  ] });
  const contacts = extractStateSyncContacts(payload.entry[0].changes[0].value);
  assert.deepEqual(contacts, [
    { phone: '5492911111111', action: 'add', name: 'Contacto App' },
    { phone: '5492912222222', action: 'remove', name: null }
  ]);
  const repository = fs.readFileSync(path.join(root, 'src/repositories/whatsapp-coexistence.repository.js'), 'utf8');
  assert.match(repository, /CASE WHEN NULLIF\(BTRIM\(name\), ''\) IS NULL THEN \$3 ELSE name END/);
  assert.match(repository, /WHERE "clinicId" = \$1/);
});

test('account offboarding is recognized, while unknown account updates do not claim disconnection', () => {
  assert.deepEqual(classifyAccountUpdate({ event: 'PARTNER_REMOVED' }), {
    event: 'PARTNER_REMOVED', coexistenceStatus: 'reconnection_required'
  });
  assert.deepEqual(classifyAccountUpdate({ event: 'BUSINESS_VERIFICATION_UPDATE' }), {
    event: 'BUSINESS_VERIFICATION_UPDATE', coexistenceStatus: null
  });
});

test('coexistence webhook bodies require verified signatures and are removed from generic raw webhook storage', () => {
  const controller = fs.readFileSync(path.join(root, 'src/controllers/webhook.controller.js'), 'utf8');
  const repository = fs.readFileSync(path.join(root, 'src/repositories/whatsapp-coexistence.repository.js'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'db/migrations/094_whatsapp_coexistence.sql'), 'utf8');
  assert.match(controller, /req\.metaSignatureValid !== true/);
  assert.match(controller, /containsCoexistenceData \? null : getSafeRawBody/);
  assert.match(controller, /removeCoexistenceOnlyFields\(originalPayload/);
  assert.match(controller, /echoCounts\.failed > 0/);
  assert.match(controller, /raw: containsCoexistenceData\s*\?/);
  assert.match(migration, /UNIQUE \("channelId", field, "eventHash"\)/);
  assert.match(repository, /payload = NULL/);
  assert.match(repository, /CASE WHEN \$2 = 'failed' THEN NULL ELSE payload END/);
  assert.match(repository, /c\."clinicId" = e\."clinicId"/);
});

test('provider status detection requires canonical app + Cloud API fields and makes only a GET request', () => {
  const service = fs.readFileSync(path.join(root, 'src/services/whatsapp-coexistence-sync.service.js'), 'utf8');
  assert.match(service, /method: 'GET'/);
  assert.match(service, /searchParams\.set\('fields', 'is_on_biz_app,platform_type'\)/);
  assert.match(service, /isOnBizApp === true && platformType === 'CLOUD_API' \? 'active'/);
  assert.doesNotMatch(service, /method: 'POST'|method: 'PUT'|\/messages/);
});

console.log('whatsapp-coexistence-sync.test.js passed');
