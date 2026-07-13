const crypto = require('crypto');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  listInstagramChannelsByClinicId,
  upsertInstagramChannel
} = require('../repositories/tenant.repository');
const {
  exchangeOAuthCodeForAccessToken,
  fetchInstagramBusinessAssets,
  subscribePageToWebhook
} = require('../integrations/instagram/instagram.service');
const { logInfo, logWarn } = require('../utils/logger');

const pendingAssetSelections = new Map();
const ASSET_SELECTION_TTL_MS = 10 * 60 * 1000;

function pruneExpiredAssetSelections() {
  const now = Date.now();
  for (const [token, record] of pendingAssetSelections.entries()) {
    if (!record || !record.expiresAt || record.expiresAt <= now) {
      pendingAssetSelections.delete(token);
    }
  }
}

function summarizeInstagramAsset(asset) {
  if (!asset) return null;
  return {
    pageId: asset.pageId || null,
    pageName: asset.pageName || null,
    instagramUserId: asset.instagramBusinessAccountId || null,
    instagramUsername: asset.instagramUsername || null
  };
}

function createAssetSelection({ tenantId, clinicId, assets }) {
  pruneExpiredAssetSelections();
  const selectionToken = crypto.randomUUID();
  pendingAssetSelections.set(selectionToken, {
    tenantId,
    clinicId,
    assets,
    expiresAt: Date.now() + ASSET_SELECTION_TTL_MS
  });
  return selectionToken;
}

function consumeAssetSelection({ selectionToken, tenantId, clinicId, selectedPageId, selectedInstagramUserId }) {
  pruneExpiredAssetSelections();
  const safeToken = String(selectionToken || '').trim();
  const record = safeToken ? pendingAssetSelections.get(safeToken) : null;
  if (!record || record.tenantId !== tenantId || record.clinicId !== clinicId) {
    return { ok: false, reason: 'instagram_asset_selection_expired' };
  }

  const pageId = String(selectedPageId || '').trim();
  const instagramUserId = String(selectedInstagramUserId || '').trim();
  const asset = record.assets.find((candidate) => {
    const matchesPage = pageId && candidate.pageId === pageId;
    const matchesInstagram = instagramUserId && candidate.instagramBusinessAccountId === instagramUserId;
    return matchesPage || matchesInstagram;
  });

  if (!asset) {
    return { ok: false, reason: 'instagram_asset_selection_not_found' };
  }

  pendingAssetSelections.delete(safeToken);
  return { ok: true, asset };
}

function summarizeInstagramChannel(channel) {
  if (!channel) return null;
  return {
    id: channel.id,
    clinicId: channel.clinicId,
    type: channel.type || 'instagram',
    provider: channel.provider || 'instagram_graph',
    externalId: channel.externalId || channel.instagramUserId || null,
    externalPageId: channel.externalPageId || null,
    externalPageName: channel.externalPageName || null,
    instagramUserId: channel.instagramUserId || channel.externalId || null,
    instagramUsername: channel.instagramUsername || null,
    status: channel.status || null,
    updatedAt: channel.updatedAt || null
  };
}

