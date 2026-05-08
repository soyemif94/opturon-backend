const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const env = require('../config/env');

const ALLOWED_PRODUCT_IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

const PRODUCT_IMAGE_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

function normalizeString(value) {
  return String(value || '').trim();
}

function resolveExplicitProductImageBaseDir() {
  return normalizeString(process.env.OPTURON_RUNTIME_DATA_DIR || process.env.OPTURON_DATA_DIR) || null;
}

function requiresExplicitPersistentStorage() {
  return String(process.env.RENDER || '').trim().toLowerCase() === 'true';
}

function resolveProductImageStorageRoot() {
  const configuredRoot = resolveExplicitProductImageBaseDir();
  if (configuredRoot) {
    return path.resolve(configuredRoot, 'product-images');
  }

  const jsonDbAbsolutePath = path.resolve(process.cwd(), env.jsonDbPath || './data/patients.json');
  return path.join(path.dirname(jsonDbAbsolutePath), 'product-images');
}

function normalizeTenantStorageKey(tenantId) {
  const normalized = normalizeString(tenantId).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return normalized || 'tenant';
}

function normalizeProductImageExtension(mimeType) {
  const normalizedMimeType = normalizeString(mimeType).toLowerCase();
  return ALLOWED_PRODUCT_IMAGE_TYPES.get(normalizedMimeType) || null;
}

function resolveStoredProductImageContentType(fileName) {
  const extension = path.extname(normalizeString(fileName)).toLowerCase();
  return PRODUCT_IMAGE_CONTENT_TYPES[extension] || 'application/octet-stream';
}

async function saveUploadedProductImage(tenantId, payload) {
  if (requiresExplicitPersistentStorage() && !resolveExplicitProductImageBaseDir()) {
    return { ok: false, reason: 'product_image_storage_not_configured' };
  }

  const extension = normalizeProductImageExtension(payload && payload.mimeType);
  if (!extension) {
    return { ok: false, reason: 'invalid_product_image_type' };
  }

  const origin = normalizeString(payload && payload.origin);
  if (!origin) {
    return { ok: false, reason: 'missing_product_image_origin' };
  }

  if (!payload || !Buffer.isBuffer(payload.buffer) || payload.buffer.length === 0) {
    return { ok: false, reason: 'missing_product_image_file' };
  }

  const tenantKey = normalizeTenantStorageKey(tenantId);
  const fileName = `${randomUUID()}.${extension}`;
  const directoryPath = path.join(resolveProductImageStorageRoot(), tenantKey);
  const filePath = path.join(directoryPath, fileName);

  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(filePath, payload.buffer);

  return {
    ok: true,
    image: {
      url: `${origin}/portal/product-images/${encodeURIComponent(tenantId)}/${encodeURIComponent(fileName)}`,
      source: 'uploaded'
    },
    storage: {
      fileName,
      filePath
    }
  };
}

async function readUploadedProductImage(tenantId, fileName) {
  if (requiresExplicitPersistentStorage() && !resolveExplicitProductImageBaseDir()) {
    return { ok: false, reason: 'product_image_storage_not_configured' };
  }

  const safeFileName = normalizeString(fileName);
  if (!safeFileName || safeFileName.includes('/') || safeFileName.includes('\\')) {
    return { ok: false, reason: 'product_image_not_found' };
  }

  const tenantKey = normalizeTenantStorageKey(tenantId);
  const filePath = path.join(resolveProductImageStorageRoot(), tenantKey, safeFileName);

  try {
    const buffer = await fs.readFile(filePath);
    return {
      ok: true,
      media: {
        buffer,
        fileName: safeFileName,
        contentType: resolveStoredProductImageContentType(safeFileName)
      }
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: false, reason: 'product_image_not_found' };
    }
    throw error;
  }
}

module.exports = {
  ALLOWED_PRODUCT_IMAGE_TYPES: Array.from(ALLOWED_PRODUCT_IMAGE_TYPES.keys()),
  resolveProductImageStorageRoot,
  saveUploadedProductImage,
  readUploadedProductImage
};
