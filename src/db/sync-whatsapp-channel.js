const { closePool } = require('./client');
const { getConfiguredChannelStatus } = require('../services/channel-resolution.service');

async function run() {
  const result = await getConfiguredChannelStatus({
    requestId: 'db-sync-whatsapp-channel',
    autoCreate: true
  });

  console.log(
    JSON.stringify(
      {
        level: result.ok ? 'info' : 'error',
        message: result.ok ? 'whatsapp_channel_sync_complete' : 'whatsapp_channel_sync_failed',
        ...result,
        ts: new Date().toISOString()
      },
      null,
      2
    )
  );

  if (!result.ok) {
    process.exitCode = 1;
  }
}

run()
  .catch((error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'whatsapp_channel_sync_failed',
        error: error.message,
        ts: new Date().toISOString()
      })
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
