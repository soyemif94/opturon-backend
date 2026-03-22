require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const { closePool, query } = require('./client');
const { ensureClinicConversationFlowAutomations } = require('../services/automation-runtime.service');

async function resolveClinic({ clinicId = null, externalTenantId = null } = {}) {
  if (clinicId) {
    const result = await query(
      `SELECT id, name, "externalTenantId"
       FROM clinics
       WHERE id = $1::uuid
       LIMIT 1`,
      [clinicId]
    );
    return result.rows[0] || null;
  }

  if (externalTenantId) {
    const result = await query(
      `SELECT id, name, "externalTenantId"
       FROM clinics
       WHERE "externalTenantId" = $1
       LIMIT 1`,
      [externalTenantId]
    );
    return result.rows[0] || null;
  }

  throw new Error('Provide CLINIC_ID or EXTERNAL_TENANT_ID to seed conversation automations.');
}

async function run() {
  const clinicId = String(process.env.CLINIC_ID || '').trim() || null;
  const externalTenantId = String(process.env.EXTERNAL_TENANT_ID || process.env.SEED_EXTERNAL_TENANT_ID || '').trim() || null;
  const clinic = await resolveClinic({ clinicId, externalTenantId });

  if (!clinic) {
    throw new Error('Clinic not found for provided CLINIC_ID/EXTERNAL_TENANT_ID.');
  }

  const ensured = await ensureClinicConversationFlowAutomations({
    clinicId: clinic.id,
    externalTenantId: clinic.externalTenantId || externalTenantId || null
  });

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'conversation_automations_seeded',
      clinicId: clinic.id,
      clinicName: clinic.name,
      externalTenantId: clinic.externalTenantId || null,
      results: ensured.map((item) => ({
        action: item.action,
        id: item.automation ? item.automation.id : null,
        name: item.automation ? item.automation.name : null
      })),
      ts: new Date().toISOString()
    })
  );
}

run()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'conversation_automations_seed_failed',
        error: error.message,
        ts: new Date().toISOString()
      })
    );
    await closePool();
    process.exit(1);
  });
