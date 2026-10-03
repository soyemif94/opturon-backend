function validateRuntimeState(row) {
  if (!row || row.id !== 1 || row.schemaVersion !== 1) throw new Error('billing_runtime_state_invalid');
  const legacy = row.generation === 1 && row.billingContractV2CutoverActive === false
    && row.cutoverAt === null && row.autoApplyNotBefore === null;
  const cutover = new Date(row.cutoverAt).getTime();
  const boundary = new Date(row.autoApplyNotBefore).getTime();
  const v2 = row.generation === 2 && row.billingContractV2CutoverActive === true
    && row.cutoverAt !== null && Number.isFinite(cutover) && boundary - cutover === 86400000;
  if (!legacy && !v2) throw new Error('billing_runtime_state_invalid');
  return row;
}

async function readRuntimeState(client = require('../db/client'), { lock = false } = {}) {
  const result = await client.query(`SELECT * FROM saas_billing_runtime_state WHERE id = 1${lock ? ' FOR SHARE' : ''}`);
  return validateRuntimeState(result.rows[0]);
}

async function requireGeneration(generation, client = require('../db/client'), { lock = false } = {}) {
  const state = await readRuntimeState(client, { lock });
  if (state.generation !== generation) throw new Error('billing_runtime_generation_disabled');
  return state;
}

module.exports = { validateRuntimeState, readRuntimeState, requireGeneration };
