const env = require('../config/env');
const fs = require('fs/promises');
const path = require('path');
const { logError, logWarn } = require('../utils/logger');
const graphClient = require('./whatsapp-graph.client');
const { normalizeDigits, normalizeWhatsAppTo } = require('./normalize-phone');

function sanitizePhoneNumber(value) {
  return normalizeWhatsAppTo(normalizeDigits(value));
}

function isValidE164WithoutPlus(value) {
  return /^\d{8,15}$/.test(String(value || ''));
}

function extractGraphError(data) {
  const err = data && data.error ? data.error : null;
  return {
    code: err && err.code ? err.code : null,
    subcode: err && err.error_subcode ? err.error_subcode : null,
    message: err && err.message ? err.message : null,
    fbtrace_id: err && err.fbtrace_id ? err.fbtrace_id : null
  };
}

function resolveAuthSource(credentials) {
  const credentialToken =
    credentials && credentials.accessToken ? String(credentials.accessToken).trim() : '';
  return credentialToken ? 'credentials' : 'env';
}

function buildGraphError(message, result, to) {
  const ge = extractGraphError(result && result.data ? result.data : null);
  const error = new Error(message);
  error.graphStatus = result && result.status ? result.status : null;
  error.graphErrorCode = ge.code;
  error.graphErrorSubcode = ge.subcode;
  error.graphErrorMessage = ge.message;
  error.fbtrace_id = ge.fbtrace_id;
  error.errorCategory = result && result.errorCategory ? result.errorCategory : null;
  error.graphPath = result && result.graphPath ? result.graphPath : null;
  error.phoneNumberId = result && result.phoneNumberId ? result.phoneNumberId : env.whatsappPhoneNumberId;
  error.to = to || null;
  error.raw = result && result.data ? result.data : null;
  return error;
}

function resolveSendArgs(arg1, arg2, arg3) {
  if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
    return {
      to: arg1.to,
      text: arg1.text,
      context: arg2 || {}
    };
  }

  return {
    to: arg1,
    text: arg2,
    context: arg3 || {}
  };
}

function resolveTemplateArgs(arg1, arg2, arg3, arg4, arg5) {
  if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
    return {
      to: arg1.to,
      templateName: arg1.templateName || (arg1.template && arg1.template.name),
      languageCode: arg1.languageCode || (arg1.template && arg1.template.languageCode) || 'es',
      components: Array.isArray(arg1.components)
        ? arg1.components
        : (arg1.template && Array.isArray(arg1.template.components) ? arg1.template.components : []),
      context: arg2 || {}
    };
  }

  return {
    to: arg1,
    templateName: arg2,
    languageCode: arg3 || 'es',
    components: Array.isArray(arg4) ? arg4 : [],
    context: arg5 || {}
  };
}

