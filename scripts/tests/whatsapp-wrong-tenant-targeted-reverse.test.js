'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const reverse = require(path.join(root, 'src/services/whatsapp-wrong-tenant-targeted-reverse.service'));

test('reverse identities and literal confirmation are immutable', () => {
  assert.equal(reverse.IDS.canonicalChannelId, '7f86db7a-0b3f-4aeb-9546-d0f2f921456a');
  assert.equal(reverse.IDS.sourceClinicId, '8e117b14-7c5c-44fb-a4a4-ac86eb6c5074');
  assert.equal(reverse.IDS.targetClinicId, 'a335961a-75c3-443b-a35f-5cc8dd243b1d');
  assert.equal(reverse.IDS.legacyChannelId, 'b3ef8ab5-4610-4571-a91b-e34d10b98dfa');
  assert.equal(reverse.CONFIRMATION, 'REVERSE_WRONG_TENANT_WHATSAPP_OWNERSHIP');
});

test('reverse command exposes only strict DRY_RUN and APPLY modes', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/ops/whatsapp-wrong-tenant-ownership-targeted-reverse.js'), 'utf8');
  assert.match(source, /\['DRY_RUN', 'APPLY'\]/);
  assert.match(source, /DRY_RUN_is_strictly_read_only/);
  assert.match(source, /literal_confirmation_mismatch/);
  assert.match(source, /workers_pause_not_confirmed/);
  assert.match(source, /manifest_checksum_mismatch/);
  assert.match(source, /manifest_not_ready/);
});

test('reverse transaction uses serializable isolation, lock, row locks and total rollback', () => {
  const source = fs.readFileSync(path.join(root, 'src/services/whatsapp-wrong-tenant-targeted-reverse.service.js'), 'utf8');
  assert.match(source, /BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /FROM clinics[\s\S]*FOR UPDATE/);
  assert.match(source, /FROM channels[\s\S]*FOR UPDATE/);
  assert.match(source, /execution === 'COMMIT'[\s\S]*ROLLBACK/);
  assert.doesNotMatch(source, /DISABLE TRIGGER|session_replication_role/);
});

test('reverse plan restores commercial references and actors, preserves credentials and deletes only mapped clones', () => {
  assert.match(reverse.REVERSE_CTE, /restored_orders/);
  assert.match(reverse.REVERSE_CTE, /restored_notification/);
  assert.match(reverse.REVERSE_CTE, /restored_rule/);
  assert.match(reverse.REVERSE_CTE, /reverse_actors/);
  assert.match(reverse.REVERSE_CTE, /kind='MINIMAL_CLONE'/);
  assert.doesNotMatch(reverse.REVERSE_CTE, /accessToken/);
  assert.doesNotMatch(reverse.REVERSE_CTE, /providerMessageId|waMessageId/);
});

test('third owner, active work, drift and uniqueness fail closed', () => {
  const date = new Date('2026-08-22T08:31:10.090Z');
  const state = {
    channels: [
      { id: reverse.IDS.canonicalChannelId, clinicId: reverse.IDS.targetClinicId, status: 'active', wabaId: reverse.IDS.wabaId, phoneNumberId: reverse.IDS.phoneNumberId },
      { id: reverse.IDS.legacyChannelId, clinicId: reverse.IDS.targetClinicId, status: 'inactive', wabaId: reverse.IDS.legacyWabaId, phoneNumberId: reverse.IDS.legacyPhoneNumberId }
    ],
    counts: { conversations: 77, conversationMessages: 1804, messages: 43, events: 117, handoffs: 11,
      agenda: 9, leads: 23, appointments: 1, jobs: 782, jobsDone: 759, jobsFailed: 23, templates: 1,
      clones: 76, legacyConversations: 1, legacyConversationMessages: 10, legacyJobs: 5,
      executableJobs: 1, leasedJobs: 0, canary: 0, onboarding: 0, thirdPhoneOwners: 1 },
    drift: { newConversations: 1 },
    uniqueness: { providerMessageIdDuplicates: 1, wamidDuplicates: 0 },
    clones: Array.from({ length: 76 }, (_, index) => ({ id: `clone-${index}`, clinicId: reverse.IDS.targetClinicId,
      createdAt: date, updatedAt: date, orders: 0, invoices: 0, payments: 0 }))
  };
  const blockers = reverse.validateState(state, { contactMapping: Array.from({ length: 77 }) });
  assert.ok(blockers.some((item) => item.startsWith('active:thirdPhoneOwners')));
  assert.ok(blockers.some((item) => item.startsWith('active:executableJobs')));
  assert.ok(blockers.some((item) => item.startsWith('post_t0:newConversations')));
  assert.ok(blockers.includes('message_uniqueness_violation'));
});
