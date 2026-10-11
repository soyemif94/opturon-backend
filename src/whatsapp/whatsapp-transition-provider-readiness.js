const env = require('../config/env');
const graphClient = require('./whatsapp-graph.client');

const REQUIRED_WEBHOOK_FIELDS = Object.freeze([
  'messages', 'account_update', 'history', 'smb_app_state_sync', 'smb_message_echoes'
]);

function normalizeFieldList(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.map((field) => String(field && typeof field === 'object' ? field.name || '' : field || '').trim())
    .filter(Boolean);
}

function normalizeCallbackUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return null;
  }
}

function resultData(result, reason) {
  if (!result || result.ok !== true || !result.data || typeof result.data !== 'object') {
    return { ok: false, reason, httpStatus: Number(result && result.status) || null };
  }
  return { ok: true, data: result.data };
}

async function readWhatsAppTransitionProviderEvidence({ wabaId, phoneNumberId, accessToken }) {
  const appId = String(env.whatsappAppId || '').trim();
  const appSecret = String(env.metaAppSecret || '').trim();
  const expectedCallback = normalizeCallbackUrl(`${String(env.opturonApiPublicUrl || '').trim().replace(/\/+$/, '')}/webhook`);
  if (!wabaId || !phoneNumberId || !accessToken || !appId || !appSecret || !expectedCallback) {
    return { ok: false, reason: 'transition_provider_readiness_configuration_incomplete' };
  }

  const apiVersion = String(env.getWhatsAppGraphVersion()).trim();
  const phoneListResult = resultData(await graphClient.request('GET', `/${wabaId}/phone_numbers`, {
    accessToken,
    apiVersion,
    query: { fields: 'id,display_phone_number' }
  }), 'transition_waba_phone_lookup_failed');
  if (!phoneListResult.ok) return { ok: false, reason: phoneListResult.reason, httpStatus: phoneListResult.httpStatus };
  const phones = Array.isArray(phoneListResult.data.data) ? phoneListResult.data.data : [];
  const matchedPhone = phones.find((phone) => String(phone && phone.id || '').trim() === phoneNumberId);
  if (!matchedPhone) return { ok: false, reason: 'transition_phone_not_in_waba' };

  const statusResult = resultData(await graphClient.request('GET', `/${phoneNumberId}`, {
    accessToken,
    apiVersion,
    query: { fields: 'is_on_biz_app,platform_type' }
  }), 'transition_phone_status_lookup_failed');
  if (!statusResult.ok) return { ok: false, reason: statusResult.reason, httpStatus: statusResult.httpStatus };

  const appResult = resultData(await graphClient.request('GET', `/${wabaId}/subscribed_apps`, {
    accessToken,
    apiVersion
  }), 'transition_waba_app_subscription_lookup_failed');
  if (!appResult.ok) return { ok: false, reason: appResult.reason, httpStatus: appResult.httpStatus };
  const apps = Array.isArray(appResult.data.data) ? appResult.data.data : [];
  const appSubscribed = apps.some((item) => {
    const nestedId = item && item.whatsapp_business_api_data && item.whatsapp_business_api_data.id;
    return String(nestedId || item && item.id || '').trim() === appId;
  });

  const appAccessToken = `${appId}|${appSecret}`;
  const webhookResult = resultData(await graphClient.request('GET', `/${appId}/subscriptions`, {
    accessToken: appAccessToken,
    apiVersion
  }), 'transition_webhook_subscription_lookup_failed');
  if (!webhookResult.ok) return { ok: false, reason: webhookResult.reason, httpStatus: webhookResult.httpStatus };
  const subscriptions = Array.isArray(webhookResult.data.data) ? webhookResult.data.data : [];
  const webhook = subscriptions.find((item) => item && item.object === 'whatsapp_business_account' && item.active === true);
  const subscribedFields = normalizeFieldList(webhook && webhook.fields);
  const missingWebhookFields = REQUIRED_WEBHOOK_FIELDS.filter((field) => !subscribedFields.includes(field));
  const callbackUrl = normalizeCallbackUrl(webhook && webhook.callback_url);
  const providerStatus = statusResult.data;
  const displayPhoneNumber = String(matchedPhone.display_phone_number || '').trim();
  const platformType = String(providerStatus.platform_type || '').trim();
  const isOnBizApp = typeof providerStatus.is_on_biz_app === 'boolean' ? providerStatus.is_on_biz_app : null;

  return {
    ok: true,
    phoneNumberId,
    wabaId,
    displayPhoneNumber,
    platformType,
    isOnBizApp,
    appId,
    appSubscribed,
    webhookActive: Boolean(webhook),
    callbackUrlMatches: callbackUrl === expectedCallback,
    subscribedFields,
    missingWebhookFields,
    ready: platformType === 'CLOUD_API' && isOnBizApp === false
      && appSubscribed && Boolean(webhook) && callbackUrl === expectedCallback && missingWebhookFields.length === 0
  };
}

module.exports = {
  REQUIRED_WEBHOOK_FIELDS,
  normalizeCallbackUrl,
  normalizeFieldList,
  readWhatsAppTransitionProviderEvidence
};
