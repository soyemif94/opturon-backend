const env = require('../config/env');
const { logError } = require('../utils/logger');

function normalizeToDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

async function sendTextMessage({ to, text, requestId = null }) {
  const accessToken = String(process.env.WHATSAPP_TOKEN || env.whatsappAccessToken || '').trim();
  const phoneNumberId = String(env.whatsappPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const graphVersion = String(env.whatsappGraphVersion || process.env.WHATSAPP_GRAPH_VERSION || 'v25.0').trim();
  const toDigits = normalizeToDigits(to);
  const bodyText = String(text || '').trim();

  if (!accessToken || !phoneNumberId || !toDigits || !bodyText) {
    throw new Error('Missing WhatsApp send config/payload');
  }

  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: toDigits,
    type: 'text',
    text: { body: bodyText }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const raw = await response.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch (_) {
      json = null;
    }

    if (!response.ok) {
      const err = new Error(`WhatsApp send failed (${response.status})`);
      err.graphStatus = response.status;
      err.rawGraphErrorBody = raw;
      err.fbtrace_id = json && json.error ? json.error.fbtrace_id || null : null;
      throw err;
    }

    return {
      ok: true,
      status: response.status,
      data: json,
      messageId:
        json && Array.isArray(json.messages) && json.messages[0] && json.messages[0].id
          ? json.messages[0].id
          : null
    };
  } catch (error) {
    logError('auto_reply_send_failed', {
      requestId,
      toLast4: toDigits.slice(-4),
      toLen: toDigits.length,
      error: error.message,
      graphStatus: error.graphStatus || null,
      fbtrace_id: error.fbtrace_id || null
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  sendTextMessage
};

