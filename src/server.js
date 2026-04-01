const path = require('path');
const dotenv = require('dotenv');
const http = require('http');
const crypto = require('crypto');

const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

const createApp = require('./app');
const env = require('./config/env');
const { logInfo, logWarn, logError } = require('./utils/logger');
const { autoDetectPhoneNumberId } = require('./whatsapp/whatsapp.service');
const buildInfo = require('./utils/build');

const app = createApp();
const host = '0.0.0.0';
const runWorkerInWeb = String(process.env.RUN_WORKER_IN_WEB || '').trim().toLowerCase() === 'true';
const expectedMetaAppSecret = 'b6259ab44b50ea6976c928cd5d8c6932';
const envValidation = env.collectEnvValidation();

console.log('WORKER_MODE', {
  runInWeb: process.env.RUN_WORKER_IN_WEB,
  pid: process.pid
});

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

logInfo('server_starting', {
  host,
  port: env.port,
  env: env.nodeEnv,
  pid: process.pid,
  buildId: buildInfo.buildId,
  commitSha: buildInfo.commitSha,
  branchName: buildInfo.branchName,
  serviceName: buildInfo.serviceName,
  cwd: process.cwd(),
  envPath: buildInfo.envPath,
  envExists: buildInfo.envExists,
  runWorkerInWeb,
  envValidation
});

if (env.whatsappDebug && env.debugApiEnabled) {
  console.log('[DEBUG] Debug routes enabled');
}

const server = http.createServer(app);
server.requestTimeout = 30000;
server.headersTimeout = 35000;
server.keepAliveTimeout = 5000;

server.listen(env.port, host, () => {
  logInfo('server_started', {
    host,
    port: env.port,
    env: env.nodeEnv,
    apiVersion: env.whatsappGraphVersion,
    phoneNumberId: env.whatsappPhoneNumberId,
    verifySignatureEnabled: env.verifySignature,
    sandboxArNormalizeEnabled: env.whatsappSandboxArNormalize,
    debugEnabled: env.whatsappDebug,
    tokenLen: env.whatsappAccessToken.length
  });

  if (envValidation.warnings.length > 0) {
    logWarn('server_started_with_env_warnings', {
      port: env.port,
      env: env.nodeEnv,
      warnings: envValidation.warnings
    });
  }

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
    console.log('WORKER_EMBEDDED_STARTED', {
      pid: process.pid
    });
    logInfo('worker_started', {
      source: 'web_server',
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

server.on('error', (error) => {
  logError('server_start_failed', {
    host,
    port: env.port,
    env: env.nodeEnv,
    error: error.message
  });
  process.exit(1);
});

