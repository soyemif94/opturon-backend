const crypto = require('crypto');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  listInstagramChannelsByClinicId,
  upsertInstagramChannel,
  disconnectInstagramChannelByIdAndClinicId
} = require('../repositories/tenant.repository');
const {
  exchangeOAuthCodeForAccessToken,
  exchangeInstagramLongLivedToken,
  logInstagramOAuthCodeTelemetry,
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

function createAssetSelection({ tenantId, clinicId, assets, tokenMetadata = {}, providerOverride = null }) {
  pruneExpiredAssetSelections();
  const selectionToken = crypto.randomUUID();
  pendingAssetSelections.set(selectionToken, {
    tenantId,
    clinicId,
    assets,
    tokenMetadata,
    providerOverride,
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
  return {
    ok: true,
    asset,
    tokenMetadata: record.tokenMetadata || {},
    providerOverride: record.providerOverride || null
  };
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

async function connectSelectedInstagramAsset({
  context,
  selectedAsset,
  tokenType = null,
  providerTokenType = null,
  expiresIn = null,
  tokenObtainedAt = null,
  tokenExpiresAt = null,
  availableAssets = [],
  providerOverride = null,
  requestId = null
}) {
  await subscribePageToWebhook({
    pageId: selectedAsset.pageId,
    accessToken: selectedAsset.pageAccessToken,
    providerOverride,
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
      oauthProvider: providerOverride || null,
      oauthTokenType: tokenType || null,
      oauthProviderTokenType: providerTokenType || null,
      oauthExpiresIn: expiresIn || null,
      oauthTokenObtainedAt: tokenObtainedAt || null,
      oauthTokenExpiresAt: tokenExpiresAt || null,
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
  return items.find((channel) => String(channel.status || '').trim().toLowerCase() === 'active') || null;
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

  const rawCode = input.code;
  const codeTelemetryId = String(input.codeTelemetryId || '').trim() || null;
  logInstagramOAuthCodeTelemetry('BACKEND_RECEIVED', rawCode, {
    requestId: input.requestId || null,
    correlationId: codeTelemetryId
  });
  const code = String(rawCode || '').trim();
  const redirectUri = String(input.redirectUri || '').trim();
  const oauthProvider = String(input.oauthProvider || '').trim().toLowerCase() || null;
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
      tokenType: selection.tokenMetadata.tokenType || null,
      providerTokenType: selection.tokenMetadata.providerTokenType || null,
      expiresIn: selection.tokenMetadata.expiresIn || null,
      tokenObtainedAt: selection.tokenMetadata.obtainedAt || null,
      tokenExpiresAt: selection.tokenMetadata.expiresAt || null,
      availableAssets: [selection.asset],
      providerOverride: selection.providerOverride,
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

  if (oauthProvider && oauthProvider !== 'instagram_login' && oauthProvider !== 'facebook_login') {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      reason: 'invalid_instagram_oauth_provider'
    };
  }

  logInfo('portal_instagram_connect_started', {
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    oauthProvider,
    requestId: input.requestId || null
  });

  const shortLivedToken = await exchangeOAuthCodeForAccessToken({
    code,
    redirectUri,
    providerOverride: oauthProvider,
    requestId: input.requestId || null,
    codeTelemetryId
  });
  const resolvedOauthProvider = shortLivedToken.provider || oauthProvider;
  const token = resolvedOauthProvider === 'instagram_login'
    ? await exchangeInstagramLongLivedToken({
        shortLivedAccessToken: shortLivedToken.accessToken,
        requestId: input.requestId || null
      })
    : shortLivedToken;
  const assets = await fetchInstagramBusinessAssets({
    accessToken: token.accessToken,
    userId: token.userId,
    providerOverride: resolvedOauthProvider,
    requestId: input.requestId || null
  });

  if (assets.length > 1) {
    const selectionToken = createAssetSelection({
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      assets,
      tokenMetadata: token,
      providerOverride: resolvedOauthProvider
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
    providerTokenType: token.providerTokenType || null,
    expiresIn: token.expiresIn || null,
    tokenObtainedAt: token.obtainedAt || null,
    tokenExpiresAt: token.expiresAt || null,
    availableAssets: assets,
    providerOverride: resolvedOauthProvider,
    requestId: input.requestId || null
  });
}

async function disconnectPortalInstagramChannel(tenantId, input = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok) return context;

  const channelId = String(input.channelId || '').trim();
  if (!channelId) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      reason: 'missing_instagram_channel_id'
    };
  }

  const channel = await disconnectInstagramChannelByIdAndClinicId(channelId, context.clinic.id);
  if (!channel) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      reason: 'instagram_channel_not_found_or_forbidden'
    };
  }

  logInfo('portal_instagram_disconnect_succeeded', {
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    requestId: input.requestId || null,
    channelId: channel.id
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    state: 'not_connected',
    channel: null,
    channels: [summarizeInstagramChannel(channel)]
  };
}

module.exports = {
  getPortalInstagramConnectionStatus,
  connectPortalInstagramChannel,
  disconnectPortalInstagramChannel
};
