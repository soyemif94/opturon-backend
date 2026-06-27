const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function createCatalogImportAuditEvent(entry, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO catalog_import_audit_log (
      "importId",
      "tenantId",
      "clinicId",
      "actorId",
      "actorName",
      action,
      payload
    )
    VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb))
    RETURNING id, "importId", "tenantId", "clinicId", "actorId", "actorName", action, payload, "createdAt"`,
    [
      entry.importId,
      entry.tenantId,
      entry.clinicId,
      entry.actorId || null,
      entry.actorName || null,
      entry.action,
      JSON.stringify(entry.payload || {})
    ]
  );

  return result.rows[0] || null;
}

module.exports = {
  createCatalogImportAuditEvent
};
