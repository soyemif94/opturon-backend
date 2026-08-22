const env = require('../config/env');
const graphClient = require('./whatsapp-graph.client');
const { logInfo } = require('../utils/logger');

function extractGraphError(data) {
  const error = data && data.error ? data.error : null;
  return {
    code: error && error.code ? error.code : null,
    subcode: error && error.error_subcode ? error.error_subcode : null,
    message: error && error.message ? error.message : null,
    fbtrace_id: error && error.fbtrace_id ? error.fbtrace_id : null
  };
}

function buildGraphError(message, result) {
  const graphError = extractGraphError(result && result.data ? result.data : null);
  const error = new Error(message);
  error.graphStatus = result && result.status ? result.status : null;
  error.graphErrorCode = graphError.code;
  error.graphErrorSubcode = graphError.subcode;
  error.graphErrorMessage = graphError.message;
  error.fbtrace_id = graphError.fbtrace_id;
  error.errorCategory = result && result.errorCategory ? result.errorCategory : null;
  error.graphPath = result && result.graphPath ? result.graphPath : null;
  error.rawGraphErrorBody = result && result.data ? result.data : null;
  return error;
}

function getSubscribedAppsArray(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    throw new Error('subscribed_apps_response_invalid');
  }

  return payload.data;
}

function getAppIdentifier(app) {
  const whatsappBusinessApiData =
    app && typeof app === 'object' && app.whatsapp_business_api_data && typeof app.whatsapp_business_api_data === 'object'
      ? app.whatsapp_business_api_data
      : null;
  const appId = whatsappBusinessApiData ? String(whatsappBusinessApiData.id || '').trim() : '';

  if (!appId) {
    return null;
  }

  return appId;
}

function isCurrentAppSubscribed(subscribedApps) {
  const currentAppId = String(env.whatsappAppId || '').trim();
  const items = getSubscribedAppsArray(subscribedApps);

  if (!currentAppId) {
    throw new Error('WHATSAPP_APP_ID is required to verify the WABA subscription.');
  }

  const identifiers = items.map(getAppIdentifier);
  if (identifiers.some((identifier) => !identifier)) {
    throw new Error('subscribed_apps_response_shape_unknown');
  }

  return identifiers.some((identifier) => identifier === currentAppId);
}

function getRequiredWabaId() {
  const wabaId = String(env.whatsappWabaId || '').trim();
  if (!wabaId) {
    throw new Error(
      'WHATSAPP_WABA_ID is required because the phone number object does not expose whatsapp_business_account in this Graph API call.'
    );
  }
  return wabaId;
}

async function getWabaFromPhoneNumber(context = {}) {
  const requestId = context.requestId || null;
  const phoneNumberId = env.whatsappPhoneNumberId;
  const wabaId = getRequiredWabaId();
  const result = await graphClient.request('GET', `/${phoneNumberId}`, {
    requestId,
    query: {
      fields: 'id,display_phone_number,verified_name'
    },
    apiVersion: env.whatsappGraphVersion
  });

  if (!result.ok) {
    throw buildGraphError(
      `Failed to validate phone number with status ${result.status || 'unknown'}`,
      result
    );
  }

  const data = result.data || {};

  logInfo('waba_detected', {
    event: 'waba_detected',
    requestId,
    phoneNumberId,
    wabaId
  });

  return {
    phoneNumberId,
    wabaId,
    display_phone_number: data.display_phone_number || null,
    verified_name: data.verified_name || null
  };
}

async function listSubscribedApps(wabaId, context = {}) {
  const requestId = context.requestId || null;
  const result = await graphClient.request('GET', `/${wabaId}/subscribed_apps`, {
    requestId,
    apiVersion: env.whatsappGraphVersion
  });

  if (!result.ok) {
    throw buildGraphError(
      `Failed to list subscribed apps with status ${result.status || 'unknown'}`,
      result
    );
  }

  return result.data || {};
}

async function subscribeCurrentApp(wabaId, context = {}) {
  const requestId = context.requestId || null;
  const result = await graphClient.request('POST', `/${wabaId}/subscribed_apps`, {
    requestId,
    apiVersion: env.whatsappGraphVersion
  });

  if (!result.ok) {
    throw buildGraphError(
      `Failed to subscribe current app with status ${result.status || 'unknown'}`,
      result
    );
  }

  return result.data || {};
}

async function ensureAppSubscribed(context = {}) {
  const requestId = context.requestId || null;
  const waba = await getWabaFromPhoneNumber({ requestId });
  let subscribedApps = await listSubscribedApps(waba.wabaId, { requestId });
  let subscribedNow = false;

  if (isCurrentAppSubscribed(subscribedApps)) {
    logInfo('waba_subscription_already_exists', {
      event: 'waba_subscription_already_exists',
      requestId,
      phoneNumberId: waba.phoneNumberId,
      wabaId: waba.wabaId
    });
  } else {
    await subscribeCurrentApp(waba.wabaId, { requestId });
    subscribedApps = await listSubscribedApps(waba.wabaId, { requestId });
    if (!isCurrentAppSubscribed(subscribedApps)) {
      throw new Error('waba_subscription_readback_missing');
    }
    subscribedNow = true;

    logInfo('waba_subscribed', {
      event: 'waba_subscribed',
      requestId,
      phoneNumberId: waba.phoneNumberId,
      wabaId: waba.wabaId
    });
  }

  return {
    success: true,
    phoneNumberId: waba.phoneNumberId,
    wabaId: waba.wabaId,
    subscribedApps,
    subscribedNow
  };
}

module.exports = {
  getWabaFromPhoneNumber,
  listSubscribedApps,
  subscribeCurrentApp,
  ensureAppSubscribed,
  getSubscribedAppsArray,
  getAppIdentifier,
  isCurrentAppSubscribed
};
