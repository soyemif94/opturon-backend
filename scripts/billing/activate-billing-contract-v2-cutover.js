// Administrative, import-safe, dry-run by default. Never imports production env.
const { validateRuntimeState } = require('../../src/repositories/saas-billing-runtime.repository');

async function activateCutover(client, { apply = false } = {}) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await client.query('SELECT * FROM saas_billing_runtime_state WHERE id = 1 FOR UPDATE');
    const state = validateRuntimeState(result.rows[0]);
    if (state.generation !== 1) throw new Error('billing_cutover_already_active');
    if (!apply) { await client.query('ROLLBACK'); return { dryRun: true, generation: 1, safetyWindowHours: 24 }; }
    const updated = await client.query(`WITH activation AS (SELECT clock_timestamp() AS at)
      UPDATE saas_billing_runtime_state SET generation = 2, "billingContractV2CutoverActive" = true,
      "cutoverAt" = activation.at, "autoApplyNotBefore" = activation.at + INTERVAL '24 hours',
      "updatedAt" = activation.at FROM activation WHERE id = 1 RETURNING *`);
    const next = validateRuntimeState(updated.rows[0]);
    await client.query('COMMIT');
    return { dryRun: false, generation: next.generation, cutoverAt: next.cutoverAt, autoApplyNotBefore: next.autoApplyNotBefore };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || args.length > 1) throw new Error('invalid_arguments');
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try { await client.connect(); console.log(JSON.stringify(await activateCutover(client, { apply: args.includes('--apply') }))); }
  finally { await client.end(); }
}
if (require.main === module) main().catch(() => { console.error('billing_cutover_failed'); process.exitCode = 1; });
module.exports = { activateCutover };
