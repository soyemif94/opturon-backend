const env = require('../config/env');
const { query } = require('../db/client');
const { validateConfiguredTokensEncryptionKey } = require('../utils/secret-crypto');

const DEFAULT_REDIRECT_PATH = '/api/app/integrations/whatsapp/embedded-signup/callback';
const DEFAULT_WEBHOOK_PATH = '/webhook';
const MANUAL_CHECKS = [
  {
    key: 'appPublished',
    label: 'App publicada / Live mode',
    status: 'manual_review_required',
    instruction: 'Verificar en Meta App Dashboard que la app este en modo Live.'
  },
  {
    key: 'businessVerification',
    label: 'Business Verification',
    status: 'manual_review_required',
    instruction: 'Confirmar Business Verification en Meta Business Manager.'
  },
  {
    key: 'techProviderVerification',
    label: 'Tech Provider / Access Verification',
    status: 'manual_review_required',
    instruction: 'Confirmar alta y permisos del rol Tech Provider/Solution Provider en Meta.'
  },
  {
    key: 'appReview',
    label: 'App Review y permisos',
    status: 'manual_review_required',
    instruction: 'Revisar aprobacion de permisos de WhatsApp/Facebook Login for Business en Meta.'
  },
  {
    key: 'customerWabaBilling',
    label: 'Metodo de pago del WABA del cliente',
    status: 'manual_review_required',
    instruction: 'Cada cliente debe completar billing en su WABA si Meta lo requiere.'
  },
  {
    key: 'numberMigration',
    label: 'Coexistencia o migracion del numero',
    status: 'manual_review_required',
    instruction: 'Confirmar si el numero ya esta usado en WhatsApp Business App o requiere migracion.'
  }
];

function normalizeString(value) {
  return String(value || '').trim();
}

function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return '';
}

function buildUrlCheck(urlValue, { requireHttps = true } = {}) {
  const configured = Boolean(normalizeString(urlValue));
  if (!configured) {
    return {
      configured: false,
      valid: false,
      validHttps: false,
      safeDisplay: null
    };
  }

  try {
    const parsed = new URL(urlValue);
    const validHttps = parsed.protocol === 'https:';
    const valid = requireHttps ? validHttps : ['https:', 'http:'].includes(parsed.protocol);
    return {
      configured: true,
      valid,
      validHttps,
      safeDisplay: parsed.toString()
    };
  } catch {
    return {
      configured: true,
      valid: false,
      validHttps: false,
      safeDisplay: normalizeString(urlValue)
    };
  }
}

function joinUrl(baseUrl, pathName) {
  const safeBaseUrl = normalizeString(baseUrl);
  if (!safeBaseUrl) return '';

  try {
    return new URL(pathName, safeBaseUrl.endsWith('/') ? safeBaseUrl : `${safeBaseUrl}/`).toString();
  } catch {
    return '';
  }
}

function isValidGraphVersion(value) {
  return /^v\d+\.\d+$/.test(normalizeString(value));
}

function buildDependencyLoaderResult(loaders) {
  const details = [];
  let ready = true;

  for (const loader of loaders) {
    try {
      loader.load();
      details.push({ key: loader.key, loaded: true });
    } catch (error) {
      ready = false;
      details.push({
        key: loader.key,
        loaded: false,
        error: error && error.message ? error.message : 'load_failed'
      });
    }
  }

  return {
    configured: true,
    ready,
    details
  };
}