async function sendGraphMessage({ requestId, credentials, toRaw, body, logLabel }) {
  const channelId = credentials && credentials.channelId ? String(credentials.channelId).trim() : null;
  const scopedAccessToken =
    credentials && credentials.accessToken ? String(credentials.accessToken).trim() : '';
  const scopedPhoneNumberId =
    credentials && credentials.phoneNumberId ? String(credentials.phoneNumberId).trim() : '';
  const allowGlobalFallback = !channelId;
  const accessToken = allowGlobalFallback
    ? (scopedAccessToken || String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim())
    : scopedAccessToken;
  const phoneNumberId = allowGlobalFallback
    ? (scopedPhoneNumberId || String(env.whatsappPhoneNumberId || '').trim())
    : scopedPhoneNumberId;
  const authSource = allowGlobalFallback ? resolveAuthSource(credentials) : 'channel_scoped';
  const to = sanitizePhoneNumber(toRaw);
  const toLast4 = to ? to.slice(-4) : null;
  const toLen = to ? to.length : 0;

  if (!isValidE164WithoutPlus(to)) {
    throw new Error('Invalid WhatsApp recipient. Expected E164 digits without +.');
  }

  if (!accessToken) {
    throw new Error(channelId ? 'Missing WhatsApp channel access token' : 'Missing WhatsApp access token');
  }

  if (!phoneNumberId) {
    throw new Error(channelId ? 'Missing WhatsApp channel phone number id' : 'WHATSAPP_PHONE_NUMBER_ID is missing.');
  }

  const graphVersion = String(process.env.WHATSAPP_GRAPH_VERSION || env.whatsappGraphVersion || 'v25.0').trim();
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;

  console.log(logLabel || 'WhatsApp send', {
    url,
    phoneNumberId,
    channelId,
    authSource,
    toLast4,
    toLen
  });

  let graphResponse;
  if (body && body.type === 'template') {
    graphResponse = await graphClient.sendTemplateMessageViaGraph({
      phoneNumberId,
      to,
      templateName: body.template && body.template.name ? body.template.name : '',
      languageCode:
        body.template && body.template.language && body.template.language.code
          ? body.template.language.code
          : 'es',
      components: body.template && Array.isArray(body.template.components) ? body.template.components : [],
      requestId,
      credentials: {
        ...(credentials || {}),
        accessToken,
        phoneNumberId
      }
    });
  } else {
    graphResponse = await graphClient.sendTextMessageViaGraph({
      phoneNumberId,
      to,
      text: body && body.text && body.text.body ? String(body.text.body) : '',
      requestId,
      credentials: {
        ...(credentials || {}),
        accessToken,
        phoneNumberId
      }
    });
  }

  const responseStatus = graphResponse.status;
  const rawText = graphResponse.raw || '';
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch (error) {
    parsed = null;
  }

  if (!graphResponse.ok) {
    const ge = extractGraphError(parsed);
    const rawGraphErrorBody = parsed || rawText || null;

    if (Number(ge.code) === 100 && Number(ge.subcode) === 33) {
      logError('whatsapp_send_failed', {
        event: 'whatsapp_send_failed',
        requestId,
        method: 'POST',
        url,
        graphPath: `/${phoneNumberId}/messages`,
        toLast4,
        toLen,
        status: responseStatus,
        durationMs: null,
        fbtrace_id: ge.fbtrace_id,
        graphErrorCode: ge.code,
        graphErrorSubcode: ge.subcode,
        graphErrorMessage: ge.message,
        rawGraphErrorBody,
        error_subcode: ge.subcode,
        phoneNumberId,
        channelId,
        authSource,
        diagnosis: [
          'ID no es Phone Number ID',
          'token no tiene acceso al activo',
          'System User no asignado al WABA',
          'token pertenece a otro business/app'
        ]
      });
    } else if (Number(ge.code) === 190 && Number(ge.subcode) === 463) {
      logWarn('whatsapp_send_failed', {
        event: 'whatsapp_send_failed',
        requestId,
        method: 'POST',
        url,
        graphPath: `/${phoneNumberId}/messages`,
        toLast4,
        toLen,
        status: responseStatus,
        durationMs: null,
        fbtrace_id: ge.fbtrace_id,
        graphErrorCode: ge.code,
        graphErrorSubcode: ge.subcode,
        graphErrorMessage: ge.message,
        rawGraphErrorBody,
        error_subcode: ge.subcode,
        phoneNumberId,
        channelId,
        authSource,
        diagnosis: 'channel_access_token_expired'
      });
    } else {
      logWarn('whatsapp_send_failed', {
        event: 'whatsapp_send_failed',
        requestId,
        method: 'POST',
        url,
        graphPath: `/${phoneNumberId}/messages`,
        toLast4,
        toLen,
        status: responseStatus,
        durationMs: null,
        fbtrace_id: ge.fbtrace_id,
        graphErrorCode: ge.code,
        graphErrorSubcode: ge.subcode,
        graphErrorMessage: ge.message,
        rawGraphErrorBody,
        error_subcode: ge.subcode,
        phoneNumberId,
        channelId,
        authSource
      });
    }

    const error = new Error(`WhatsApp send failed with status ${responseStatus || 'unknown'}`);
    error.graphStatus = responseStatus || null;
    error.graphErrorCode = ge.code;
    error.graphErrorSubcode = ge.subcode;
    error.graphErrorMessage = ge.message;
    error.fbtrace_id = ge.fbtrace_id;
    error.phoneNumberId = phoneNumberId;
    error.to = to;
    error.graphUrl = url;
    error.graphPath = `/${phoneNumberId}/messages`;
    error.raw = parsed;
    error.rawGraphErrorBody = rawGraphErrorBody;
    throw error;
  }

  const messageId =
    parsed &&
    Array.isArray(parsed.messages) &&
    parsed.messages[0] &&
    parsed.messages[0].id
      ? parsed.messages[0].id
      : null;

  return {
    messageId,
    status: responseStatus,
    raw: parsed
  };
}

