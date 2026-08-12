const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.resolve(__dirname, '..', '..');
const migration015 = fs.readFileSync(
  path.join(root, 'db/migrations/015_whatsapp_template_library.sql'),
  'utf8'
);
const migration075 = fs.readFileSync(
  path.join(root, 'db/migrations/075_whatsapp_templates_channel_waba_identity.sql'),
  'utf8'
);

const ids = {
  clinicA: '10000000-0000-4000-8000-000000000001',
  clinicB: '10000000-0000-4000-8000-000000000002',
  channelA: '20000000-0000-4000-8000-000000000001',
  channelB: '20000000-0000-4000-8000-000000000002',
  channelOtherTenant: '20000000-0000-4000-8000-000000000003'
};

function templateId(sequence) {
  return `30000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

async function createLegacyDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clinics (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE channels (
      id UUID PRIMARY KEY,
      "clinicId" UUID NOT NULL REFERENCES clinics(id),
      "wabaId" TEXT NULL
    );
    INSERT INTO clinics (id, name) VALUES
      ('${ids.clinicA}', 'Clinic A'),
      ('${ids.clinicB}', 'Clinic B');
    INSERT INTO channels (id, "clinicId", "wabaId") VALUES
      ('${ids.channelA}', '${ids.clinicA}', 'waba-a'),
      ('${ids.channelB}', '${ids.clinicA}', 'waba-b'),
      ('${ids.channelOtherTenant}', '${ids.clinicB}', 'waba-other');
  `);
  await db.exec(migration015);
  return db;
}

async function insertTemplate(db, input) {
  await db.query(
    `INSERT INTO whatsapp_templates (
      id, "clinicId", "externalTenantId", "channelId", "wabaId", "templateKey",
      "metaTemplateId", "metaTemplateName", language, category, status, definition, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)`,
    [
      input.id,
      input.clinicId || ids.clinicA,
      input.externalTenantId || 'tenant-a',
      input.channelId === undefined ? ids.channelA : input.channelId,
      input.wabaId === undefined ? 'waba-a' : input.wabaId,
      input.templateKey,
      input.metaTemplateId || null,
      input.metaTemplateName,
      input.language || 'es_AR',
      input.category || 'UTILITY',
      input.status || 'pending',
      JSON.stringify(input.definition || {}),
      JSON.stringify(input.metadata || {})
    ]
  );
}

