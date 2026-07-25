const assert = require('assert');
const path = require('path');
const crypto = require('crypto');

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

function buildService() {
  const state = {
    imports: [],
    contacts: new Map(),
    conversations: new Map(),
    messages: [],
    logs: []
  };

  const tenantContexts = {
    tenant_a: { ok: true, tenantId: 'tenant_a', clinic: { id: 'clinic_a' } },
    tenant_b: { ok: true, tenantId: 'tenant_b', clinic: { id: 'clinic_b' } }
  };

  const channels = {
    clinic_a: { id: 'channel_a', phoneNumberId: 'phone_a' },
    clinic_b: { id: 'channel_b', phoneNumberId: 'phone_b' }
  };

  function createClient() {
    return {
      query: async (text, params) => {
        if (text.includes('FROM conversation_messages m') && text.includes('COUNT(*)::int AS count')) {
          const clinicId = params[0];
          const waMessageIds = params[1];
          const count = state.messages.filter((message) => message.clinicId === clinicId && waMessageIds.includes(message.waMessageId)).length;
          return { rows: [{ count }] };
        }

        if (text.includes('INSERT INTO conversation_imports')) {
          const clinicId = params[2];
          const fileHash = params[7];
          const existing = state.imports.find((item) => item.clinicId === clinicId && item.fileHash === fileHash && (item.status === 'previewed' || item.status === 'confirmed'));
          if (existing) {
            return { rows: [{ ...existing }] };
          }
          const row = {
            id: params[0],
            tenantId: params[1],
            clinicId,
            actorId: params[3],
            actorName: params[4],
            status: 'previewed',
            originalFileName: params[5],
            fileSizeBytes: params[6],
            fileHash,
            format: params[8],
            summary: JSON.parse(params[9]),
            warnings: JSON.parse(params[10]),
            selectedContactId: null,
            conversationId: null,
            confirmedAt: null
          };
          state.imports.push(row);
          return { rows: [{ ...row }] };
        }

        if (text.includes('FROM conversation_imports') && text.includes('FOR UPDATE')) {
          const importRecord = state.imports.find((item) => item.id === params[0] && item.clinicId === params[1]);
          return { rows: importRecord ? [{ ...importRecord }] : [] };
        }

        if (text.includes('INSERT INTO contacts')) {
          const contact = {
            id: params[0],
            clinicId: params[1],
            waId: params[2],
            name: params[3],
            notes: params[4]
          };
          state.contacts.set(contact.id, contact);
          return { rows: [] };
        }

        if (text.includes('SELECT id') && text.includes('FROM conversations')) {
          const existing = Array.from(state.conversations.values()).find(
            (conversation) =>
              conversation.clinicId === params[0] &&
              conversation.channelId === params[1] &&
              conversation.contactId === params[2]
          );
          return { rows: existing ? [{ id: existing.id }] : [] };
        }

        if (text.includes('INSERT INTO conversations')) {
          const conversation = {
            id: params[0],
            clinicId: params[1],
            channelId: params[2],
            contactId: params[3],
            waFrom: params[4],
            waTo: params[5],
            context: JSON.parse(params[6])
          };
          state.conversations.set(conversation.id, conversation);
          return { rows: [] };
        }

        if (text.includes('INSERT INTO conversation_messages')) {
          const existing = state.messages.find((message) => message.waMessageId === params[2]);
          if (existing) return { rowCount: 0, rows: [] };
          const message = {
            conversationId: params[0],
            clinicId: state.conversations.get(params[0]).clinicId,
            direction: params[1],
            waMessageId: params[2],
            from: params[3],
            to: params[4],
            type: params[5],
            text: params[6],
            raw: JSON.parse(params[7]),
            createdAt: params[8]
          };
          state.messages.push(message);
          return { rowCount: 1, rows: [{ id: `msg_${state.messages.length}` }] };
        }

        if (text.includes('UPDATE conversation_imports')) {
          const importRecord = state.imports.find((item) => item.id === params[0] && item.clinicId === params[1]);
          importRecord.status = 'confirmed';
          importRecord.selectedContactId = params[2];
          importRecord.conversationId = params[3];
          importRecord.summary = JSON.parse(params[4]);
          importRecord.confirmedAt = '2026-07-25T03:30:00.000Z';
          return { rows: [{ ...importRecord }] };
        }

        throw new Error(`Unhandled query in test: ${text}`);
      }
    };
  }

  const client = createClient();

  mockModule('src/db/client.js', {
    query: (text, params) => client.query(text, params),
    withTransaction: async (fn) => fn(client)
  });

  mockModule('src/services/portal-context.service.js', {
    resolvePortalTenantContext: async (tenantId) => tenantContexts[tenantId] || { ok: false, tenantId, reason: 'tenant_mapping_not_found' }
  });

  mockModule('src/repositories/contact.repository.js', {
    findPortalContactById: async (clinicId, contactId) => {
      const contact = state.contacts.get(contactId);
      return contact && contact.clinicId === clinicId ? contact : null;
    }
  });

  mockModule('src/repositories/tenant.repository.js', {
    findPreferredWhatsAppChannelByClinicId: async (clinicId) => channels[clinicId] || null
  });

  mockModule('src/utils/logger.js', {
    logInfo: (event, payload) => {
      state.logs.push({ event, payload });
    }
  });

  const servicePath = modulePath('src/services/portal-whatsapp-imports.service.js');
  delete require.cache[servicePath];
  return {
    state,
    service: require(servicePath)
  };
}

