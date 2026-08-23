const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..', '..');
const {
  normalizeWhatsAppIdentity,
  whatsappIdentityCandidates,
  createWhatsAppConversationResolver
} = require(path.join(root, 'src/conversations/whatsapp-conversation-resolver.js'));
const repair = require(path.join(root, 'src/services/whatsapp-canary-conversation-repair.service.js'));

function resolverFixture({ conversation = { id: 'conversation-existing', status: 'open' } } = {}) {
  const state = { contacts: [], inbound: [], outbound: [] };
  const resolve = createWhatsAppConversationResolver({
    upsertContact: async (input, client, options) => {
      state.contacts.push({ input, client, options });
      return { id: 'contact-existing', name: 'Emi Fernandez' };
    },
    upsertConversation: async (input) => { state.inbound.push(input); return conversation; },
    upsertOutboundConversation: async (input) => { state.outbound.push(input); return conversation; }
  });
  return { state, resolve };
}

const base = {
  providerIdentity: '+54 9 291 527 5449',
  phone: '+5492915275449',
  clinicId: 'clinic-a',
  channelId: 'channel-a',
  waTo: '+54 9 11 0000 0000'
};

test('provider identity keeps the Argentine mobile 9 and never uses transport normalization', () => {
  assert.equal(normalizeWhatsAppIdentity(base.providerIdentity), '5492915275449');
  assert.deepEqual(whatsappIdentityCandidates('+542915275449'), ['5492915275449', '542915275449']);
  assert.deepEqual(whatsappIdentityCandidates('+5492915275449'), ['5492915275449', '542915275449']);
});

test('outbound reuses the repository canonical conversation and preserves CRM name', async () => {
  const fx = resolverFixture();
  const result = await fx.resolve({ ...base, direction: 'outbound', contactName: 'Opturon Canary — recipient interno', preserveExistingName: true, preserveExistingIdentity: true }, { tx: true });
  assert.equal(result.contact.name, 'Emi Fernandez');
  assert.equal(result.conversation.id, 'conversation-existing');
  assert.equal(fx.state.contacts.length, 1);
  assert.equal(fx.state.contacts[0].input.waId, '5492915275449');
  assert.equal(fx.state.contacts[0].options.preserveExistingName, true);
  assert.equal(fx.state.contacts[0].options.preserveExistingIdentity, true);
  assert.deepEqual(fx.state.contacts[0].options.identityCandidates, ['5492915275449', '542915275449']);
  assert.equal(fx.state.outbound.length, 1);
  assert.equal(fx.state.outbound[0].clinicId, 'clinic-a');
  assert.equal(fx.state.outbound[0].channelId, 'channel-a');
  assert.equal(fx.state.outbound[0].contactId, 'contact-existing');
  assert.equal(fx.state.inbound.length, 0);
});

test('closed or archived canonical conversation is deterministically reused by repository result', async () => {
  const fx = resolverFixture({ conversation: { id: 'conversation-closed', status: 'closed' } });
  const result = await fx.resolve({ ...base, direction: 'outbound' });
  assert.equal(result.conversation.id, 'conversation-closed');
  assert.equal(fx.state.outbound.length, 1);
});

test('existing contact without a conversation delegates one scoped creation to the shared repository', async () => {
  const fx = resolverFixture({ conversation: { id: 'conversation-created', status: 'open' } });
  const result = await fx.resolve({ ...base, direction: 'outbound' });
  assert.equal(result.conversation.id, 'conversation-created');
  assert.equal(fx.state.contacts.length, 1);
  assert.equal(fx.state.outbound.length, 1);
});

test('inbound and outbound use one resolver while retaining direction-specific repository semantics', async () => {
  const fx = resolverFixture();
  await fx.resolve({ ...base, direction: 'inbound' });
  await fx.resolve({ ...base, direction: 'outbound' });
  assert.equal(fx.state.inbound.length, 1);
  assert.equal(fx.state.outbound.length, 1);
  assert.deepEqual(
    [fx.state.inbound[0].clinicId, fx.state.inbound[0].channelId],
    [fx.state.outbound[0].clinicId, fx.state.outbound[0].channelId]
  );
});

test('same identity remains isolated by clinic and canonical channel', async () => {
  const fx = resolverFixture();
  await fx.resolve({ ...base, direction: 'outbound' });
  await fx.resolve({ ...base, direction: 'outbound', clinicId: 'clinic-b' });
  await fx.resolve({ ...base, direction: 'outbound', channelId: 'channel-b' });
  assert.deepEqual(fx.state.outbound.map(({ clinicId, channelId }) => [clinicId, channelId]), [
    ['clinic-a', 'channel-a'], ['clinic-b', 'channel-a'], ['clinic-a', 'channel-b']
  ]);
});

test('resolver fails closed without identity, tenant clinic, channel or direction', async () => {
  const fx = resolverFixture();
  await assert.rejects(() => fx.resolve({ ...base, providerIdentity: '', phone: '', direction: 'outbound' }), /identity_context_invalid/);
  await assert.rejects(() => fx.resolve({ ...base, clinicId: '', direction: 'outbound' }), /identity_context_invalid/);
  await assert.rejects(() => fx.resolve({ ...base, channelId: '', direction: 'outbound' }), /identity_context_invalid/);
  await assert.rejects(() => fx.resolve({ ...base, direction: 'sideways' }), /identity_context_invalid/);
});

