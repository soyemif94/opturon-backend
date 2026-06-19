const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');

const rootDir = path.resolve(__dirname, '..', '..');
const SCRATCH_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const POSTGRES_IMAGE = 'postgres:16-alpine';
const SCRATCH_DB = 'opturon_partners_scratch';
const SCRATCH_USER = 'postgres';
const SCRATCH_PASSWORD = 'postgres';

function modulePath(relativePath) {
  return path.join(rootDir, relativePath);
}

function runCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options
  });
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function sanitizeDbUrl(dbUrl) {
  const parsed = new URL(dbUrl);
  return `${parsed.protocol}//${parsed.username}:***@${parsed.hostname}:${parsed.port}${parsed.pathname}`;
}

async function waitForPostgres(dbUrl, timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const client = new Client({ connectionString: dbUrl });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      try {
        await client.end();
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error('scratch_postgres_not_ready');
}

async function withScratchDatabase(testFn) {
  const containerId = execFileSync(
    'docker',
    ['run', '-d', '-e', `POSTGRES_PASSWORD=${SCRATCH_PASSWORD}`, '-e', `POSTGRES_DB=${SCRATCH_DB}`, '-P', POSTGRES_IMAGE],
    { cwd: rootDir, encoding: 'utf8' }
  ).trim();

  try {
    const portOutput = execFileSync('docker', ['port', containerId, '5432/tcp'], { cwd: rootDir, encoding: 'utf8' }).trim();
    const mappedPort = portOutput.split(':').pop();
    const dbUrl = `postgresql://${SCRATCH_USER}:${SCRATCH_PASSWORD}@127.0.0.1:${mappedPort}/${SCRATCH_DB}`;

    await waitForPostgres(dbUrl);
    await testFn(dbUrl);
  } finally {
    try {
      execFileSync('docker', ['rm', '-f', containerId], { cwd: rootDir, encoding: 'utf8' });
    } catch {}
  }
}

function migrationEnv(dbUrl) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl,
    TOKENS_ENCRYPTION_KEY: SCRATCH_KEY,
    PORTAL_INTERNAL_KEY: 'scratch-internal-key'
  };
}

async function runMigration(dbUrl) {
  runCommand('node', ['src/db/migrate.js'], { env: migrationEnv(dbUrl) });
}

async function inspectSchema(client) {
  const tables = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name LIKE 'partner_%'
     ORDER BY table_name ASC`
  );
  assert.ok(tables.rows.some((row) => row.table_name === 'partner_commission_entries'));

  const monetaryColumns = await client.query(
    `SELECT column_name, data_type, numeric_precision, numeric_scale
     FROM information_schema.columns
     WHERE table_name = 'partner_commission_entries'
       AND column_name IN ('basisAmount', 'commissionRate', 'commissionAmount')
     ORDER BY column_name ASC`
  );
  const byName = new Map(monetaryColumns.rows.map((row) => [row.column_name, row]));
  assert.strictEqual(byName.get('basisAmount').data_type, 'numeric');
  assert.strictEqual(byName.get('basisAmount').numeric_scale, 2);
  assert.strictEqual(byName.get('commissionRate').data_type, 'numeric');
  assert.strictEqual(byName.get('commissionRate').numeric_scale, 2);
  assert.strictEqual(byName.get('commissionAmount').data_type, 'numeric');
  assert.strictEqual(byName.get('commissionAmount').numeric_scale, 2);

  const tenantIndex = await client.query(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'partner_client_attributions_active_tenant_idx'`
  );
  assert.strictEqual(tenantIndex.rowCount, 1);
  assert.match(tenantIndex.rows[0].indexdef, /WHERE \(status = 'active'::text\)/);

  const reversalIndex = await client.query(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'partner_commission_entries_reversal_unique_idx'`
  );
  assert.strictEqual(reversalIndex.rowCount, 1);

  const constraints = await client.query(
    `SELECT conname
     FROM pg_constraint
     WHERE conname IN (
       'partner_commission_entries_amounts_check',
       'partner_commission_entries_payment_status_check',
       'partner_relationships_self_reference_check',
       'partner_commission_plan_versions_cap_check'
     )`
  );
  assert.strictEqual(constraints.rowCount, 4);
}

async function verifyTransactionalRollback(client) {
  try {
    await client.query('BEGIN');
    await client.query('CREATE TABLE scratch_tx_probe(id INT)');
    await client.query('SELECT * FROM definitely_missing_table');
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK');
  }

  const probe = await client.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'scratch_tx_probe'`
  );
  assert.strictEqual(probe.rowCount, 0);
}

