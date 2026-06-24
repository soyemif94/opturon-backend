const fs = require('fs/promises');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const env = require('../config/env');

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const ALLOWED_RECEIPT_TYPES = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

const EXTENSION_MIME_TYPES = new Map([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp']
]);

function normalizeString(value) {
  return String(value || '').trim();
}

function resolveExplicitBaseDir() {
  return normalizeString(process.env.OPTURON_RUNTIME_DATA_DIR || process.env.OPTURON_DATA_DIR) || null;
}

function requiresExplicitPersistentStorage() {
  return String(process.env.RENDER || '').trim().toLowerCase() === 'true';
}

function resolveReceiptStorageRoot() {
  const configuredRoot = resolveExplicitBaseDir();
  if (configuredRoot) {
    return path.resolve(configuredRoot, 'partner-client-request-receipts');
  }

  const jsonDbAbsolutePath = path.resolve(process.cwd(), env.jsonDbPath || './data/patients.json');
  return path.join(path.dirname(jsonDbAbsolutePath), 'partner-client-request-receipts');
}

function sanitizeOriginalName(fileName) {
  const base = path.basename(normalizeString(fileName) || 'comprobante');
  return base.replace(/[^\w.\- ()]+/g, '_').slice(0, 160) || 'comprobante';
}

function detectMimeFromSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.subarray(0, 4).toString('hex') === '25504446') return 'application/pdf';
  if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function validateReceiptFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    return { ok: false, reason: 'missing_client_request_receipt' };
  }
  if (file.buffer.length > MAX_RECEIPT_BYTES) {
    return { ok: false, reason: 'client_request_receipt_too_large' };
  }

  const originalName = sanitizeOriginalName(file.originalname || file.name || 'comprobante');
  if (originalName.includes('/') || originalName.includes('\\') || originalName.includes('..')) {
    return { ok: false, reason: 'invalid_client_request_receipt_name' };
  }

  const extension = path.extname(originalName).toLowerCase();
  const declaredMime = normalizeString(file.mimetype || file.type).toLowerCase();
  const extensionMime = EXTENSION_MIME_TYPES.get(extension) || null;
  const signatureMime = detectMimeFromSignature(file.buffer);
  const allowedExtension = extensionMime && ALLOWED_RECEIPT_TYPES.has(extensionMime);
  const allowedDeclared = ALLOWED_RECEIPT_TYPES.has(declaredMime);

  if (!allowedExtension || !allowedDeclared || !signatureMime) {
    return { ok: false, reason: 'invalid_client_request_receipt_type' };
  }
  if (declaredMime !== signatureMime || extensionMime !== signatureMime) {
    return { ok: false, reason: 'client_request_receipt_signature_mismatch' };
  }

  return {
    ok: true,
    originalName,
    mimeType: signatureMime,
    extension: ALLOWED_RECEIPT_TYPES.get(signatureMime),
    sizeBytes: file.buffer.length,
    sha256: createHash('sha256').update(file.buffer).digest('hex')
  };
}

async function saveClientRequestReceipt(partnerId, file) {
  if (requiresExplicitPersistentStorage() && !resolveExplicitBaseDir()) {
    return { ok: false, reason: 'client_request_receipt_storage_not_configured' };
  }

  const validation = validateReceiptFile(file);
  if (!validation.ok) return validation;

  const partnerKey = normalizeString(partnerId).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (!partnerKey) return { ok: false, reason: 'invalid_partner_id' };

  const fileName = `${randomUUID()}.${validation.extension}`;
  const directoryPath = path.join(resolveReceiptStorageRoot(), partnerKey);
  const filePath = path.join(directoryPath, fileName);
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(filePath, file.buffer, { flag: 'wx' });

  return {
    ok: true,
    receipt: {
      storageKey: `${partnerKey}/${fileName}`,
      originalName: validation.originalName,
      mimeType: validation.mimeType,
      sizeBytes: validation.sizeBytes,
      sha256: validation.sha256
    }
  };
}

async function readClientRequestReceipt(storageKey) {
  const safeKey = normalizeString(storageKey);
  if (!safeKey || safeKey.includes('..') || safeKey.startsWith('/') || safeKey.startsWith('\\')) {
    return { ok: false, reason: 'client_request_receipt_not_found' };
  }
  const parts = safeKey.split('/');
  if (parts.length !== 2 || parts.some((part) => !part || part.includes('\\'))) {
    return { ok: false, reason: 'client_request_receipt_not_found' };
  }

  if (requiresExplicitPersistentStorage() && !resolveExplicitBaseDir()) {
    return { ok: false, reason: 'client_request_receipt_storage_not_configured' };
  }

  try {
    const buffer = await fs.readFile(path.join(resolveReceiptStorageRoot(), parts[0], parts[1]));
    const mimeType = EXTENSION_MIME_TYPES.get(path.extname(parts[1]).toLowerCase()) || 'application/octet-stream';
    return { ok: true, buffer, mimeType };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, reason: 'client_request_receipt_not_found' };
    throw error;
  }
}

module.exports = {
  MAX_RECEIPT_BYTES,
  ALLOWED_RECEIPT_TYPES: Array.from(ALLOWED_RECEIPT_TYPES.keys()),
  resolveReceiptStorageRoot,
  validateReceiptFile,
  saveClientRequestReceipt,
  readClientRequestReceipt
};
