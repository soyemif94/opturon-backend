const { findClinicByExternalTenantId, listWhatsAppChannelsByClinicId } = require('../repositories/tenant.repository');
const { listProductsByClinicId } = require('../repositories/products.repository');
const { listAutomationsByClinicId } = require('../repositories/automations.repository');
const { query } = require('../db/client');
const { logInfo, logWarn } = require('../utils/logger');

function summarizeClinic(clinic) {
  if (!clinic) return null;
  return {
    id: clinic.id,
    name: clinic.name || null,
    timezone: clinic.timezone || null,
    externalTenantId: clinic.externalTenantId || null
  };
}

function summarizeChannel(channel) {
  if (!channel) return null;
  return {
    id: channel.id,
    clinicId: channel.clinicId,
    provider: channel.provider || null,
    phoneNumberId: channel.phoneNumberId || null,
    displayPhoneNumber: channel.displayPhoneNumber || null,
    verifiedName: channel.verifiedName || null,
    wabaId: channel.wabaId || null,
    status: channel.status || null
  };
}

function parseClinicSettings(clinic) {
  if (!clinic || typeof clinic !== 'object') return {};
  const raw = clinic.settings;
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractExplicitPortalChannelId(clinic) {
  const settings = parseClinicSettings(clinic);
  const candidates = [
    settings && settings.whatsapp && settings.whatsapp.defaultChannelId,
    settings && settings.whatsapp && settings.whatsapp.primaryChannelId,
    settings && settings.portal && settings.portal.defaultWhatsAppChannelId,
    settings && settings.portal && settings.portal.selectedWhatsAppChannelId
  ];

  for (const value of candidates) {
    const safe = String(value || '').trim();
    if (safe) return safe;
  }

  return null;
}

function pickPortalChannel(channels, clinic = null) {
  const items = Array.isArray(channels) ? channels : [];
  if (!items.length) {
    return { channel: null, reason: 'mapped_clinic_without_whatsapp_channel', strategy: 'none' };
  }

  const activeChannels = items.filter((channel) => String(channel.status || '').trim().toLowerCase() === 'active');
  const explicitChannelId = extractExplicitPortalChannelId(clinic);
  if (explicitChannelId) {
    const selectedChannel = items.find((channel) => String(channel.id || '').trim() === explicitChannelId) || null;
    if (!selectedChannel) {
      return {
        channel: null,
        reason: 'portal_selected_channel_not_found',
        strategy: 'explicit',
        explicitChannelId
      };
    }

    if (String(selectedChannel.status || '').trim().toLowerCase() !== 'active') {
      return {
        channel: null,
        reason: 'portal_selected_channel_inactive',
        strategy: 'explicit',
        explicitChannelId
      };
    }

    return {
      channel: selectedChannel,
      reason: 'resolved',
      strategy: 'explicit',
      explicitChannelId
    };
  }

  if (activeChannels.length === 1) {
    return { channel: activeChannels[0], reason: 'resolved', strategy: 'single_active' };
  }
  if (activeChannels.length > 1) {
    return {
      channel: null,
      reason: 'multiple_whatsapp_channels_configured',
      strategy: 'ambiguous_multiple_active',
      activeChannelIds: activeChannels.map((channel) => channel.id)
    };
  }

  if (items.length === 1) {
    return { channel: items[0], reason: 'resolved', strategy: 'single_inactive_fallback' };
  }

  return {
    channel: null,
    reason: 'multiple_whatsapp_channels_configured',
    strategy: 'ambiguous_multiple_inactive_or_mixed'
  };
}

async function resolvePortalTenantContext(externalTenantId) {
  const safeTenantId = String(externalTenantId || '').trim();
  if (!safeTenantId) {
    return {
      ok: false,
      tenantId: null,
      clinic: null,
      channel: null,
      reason: 'missing_tenant_id'
    };
  }

  const clinic = await findClinicByExternalTenantId(safeTenantId);
  if (!clinic) {
    return {
      ok: false,
      tenantId: safeTenantId,
      clinic: null,
      channel: null,
      reason: 'tenant_mapping_not_found'
    };
  }

  const [channels, products, automations, conversationsResult] = await Promise.all([
    listWhatsAppChannelsByClinicId(clinic.id),
    listProductsByClinicId(clinic.id),
    listAutomationsByClinicId(clinic.id),
    query(
      `SELECT COUNT(*)::int AS total
       FROM conversations
       WHERE "clinicId" = $1::uuid`,
      [clinic.id]
    )
  ]);
  const channelSelection = pickPortalChannel(channels, clinic);
  const activeProducts = (Array.isArray(products) ? products : []).filter(
    (product) => String(product && product.status ? product.status : '').trim().toLowerCase() === 'active'
  );
  const activeAutomations = (Array.isArray(automations) ? automations : []).filter((automation) => automation && automation.enabled !== false);
  const conversationsCount = Number(conversationsResult.rows[0] && conversationsResult.rows[0].total ? conversationsResult.rows[0].total : 0);

  if (!channelSelection.channel && channelSelection.reason !== 'mapped_clinic_without_whatsapp_channel') {
    logWarn('portal_channel_selection_ambiguous', {
      tenantId: safeTenantId,
      clinicId: clinic.id,
      reason: channelSelection.reason,
      strategy: channelSelection.strategy || null,
      explicitChannelId: channelSelection.explicitChannelId || null,
      channelIds: channels.map((channel) => channel.id),
      activeChannelIds: channels
        .filter((channel) => String(channel.status || '').trim().toLowerCase() === 'active')
        .map((channel) => channel.id)
    });
  } else if (channelSelection.channel) {
    logInfo('portal_channel_selection_resolved', {
      tenantId: safeTenantId,
      clinicId: clinic.id,
      channelId: channelSelection.channel.id,
      strategy: channelSelection.strategy || null
    });
  }

  return {
    ok: true,
    tenantId: safeTenantId,
    clinic: summarizeClinic(clinic),
    channel: summarizeChannel(channelSelection.channel),
    channels: channels.map(summarizeChannel),
    channelSelection: {
      reason: channelSelection.reason,
      strategy: channelSelection.strategy || null,
      explicitChannelId: channelSelection.explicitChannelId || null
    },
    onboarding: {
      hasChannel: Boolean(channelSelection.channel && String(channelSelection.channel.status || '').trim().toLowerCase() === 'active'),
      hasProducts: activeProducts.length > 0,
      hasMessages: conversationsCount > 0,
      botEnabled: activeAutomations.length > 0,
      productsCount: activeProducts.length,
      conversationsCount,
      automationsCount: activeAutomations.length
    },
    reason: channelSelection.reason
  };
}

module.exports = {
  resolvePortalTenantContext
};