async function sendTextMessage(arg1, arg2, arg3) {
  const resolved = resolveSendArgs(arg1, arg2, arg3);
  const requestId = resolved.context && resolved.context.requestId ? resolved.context.requestId : null;
  const credentials = resolved.context && resolved.context.credentials ? resolved.context.credentials : {};
  const text = String(resolved.text || '').trim();

  if (!text) {
    throw new Error('Text is required.');
  }

  return sendGraphMessage({
    requestId,
    credentials,
    toRaw: resolved.to,
    body: {
      type: 'text',
      text: { body: text }
    },
    logLabel: 'WhatsApp send'
  });
}

async function sendTemplateMessage(arg1, arg2, arg3, arg4, arg5) {
  const resolved = resolveTemplateArgs(arg1, arg2, arg3, arg4, arg5);
  const requestId = resolved.context && resolved.context.requestId ? resolved.context.requestId : null;
  const credentials = resolved.context && resolved.context.credentials ? resolved.context.credentials : {};
  const templateName = String(resolved.templateName || '').trim();
  const languageCode = String(resolved.languageCode || 'es').trim() || 'es';
  const components = Array.isArray(resolved.components) ? resolved.components : [];

  if (!templateName) {
    throw new Error('templateName is required.');
  }

  const template = {
    name: templateName,
    language: { code: languageCode }
  };
  if (components.length) {
    template.components = components;
  }

  return sendGraphMessage({
    requestId,
    credentials,
    toRaw: resolved.to,
    body: {
      type: 'template',
      template
    },
    logLabel: 'WhatsApp template send'
  });
}

async function fetchPaginated(pathToRequest, query, requestId) {
  const items = [];
  let nextPath = pathToRequest;
  let nextQuery = query || null;

  while (nextPath) {
    const result = await graphClient.request('GET', nextPath, {
      requestId,
      query: nextQuery
    });

    if (!result.ok) {
      const error = buildGraphError(
        `Graph assets request failed with status ${result.status || 'unknown'}`,
        result,
        null
      );
      throw error;
    }

    const dataItems = result.data && Array.isArray(result.data.data) ? result.data.data : [];
    items.push(...dataItems);

    const nextUrl =
      result.data && result.data.paging && result.data.paging.next ? String(result.data.paging.next) : null;

    if (!nextUrl) {
      nextPath = null;
      nextQuery = null;
      continue;
    }

    const parsedNext = new URL(nextUrl);
    nextPath = parsedNext.pathname.replace(`/${env.whatsappApiVersion}`, '');
    nextQuery = {};
    parsedNext.searchParams.forEach((value, key) => {
      nextQuery[key] = value;
    });
  }

  return items;
}

async function discoverAssets(context = {}) {
  const requestId = context.requestId || null;

  try {
    const businessesRaw = await fetchPaginated('/me/businesses', { fields: 'id,name' }, requestId);
    const businesses = businessesRaw.map((b) => ({
      id: b && b.id ? b.id : null,
      name: b && b.name ? b.name : null
    }));

    const wabas = [];
    const phoneNumbers = [];

    for (const business of businesses) {
      if (!business.id) continue;
      const wabasRaw = await fetchPaginated(
        `/${business.id}/owned_whatsapp_business_accounts`,
        { fields: 'id,name' },
        requestId
      );

      wabasRaw.forEach((w) => {
        wabas.push({
          id: w && w.id ? w.id : null,
          name: w && w.name ? w.name : null,
          businessId: business.id
        });
      });
    }

    for (const waba of wabas) {
      if (!waba.id) continue;
      const phonesRaw = await fetchPaginated(
        `/${waba.id}/phone_numbers`,
        { fields: 'id,display_phone_number,verified_name' },
        requestId
      );

      phonesRaw.forEach((p) => {
        phoneNumbers.push({
          id: p && p.id ? p.id : null,
          display_phone_number: p && p.display_phone_number ? p.display_phone_number : null,
          verified_name: p && p.verified_name ? p.verified_name : null,
          wabaId: waba.id
        });
      });
    }

    const recommendedPhoneNumberId = phoneNumbers.length > 0 ? phoneNumbers[0].id : null;
    const diagnosis = phoneNumbers.length > 0 ? null : 'Token no tiene acceso a ningún Phone Number ID';

    return {
      businesses,
      wabas,
      phoneNumbers,
      recommendedPhoneNumberId,
      diagnosis
    };
  } catch (error) {
    const isAuthIssue = error.graphStatus === 401 || error.graphStatus === 403;
    if (isAuthIssue) {
      return {
        businesses: [],
        wabas: [],
        phoneNumbers: [],
        recommendedPhoneNumberId: null,
        diagnosis: 'Token no tiene acceso a ningún Phone Number ID'
      };
    }

    throw error;
  }
}

