const crypto = require('crypto');

const ENCRYPTED_SECRET_PREFIX = 'enc:v1:gcm:';
const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const REQUIRED_KEY_LENGTH = 32;

function normalizeString(value) {
  return String(value || '').trim();
}

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = normalizeString(value).replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  return Buffer.from(`${normalized}${'='.repeat(paddingLength)}`, 'base64');
}

function buildEncryptionConfigurationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.isEncryptionConfigurationError = true;
  return error;
}

function parseEncryptionKey(rawValue) {
  const safeValue = normalizeString(rawValue);
  if (!safeValue) {
    throw buildEncryptionConfigurationError(
      'TOKENS_ENCRYPTION_KEY_MISSING',
      'TOKENS_ENCRYPTION_KEY is required to encrypt persisted Meta tokens.'
    );
  }

  if (/^[0-9a-fA-F]{64}$/.test(safeValue)) {
    return Buffer.from(safeValue, 'hex');
  }

  const decoded = fromBase64Url(safeValue);
  if (decoded.length === REQUIRED_KEY_LENGTH) {
    return decoded;
  }

  throw buildEncryptionConfigurationError(
    'TOKENS_ENCRYPTION_KEY_INVALID',
    'TOKENS_ENCRYPTION_KEY must decode to exactly 32 bytes (base64/base64url) or be 64 hex chars.'
  );
}

function getTokensEncryptionKeyMaterial() {
  return parseEncryptionKey(process.env.TOKENS_ENCRYPTION_KEY);
}

function validateConfiguredTokensEncryptionKey() {
  return getTokensEncryptionKeyMaterial();
}

function isEncryptedSecret(value) {
  return normalizeString(value).startsWith(ENCRYPTED_SECRET_PREFIX);
}

function encryptSecret(value) {
  const plaintext = normalizeString(value);
  if (!plaintext) return null;
  if (isEncryptedSecret(plaintext)) return plaintext;

  const key = getTokensEncryptionKeyMaterial();
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTED_SECRET_PREFIX}${toBase64Url(iv)}:${toBase64Url(tag)}:${toBase64Url(encrypted)}`;
}

function decryptSecret(value, options = {}) {
  const allowLegacy = options.allowLegacy !== false;
  const safeValue = normalizeString(value);
  if (!safeValue) return null;

  if (!isEncryptedSecret(safeValue)) {
    if (allowLegacy) {
      return safeValue;
    }
    throw new Error('secret_not_encrypted');
  }

  const encodedParts = safeValue.slice(ENCRYPTED_SECRET_PREFIX.length).split(':');
  if (encodedParts.length !== 3) {
    const error = new Error('encrypted_secret_format_invalid');
    error.code = 'ENCRYPTED_SECRET_FORMAT_INVALID';
    throw error;
  }

  try {
    const [ivEncoded, tagEncoded, payloadEncoded] = encodedParts;
    const key = getTokensEncryptionKeyMaterial();
    const iv = fromBase64Url(ivEncoded);
    const tag = fromBase64Url(tagEncoded);
    const payload = fromBase64Url(payloadEncoded);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
    return decrypted.toString('utf8').trim() || null;
  } catch (error) {
    if (error && error.isEncryptionConfigurationError) {
      throw error;
    }
    const decryptError = new Error('encrypted_secret_decrypt_failed');
    decryptError.code = 'ENCRYPTED_SECRET_DECRYPT_FAILED';
    throw decryptError;
  }
}

function maybeEncryptSecret(value) {
  const safeValue = normalizeString(value);
  if (!safeValue) return null;
  return encryptSecret(safeValue);
}

function maybeDecryptSecret(value, options = {}) {
  const safeValue = normalizeString(value);
  if (!safeValue) return null;
  return decryptSecret(safeValue, options);
}

module.exports = {
  ENCRYPTED_SECRET_PREFIX,
  encryptSecret,
  decryptSecret,
  maybeEncryptSecret,
  maybeDecryptSecret,
  isEncryptedSecret,
  parseEncryptionKey,
  getTokensEncryptionKeyMaterial,
  validateConfiguredTokensEncryptionKey
};
