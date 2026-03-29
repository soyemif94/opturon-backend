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
    status: channel.status || null
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
    requestId: input.requestId || null
  });

  if (assets.length > 1) {
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
        assetCount: assets.length
      }
    };
  }

  const selectedAsset = assets[0];

  await subscribePageToWebhook({
    pageId: selectedAsset.pageId,
    accessToken: selectedAsset.pageAccessToken,
    requestId: input.requestId || null
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
      oauthTokenType: token.tokenType || null,
      oauthExpiresIn: token.expiresIn || null,
      availableAssets: assets.map((asset) => ({
        pageId: asset.pageId,
        pageName: asset.pageName,
        instagramBusinessAccountId: asset.instagramBusinessAccountId,
        instagramUsername: asset.instagramUsername
      }))
    }
  });

  logInfo('portal_instagram_connect_succeeded', {
    tenantId: context.tenantId,
    clinicId: context.clinic.id,
    requestId: input.requestId || null,
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

module.exports = {
  getPortalInstagramConnectionStatus,
  connectPortalInstagramChannel
};