async function updateEnvPhoneNumberId(detectedPhoneNumberId, requestId) {
  const envFilePath = path.resolve(process.cwd(), '.env');
  const targetLine = `WHATSAPP_PHONE_NUMBER_ID=${detectedPhoneNumberId}`;

  try {
    let raw = '';
    try {
      raw = await fs.readFile(envFilePath, 'utf-8');
    } catch (readError) {
      if (readError && readError.code === 'ENOENT') {
        logWarn('autofix_env_missing', {
          event: 'whatsapp_autofix',
          requestId,
          message: '.env not found. Create .env and set WHATSAPP_PHONE_NUMBER_ID manually.',
          recommendedPhoneNumberId: detectedPhoneNumberId
        });
        return false;
      }
      throw readError;
    }

    const hasPhoneLine = /^WHATSAPP_PHONE_NUMBER_ID=.*$/m.test(raw);
    const updated = hasPhoneLine ? raw.replace(/^WHATSAPP_PHONE_NUMBER_ID=.*$/m, targetLine) : `${raw.trimEnd()}\n${targetLine}\n`;
    await fs.writeFile(envFilePath, updated, 'utf-8');

    logWarn('autofix_env_updated', {
      event: 'whatsapp_autofix',
      requestId,
      message: '.env updated with correct Phone Number ID',
      recommendedPhoneNumberId: detectedPhoneNumberId
    });
    return true;
  } catch (error) {
    logWarn('autofix_env_update_failed', {
      event: 'whatsapp_autofix',
      requestId,
      error: error.message,
      recommendedPhoneNumberId: detectedPhoneNumberId
    });
    return false;
  }
}

async function autoDetectPhoneNumberId(context = {}) {
  const requestId = context.requestId || null;
  const applyEnvFix = context.applyEnvFix !== false;
  const assets = await discoverAssets({ requestId });

  const envPhoneNumberId = env.whatsappPhoneNumberId;
  const detectedPhoneNumberId = assets && assets.phoneNumbers && assets.phoneNumbers[0] ? assets.phoneNumbers[0].id : null;

  if (!detectedPhoneNumberId) {
    const recommendation = 'Token has no accessible Phone Number ID. System User likely missing asset.';
    logWarn('autofix_no_phone_number_id', {
      event: 'whatsapp_autofix',
      requestId,
      envPhoneNumberId,
      recommendation
    });
    return {
      envPhoneNumberId,
      detectedPhoneNumberId: null,
      match: false,
      recommendation
    };
  }

  const match = String(envPhoneNumberId) === String(detectedPhoneNumberId);
  if (!match) {
    logWarn('autofix_phone_number_mismatch', {
      event: 'whatsapp_autofix',
      requestId,
      envPhoneNumberId,
      detectedPhoneNumberId,
      message: 'ENV phoneNumberId mismatch. Recommended: detectedId'
    });

    if (applyEnvFix) {
      await updateEnvPhoneNumberId(detectedPhoneNumberId, requestId);
    }
  }

  return {
    envPhoneNumberId,
    detectedPhoneNumberId,
    match,
    recommendation: match
      ? 'ENV phoneNumberId matches detected Phone Number ID.'
      : 'Use detectedPhoneNumberId as WHATSAPP_PHONE_NUMBER_ID and restart service.'
  };
}

async function sendTestMessage(to, text, context = {}) {
  return sendTextMessage({ to, text }, context);
}

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  sendGraphMessage,
  sendTestMessage,
  discoverAssets,
  sanitizePhoneNumber,
  autoDetectPhoneNumberId
};

