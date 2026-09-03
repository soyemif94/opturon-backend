const env = require('../../config/env');
const { logWarn } = require('../../utils/logger');

const DEFAULT_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const MISSING_PROFILE_PIC_RETRY_TTL_MS = 60 * 60 * 1000;
const DEFAULT_GRAPH_VERSION = String(env.getWhatsAppGraphVersion()).trim();
const DEFAULT_FETCH_TIMEOUT_MS = 8000;

function normalizeString(value) {
  const safeValue = String(value || '').trim();
  return safeValue || null;
}

function normalizeMetadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeInstagramProfileSnapshot(contact) {
  const metadata = normalizeMetadataObject(contact && contact.metadata);
  return normalizeMetadataObject(metadata.instagramProfile);
}

function normalizeInstagramUsername(value) {
  const safeValue = normalizeString(value);
  if (!safeValue) return null;
  return safeValue.replace(/^@+/, '') || null;
}

function formatInstagramUsername(value) {
  const username = normalizeInstagramUsername(value);
  return username ? `@${username}` : null;
}

function fingerprintIdentifier(value) {
  const safeValue = normalizeString(value);
  if (!safeValue) return null;
  if (safeValue.length <= 6) return safeValue;
  return `${safeValue.slice(0, 2)}***${safeValue.slice(-4)}`;
}

function isTruthyDateString(value) {
  return Boolean(value) && Number.isFinite(Date.parse(String(value)));
}

function isInstagramProfileStale(contact, ttlMs = DEFAULT_PROFILE_TTL_MS, now = new Date()) {
  const snapshot = normalizeInstagramProfileSnapshot(contact);
  const fetchedAt = normalizeString(snapshot.providerProfileFetchedAt || snapshot.providerProfilePicFetchedAt);
  if (!fetchedAt || !isTruthyDateString(fetchedAt)) return true;

  const lastFetchedAt = Date.parse(fetchedAt);
  if (!Number.isFinite(lastFetchedAt)) return true;
  const effectiveTtlMs = normalizeString(snapshot.providerProfilePicUrl)
    ? ttlMs
    : Math.min(ttlMs, MISSING_PROFILE_PIC_RETRY_TTL_MS);
  return now.getTime() - lastFetchedAt >= effectiveTtlMs;
}

function isDerivedIdentityValue(value, snapshot, waId) {
  const safeValue = normalizeString(value);
  if (!safeValue) return false;

  const username = formatInstagramUsername(snapshot && snapshot.username);
  const providerName = normalizeString(snapshot && snapshot.name);
  const technicalId = normalizeString(waId);

  return [username, providerName, technicalId].some((candidate) => safeValue === candidate);
}

function chooseInstagramDisplayName(contact, profile) {
  const snapshot = normalizeInstagramProfileSnapshot(contact);
  const currentName = normalizeString(contact && contact.name);
  if (currentName && !isDerivedIdentityValue(currentName, snapshot, contact && contact.waId)) {
    return currentName;
  }

  const providerName = normalizeString(profile && profile.name);
  const username = formatInstagramUsername(profile && profile.username);
  return providerName || username || normalizeString(contact && contact.waId);
}

function chooseInstagramAvatar(contact, profile) {
  const snapshot = normalizeInstagramProfileSnapshot(contact);
  const currentAvatar = normalizeString(contact && contact.profileImageUrl);
  const previousProviderAvatar = normalizeString(snapshot.providerProfilePicUrl);
  const nextProviderAvatar = normalizeString(profile && profile.profilePicUrl);

  if (currentAvatar && currentAvatar !== previousProviderAvatar) {
    return currentAvatar;
  }

  return nextProviderAvatar || currentAvatar || null;
}

function buildInstagramProfileMetadata({ contact, channel, igsid, profile, fetchedAt }) {
  const currentMetadata = normalizeMetadataObject(contact && contact.metadata);
  const currentSnapshot = normalizeInstagramProfileSnapshot(contact);
  const providerProfilePicUrl = normalizeString(profile && profile.profilePicUrl);
  const providerProfileFetchedAt = normalizeString(fetchedAt) || new Date().toISOString();

  return {
    ...currentMetadata,
    instagramProfile: {
      ...currentSnapshot,
      provider: 'instagram_graph',
      channelId: normalizeString(channel && channel.id),
      recipientInstagramUserId: normalizeString(channel && (channel.instagramUserId || channel.externalId)),
      senderIgsid: normalizeString(igsid),
      name: normalizeString(profile && profile.name),
      username: normalizeInstagramUsername(profile && profile.username),
      providerProfilePicUrl,
      providerProfileFetchedAt,
      providerProfilePicFetchedAt: providerProfilePicUrl ? providerProfileFetchedAt : currentSnapshot.providerProfilePicFetchedAt || null
    }
  };
}

