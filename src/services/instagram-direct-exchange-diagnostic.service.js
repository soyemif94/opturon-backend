const { resolveInstagramBusinessLoginCredentials } = require('../integrations/instagram/instagram.service');

const EXPECTED_INSTAGRAM_CLIENT_ID = '1349038906605969';
const DIAGNOSTIC_REDIRECT_URI = 'https://www.opturon.com/api/app/integrations/instagram/debug-callback';

function sanitizeProviderMessage(value, { code, secret } = {}) {
  let message = String(value || '').trim().slice(0, 1000);
  if (!message) return null;
  for (const sensitiveValue of [code, secret]) {
    const normalized = String(sensitiveValue || '');
    if (normalized) message = message.split(normalized).join('[REDACTED]');
  }
  return message.replace(
    /\b(?:authorization[_ -]?code|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|state)\s*[=:]\s*[^\s&,]+/gi,
    '[REDACTED]'
  );
}

function localFailure(message) {
  return {
    httpStatus: 0,
    tokenExchange: 'FAIL',
    userIdPresent: false,
    accessTokenPresent: false,
    providerErrorType: 'local_validation',
    providerErrorCode: null,
    providerErrorMessage: message
  };
}

/**
 * Temporary isolation probe. It deliberately does not call the production
 * exchange helper, does not log secrets/codes, and has no persistence path.
 */
async function runInstagramDirectExchangeDiagnostic({ code } = {}) {
  const authorizationCode = String(code || '');
  const { clientId, clientSecret } = resolveInstagramBusinessLoginCredentials();

  if (!authorizationCode) return localFailure('missing_authorization_code');
  if (clientId !== EXPECTED_INSTAGRAM_CLIENT_ID || !clientSecret) {
    return localFailure('instagram_business_credentials_unavailable');
  }

  const formData = new FormData();
  formData.set('client_id', clientId);
  formData.set('client_secret', clientSecret);
  formData.set('grant_type', 'authorization_code');
  formData.set('redirect_uri', DIAGNOSTIC_REDIRECT_URI);
  formData.set('code', authorizationCode);

  try {
    const response = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: formData
    });
    let text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    text = null;

    const accessTokenPresent = Boolean(json && typeof json.access_token === 'string' && json.access_token.trim());
    const userIdPresent = Boolean(json && String(json.user_id || '').trim());
    const providerError = json && typeof json.error === 'object' ? json.error : {};
    const tokenExchange = response.ok && accessTokenPresent && userIdPresent ? 'PASS' : 'FAIL';

    // Discard the only in-memory token reference before building the response.
    if (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'access_token')) {
      json.access_token = undefined;
    }
    const result = {
      httpStatus: Number(response.status) || 0,
      tokenExchange,
      userIdPresent,
      accessTokenPresent,
      providerErrorType: tokenExchange === 'FAIL' ? String(providerError.type || providerError.error_type || '').trim() || null : null,
      providerErrorCode: tokenExchange === 'FAIL' ? String(providerError.code || providerError.error_code || '').trim() || null : null,
      providerErrorMessage: tokenExchange === 'FAIL'
        ? sanitizeProviderMessage(
          providerError.message || providerError.error_message || (response.ok ? 'provider_response_missing_required_fields' : 'provider_request_failed'),
          { code: authorizationCode, secret: clientSecret }
        )
        : null
    };
    json = null;
    return result;
  } catch {
    return {
      httpStatus: 0,
      tokenExchange: 'FAIL',
      userIdPresent: false,
      accessTokenPresent: false,
      providerErrorType: 'network',
      providerErrorCode: null,
      providerErrorMessage: 'provider_request_failed'
    };
  }
}

module.exports = {
  EXPECTED_INSTAGRAM_CLIENT_ID,
  DIAGNOSTIC_REDIRECT_URI,
  runInstagramDirectExchangeDiagnostic
};