async function connectSelectedInstagramAsset({ context, selectedAsset, tokenType = null, expiresIn = null, availableAssets = [], requestId = null }) {
  await subscribePageToWebhook({
    pageId: selectedAsset.pageId,
    accessToken: selectedAsset.pageAccessToken,
    requestId
  });

  const channel = await upsertInstagramChannel({
    clinicId: context.clinic.id,
    externalId: selectedAsset.instagramBusinessAccountId,
    externalPageId: selectedAsset.pageId,
    externalPageName: selectedAsset.pageName,
    instagramUserId: selectedAsset.instagramBusinessAccountId,
    instagramUsername: selectedAsset.instagramUsername,
    accessToken: selectedAsset.pageAccessToken,
    status: 'active',
    connectionSource: 'instagram_oauth',
    connectionMetadata: {
      oauthTokenType: tokenType || null,
      oauthExpiresIn: expiresIn || null,
      availableAssets: availableAssets.map((asset) => summarizeInstagramAsset(asset)).filter(Boolean)
    }
  });

  logInfo('portal_instagram_connect_succeeded', {
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    requestId,
    channelId: channel && channel.id ? channel.id : null,
    externalId: channel && channel.externalId ? channel.externalId : null,
    externalPageId: channel && channel.externalPageId ? channel.externalPageId : null
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    state: 'connected',
    channel: summarizeInstagramChannel(channel)
  };
}

function pickPrimaryInstagramChannel(channels) {
  const items = Array.isArray(channels) ? channels : [];
  if (!items.length) return null;

  return (
    items.find((channel) => String(channel.status || '').trim().toLowerCase() === 'active') ||
    items[0] ||
    null
  );
}

async function getPortalInstagramConnectionStatus(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok) return context;

  const channels = await listInstagramChannelsByClinicId(context.clinic.id);
  const primaryChannel = pickPrimaryInstagramChannel(channels);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    state: primaryChannel ? 'connected' : 'not_connected',
    channel: summarizeInstagramChannel(primaryChannel),
    channels: channels.map(summarizeInstagramChannel)
  };
}

async function connectPortalInstagramChannel(tenantId, input = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok) return context;

  const code = String(input.code || '').trim();
  const redirectUri = String(input.redirectUri || '').trim();
  const selectionToken = String(input.selectionToken || '').trim();
  const selectedPageId = String(input.selectedPageId || '').trim();
  const selectedInstagramUserId = String(input.selectedInstagramUserId || '').trim();

  if (selectionToken) {
    const selection = consumeAssetSelection({
      selectionToken,
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      selectedPageId,
      selectedInstagramUserId
    });

    if (!selection.ok) {
      return {
        ok: false,
        tenantId: context.tenantId,
        clinicId: context.clinic.id,
        reason: selection.reason
      };
    }

    return connectSelectedInstagramAsset({
      context,
      selectedAsset: selection.asset,
      availableAssets: [selection.asset],
      requestId: input.requestId || null
    });
  }

  if (!code) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      reason: 'missing_instagram_oauth_code'
    };
  }

  if (!redirectUri) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      reason: 'missing_instagram_redirect_uri'
    };
  }

  logInfo('portal_instagram_connect_started', {
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    requestId: input.requestId || null
  });

  const token = await exchangeOAuthCodeForAccessToken({
    code,
    redirectUri,
    requestId: input.requestId || null
  });
  const assets = await fetchInstagramBusinessAssets({
    accessToken: token.accessToken,
    userId: token.userId,
    requestId: input.requestId || null
  });

  if (assets.length > 1) {
    const selectionToken = createAssetSelection({
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      assets
    });

    logWarn('portal_instagram_connect_ambiguous_assets', {
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      requestId: input.requestId || null,
      assetCount: assets.length,
      pageIds: assets.map((asset) => asset.pageId),
      instagramBusinessAccountIds: assets.map((asset) => asset.instagramBusinessAccountId)
    });

    return {
      ok: false,
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      reason: 'instagram_multiple_assets_found',
      details: {
        assetCount: assets.length,
        selectionToken,
        candidates: assets.map((asset) => summarizeInstagramAsset(asset)).filter(Boolean),
        expiresInSeconds: Math.floor(ASSET_SELECTION_TTL_MS / 1000)
      }
    };
  }

  const selectedAsset = assets[0];

  return connectSelectedInstagramAsset({
    context,
    selectedAsset,
    tokenType: token.tokenType || null,
    expiresIn: token.expiresIn || null,
    availableAssets: assets,
    requestId: input.requestId || null
  });
}

module.exports = {
  getPortalInstagramConnectionStatus,
  connectPortalInstagramChannel
};
