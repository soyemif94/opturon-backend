const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { Client } = require('pg');

async function expectInsertOutcome(client, movementType, shouldPass) {
  let passed = true;
  await client.query('SAVEPOINT inventory_movement_type_check');
  try {
    await client.query(
      `INSERT INTO inventory_movements (
         id,
         "tenantId",
         "productId",
         "lotId",
         "movementType",
         quantity,
         "quantityBefore",
         "quantityAfter",
         metadata,
         "createdAt",
         status
       )
       VALUES (
         gen_random_uuid(),
         gen_random_uuid(),
         gen_random_uuid(),
         NULL,
         $1,
         1,
         0,
         1,
         '{}'::jsonb,
         NOW(),
         'posted'
       )`,
      [movementType]
    );
    await client.query('RELEASE SAVEPOINT inventory_movement_type_check');
  } catch {
    passed = false;
    await client.query('ROLLBACK TO SAVEPOINT inventory_movement_type_check');
    await client.query('RELEASE SAVEPOINT inventory_movement_type_check');
  }

  assert.strictEqual(passed, shouldPass, `${movementType} insert expectation mismatch`);
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE inventory_movements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "productId" UUID NOT NULL,
        "lotId" UUID NULL,
        "movementType" TEXT NOT NULL,
        quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
        "quantityBefore" NUMERIC(14, 3) NULL CHECK ("quantityBefore" IS NULL OR "quantityBefore" >= 0),
        "quantityAfter" NUMERIC(14, 3) NULL CHECK ("quantityAfter" IS NULL OR "quantityAfter" >= 0),
        "referenceType" TEXT NULL,
        "referenceId" UUID NULL,
        reason TEXT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        "createdBy" UUID NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "locationId" UUID NULL,
        "idempotencyKey" TEXT NULL,
        unit TEXT NULL,
        status TEXT NOT NULL DEFAULT 'posted',
        "reversalOfMovementId" UUID NULL,
        "reversedByMovementId" UUID NULL,
        CONSTRAINT chk_inventory_movements_type CHECK ("movementType" IN (
          'initial_stock',
          'purchase_receipt',
          'manual_adjustment_in',
          'manual_adjustment_out',
          'expired_writeoff',
          'cancellation',
          'sale'
        ))
      )
    `);

    await expectInsertOutcome(client, 'manual_increase', false);

    const migration066 = fs.readFileSync(
      path.join(process.cwd(), 'db', 'migrations', '066_inventory_movement_canonical_types.sql'),
      'utf8'
    );
    await client.query(migration066);

    for (const movementType of [
      'initial_stock',
      'manual_adjustment_in',
      'opening_balance',
      'manual_increase',
      'manual_decrease',
      'correction',
      'return_in',
      'return_out'
    ]) {
      await expectInsertOutcome(client, movementType, true);
    }

    await expectInsertOutcome(client, 'not_a_real_inventory_type', false);
    await client.query('ROLLBACK');
  } finally {
    try {
      if (!client._ending) {
        await client.end();
      }
    } catch {}
  }

  console.log('inventory-movement-canonical-types-migration.test.js passed');
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
