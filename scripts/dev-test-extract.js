const fs = require('fs/promises');
const path = require('path');
const { processInboundMessages } = require('../src/conversations/conversation.service');

async function main() {
  const filePath = path.resolve(__dirname, 'dev-test-webhook.json');
  const raw = await fs.readFile(filePath, 'utf-8');
  const payload = JSON.parse(raw);

  const result = await processInboundMessages({
    body: payload,
    headers: {},
    requestId: 'dev-test-extract'
  });

  console.log(
    JSON.stringify(
      {
        success: true,
        result
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        success: false,
        error: error.message
      },
      null,
      2
    )
  );
  process.exit(1);
});
