const { createScriptPgClient } = require('./lib/postgres-cli');
const { parseArgs, runInventoryLotLocationBackfill } = require('./lib/inventory-lot-preflight');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = createScriptPgClient();
  await client.connect();

  try {
    const result = await runInventoryLotLocationBackfill(client, args);
    console.log(JSON.stringify(result, null, 2));
    await client.end();
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }, null, 2));
  process.exitCode = 1;
});