async function insertSeedData(client) {
  const adminClinicId = '10000000-0000-4000-8000-000000000001';
  const adminActorId = '10000000-0000-4000-8000-000000000010';
  const tenantAClinicId = '20000000-0000-4000-8000-000000000001';
  const tenantBClinicId = '20000000-0000-4000-8000-000000000002';
  const tenantCClinicId = '20000000-0000-4000-8000-000000000003';

  await client.query(
    `INSERT INTO clinics (id, name, timezone, settings, "externalTenantId")
     VALUES
      ($1, 'Opturon Admin', 'UTC', '{"portal":{"accountScope":"opturon_admin"}}'::jsonb, 'tenant_admin'),
      ($2, 'Tenant A', 'UTC', '{}'::jsonb, 'tenant_a'),
      ($3, 'Tenant B', 'UTC', '{}'::jsonb, 'tenant_b'),
      ($4, 'Tenant C', 'UTC', '{}'::jsonb, 'tenant_c')`,
    [adminClinicId, tenantAClinicId, tenantBClinicId, tenantCClinicId]
  );

  await client.query(
    `INSERT INTO staff_users (id, "clinicId", name, role, active, email, "passwordHash", "accountType", "accountRootUserId")
     VALUES ($1, $2, 'Admin Actor', 'owner', TRUE, 'admin@opturon.test', '$2b$10$abcdefghijklmnopqrstuv', 'internal_staff', $1)`,
    [adminActorId, adminClinicId]
  );

  return {
    adminActorId,
    tenantIds: {
      a: 'tenant_a',
      b: 'tenant_b',
      c: 'tenant_c'
    }
  };
}

async function setPartnerRank(client, partnerId, rankCode, actorId) {
  await client.query(
    `INSERT INTO partner_rank_history ("partnerId", "rankCode", "effectiveFrom", "createdByStaffUserId")
     VALUES ($1, $2, NOW(), $3)`,
    [partnerId, rankCode, actorId]
  );
}