async function expectPgCode(work, expectedCode) {
  let caught = null;
  try {
    await work();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected PostgreSQL error ${expectedCode}`);
  assert.equal(caught.code, expectedCode);
  return caught;
}

async function testPrechecks() {
  const nullScopeDb = await createLegacyDatabase();
  await insertTemplate(nullScopeDb, {
    id: templateId(1),
    channelId: null,
    templateKey: 'legacy_no_channel',
    metaTemplateName: 'legacy_no_channel'
  });
  const nullScopeError = await expectPgCode(() => nullScopeDb.exec(migration075), '23514');
  assert.match(nullScopeError.message, /missing_channel_scope/);
  assert.match(nullScopeError.message, /30000000/);
  await nullScopeDb.close();

  const duplicateDb = await createLegacyDatabase();
  await duplicateDb.exec(`
    DROP INDEX idx_whatsapp_templates_clinic_key_language;
    DROP INDEX idx_whatsapp_templates_clinic_meta_name;
  `);
  const duplicate = {
    clinicId: ids.clinicA,
    channelId: ids.channelA,
    wabaId: 'waba-a',
    templateKey: 'duplicate_identity',
    metaTemplateName: 'duplicate_identity',
    language: 'es_AR'
  };
  await insertTemplate(duplicateDb, { ...duplicate, id: templateId(2) });
  await insertTemplate(duplicateDb, { ...duplicate, id: templateId(3) });
  const duplicateError = await expectPgCode(() => duplicateDb.exec(migration075), '23514');
  assert.match(duplicateError.message, /duplicate_canonical_identity/);
  assert.match(duplicateError.message, /duplicate_provider_identity/);
  await duplicateDb.close();

  const unsafeScopeDb = await createLegacyDatabase();
  await insertTemplate(unsafeScopeDb, {
    id: templateId(4),
    clinicId: ids.clinicB,
    externalTenantId: 'tenant-b',
    channelId: ids.channelA,
    wabaId: 'waba-a',
    templateKey: 'cross_tenant_legacy',
    metaTemplateName: 'cross_tenant_legacy'
  });
  await insertTemplate(unsafeScopeDb, {
    id: templateId(5),
    wabaId: ' ',
    templateKey: 'missing_waba_legacy',
    metaTemplateName: 'missing_waba_legacy'
  });
  await insertTemplate(unsafeScopeDb, {
    id: templateId(6),
    templateKey: ' ',
    metaTemplateName: 'incomplete_identity_legacy'
  });
  const unsafeScopeError = await expectPgCode(() => unsafeScopeDb.exec(migration075), '23514');
  assert.match(unsafeScopeError.message, /cross_tenant_channel_scope/);
  assert.match(unsafeScopeError.message, /missing_waba_scope/);
  assert.match(unsafeScopeError.message, /incomplete_template_identity/);
  await unsafeScopeDb.close();

  const multiLanguageDb = await createLegacyDatabase();
  await multiLanguageDb.exec('DROP INDEX idx_whatsapp_templates_clinic_meta_name;');
  await insertTemplate(multiLanguageDb, {
    id: templateId(7),
    templateKey: 'legacy_multi_language_es',
    metaTemplateName: 'legacy_multi_language',
    language: 'es_AR'
  });
  await insertTemplate(multiLanguageDb, {
    id: templateId(8),
    templateKey: 'legacy_multi_language_en',
    metaTemplateName: 'legacy_multi_language',
    language: 'en_US'
  });
  const multiLanguageError = await expectPgCode(() => multiLanguageDb.exec(migration075), '23514');
  assert.match(multiLanguageError.message, /legacy_multi_language_provider_name/);
  await multiLanguageDb.close();
}

async function testMigrationAndRepository() {
  const db = await createLegacyDatabase();
  await insertTemplate(db, {
    id: templateId(10),
    templateKey: 'inventory_lot_expiring_v1',
    metaTemplateName: 'inventory_lot_expiring_v1',
    status: 'pending'
  });
  await db.exec(migration075);

  const indexes = await db.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE tablename = 'whatsapp_templates'
  `);
  const indexNames = new Set(indexes.rows.map((row) => row.indexname));
  assert.ok(indexNames.has('uq_whatsapp_templates_scope_key_language'));
  assert.ok(indexNames.has('uq_whatsapp_templates_scope_provider_language'));
  assert.ok(!indexNames.has('idx_whatsapp_templates_clinic_key_language'));
  assert.ok(!indexNames.has('idx_whatsapp_templates_clinic_meta_name'));

  const constraints = await db.query(`
    SELECT conname, contype, convalidated
    FROM pg_constraint
    WHERE conrelid = 'whatsapp_templates'::regclass
  `);
  const constraintByName = new Map(constraints.rows.map((row) => [row.conname, row]));
  assert.equal(constraintByName.get('fk_whatsapp_templates_channel_tenant').contype, 'f');
  assert.equal(constraintByName.get('fk_whatsapp_templates_channel_tenant').convalidated, true);
  assert.equal(constraintByName.get('chk_whatsapp_templates_channel_scope').convalidated, true);

  const column = await db.query(`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_name = 'whatsapp_templates' AND column_name = 'channelId'
  `);
  assert.equal(column.rows[0].is_nullable, 'NO');

  await expectPgCode(() => insertTemplate(db, {
    id: templateId(11),
    templateKey: 'inventory_lot_expiring_v1',
    metaTemplateName: 'inventory_lot_expiring_v1'
  }), '23505');

  await insertTemplate(db, {
    id: templateId(12),
    channelId: ids.channelB,
    wabaId: 'waba-b',
    templateKey: 'inventory_lot_expiring_v1',
    metaTemplateName: 'inventory_lot_expiring_v1'
  });
  await insertTemplate(db, {
    id: templateId(13),
    wabaId: 'waba-historical',
    templateKey: 'inventory_lot_expiring_v1',
    metaTemplateName: 'inventory_lot_expiring_v1'
  });
  await insertTemplate(db, {
    id: templateId(14),
    templateKey: 'inventory_lot_expiring_v1',
    metaTemplateName: 'inventory_lot_expiring_v1',
    language: 'en_US'
  });

  await expectPgCode(() => insertTemplate(db, {
    id: templateId(15),
    clinicId: ids.clinicB,
    externalTenantId: 'tenant-b',
    channelId: ids.channelA,
    wabaId: 'waba-a',
    templateKey: 'cross_tenant',
    metaTemplateName: 'cross_tenant'
  }), '23503');

  const repository = require(path.join(root, 'src/repositories/whatsapp-templates.repository.js'));
  const exactScope = {
    clinicId: ids.clinicA,
    channelId: ids.channelA,
    wabaId: 'waba-a',
    templateKey: 'lookup_exact',
    language: 'es_AR'
  };
  await insertTemplate(db, {
    id: templateId(20),
    ...exactScope,
    metaTemplateName: 'lookup_exact'
  });

  const exact = await repository.findWhatsAppTemplateByScope(exactScope, db);
  assert.equal(exact.id, templateId(20));
  assert.equal(await repository.findWhatsAppTemplateByScope({ ...exactScope, clinicId: ids.clinicB }, db), null);
  assert.equal(await repository.findWhatsAppTemplateByScope({ ...exactScope, channelId: ids.channelB }, db), null);
  assert.equal(await repository.findWhatsAppTemplateByScope({ ...exactScope, wabaId: 'wrong-waba' }, db), null);
  assert.equal(await repository.findWhatsAppTemplateByScope({ ...exactScope, language: 'es' }, db), null);
  assert.equal(await repository.findWhatsAppTemplateByScope({ ...exactScope, language: 'es_ES' }, db), null);

  const providerExact = await repository.findWhatsAppTemplateByProviderIdentity({
    clinicId: ids.clinicA,
    channelId: ids.channelA,
    wabaId: 'waba-a',
    metaTemplateName: 'lookup_exact',
    language: 'es_AR'
  }, db);
  assert.equal(providerExact.id, templateId(20));
  assert.equal(await repository.findWhatsAppTemplateByProviderIdentity({
    clinicId: ids.clinicA,
    channelId: ids.channelA,
    wabaId: 'waba-a',
    metaTemplateName: 'lookup_exact',
    language: 'en_US'
  }, db), null);

  const syncBase = {
    clinicId: ids.clinicA,
    externalTenantId: 'tenant-a',
    wabaId: 'waba-a',
    templateKey: 'sync_identity',
    language: 'es_AR',
    category: 'UTILITY',
    metaTemplateName: 'sync_identity',
    localDefinition: {
      source: 'sync_only_blueprint',
      blueprint: { version: 1 }
    },
    localMetadata: {
      operationalAlertContract: 'operational_alert_body_parameters_v1',
      formatter: { key: 'inventory_lot_expiring', version: 1 }
    },
    providerMetadata: { source: 'meta_sync', requestMarker: 'first' }
  };
  await repository.upsertSyncedWhatsAppTemplate({
    ...syncBase,
    channelId: ids.channelA,
    status: 'PENDING',
    providerDefinition: {
      components: [{ type: 'BODY', text: 'old {{1}} {{2}} {{3}} {{4}} {{5}}' }]
    }
  }, db);
  await repository.upsertSyncedWhatsAppTemplate({
    ...syncBase,
    channelId: ids.channelB,
    wabaId: 'waba-b',
    metaTemplateName: 'sync_identity_channel_b',
    status: 'PENDING',
    providerDefinition: {
      components: [{ type: 'BODY', text: 'channel b {{1}} {{2}} {{3}} {{4}} {{5}}' }]
    }
  }, db);
  const updated = await repository.upsertSyncedWhatsAppTemplate({
    ...syncBase,
    channelId: ids.channelA,
    status: 'APPROVED',
    localDefinition: { source: 'must_not_replace_local_definition' },
    localMetadata: {
      operationalAlertContract: 'must_not_replace_local_contract',
      formatter: { key: 'wrong', version: 99 }
    },
    providerDefinition: {
      components: [{ type: 'BODY', text: 'new {{1}} {{2}} {{3}} {{4}} {{5}}' }]
    },
    providerMetadata: { source: 'meta_sync', requestMarker: 'second' }
  }, db);

  assert.equal(updated.status, 'approved');
  assert.equal(updated.definition.source, 'sync_only_blueprint');
  assert.equal(updated.definition.provider.components[0].text, 'new {{1}} {{2}} {{3}} {{4}} {{5}}');
  assert.equal(updated.metadata.operationalAlertContract, 'operational_alert_body_parameters_v1');
  assert.deepEqual(updated.metadata.formatter, { key: 'inventory_lot_expiring', version: 1 });
  assert.equal(updated.metadata.providerSync.requestMarker, 'second');

  const syncRows = await db.query(`
    SELECT "channelId", "wabaId", status, definition
    FROM whatsapp_templates
    WHERE "clinicId" = $1 AND "templateKey" = 'sync_identity' AND language = 'es_AR'
    ORDER BY "channelId"
  `, [ids.clinicA]);
  assert.equal(syncRows.rows.length, 2);
  const channelBRow = syncRows.rows.find((row) => row.channelId === ids.channelB);
  assert.equal(channelBRow.status, 'pending');
  assert.match(channelBRow.definition.provider.components[0].text, /channel b/);

  const formatter = require(path.join(root, 'src/operational-alerts/operational-alert-formatter.js'));
  assert.deepEqual(formatter.validateOperationalAlertTemplateContract(updated, {
    metadata: {
      bodyParameterCount: 5,
      templateSpecification: {
        templateKey: 'sync_identity',
        language: 'es_AR',
        category: 'UTILITY',
        bodyParameterCount: 5
      }
    }
  }), { ok: true });

  const unknownCategory = await repository.upsertSyncedWhatsAppTemplate({
    ...syncBase,
    channelId: ids.channelA,
    templateKey: 'unknown_category',
    metaTemplateName: 'unknown_category',
    category: null,
    status: 'A_NEW_META_STATE',
    providerDefinition: { components: [] }
  }, db);
  assert.equal(unknownCategory.category, 'UNKNOWN');
  assert.equal(unknownCategory.status, 'unknown');
  await assert.rejects(
    repository.upsertSyncedWhatsAppTemplate({
      ...syncBase,
      channelId: ids.channelA,
      templateKey: 'provider_definition_missing',
      metaTemplateName: 'provider_definition_missing',
      status: 'PENDING'
    }, db),
    /whatsapp_template_provider_components_required/
  );

  await db.close();
}