async function checkTableAvailability(queryImpl) {
  try {
    const result = await queryImpl(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'channel_onboarding_sessions'
       ) AS present`
    );
    return {
      configured: true,
      available: Boolean(result.rows && result.rows[0] && result.rows[0].present)
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      error: error && error.message ? error.message : 'table_check_failed'
    };
  }
}

async function checkReachability(fetchImpl, urlValue) {
  const urlCheck = buildUrlCheck(urlValue);
  if (!urlCheck.valid) {
    return {
      configured: urlCheck.configured,
      reachable: false,
      httpStatus: null,
      safeDisplay: urlCheck.safeDisplay
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetchImpl(urlValue, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*'
      }
    });
    return {
      configured: true,
      reachable: true,
      httpStatus: response.status,
      safeDisplay: urlCheck.safeDisplay
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      httpStatus: null,
      safeDisplay: urlCheck.safeDisplay,
      error: error && error.name === 'AbortError' ? 'timeout' : error && error.message ? error.message : 'network_error'
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeAutomaticChecks(checks) {
  const automaticKeys = Object.keys(checks).filter((key) => checks[key] && checks[key].kind === 'automatic');
  const readyKeys = automaticKeys.filter((key) => checks[key].blocking !== true);
  return {
    total: automaticKeys.length,
    ready: readyKeys.length
  };
}

async function getMetaEmbeddedSignupReadiness(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const queryImpl = options.queryImpl || query;
  const validateEncryptionKey = options.validateEncryptionKey || validateConfiguredTokensEncryptionKey;
  const resolvedEnv = options.envOverride || env;

  const appId = firstNonEmpty([resolvedEnv.whatsappAppId, process.env.WHATSAPP_APP_ID]);
  const appSecret = firstNonEmpty([resolvedEnv.metaAppSecret, process.env.META_APP_SECRET]);
  const configId = firstNonEmpty([
    process.env.META_EMBEDDED_SIGNUP_CONFIG_ID,
    process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID
  ]);
  const graphVersion = firstNonEmpty([
    resolvedEnv.getWhatsAppGraphVersion ? resolvedEnv.getWhatsAppGraphVersion() : resolvedEnv.whatsappGraphVersion,
    process.env.WHATSAPP_GRAPH_VERSION,
    process.env.WHATSAPP_API_VERSION,
    process.env.META_GRAPH_VERSION
  ]);
  const publicAppUrl = firstNonEmpty([resolvedEnv.opturonPublicAppUrl, process.env.NEXT_PUBLIC_APP_URL]);
  const apiPublicUrl = firstNonEmpty([resolvedEnv.opturonApiPublicUrl, process.env.API_BASE_URL]);
  const verifyToken = firstNonEmpty([resolvedEnv.metaVerifyToken, process.env.WHATSAPP_VERIFY_TOKEN]);
  const redirectUri = joinUrl(publicAppUrl, DEFAULT_REDIRECT_PATH);
  const webhookCallback = joinUrl(apiPublicUrl, DEFAULT_WEBHOOK_PATH);

  const tokenEncryption = {
    configured: false,
    valid: false
  };
  try {
    validateEncryptionKey();
    tokenEncryption.configured = true;
    tokenEncryption.valid = true;
  } catch {
    tokenEncryption.configured = Boolean(firstNonEmpty([resolvedEnv.tokensEncryptionKey, process.env.TOKENS_ENCRYPTION_KEY]));
    tokenEncryption.valid = false;
  }

  const onboardingTable = normalizeString(resolvedEnv.databaseUrl)
    ? await checkTableAvailability(queryImpl)
    : { configured: false, available: false };
  const dependencies = buildDependencyLoaderResult([
    { key: 'portal-whatsapp-embedded-signup.service', load: () => require('./portal-whatsapp-embedded-signup.service') },
    { key: 'whatsapp-onboarding.repository', load: () => require('../repositories/whatsapp-onboarding.repository') },
    { key: 'tenant.repository', load: () => require('../repositories/tenant.repository') }
  ]);
  const webhookReachability = fetchImpl
    ? await checkReachability(fetchImpl, webhookCallback)
    : {
        configured: buildUrlCheck(webhookCallback).configured,
        reachable: false,
        httpStatus: null,
        safeDisplay: buildUrlCheck(webhookCallback).safeDisplay,
        error: 'fetch_unavailable'
      };

  const redirectUriCheckBase = buildUrlCheck(redirectUri);
  const publicAppUrlCheck = buildUrlCheck(publicAppUrl);
  const graphVersionValid = isValidGraphVersion(graphVersion);

  const checks = {
    appId: {
      kind: 'automatic',
      configured: Boolean(appId),
      blocking: !appId
    },
    appSecret: {
      kind: 'automatic',
      configured: Boolean(appSecret),
      blocking: !appSecret
    },
    configId: {
      kind: 'automatic',
      configured: Boolean(configId),
      blocking: !configId
    },
    graphVersion: {
      kind: 'automatic',
      configured: Boolean(graphVersion),
      valid: graphVersionValid,
      value: graphVersion || null,
      blocking: !graphVersionValid
    },
    publicAppUrl: {
      kind: 'automatic',
      configured: publicAppUrlCheck.configured,
      validHttps: publicAppUrlCheck.validHttps,
      safeDisplay: publicAppUrlCheck.safeDisplay,
      blocking: !publicAppUrlCheck.valid
    },
    redirectUri: {
      kind: 'automatic',
      configured: redirectUriCheckBase.configured,
      valid: redirectUriCheckBase.valid && redirectUriCheckBase.validHttps,
      validHttps: redirectUriCheckBase.validHttps,
      safeDisplay: redirectUriCheckBase.safeDisplay,
      blocking: !(redirectUriCheckBase.valid && redirectUriCheckBase.validHttps)
    },
    webhookCallback: {
      kind: 'automatic',
      configured: webhookReachability.configured,
      reachable: webhookReachability.reachable,
      httpStatus: webhookReachability.httpStatus,
      safeDisplay: webhookReachability.safeDisplay,
      blocking: !webhookReachability.reachable
    },
    verifyToken: {
      kind: 'automatic',
      configured: Boolean(verifyToken),
      blocking: !verifyToken
    },
    tokenEncryption: {
      kind: 'automatic',
      configured: tokenEncryption.configured,
      valid: tokenEncryption.valid,
      blocking: !(tokenEncryption.configured && tokenEncryption.valid)
    },
    onboardingTable: {
      kind: 'automatic',
      configured: onboardingTable.configured,
      available: onboardingTable.available,
      blocking: !(onboardingTable.configured && onboardingTable.available)
    },
    dependencies: {
      kind: 'automatic',
      configured: true,
      ready: dependencies.ready,
      details: dependencies.details,
      blocking: !dependencies.ready
    },
    frontendLaunchPayload: {
      kind: 'automatic',
      configured: Boolean(appId && configId),
      safe: true,
      deliveryMode: 'server_side_payload',
      fields: ['appId', 'configId', 'graphVersion', 'redirectUri', 'state'],
      missingConfig: [
        ...(appId ? [] : ['WHATSAPP_APP_ID']),
        ...(configId ? [] : ['META_EMBEDDED_SIGNUP_CONFIG_ID'])
      ],
      blocking: !(appId && configId)
    }
  };

  MANUAL_CHECKS.forEach((manualCheck) => {
    checks[manualCheck.key] = {
      kind: 'manual',
      status: manualCheck.status,
      label: manualCheck.label,
      instruction: manualCheck.instruction
    };
  });

  const blockingChecks = Object.entries(checks)
    .filter(([, value]) => value && value.kind === 'automatic' && value.blocking === true)
    .map(([key]) => key);
  const manualChecks = MANUAL_CHECKS.map((item) => item.key);
  const automaticSummary = summarizeAutomaticChecks(checks);
  const readyForTest = blockingChecks.length === 0;
  const readyForProduction = false;
  const status = readyForTest ? 'ready_for_test' : 'configuration_incomplete';

  return {
    ok: true,
    readyForTest,
    readyForProduction,
    status,
    automaticChecksReady: automaticSummary.ready,
    automaticChecksTotal: automaticSummary.total,
    checks,
    blockingChecks,
    manualChecks
  };
}

module.exports = {
  DEFAULT_REDIRECT_PATH,
  DEFAULT_WEBHOOK_PATH,
  MANUAL_CHECKS,
  getMetaEmbeddedSignupReadiness
};
