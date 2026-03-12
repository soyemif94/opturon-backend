const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

const PORTAL_ROLE_SQL = `('owner', 'manager', 'seller', 'viewer', 'editor')`;

async function listPortalUsersByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            "clinicId",
            name,
            email,
            CASE WHEN role = 'editor' THEN 'seller' ELSE role END AS role,
            active,
            "createdAt",
            "updatedAt"
     FROM staff_users
     WHERE "clinicId" = $1
       AND email IS NOT NULL
       AND active = TRUE
       AND role IN ${PORTAL_ROLE_SQL}
     ORDER BY "createdAt" ASC`,
    [clinicId]
  );

  return result.rows;
}

async function countOwnersByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT COUNT(*)::INT AS count
     FROM staff_users
     WHERE "clinicId" = $1
       AND email IS NOT NULL
       AND active = TRUE
       AND role = 'owner'`,
    [clinicId]
  );

  return result.rows[0]?.count || 0;
}

async function createPortalUser(payload, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO staff_users ("clinicId", name, email, "passwordHash", role, active, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
     RETURNING id,
               "clinicId",
               name,
               email,
               CASE WHEN role = 'editor' THEN 'seller' ELSE role END AS role,
               active,
               "createdAt",
               "updatedAt"`,
    [payload.clinicId, payload.name, payload.email, payload.passwordHash, payload.role]
  );

  return result.rows[0] || null;
}

async function updatePortalUserRole(payload, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE staff_users
     SET role = $3,
         "updatedAt" = NOW()
     WHERE id = $1
       AND "clinicId" = $2
       AND role IN ${PORTAL_ROLE_SQL}
     RETURNING id,
               "clinicId",
               name,
               email,
               CASE WHEN role = 'editor' THEN 'seller' ELSE role END AS role,
               active,
               "createdAt",
               "updatedAt"`,
    [payload.userId, payload.clinicId, payload.role]
  );

  return result.rows[0] || null;
}

async function deletePortalUserById(payload, client = null) {
  const result = await dbQuery(
    client,
     `DELETE FROM staff_users
     WHERE id = $1
       AND "clinicId" = $2
       AND role IN ${PORTAL_ROLE_SQL}
     RETURNING id`,
    [payload.userId, payload.clinicId]
  );

  return result.rows[0] || null;
}

async function findPortalUserByEmail(email, client = null) {
  const result = await dbQuery(
    client,
    `SELECT su.id,
            su."clinicId",
            su.name,
            su.email,
            CASE WHEN su.role = 'editor' THEN 'seller' ELSE su.role END AS role,
            su.active,
            su."passwordHash",
            c."externalTenantId" AS "tenantId"
     FROM staff_users su
     INNER JOIN clinics c ON c.id = su."clinicId"
     WHERE LOWER(su.email) = LOWER($1)
       AND su.email IS NOT NULL
       AND su.active = TRUE
       AND su.role IN ${PORTAL_ROLE_SQL}
     LIMIT 1`,
    [email]
  );

  return result.rows[0] || null;
}

module.exports = {
  countOwnersByClinicId,
  listPortalUsersByClinicId,
  createPortalUser,
  updatePortalUserRole,
  deletePortalUserById,
  findPortalUserByEmail
};