function testDomainAndBlueprintContracts() {
  const domain = require(path.join(root, 'src/whatsapp/whatsapp-template-domain.js'));
  assert.equal(domain.normalizeWhatsAppTemplateCategory(null), 'UNKNOWN');
  assert.equal(domain.normalizeWhatsAppTemplateCategory('unexpected'), 'UNKNOWN');
  assert.equal(domain.normalizeWhatsAppTemplateLanguage('es'), 'es');
  assert.notEqual(domain.normalizeWhatsAppTemplateLanguage('es'), 'es_AR');
  assert.equal(domain.normalizeWhatsAppTemplateStatus('IN_REVIEW'), 'in_review');
  assert.equal(domain.normalizeWhatsAppTemplateStatus('IN_APPEAL'), 'in_appeal');
  assert.equal(domain.normalizeWhatsAppTemplateStatus('new_meta_state'), 'unknown');
  assert.equal(domain.isWhatsAppTemplateStatusUsable('APPROVED'), true);
  assert.equal(domain.isWhatsAppTemplateStatusUsable('REINSTATED'), false);
  assert.equal(domain.isWhatsAppTemplateStatusUsable('new_meta_state'), false);

  const blueprints = require(path.join(root, 'src/whatsapp/template-blueprints.js'));
  const syncBlueprint = blueprints.findSyncTemplateBlueprintByProviderIdentity(
    'inventory_lot_expiring_v1',
    'es_AR'
  );
  assert.equal(syncBlueprint.key, 'inventory_lot_expiring_v1');
  assert.equal(syncBlueprint.syncOnly, true);
  assert.equal(syncBlueprint.category, 'UTILITY');
  assert.equal(syncBlueprint.bodyParameterCount, 5);
  assert.deepEqual(syncBlueprint.variables, ['title', 'summary', 'items', 'overflow', 'footer']);
  assert.deepEqual(syncBlueprint.formatter, { key: 'inventory_lot_expiring', version: 1 });
  assert.equal(blueprints.findSyncTemplateBlueprintByProviderIdentity('inventory_lot_expiring_v1', 'es'), null);
  assert.equal(blueprints.findTemplateBlueprintByKey('inventory_lot_expiring_v1'), null);
  assert.ok(!blueprints.listTemplateBlueprints().some((item) => item.key === 'inventory_lot_expiring_v1'));
  assert.ok(blueprints.listSyncTemplateBlueprints().some((item) => item.key === 'inventory_lot_expiring_v1'));

  const readinessSource = fs.readFileSync(
    path.join(root, 'src/services/portal-operational-alerts.service.js'),
    'utf8'
  );
  assert.match(
    readinessSource,
    /findTemplate\(\{\s*clinicId:\s*clinic\.id,\s*channelId:\s*rule\.channelId,\s*wabaId:\s*channel\.wabaId,\s*templateKey:\s*rule\.templateKey,\s*language:\s*rule\.templateLanguage/s
  );
}

async function main() {
  await testPrechecks();
  await testMigrationAndRepository();
  testDomainAndBlueprintContracts();
  console.log('whatsapp-template-channel-waba-identity.test.js passed (A-U)');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