test('contact upsert prioritizes provider identity and cannot overwrite a CRM name', async () => {
  const dbFilename = require.resolve(path.join(root, 'src/db/client.js'));
  const contactFilename = require.resolve(path.join(root, 'src/repositories/contact.repository.js'));
  const savedDb = require.cache[dbFilename];
  const savedContact = require.cache[contactFilename];
  const calls = [];
  require.cache[dbFilename] = {
    id: dbFilename,
    filename: dbFilename,
    loaded: true,
    exports: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM contacts\s+WHERE/.test(sql)) {
          return { rows: [{ id: 'contact-existing', clinicId: 'clinic-a', name: 'Emi Fernandez' }] };
        }
        return { rows: [{ id: 'contact-existing', clinicId: 'clinic-a', name: 'Emi Fernandez' }] };
      }
    }
  };
  delete require.cache[contactFilename];
  try {
    const contacts = require(contactFilename);
    const result = await contacts.upsertContact({ clinicId: 'clinic-a', waId: '5492915275449', phone: '+542915275449', name: 'Operational recipient' }, null, {
      preserveExistingName: true,
      preserveExistingIdentity: true,
      identityCandidates: ['5492915275449', '542915275449']
    });
    assert.equal(result.name, 'Emi Fernandez');
    assert.deepEqual(calls[0].params[1], ['5492915275449', '542915275449']);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].params[5], true);
    assert.equal(calls[1].params[6], true);
    assert.match(calls[1].sql, /CASE WHEN \$6::boolean THEN name/);
    assert.match(calls[1].sql, /CASE WHEN \$7::boolean THEN "waId"/);
  } finally {
    if (savedDb) require.cache[dbFilename] = savedDb; else delete require.cache[dbFilename];
    if (savedContact) require.cache[contactFilename] = savedContact; else delete require.cache[contactFilename];
  }
});

test('PGlite exact production rows choose canonical 13-digit contact over retired 12-digit duplicate', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE contacts (
      id text PRIMARY KEY, "clinicId" text NOT NULL, "waId" text, phone text, name text,
      email text, "profileImageUrl" text, "whatsappPhone" text, "taxId" text,
      "taxCondition" text, "companyName" text, notes text, status text,
      "archivedAt" timestamptz, "deletedAt" timestamptz, "optedOut" boolean DEFAULT false,
      "createdAt" timestamptz DEFAULT now(), "updatedAt" timestamptz DEFAULT now(),
      UNIQUE ("clinicId", "waId")
    );
    INSERT INTO contacts (id,"clinicId","waId",phone,"whatsappPhone",name,status,"deletedAt","updatedAt") VALUES
      ('canonical','clinic-a','5492915275449','+5492915275449','5492915275449','Emi Fernandez','active',NULL,now()),
      ('duplicate','clinic-a','542915275449','+542915275449',NULL,'Opturon Canary — recipient interno','deleted',now(),now());
  `);
  const contacts = require(path.join(root, 'src/repositories/contact.repository.js'));
  const result = await contacts.upsertContact({
    clinicId: 'clinic-a',
    waId: '5492915275449',
    phone: '+542915275449',
    name: 'Opturon Canary — recipient interno'
  }, db, {
    preserveExistingName: true,
    preserveExistingIdentity: true,
    identityCandidates: ['5492915275449', '542915275449']
  });
  assert.equal(result.id, 'canonical');
  assert.equal(result.name, 'Emi Fernandez');
  assert.equal(result.waId, '5492915275449');
  assert.equal(result.phone, '+5492915275449');
  const rows = await db.query('SELECT id,status,"deletedAt" FROM contacts ORDER BY id');
  assert.equal(rows.rows.find((row) => row.id === 'duplicate').status, 'deleted');
  await db.close();
});

test('repair recognizes equivalent Meta transport and provider identities only after canonicalization', () => {
  const transport = { waId: '542915275449' };
  const provider = { waId: '5492915275449' };
  assert.equal(repair.canonicalWhatsAppIdentity(transport.waId), '5492915275449');
  assert.equal(repair.identitiesIntersect(transport, provider), true);
  assert.equal(repair.identitiesIntersect(transport, { waId: '5492915270000' }), false);
});

test('repair contract is transaction-only, fail-closed, preserves message/WAMID and scopes tenant/channel', () => {
  const source = fs.readFileSync(path.join(root, 'src/services/whatsapp-canary-conversation-repair.service.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src/routes/portal.routes.js'), 'utf8');
  assert.match(source, /withTransaction/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /sourceMessages\.length !== 1/);
  assert.match(source, /outbound\.id !== attempt\.inboxMessageId/);
  assert.match(source, /outbound\.waMessageId[^\n]+attempt\.providerMessageId/);
  assert.match(source, /UPDATE conversation_messages SET "conversationId"/);
  assert.doesNotMatch(source, /UPDATE conversation_messages SET[\s\S]{0,180}"waMessageId"/);
  assert.match(source, /UPDATE whatsapp_template_canary_attempts SET "conversationId"/);
  assert.doesNotMatch(source, /UPDATE whatsapp_template_canary_attempts SET[\s\S]{0,180}"providerMessageId"/);
  assert.match(source, /source\.channelId !== context\.channel\.id/);
  assert.match(routes, /repair-conversation'[^\n]+requirePortalInternalAuth[^\n]+requireWhatsAppCanaryWrite/);
});

test('runtime wiring sends both normal inbound and Canary outbound through shared resolution', () => {
  const inbound = fs.readFileSync(path.join(root, 'src/conversations/conversation.service.js'), 'utf8');
  const canary = fs.readFileSync(path.join(root, 'src/services/portal-whatsapp-template-canary.service.js'), 'utf8');
  assert.match(inbound, /resolveWhatsAppConversation\(\{[\s\S]*direction: 'inbound'/);
  assert.match(canary, /resolveWhatsAppConversation\(\{[\s\S]*direction: 'outbound'/);
  assert.match(canary, /transportRecipient = normalizeWhatsAppTo/);
  assert.match(canary, /providerIdentity: normalizeWhatsAppIdentity/);
});