function textFile(text, overrides = {}) {
  const buffer = Buffer.from(text, 'utf8');
  return {
    originalname: overrides.originalname || 'chat.txt',
    mimetype: overrides.mimetype === undefined ? 'text/plain' : overrides.mimetype,
    size: buffer.length,
    buffer
  };
}

async function testRejectsEmptyAndBinaryFiles() {
  const { service } = buildService();

  const empty = await service.previewImport({
    tenantId: 'tenant_a',
    actor: { id: 'actor_a', name: 'Actor A' },
    file: { originalname: 'chat.txt', mimetype: 'text/plain', size: 0, buffer: Buffer.alloc(0) }
  });
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, 'empty_file');

  const binary = await service.previewImport({
    tenantId: 'tenant_a',
    actor: { id: 'actor_a', name: 'Actor A' },
    file: { originalname: 'chat.txt', mimetype: 'application/octet-stream', size: 4, buffer: Buffer.from([0, 255, 1, 2]) }
  });
  assert.strictEqual(binary.ok, false);
  assert.strictEqual(binary.reason, 'binary_file');
}

async function testRequiresExplicitSelfParticipantAndPreservesDirections() {
  const { service, state } = buildService();
  const preview = await service.previewImport({
    tenantId: 'tenant_a',
    actor: { id: 'actor_a', name: 'Actor A' },
    file: textFile(
      [
        '[10/4/26, 10:01:40 a. m.] Mati Moran: Hola',
        '[10/4/26, 10:02:40 a. m.] Soporte Opturon: Buen dia'
      ].join('\n')
    )
  });

  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.import.selfParticipantRequired, true);

  const missingSelf = await service.confirmImport({
    tenantId: 'tenant_a',
    actor: { id: 'actor_a', name: 'Actor A' },
    importId: preview.import.importId
  });
  assert.strictEqual(missingSelf.ok, false);
  assert.strictEqual(missingSelf.reason, 'whatsapp_import_self_participant_required');

  const confirmed = await service.confirmImport({
    tenantId: 'tenant_a',
    actor: { id: 'actor_a', name: 'Actor A' },
    importId: preview.import.importId,
    selectedSelfParticipant: 'Mati Moran'
  });

  assert.strictEqual(confirmed.ok, true);
  assert.strictEqual(confirmed.idempotent, false);
  assert.strictEqual(state.messages.length, 2);
  assert.strictEqual(state.messages[0].direction, 'outbound');
  assert.strictEqual(state.messages[1].direction, 'inbound');
  assert.strictEqual(state.messages[0].raw.import.imported, true);
}

async function testReimportSameTenantIsIdempotentAndDifferentTenantIsIsolated() {
  const { service, state } = buildService();
  const file = textFile(
    [
      '10/4/26, 10:01 - Mati Moran: Hola',
      '10/4/26, 10:02 - Soporte Opturon: Buen dia'
    ].join('\n')
  );

  const previewA = await service.previewImport({
    tenantId: 'tenant_a',
    actor: { id: 'actor_a', name: 'Actor A' },
    file
  });
  const confirmA = await service.confirmImport({
    tenantId: 'tenant_a',
    actor: { id: 'actor_a', name: 'Actor A' },
    importId: previewA.import.importId,
    selectedSelfParticipant: 'Mati Moran'
  });
  assert.strictEqual(confirmA.ok, true);
  assert.strictEqual(state.messages.length, 2);

  const previewAgain = await service.previewImport({
    tenantId: 'tenant_a',
    actor: { id: 'actor_a', name: 'Actor A' },
    file
  });
  assert.strictEqual(previewAgain.ok, true);
  assert.strictEqual(previewAgain.import.importId, previewA.import.importId);

  const confirmAgain = await service.confirmImport({
    tenantId: 'tenant_a',
    actor: { id: 'actor_a', name: 'Actor A' },
    importId: previewAgain.import.importId,
    selectedSelfParticipant: 'Mati Moran'
  });
  assert.strictEqual(confirmAgain.ok, true);
  assert.strictEqual(confirmAgain.idempotent, true);
  assert.strictEqual(state.messages.length, 2);

  const previewB = await service.previewImport({
    tenantId: 'tenant_b',
    actor: { id: 'actor_b', name: 'Actor B' },
    file
  });
  assert.strictEqual(previewB.ok, true);
  assert.notStrictEqual(previewB.import.importId, previewA.import.importId);

  const wrongTenantConfirm = await service.confirmImport({
    tenantId: 'tenant_b',
    actor: { id: 'actor_b', name: 'Actor B' },
    importId: previewA.import.importId,
    selectedSelfParticipant: 'Mati Moran'
  });
  assert.strictEqual(wrongTenantConfirm.ok, false);
  assert.strictEqual(wrongTenantConfirm.reason, 'whatsapp_import_not_found');
}

async function run() {
  await testRejectsEmptyAndBinaryFiles();
  await testRequiresExplicitSelfParticipantAndPreservesDirections();
  await testReimportSameTenantIsIdempotentAndDifferentTenantIsIsolated();
  console.log('portal-whatsapp-imports.service.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
