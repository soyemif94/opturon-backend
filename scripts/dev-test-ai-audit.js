const conversationRepo = require('../src/conversations/conversation.repo');

function parseArgValue(name, defaultValue = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => String(arg || '').startsWith(prefix));
  if (!found) return defaultValue;
  return found.slice(prefix.length);
}

async function main() {
  const conversationId = parseArgValue('conversationId', null);
  const limitRaw = parseArgValue('limit', '20');
  const limit = Number.isInteger(Number(limitRaw)) ? Number(limitRaw) : 20;

  const items = await conversationRepo.listOutboundAiAudit({
    conversationId,
    limit
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        success: true,
        count: items.length,
        items
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