async function fetchInstagramUserProfile({ igsid, accessToken, apiVersion = DEFAULT_GRAPH_VERSION }) {
  const safeIgsid = normalizeString(igsid);
  const safeAccessToken = normalizeString(accessToken);
  if (!safeIgsid) {
    throw new Error('missing_instagram_sender_igsid');
  }
  if (!safeAccessToken) {
    throw new Error('missing_instagram_channel_access_token');
  }

  const url = new URL(`https://graph.instagram.com/${String(apiVersion || DEFAULT_GRAPH_VERSION).trim()}/${safeIgsid}`);
  url.searchParams.set('fields', 'name,username,profile_pic');
  url.searchParams.set('access_token', safeAccessToken);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (error) {
    json = null;
  }

  const error = json && json.error && typeof json.error === 'object' ? json.error : null;
  return {
    ok: response.ok,
    status: response.status,
    name: normalizeString(json && json.name),
    username: normalizeInstagramUsername(json && json.username),
    profilePicUrl: normalizeString(json && json.profile_pic),
    errorCode: error && error.code ? error.code : null,
    errorType: normalizeString(error && error.type),
    errorMessage: normalizeString(error && error.message)
  };
}

async function maybeEnrichInstagramContactProfile({ contact, channel, igsid, ttlMs = DEFAULT_PROFILE_TTL_MS, now = new Date() }) {
  const safeIgsid = normalizeString(igsid);
  if (!contact || !channel || !safeIgsid) {
    return {
      changed: false,
      contactPatch: null,
      status: 'skipped_missing_context'
    };
  }

  if (!isInstagramProfileStale(contact, ttlMs, now) && normalizeInstagramProfileSnapshot(contact).senderIgsid === safeIgsid) {
    return {
      changed: false,
      contactPatch: null,
      status: 'skipped_fresh_snapshot'
    };
  }

  try {
    const profile = await fetchInstagramUserProfile({
      igsid: safeIgsid,
      accessToken: channel.accessToken,
      apiVersion: DEFAULT_GRAPH_VERSION
    });

    if (!profile.ok) {
      logWarn('instagram_profile_lookup_failed', {
        provider: 'instagram_graph',
        channelId: channel.id || null,
        igsidFingerprint: fingerprintIdentifier(safeIgsid),
        status: profile.status,
        errorCode: profile.errorCode,
        errorType: profile.errorType
      });
      return {
        changed: false,
        contactPatch: null,
        status: 'lookup_failed',
        lookup: profile
      };
    }

    const fetchedAt = now.toISOString();
    const metadata = buildInstagramProfileMetadata({
      contact,
      channel,
      igsid: safeIgsid,
      profile,
      fetchedAt
    });
    const nextName = chooseInstagramDisplayName(contact, profile);
    const nextAvatar = chooseInstagramAvatar(contact, profile);

    return {
      changed: true,
      status: 'enriched',
      lookup: profile,
      contactPatch: {
        name: nextName,
        profileImageUrl: nextAvatar,
        metadata
      }
    };
  } catch (error) {
    logWarn('instagram_profile_lookup_exception', {
      provider: 'instagram_graph',
      channelId: channel.id || null,
      igsidFingerprint: fingerprintIdentifier(safeIgsid),
      status: null,
      errorCode: error.code || null,
      errorType: error.name || 'Error'
    });
    return {
      changed: false,
      contactPatch: null,
      status: 'lookup_exception'
    };
  }
}

module.exports = {
  DEFAULT_PROFILE_TTL_MS,
  MISSING_PROFILE_PIC_RETRY_TTL_MS,
  formatInstagramUsername,
  normalizeInstagramProfileSnapshot,
  isInstagramProfileStale,
  chooseInstagramDisplayName,
  chooseInstagramAvatar,
  buildInstagramProfileMetadata,
  fetchInstagramUserProfile,
  maybeEnrichInstagramContactProfile
};