async function exerciseScratchDomain(dbUrl) {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = dbUrl;
  process.env.TOKENS_ENCRYPTION_KEY = SCRATCH_KEY;
  process.env.PORTAL_INTERNAL_KEY = 'scratch-internal-key';

  const { query, closePool } = require(modulePath('src/db/client.js'));
  const service = require(modulePath('src/services/partners.service.js'));

  try {
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    const seed = await insertSeedData(client);
    await client.end();

    const rulesV1 = {
      recurringCapPercent: '15.00',
      rankConfigs: [
        { code: 'asesor', ownSignupRatePercent: '25.00', ownRecurringRatePercent: '10.00', lineRecurringRatePercentByDepth: ['0.00', '0.00', '0.00'] },
        { code: 'lider', ownSignupRatePercent: '27.50', ownRecurringRatePercent: '11.00', lineRecurringRatePercentByDepth: ['2.00', '0.00', '0.00'] },
        { code: 'coordinador', ownSignupRatePercent: '30.00', ownRecurringRatePercent: '12.00', lineRecurringRatePercentByDepth: ['3.00', '1.50', '0.00'] },
        { code: 'emperador', ownSignupRatePercent: '32.50', ownRecurringRatePercent: '12.00', lineRecurringRatePercentByDepth: ['4.00', '2.00', '1.00'] }
      ],
      rankThresholds: [
        { code: 'asesor', minActiveClients: 0, minGeneratedCommission: '0.00' },
        { code: 'lider', minActiveClients: 3, minGeneratedCommission: '10.00' },
        { code: 'coordinador', minActiveClients: 5, minGeneratedCommission: '20.00' },
        { code: 'emperador', minActiveClients: 8, minGeneratedCommission: '30.00' }
      ]
    };

    const partnerA = await service.createPartner({ email: 'a@partner.test', password: 'password123', displayName: 'Partner A' }, { actorStaffUserId: seed.adminActorId });
    const partnerB = await service.createPartner({ email: 'b@partner.test', password: 'password123', displayName: 'Partner B' }, { actorStaffUserId: seed.adminActorId });
    const partnerC = await service.createPartner({ email: 'c@partner.test', password: 'password123', displayName: 'Partner C' }, { actorStaffUserId: seed.adminActorId });
    assert.strictEqual(partnerA.ok, true);
    assert.strictEqual(partnerB.ok, true);
    assert.strictEqual(partnerC.ok, true);

    await service.assignPartnerSponsor(partnerA.partner.id, partnerB.partner.id, { actorStaffUserId: seed.adminActorId });
    await service.assignPartnerSponsor(partnerB.partner.id, partnerC.partner.id, { actorStaffUserId: seed.adminActorId });

    const rankClient = new Client({ connectionString: dbUrl });
    await rankClient.connect();
    await setPartnerRank(rankClient, partnerA.partner.id, 'lider', seed.adminActorId);
    await setPartnerRank(rankClient, partnerB.partner.id, 'emperador', seed.adminActorId);
    await setPartnerRank(rankClient, partnerC.partner.id, 'coordinador', seed.adminActorId);
    await rankClient.end();

    const planV1 = await service.createCommissionPlanWithVersion(
      {
        code: 'partners-v1',
        name: 'Partners V1',
        status: 'published',
        maxPayoutPercent: '15.00',
        rules: rulesV1
      },
      { actorStaffUserId: seed.adminActorId }
    );
    assert.strictEqual(planV1.ok, true);

    const attributionA = await service.attributeTenantToPartner(partnerA.partner.id, { tenantId: seed.tenantIds.a }, { actorStaffUserId: seed.adminActorId });
    assert.strictEqual(attributionA.ok, true);

    const generationPayload = {
      tenantId: seed.tenantIds.a,
      sourceType: 'subscription',
      sourceRef: 'payment-1',
      sourceEventId: 'payment-evt-1',
      eventType: 'subscription_recurring_accredited',
      eventAt: '2026-06-19T00:00:00.000Z',
      basisAmount: '100.05',
      paymentStatus: 'accredited',
      reversed: false
    };

    const [gen1, gen2] = await Promise.all([
      service.simulateCommissionEntries(generationPayload, { persist: true, actorStaffUserId: seed.adminActorId }),
      service.simulateCommissionEntries(generationPayload, { persist: true, actorStaffUserId: seed.adminActorId })
    ]);
    assert.strictEqual(gen1.ok, true);
    assert.strictEqual(gen2.ok, true);
    assert.ok(gen1.reusedExisting || gen2.reusedExisting);

    const entriesAfterGeneration = await query(
      `SELECT COUNT(*)::INT AS count
       FROM partner_commission_entries
       WHERE "sourceRef" = 'payment-1'
         AND "sourceEventId" = 'payment-evt-1'
         AND status = 'generated'`
    );
    assert.strictEqual(entriesAfterGeneration.rows[0].count, 2);

    const generatedRows = await query(
      `SELECT id, "commissionRate", "commissionAmount", "planVersionNumberSnapshot", "planCodeSnapshot"
       FROM partner_commission_entries
       WHERE "sourceRef" = 'payment-1'
         AND "sourceEventId" = 'payment-evt-1'
         AND status = 'generated'
       ORDER BY "depthLevel" ASC`
    );
    assert.deepStrictEqual(
      generatedRows.rows.map((row) => row.commissionRate),
      ['11.00', '4.00']
    );

    const reverse1 = await service.reverseCommissionEntries({ entryId: generatedRows.rows[0].id, reason: 'scratch_reverse' }, { actorStaffUserId: seed.adminActorId });
    const reverse2 = await service.reverseCommissionEntries({ entryId: generatedRows.rows[0].id, reason: 'scratch_reverse' }, { actorStaffUserId: seed.adminActorId });
    assert.strictEqual(reverse1.ok, true);
    assert.strictEqual(reverse2.ok, false);
    assert.strictEqual(reverse2.reason, 'partner_commission_entry_already_reversed');

    const pending = await service.simulateCommissionEntries(
      {
        ...generationPayload,
        sourceRef: 'payment-pending',
        sourceEventId: 'payment-pending-evt',
        paymentStatus: 'pending'
      },
      { persist: false }
    );
    assert.strictEqual(pending.ok, false);
    assert.strictEqual(pending.reason, 'partner_commission_payment_not_eligible');

    const rulesV2 = {
      ...rulesV1,
      rankConfigs: rulesV1.rankConfigs.map((config) =>
        config.code === 'lider'
          ? { ...config, ownRecurringRatePercent: '12.00' }
          : config
      )
    };
    const planV2 = await service.addCommissionPlanVersion(
      'partners-v1',
      {
        status: 'published',
        maxPayoutPercent: '15.00',
        rules: rulesV2
      },
      { actorStaffUserId: seed.adminActorId }
    );
    assert.strictEqual(planV2.ok, true);

    const historicalEntry = await query(
      `SELECT "commissionRate", "commissionAmount", "planVersionNumberSnapshot", "planCodeSnapshot"
       FROM partner_commission_entries
       WHERE id = $1`,
      [generatedRows.rows[0].id]
    );
    assert.strictEqual(historicalEntry.rows[0].planVersionNumberSnapshot, 1);
    assert.strictEqual(historicalEntry.rows[0].planCodeSnapshot, 'partners-v1');
    assert.strictEqual(historicalEntry.rows[0].commissionRate, '11.00');

    const [attrRace1, attrRace2] = await Promise.all([
      service.attributeTenantToPartner(partnerA.partner.id, { tenantId: seed.tenantIds.b }, { actorStaffUserId: seed.adminActorId }),
      service.attributeTenantToPartner(partnerB.partner.id, { tenantId: seed.tenantIds.b }, { actorStaffUserId: seed.adminActorId })
    ]);
    assert.ok(
      (attrRace1.ok === true && attrRace2.ok === false && attrRace2.reason === 'tenant_already_attributed') ||
      (attrRace2.ok === true && attrRace1.ok === false && attrRace1.reason === 'tenant_already_attributed')
    );

    const selfSponsor = await service.assignPartnerSponsor(partnerA.partner.id, partnerA.partner.id, { actorStaffUserId: seed.adminActorId });
    assert.strictEqual(selfSponsor.ok, false);
    assert.strictEqual(selfSponsor.reason, 'partner_sponsor_self_reference');

    const cycleTwo = await service.assignPartnerSponsor(partnerC.partner.id, partnerA.partner.id, { actorStaffUserId: seed.adminActorId });
    assert.strictEqual(cycleTwo.ok, false);
    assert.strictEqual(cycleTwo.reason, 'partner_sponsor_cycle_detected');

    const capExceededPlan = await service.createCommissionPlanWithVersion(
      {
        code: 'partners-cap-bad',
        name: 'Partners Cap Bad',
        status: 'draft',
        maxPayoutPercent: '15.00',
        rules: {
          recurringCapPercent: '16.00',
          rankConfigs: [{ code: 'asesor', ownSignupRatePercent: '25.00', ownRecurringRatePercent: '10.00', lineRecurringRatePercentByDepth: ['0.00'] }]
        }
      },
      { actorStaffUserId: seed.adminActorId }
    );
    assert.strictEqual(capExceededPlan.ok, false);
    assert.strictEqual(capExceededPlan.reason, 'invalid_partner_commission_rules');

    return {
      planVersion1Id: planV1.version.id,
      planVersion2Id: planV2.version.id,
      generatedEntryCount: entriesAfterGeneration.rows[0].count
    };
  } finally {
    await closePool();
  }
}

async function main() {
  await withScratchDatabase(async (dbUrl) => {
    console.log(JSON.stringify({
      scratchDatabase: sanitizeDbUrl(dbUrl),
      note: 'scratch_only_not_production'
    }));

    await runMigration(dbUrl);
    await runMigration(dbUrl);

    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    await inspectSchema(client);
    await verifyTransactionalRollback(client);
    await client.end();

    const domainSummary = await exerciseScratchDomain(dbUrl);
    console.log(JSON.stringify({
      migrationScratch: 'ok',
      schemaInspection: 'ok',
      domainSummary
    }));
  });

  console.log('partners-scratch-postgres.test.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
