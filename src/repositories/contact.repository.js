const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

async function upsertContact({ clinicId, waId, phone, name }, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO contacts ("clinicId", "waId", phone, name, "updatedAt")
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT ("clinicId", "waId")
     DO UPDATE SET
       phone = EXCLUDED.phone,
       name = COALESCE(EXCLUDED.name, contacts.name),
       "updatedAt" = NOW()
     RETURNING id, "clinicId", "waId", phone, name, "optedOut"`,
    [clinicId, waId, phone || null, name || null]
  );

  return result.rows[0];
}

async function findContactById(contactId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", "waId", phone, name, "optedOut"
     FROM contacts WHERE id = $1 LIMIT 1`,
    [contactId]
  );

  return result.rows[0] || null;
}

module.exports = {
  upsertContact,
  findContactById
};

