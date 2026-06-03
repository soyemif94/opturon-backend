const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const env = require('../config/env');

const ALLOWED_LOYALTY_REWARD_IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

const LOYALTY_REWARD_IMAGE_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

function normalizeString(value) {
  return String(value || '').trim();
}

function resolveExplicitRewardImageBaseDir() {
  return normalizeString(process.env.OPTURON_RUNTIME_DATA_DIR || process.env.OPTURON_DATA_DIR) || null;
}

function requiresExplicitPersistentStorage() {
  return String(process.env.RENDER || '').trim().toLowerCase() === 'true';
}

function resolveLoyaltyRewardImageStorageRoot() {
  const configuredRoot = resolveExplicitRewardImageBaseDir();
  if (configuredRoot) {
    return path.resolve(configuredRoot, 'loyalty-reward-images');
  }

  const jsonDbAbsolutePath = path.resolve(process.cwd(), env.jsonDbPath || './data/patients.json');
  return path.join(path.dirname(jsonDbAbsolutePath), 'loyalty-reward-images');
}

function normalizeTenantStorageKey(tenantId) {
  const normalized = normalizeString(tenantId).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return normalized || 'tenant';
}

function normalizeRewardImageExtension(mimeType) {
  const normalizedMimeType = normalizeString(mimeType).toLowerCase();
  return ALLOWED_LOYALTY_REWARD_IMAGE_TYPES.get(normalizedMimeType) || null;
}

function resolveStoredRewardImageContentType(fileName) {
  const extension = path.extname(normalizeString(fileName)).toLowerCase();
  return LOYALTY_REWARD_IMAGE_CONTENT_TYPES[extension] || 'application/octet-stream';
}

async function saveUploadedLoyaltyRewardImage(tenantId, payload) {
  if (requiresExplicitPersistentStorage() && !resolveExplicitRewardImageBaseDir()) {
    return { ok: false, reason: 'loyalty_reward_image_storage_not_configured' };
  }

  const extension = normalizeRewardImageExtension(payload && payload.mimeType);
  if (!extension) {
    return { ok: false, reason: 'invalid_loyalty_reward_image_type' };
  }

  const origin = normalizeString(payload && payload.origin);
  if (!origin) {
    return { ok: false, reason: 'missing_loyalty_reward_image_origin' };
  }

  if (!payload || !Buffer.isBuffer(payload.buffer) || payload.buffer.length === 0) {
    return { ok: false, reason: 'missing_loyalty_reward_image_file' };
  }

  const tenantKey = normalizeTenantStorageKey(tenantId);
  const fileName = `${randomUUID()}.${extension}`;
  const directoryPath = path.join(resolveLoyaltyRewardImageStorageRoot(), tenantKey);
  const filePath = path.join(directoryPath, fileName);

  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(filePath, payload.buffer);

  return {
    ok: true,
    image: {
      url: `${origin}/portal/loyalty-reward-images/${encodeURIComponent(tenantId)}/${encodeURIComponent(fileName)}`,
      source: 'uploaded'
    },
    storage: {
      fileName,
      filePath
    }
  };
}

async function readUploadedLoyaltyRewardImage(tenantId, fileName) {
  if (requiresExplicitPersistentStorage() && !resolveExplicitRewardImageBaseDir()) {
    return { ok: false, reason: 'loyalty_reward_image_storage_not_configured' };
  }

  const safeFileName = normalizeString(fileName);
  if (!safeFileName || safeFileName.includes('/') || safeFileName.includes('\\')) {
    return { ok: false, reason: 'loyalty_reward_image_not_found' };
  }

  const tenantKey = normalizeTenantStorageKey(tenantId);
  const filePath = path.join(resolveLoyaltyRewardImageStorageRoot(), tenantKey, safeFileName);

  try {
    const buffer = await fs.readFile(filePath);
    return {
      ok: true,
      media: {
        buffer,
        fileName: safeFileName,
        contentType: resolveStoredRewardImageContentType(safeFileName)
      }
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: false, reason: 'loyalty_reward_image_not_found' };
    }
    throw error;
  }
}

module.exports = {
  ALLOWED_LOYALTY_REWARD_IMAGE_TYPES: Array.from(ALLOWED_LOYALTY_REWARD_IMAGE_TYPES.keys()),
  resolveLoyaltyRewardImageStorageRoot,
  saveUploadedLoyaltyRewardImage,
  readUploadedLoyaltyRewardImage
};
