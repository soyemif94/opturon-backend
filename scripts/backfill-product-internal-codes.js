const { withTransaction, closePool } = require('../src/db/client');
const { formatInternalCodeFromNumber } = require('../src/services/inventory-base.service');

function readFlag(prefix) {
  const match = process.argv.find((arg) => String(arg || '').startsWith(prefix));
  return match ? String(match).slice(prefix.length) : '';
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function buildMode() {
  return process.argv.includes('--apply') ? 'apply' : 'dry-run';
}

async function listScopedClinics(client, filters) {
  const conditions = [
    `COALESCE(
      clinics.settings -> 'portal' ->> 'accountScope',
      clinics.settings ->> 'accountScope',
      'client'
    ) <> 'opturon_admin'`
  ];
  const params = [];

  if (filters.clinicId) {
    params.push(filters.clinicId);
    conditions.push(`clinics.id = $${params.length}::uuid`);
  }

  if (filters.externalTenantId) {
    params.push(filters.externalTenantId);
    conditions.push(`clinics."externalTenantId" = $${params.length}`);
  }

  const result = await client.query(
    `SELECT clinics.id, clinics."externalTenantId"
     FROM clinics
     WHERE ${conditions.join(' AND ')}
     ORDER BY clinics."createdAt" ASC, clinics.id ASC`,
    params
  );

  return result.rows.map((row) => ({
    clinicId: row.id,
    externalTenantId: row.externalTenantId || null
  }));
}

async function ensureAllocatorBaseline(client, clinicId) {
  const maxResult = await client.query(
    `SELECT COALESCE(
        MAX(
          ((ASCII(SPLIT_PART("internalCode", '-', 1)) - 65) * 10000)
          + SPLIT_PART("internalCode", '-', 2)::int
        ),
        -1
      ) AS "maxValue"
     FROM products
     WHERE "clinicId" = $1::uuid
       AND "internalCode" ~ '^[A-Z]-[0-9]{4}$'`,
    [clinicId]
  );

  const nextValue = Number(maxResult.rows[0] && maxResult.rows[0].maxValue) + 1;
  await client.query(
    `INSERT INTO product_internal_code_allocators ("clinicId", "nextValue", "updatedAt")
     VALUES ($1::uuid, $2::int, NOW())
     ON CONFLICT ("clinicId")
     DO UPDATE SET
       "nextValue" = GREATEST(product_internal_code_allocators."nextValue", EXCLUDED."nextValue"),
       "updatedAt" = NOW()`,
    [clinicId, nextValue]
  );
}

async function getAllocatorBaseline(client, clinicId) {
  const result = await client.query(
    `SELECT
       COALESCE(
         MAX(
           ((ASCII(SPLIT_PART(p."internalCode", '-', 1)) - 65) * 10000)
           + SPLIT_PART(p."internalCode", '-', 2)::int
         ),
         -1
       ) AS "maxValue",
       (
         SELECT pia."nextValue"
         FROM product_internal_code_allocators pia
         WHERE pia."clinicId" = $1::uuid
         LIMIT 1
       ) AS "allocatorNextValue"
     FROM products p
     WHERE p."clinicId" = $1::uuid
       AND p."internalCode" ~ '^[A-Z]-[0-9]{4}$'`,
    [clinicId]
  );

  const row = result.rows[0] || {};
  const maxValue = Number(row.maxValue);
  const nextFromCodes = maxValue + 1;
  const allocatorNextValue = row.allocatorNextValue == null ? null : Number(row.allocatorNextValue);
  const baselineNextValue = allocatorNextValue == null ? nextFromCodes : Math.max(allocatorNextValue, nextFromCodes);
  return {
    maxValue,
    allocatorNextValue,
    baselineNextValue
  };
}

async function reserveNextValue(client, clinicId) {
  const result = await client.query(
    `INSERT INTO product_internal_code_allocators ("clinicId", "nextValue", "updatedAt")
     VALUES ($1::uuid, 1, NOW())
     ON CONFLICT ("clinicId")
     DO UPDATE SET
       "nextValue" = product_internal_code_allocators."nextValue" + 1,
       "updatedAt" = NOW()
     RETURNING "nextValue" - 1 AS value`,
    [clinicId]
  );
  return Number(result.rows[0] && result.rows[0].value);
}

async function listMissingProducts(client, clinicId, chunkSize) {
  const result = await client.query(
    `SELECT id
     FROM products
     WHERE "clinicId" = $1::uuid
       AND "deletedAt" IS NULL
       AND "internalCode" IS NULL
     ORDER BY "createdAt" ASC, id ASC
     LIMIT $2`,
    [clinicId, chunkSize]
  );
  return result.rows.map((row) => row.id);
}

async function countMissingProducts(client, clinicId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM products
     WHERE "clinicId" = $1::uuid
       AND "deletedAt" IS NULL
       AND "internalCode" IS NULL`,
    [clinicId]
  );
  return Number(result.rows[0] && result.rows[0].total);
}

async function processClinic(clinic, options) {
  return withTransaction(async (client) => {
    const missingBefore = await countMissingProducts(client, clinic.clinicId);
    const allocatorBaseline = await getAllocatorBaseline(client, clinic.clinicId);
    if (missingBefore === 0) {
      return {
        clinicId: clinic.clinicId,
        externalTenantId: clinic.externalTenantId,
        mode: options.mode,
        missingBefore: 0,
        assigned: 0,
        skipped: 0,
        overflow: false,
        allocatorBaseline
      };
    }

    const productIds = await listMissingProducts(client, clinic.clinicId, options.chunkSize);
    const previewUpperBound = allocatorBaseline.baselineNextValue + Math.max(0, productIds.length - 1);
    const overflow = allocatorBaseline.baselineNextValue > 259999 || previewUpperBound > 259999;

    if (options.mode !== 'apply') {
      throw {
        dryRun: true,
        result: {
          clinicId: clinic.clinicId,
          externalTenantId: clinic.externalTenantId,
          mode: options.mode,
          missingBefore,
          assigned: 0,
          skipped: Math.max(0, missingBefore - productIds.length),
          previewChunk: productIds.length,
          overflow,
          allocatorBaseline
        }
      };
    }

    if (overflow) {
      throw new Error(`internal_code_range_exhausted:${clinic.clinicId}`);
    }

    await ensureAllocatorBaseline(client, clinic.clinicId);
    let assigned = 0;
    for (const productId of productIds) {
      const nextValue = await reserveNextValue(client, clinic.clinicId);
      let internalCode;
      try {
        internalCode = formatInternalCodeFromNumber(nextValue);
      } catch (error) {
        throw new Error(`internal_code_range_exhausted:${clinic.clinicId}`);
      }

      const updateResult = await client.query(
        `UPDATE products
         SET "internalCode" = $3,
             "updatedAt" = NOW()
         WHERE id = $1::uuid
           AND "clinicId" = $2::uuid
           AND "internalCode" IS NULL
         RETURNING id`,
        [productId, clinic.clinicId, internalCode]
      );

      if (updateResult.rowCount === 0) {
        continue;
      }

      assigned += 1;
      await client.query(
        `INSERT INTO portal_user_audit_log (
          "tenantId",
          "clinicId",
          "actorUserId",
          "targetUserId",
          action,
          payload
        )
        VALUES ($1::text, $2::uuid, NULL, NULL, 'product_internal_code_backfilled', $3::jsonb)`,
        [
          clinic.externalTenantId || clinic.clinicId,
          clinic.clinicId,
          JSON.stringify({
            productId,
            internalCode,
            source: 'backfill_product_internal_codes',
            mode: options.mode
          })
        ]
      );
    }

    return {
      clinicId: clinic.clinicId,
      externalTenantId: clinic.externalTenantId,
      mode: options.mode,
      missingBefore,
      assigned,
      skipped: Math.max(0, missingBefore - assigned),
      overflow: false,
      allocatorBaseline: {
        ...allocatorBaseline,
        baselineNextValue: allocatorBaseline.baselineNextValue + assigned
      }
    };
  }).catch((error) => {
    if (error && error.dryRun) {
      return error.result;
    }
    throw error;
  });
}

async function main() {
  const options = {
    mode: buildMode(),
    clinicId: normalizeString(readFlag('--clinic-id=')) || null,
    externalTenantId: normalizeString(readFlag('--tenant-id=')) || null,
    chunkSize: parsePositiveInt(readFlag('--chunk='), 250)
  };

  const clinics = await withTransaction((client) => listScopedClinics(client, options));
  const results = [];
  for (const clinic of clinics) {
    results.push(await processClinic(clinic, options));
  }

  const summary = results.reduce(
    (accumulator, item) => {
      accumulator.tenants += 1;
      accumulator.assigned += Number(item.assigned || 0);
      accumulator.missingBefore += Number(item.missingBefore || 0);
      return accumulator;
    },
    { tenants: 0, assigned: 0, missingBefore: 0 }
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: options.mode,
        chunkSize: options.chunkSize,
        clinicFilterApplied: Boolean(options.clinicId || options.externalTenantId),
        summary,
        results
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          mode: buildMode(),
          error: error instanceof Error ? error.message : String(error || 'unknown_error')
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
