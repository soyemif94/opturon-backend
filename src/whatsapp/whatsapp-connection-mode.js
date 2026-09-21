const WHATSAPP_CONNECTION_MODE = Object.freeze({
  API_ONLY: 'API_ONLY',
  COEXISTENCE: 'COEXISTENCE'
});

const WHATSAPP_CHANNEL_PROVIDER = 'whatsapp_cloud';

const VALID_CONNECTION_MODES = new Set(Object.values(WHATSAPP_CONNECTION_MODE));

function invalidConnectionModeError(value) {
  const error = new Error('Invalid WhatsApp connection mode.');
  error.code = 'invalid_whatsapp_connection_mode';
  error.reason = 'invalid_whatsapp_connection_mode';
  error.value = value;
  return error;
}

function assertWhatsAppConnectionMode(value) {
  if (!VALID_CONNECTION_MODES.has(value)) {
    throw invalidConnectionModeError(value);
  }
  return value;
}

function resolveStoredWhatsAppConnectionMode(value) {
  if (value === null || value === undefined) {
    return WHATSAPP_CONNECTION_MODE.API_ONLY;
  }
  return assertWhatsAppConnectionMode(value);
}

function resolveChannelWhatsAppConnectionMode(provider, value) {
  if (provider === WHATSAPP_CHANNEL_PROVIDER) {
    return resolveStoredWhatsAppConnectionMode(value);
  }

  if (value === null || value === undefined) {
    return null;
  }

  throw invalidConnectionModeError(value);
}

function shouldRegisterWhatsAppPhone(connectionMode) {
  return assertWhatsAppConnectionMode(connectionMode) === WHATSAPP_CONNECTION_MODE.API_ONLY;
}

module.exports = {
  WHATSAPP_CHANNEL_PROVIDER,
  WHATSAPP_CONNECTION_MODE,
  assertWhatsAppConnectionMode,
  resolveChannelWhatsAppConnectionMode,
  resolveStoredWhatsAppConnectionMode,
  shouldRegisterWhatsAppPhone
};
