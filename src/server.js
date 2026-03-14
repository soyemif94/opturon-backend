const path = require('path');
const dotenv = require('dotenv');
const http = require('http');
const crypto = require('crypto');

const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

const createApp = require('./app');
const env = require('./config/env');
const { logInfo } = require('./utils/logger');
const { autoDetectPhoneNumberId } = require('./whatsapp/whatsapp.service');
const buildInfo = require('./utils/build');

env.validateEnvOrExit();

const app = createApp();
const host = '0.0.0.0';
const runWorkerInWeb = String(process.env.RUN_WORKER_IN_WEB || '').trim().toLowerCase() === 'true';
const expectedMetaAppSecret = 'b6259ab44b50ea6976c928cd5d8c6932';

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

console.log('[BOOT]', {
  cwd: process.cwd(),
  envPath: buildInfo.envPath,
  envExists: buildInfo.envExists
});

console.log('[BUILD]', {
  buildId: buildInfo.buildId,
  pid: process.pid,
  file: buildInfo.file,
  cwd: buildInfo.cwd
});

console.log('[ENV]', {
  WHATSAPP_DEBUG: env.whatsappDebug,
  DEBUG_API_ENABLED: env.debugApiEnabled
});

if (env.whatsappDebug && env.debugApiEnabled) {
  console.log('[DEBUG] Debug routes enabled');
}

const server = http.createServer(app);
server.requestTimeout = 30000;
server.headersTimeout = 35000;
server.keepAliveTimeout = 5000;

server.listen(env.port, host, () => {
  logInfo('Server started', {
    host,
    port: env.port,
    env: env.nodeEnv,
    apiVersion: env.whatsappGraphVersion || env.whatsappApiVersion,
    phoneNumberId: env.whatsappPhoneNumberId,
    verifySignatureEnabled: env.verifySignature,
    sandboxArNormalizeEnabled: env.whatsappSandboxArNormalize,
    debugEnabled: env.whatsappDebug,
    tokenLen: env.whatsappAccessToken.length
  });

  logInfo('meta_app_secret_runtime_check', {
    exists: Boolean(env.metaAppSecret),
    runtimeLength: String(env.metaAppSecret || '').length,
    runtimeFingerprint: fingerprint(env.metaAppSecret),
    expectedFingerprint: fingerprint(expectedMetaAppSecret),
    metaAppSecretMatchesExpected: fingerprint(env.metaAppSecret) === fingerprint(expectedMetaAppSecret),
    verifySignatureEnabled: env.verifySignature,
    whatsappAppId: env.whatsappAppId || null
  });

  if (runWorkerInWeb) {
    const { startWorker } = require('./worker');
    logInfo('worker_embed_requested', {
      enabled: true
    });
    startWorker();
  }

  if (env.whatsappDebug) {
    if (String(env.whatsappPhoneNumberId || '').trim()) {
      logInfo('whatsapp_discovery_skipped', {
        requestId: 'startup',
        reason: 'env_phone_number_id_set',
        phoneNumberId: env.whatsappPhoneNumberId
      });
      return;
    }

    autoDetectPhoneNumberId({ requestId: 'startup', applyEnvFix: true }).catch((error) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          message: 'whatsapp_autofix_startup_failed',
          requestId: 'startup',
          error: error.message,
          ts: new Date().toISOString()
        })
      );
    });
  }
});

