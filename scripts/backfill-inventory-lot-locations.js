const { Client } = require('pg');

function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'apply') {
      options.apply = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) continue;
    options[key] = next;
    index += 1;
  }
  return options;
}

function normalizeText(value) {
  return String(value || '').trim().toUpperCase();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new Client();
  await client.connect();
  await client.query('BEGIN');
  if (!args.apply) {
    await client.query('SET TRANSACTION READ ONLY');
  }

  try {
    const lotRows = await client.query(
      `SELECT l.id, l."tenantId", l."warehouseName", l."locationName", l."locationId"
       FROM inventory_lots l
       WHERE 1 = 1
         ${args.tenant ? 'AND l."tenantId" = $1::uuid' : ''}
       ORDER BY l."tenantId", l."createdAt" ASC`,
      args.tenant ? [args.tenant] : []
    );

    const locationRows = await client.query(
      `SELECT id, "tenantId", code, name, "isPrimary", active
       FROM inventory_locations
       ${args.tenant ? 'WHERE "tenantId" = $1::uuid' : ''}
       ORDER BY "tenantId", "isPrimary" DESC, name ASC`,
      args.tenant ? [args.tenant] : []
    );

    const byTenant = new Map();
    for (const row of locationRows.rows) {
      const list = byTenant.get(row.tenantId) || [];
      list.push(row);
      byTenant.set(row.tenantId, list);
    }

    const proposals = lotRows.rows.map((row) => {
      if (row.locationId) {
        return {
          lotId: row.id,
          tenantId: row.tenantId,
          classification: 'already_assigned',
          matchedLocationId: null
        };
      }

      const locations = byTenant.get(row.tenantId) || [];
      const source = normalizeText(row.locationName || row.warehouseName);
      const exact = locations.filter((location) => normalizeText(location.name) === source || normalizeText(location.code) === source);
      const activeExact = exact.filter((location) => location.active !== false);
      const exactOutsideTenant = locationRows.rows.filter(
        (location) =>
          location.tenantId !== row.tenantId &&
          (normalizeText(location.name) === source || normalizeText(location.code) === source)
      );

      let classification = 'no_match';
      let matchedLocationId = null;
      if (activeExact.length === 1) {
        classification = 'exact_match';
        matchedLocationId = activeExact[0].id;
      } else if (activeExact.length > 1) {
        classification = 'ambiguous_match';
      } else if (exact.length > 0) {
        classification = 'inactive_location';
      } else if (exactOutsideTenant.length > 0) {
        classification = 'tenant_mismatch';
      }

      return {
        lotId: row.id,
        tenantId: row.tenantId,
        classification,
        matchedLocationId
      };
    });

    if (args.apply) {
      for (const proposal of proposals) {
        if (proposal.classification !== 'exact_match' || !proposal.matchedLocationId) continue;
        await client.query(
          `UPDATE inventory_lots
           SET "locationId" = $3::uuid
           WHERE id = $1::uuid
             AND "tenantId" = $2::uuid
             AND "locationId" IS NULL`,
          [proposal.lotId, proposal.tenantId, proposal.matchedLocationId]
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          apply: args.apply,
          readOnlyTransaction: args.apply !== true,
          proposals: proposals.map((item) => ({
            lotId: `${String(item.lotId).slice(0, 8)}...`,
            tenantId: `${String(item.tenantId).slice(0, 8)}...`,
            classification: item.classification,
            matchedLocationId: item.matchedLocationId ? `${String(item.matchedLocationId).slice(0, 8)}...` : null,
          })),
          summary: proposals.reduce((acc, item) => {
            acc[item.classification] = Number(acc[item.classification] || 0) + 1;
            return acc;
          }, {})
        },
        null,
        2
      )
    );

    if (args.apply) {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    await client.end();
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }, null, 2));
  process.exitCode = 1;
});
