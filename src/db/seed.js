const env = require('../config/env');
const { query, closePool } = require('./client');

async function ensureSeedInputs() {
  const clinicName = String(process.env.SEED_CLINIC_NAME || 'Clinica Demo').trim();
  const phoneNumberId = String(process.env.SEED_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const wabaId = String(process.env.SEED_WABA_ID || process.env.WHATSAPP_WABA_ID || '').trim();
  const accessToken = String(process.env.SEED_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
  const externalTenantId = String(process.env.SEED_EXTERNAL_TENANT_ID || process.env.SEED_TENANT_ID || '').trim();
  const staffName = String(process.env.SEED_STAFF_NAME || 'Recepcion').trim();

  if (!phoneNumberId) {
    throw new Error('SEED_PHONE_NUMBER_ID is required for db:seed');
  }

  return {
    clinicName,
    phoneNumberId,
    wabaId: wabaId || null,
    accessToken: accessToken || null,
    externalTenantId: externalTenantId || null,
    staffName: staffName || 'Recepcion'
  };
}

async function getOrCreateClinic(clinicName, externalTenantId = null) {
  const existing = await query(
    `SELECT id, name, "externalTenantId" FROM clinics WHERE name = $1 ORDER BY "createdAt" ASC LIMIT 1`,
    [clinicName]
  );

  if (existing.rows[0]) {
    if (externalTenantId && existing.rows[0].externalTenantId !== externalTenantId) {
      const updated = await query(
        `UPDATE clinics
         SET "externalTenantId" = $2,
             "updatedAt" = NOW()
         WHERE id = $1
         RETURNING id, name, "externalTenantId"`,
        [existing.rows[0].id, externalTenantId]
      );
      return updated.rows[0];
    }
    return existing.rows[0];
  }

  const inserted = await query(
    `INSERT INTO clinics (name, "externalTenantId") VALUES ($1, $2) RETURNING id, name, "externalTenantId"`,
    [clinicName, externalTenantId]
  );

  return inserted.rows[0];
}

async function upsertChannel({ clinicId, phoneNumberId, wabaId, accessToken }) {
  const result = await query(
    `INSERT INTO channels ("clinicId", provider, "phoneNumberId", "wabaId", "accessToken", status, "updatedAt")
     VALUES ($1, 'whatsapp_cloud', $2, $3, $4, 'active', NOW())
     ON CONFLICT ("phoneNumberId")
     DO UPDATE SET
       "clinicId" = EXCLUDED."clinicId",
       "wabaId" = COALESCE(EXCLUDED."wabaId", channels."wabaId"),
       "accessToken" = COALESCE(EXCLUDED."accessToken", channels."accessToken"),
       status = 'active',
       "updatedAt" = NOW()
     RETURNING id, "clinicId", "phoneNumberId"`,
    [clinicId, phoneNumberId, wabaId, accessToken]
  );

  return result.rows[0];
}

async function runSeed() {
  const seed = await ensureSeedInputs();
  const clinic = await getOrCreateClinic(seed.clinicName, seed.externalTenantId);
  const channel = await upsertChannel({
    clinicId: clinic.id,
    phoneNumberId: seed.phoneNumberId,
    wabaId: seed.wabaId,
    accessToken: seed.accessToken
  });

  const rules = await query(
    `INSERT INTO calendar_rules (
      "clinicId", timezone, "slotMinutes", "leadTimeMinutes", "workDays", "workHours", "breakHours", "updatedAt"
    )
    VALUES (
      $1, 'America/Argentina/Buenos_Aires', 30, 60, '[1,2,3,4,5]'::jsonb, '{"start":"09:00","end":"18:00"}'::jsonb, '{"start":"13:00","end":"14:00"}'::jsonb, NOW()
    )
    ON CONFLICT ("clinicId")
    DO UPDATE SET "updatedAt" = NOW()
    RETURNING id`,
    [clinic.id]
  );

  const existingStaff = await query(
    `SELECT id, name
     FROM staff_users
     WHERE "clinicId" = $1
       AND "accountType" = 'internal_staff'
       AND name = $2
     LIMIT 1`,
    [clinic.id, seed.staffName]
  );

  let staff = existingStaff.rows[0] || null;
  if (!staff) {
    const insertedStaff = await query(
      `INSERT INTO staff_users ("clinicId", name, role, "accountType", active, "updatedAt")
       VALUES ($1, $2, 'staff', 'internal_staff', TRUE, NOW())
       RETURNING id, name`,
      [clinic.id, seed.staffName]
    );
    staff = insertedStaff.rows[0] || null;
  }

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'db_seed_complete',
      clinicId: clinic.id,
      clinicName: clinic.name,
      externalTenantId: clinic.externalTenantId || null,
      channelId: channel.id,
      phoneNumberId: channel.phoneNumberId,
      calendarRulesId: rules.rows[0] ? rules.rows[0].id : null,
      staffCreated: !!staff,
      staffName: staff ? staff.name : seed.staffName,
      tokenStored: Boolean(seed.accessToken),
      tokenLen: seed.accessToken ? seed.accessToken.length : 0,
      ts: new Date().toISOString()
    })
  );
}

runSeed()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'db_seed_failed',
        error: error.message,
        ts: new Date().toISOString()
      })
    );
    await closePool();
    process.exit(1);
  });

