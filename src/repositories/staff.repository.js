const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function listActiveStaff(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", name, role, active
     FROM staff_users
     WHERE "clinicId" = $1 AND active = TRUE
     ORDER BY "createdAt" ASC`,
    [clinicId]
  );

  return result.rows;
}

async function getDefaultAssignee(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", name, role, active
     FROM staff_users
     WHERE "clinicId" = $1 AND active = TRUE
     ORDER BY "createdAt" ASC
     LIMIT 1`,
    [clinicId]
  );

  return result.rows[0] || null;
}

async function upsertDemoStaff(clinicId, name, client = null) {
  const safeName = String(name || 'Recepcion').trim();
  const existing = await dbQuery(
    client,
    `SELECT id, "clinicId", name, role, active
     FROM staff_users
     WHERE "clinicId" = $1 AND name = $2
     LIMIT 1`,
    [clinicId, safeName]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const inserted = await dbQuery(
    client,
    `INSERT INTO staff_users ("clinicId", name, role, active, "updatedAt")
     VALUES ($1, $2, 'staff', TRUE, NOW())
     RETURNING id, "clinicId", name, role, active`,
    [clinicId, safeName]
  );

  return inserted.rows[0];
}

module.exports = {
  listActiveStaff,
  getDefaultAssignee,
  upsertDemoStaff
};

