const { query } = require('../db/client');

const { maybeDecryptSecret, maybeEncryptSecret } = require('../utils/secret-crypto');

const BOT_RUNTIME_CONFIG_MUTATION_SOURCES = Object.freeze({
  CUSTOMER_CONVERSATION: 'CUSTOMER_CONVERSATION',
  AUTHORIZED_ADMIN_CONFIGURATION: 'AUTHORIZED_ADMIN_CONFIGURATION'
});

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

const DEFAULT_PORTAL_SUBACCOUNT_LIMIT = (() => {
  const parsed = Number.parseInt(String(process.env.PORTAL_SUBACCOUNT_LIMIT_DEFAULT || '5'), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5;
})();

function parseClinicSettings(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parsePositiveLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function mapChannelTokenRecord(record) {
  if (!record || typeof record !== 'object') return record;
  if (!Object.prototype.hasOwnProperty.call(record, 'accessToken')) {
    return record;
  }

  return {
    ...record,
    accessToken: maybeDecryptSecret(record.accessToken)
  };
}

function mapChannelTokenRows(rows) {
  return Array.isArray(rows) ? rows.map(mapChannelTokenRecord) : [];
}

function prepareAccessTokenForStorage(value) {
  return maybeEncryptSecret(value);
}

function normalizePortalAccountScope(settings) {
  const candidates = [
    settings?.portal?.accountScope,
    settings?.portal?.scope,
    settings?.accountScope,
    settings?.tenantScope
  ];

  for (const value of candidates) {
    const normalized = normalizeString(value).toLowerCase();
    if (normalized === 'opturon_admin' || normalized === 'global_admin' || normalized === 'superadmin') {
      return 'opturon_admin';
    }
    if (normalized === 'client' || normalized === 'customer') {
      return 'client';
    }
  }

  if (settings?.portal?.isOpturonAdmin === true || settings?.portal?.isGlobalAdmin === true) {
    return 'opturon_admin';
  }

  return 'client';
}

function buildPortalAccountConfig(settings) {
  const accountScope = normalizePortalAccountScope(settings);
  const primaryPortalUserId = normalizeString(settings?.portal?.primaryPortalUserId) || null;
  const explicitLimit =
    parseNonNegativeLimit(settings?.portal?.policy?.limits?.maxPortalUsers) ??
    parsePositiveLimit(settings?.portal?.limits?.subaccounts) ??
    parsePositiveLimit(settings?.portal?.limits?.maxPortalUsers) ??
    parsePositiveLimit(settings?.portal?.userLimits?.subaccounts) ??
    parsePositiveLimit(settings?.portal?.subaccountLimit);
  const unlimitedSubaccounts = accountScope === 'opturon_admin';

  return {
    accountScope,
    primaryPortalUserId,
    subaccountLimit: unlimitedSubaccounts ? null : explicitLimit !== null ? explicitLimit : DEFAULT_PORTAL_SUBACCOUNT_LIMIT,
    unlimitedSubaccounts,
    limitSource: unlimitedSubaccounts ? 'opturon_admin_scope' : explicitLimit !== null ? 'clinic_settings' : 'default_env'
  };
}

async function findChannelByPhoneNumberId(phoneNumberId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE "phoneNumberId" = $1
       AND provider = 'whatsapp_cloud'
       AND LOWER(COALESCE(status, '')) = 'active'
     LIMIT 1`,
    [phoneNumberId]
  );

  return mapChannelTokenRecord(result.rows[0] || null);
}

async function findWhatsAppChannelByPhoneNumberIdIncludingInactive(phoneNumberId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", provider, "phoneNumberId", status
     FROM channels
     WHERE "phoneNumberId" = $1
       AND provider = 'whatsapp_cloud'
     ORDER BY id ASC
     LIMIT 2`,
    [phoneNumberId]
  );

  return result.rows.length === 1 ? result.rows[0] : null;
}

async function findChannelById(channelId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE id = $1
     LIMIT 1`,
    [channelId]
  );

  return mapChannelTokenRecord(result.rows[0] || null);
}

async function findChannelByIdAndClinicId(channelId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE id = $1
       AND "clinicId" = $2
     LIMIT 1`,
    [channelId, clinicId]
  );

  return mapChannelTokenRecord(result.rows[0] || null);
}

async function findClinicByExternalTenantId(externalTenantId, client = null, options = {}) {
  const lockClause = options && options.forUpdate === true ? ' FOR UPDATE' : '';
  const result = await dbQuery(
    client,
    `SELECT id, name, timezone, "externalTenantId", settings
     FROM clinics
     WHERE "externalTenantId" = $1
     LIMIT 1${lockClause}`,
    [externalTenantId]
  );

  return result.rows[0] || null;
}

async function updateClinicOperationalAlertsEnabledById(clinicId, enabled, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE clinics
     SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb),
       '{operationalAlertsEnabled}',
       $2::jsonb,
       true
     ),
     "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, name, timezone, "externalTenantId", settings`,
    [clinicId, JSON.stringify(enabled === true)]
  );

  return result.rows[0] || null;
}

async function provisionCleanClinicForExternalTenant(input, client = null) {
  const safeExternalTenantId = normalizeString(input && input.externalTenantId);
  const safeName = normalizeString(input && input.name) || safeExternalTenantId;
  const safeTimezone = normalizeString(input && input.timezone) || 'America/Argentina/Buenos_Aires';

  if (!safeExternalTenantId) {
    throw new Error('missing_external_tenant_id');
  }

  const existing = await findClinicByExternalTenantId(safeExternalTenantId, client);
  if (existing) {
    const result = await dbQuery(
      client,
      `UPDATE clinics
       SET name = COALESCE(NULLIF($2, ''), name),
           timezone = COALESCE(NULLIF($3, ''), timezone),
           settings = COALESCE(settings, '{}'::jsonb),
           "updatedAt" = NOW()
       WHERE id = $1::uuid
       RETURNING id, name, timezone, "externalTenantId", settings`,
      [existing.id, safeName, safeTimezone]
    );

    return result.rows[0] || null;
  }

  const result = await dbQuery(
    client,
    `INSERT INTO clinics (name, timezone, "externalTenantId", settings, "updatedAt")
     VALUES (
       $1,
       $2,
       $3,
       jsonb_build_object(
         'portal', jsonb_build_object(
           'accountScope', 'client',
           'policy', jsonb_build_object(
             'planCode', 'basic',
             'limits', jsonb_build_object(
               'maxPortalUsers', ${DEFAULT_PORTAL_SUBACCOUNT_LIMIT},
               'maxAutomations', 20,
               'maxContacts', 1000
             ),
             'capabilities', '[]'::jsonb,
             'enabledModules', jsonb_build_object(
               'inbox', true,
               'agenda', true,
               'catalog', true,
               'automations', true,
               'sales', true,
               'loyalty', true,
               'payments', true
             )
           )
         ),
         'businessProfile', jsonb_build_object(
           'legalName', '',
           'taxId', '',
           'taxIdType', 'NONE',
           'vatCondition', '',
           'grossIncomeNumber', '',
           'fiscalAddress', '',
           'city', '',
           'province', '',
           'pointOfSaleSuggested', '',
           'defaultSuggestedFiscalVoucherType', 'NONE',
           'accountantEmail', '',
           'accountantName', '',
           'profileImageUrl', '',
           'openingHours', '',
           'address', '',
           'deliveryZones', '',
           'paymentMethods', '',
           'policies', '',
           'businessType', 'services_general',
           'capabilities', '[]'::jsonb
         ),
         'bot', jsonb_build_object('mode', 'automatic')
       ),
       NOW()
     )
     RETURNING id, name, timezone, "externalTenantId", settings`,
    [safeName, safeTimezone, safeExternalTenantId]
  );

  return result.rows[0] || null;
}

async function getClinicPortalSubaccountLimitById(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT settings
     FROM clinics
     WHERE id = $1
     LIMIT 1`,
    [clinicId]
  );

  const settings = parseClinicSettings(result.rows[0]?.settings);
  const config = buildPortalAccountConfig(settings);

  return {
    subaccountLimit: config.subaccountLimit,
    unlimitedSubaccounts: config.unlimitedSubaccounts,
    accountScope: config.accountScope,
    source: config.limitSource
  };
}

async function getClinicPortalAccountConfigById(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT settings
     FROM clinics
     WHERE id = $1
     LIMIT 1`,
    [clinicId]
  );

  const settings = parseClinicSettings(result.rows[0]?.settings);
  return buildPortalAccountConfig(settings);
}

async function updateClinicPortalPrimaryUserIdById(clinicId, primaryPortalUserId, client = null) {
  const safePrimaryPortalUserId = String(primaryPortalUserId || '').trim() || null;
  const result = await dbQuery(
    client,
    `UPDATE clinics
     SET settings = jsonb_set(
       jsonb_set(
         COALESCE(settings, '{}'::jsonb),
         '{portal}',
         COALESCE(
           CASE
             WHEN jsonb_typeof(settings -> 'portal') = 'object' THEN settings -> 'portal'
             ELSE '{}'::jsonb
           END,
           '{}'::jsonb
         ),
         true
       ),
       '{portal,primaryPortalUserId}',
       to_jsonb($2::text),
       true
     ),
     "updatedAt" = NOW()
     WHERE id = $1
     RETURNING settings`,
    [clinicId, safePrimaryPortalUserId]
  );

  const settings = parseClinicSettings(result.rows[0]?.settings);
  return {
    primaryPortalUserId: String(settings?.portal?.primaryPortalUserId || '').trim() || null
  };
}

async function findPreferredWhatsAppChannelByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE "clinicId" = $1
       AND provider = 'whatsapp_cloud'
     ORDER BY
       CASE WHEN LOWER(COALESCE(status, '')) = 'active' THEN 0 ELSE 1 END,
       "updatedAt" DESC,
       "createdAt" DESC
     LIMIT 1`,
    [clinicId]
  );

  return result.rows[0] || null;
}

async function listWhatsAppChannelsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status, "updatedAt", "createdAt"
     FROM channels
     WHERE "clinicId" = $1
       AND provider = 'whatsapp_cloud'
     ORDER BY
       CASE WHEN LOWER(COALESCE(status, '')) = 'active' THEN 0 ELSE 1 END,
      "updatedAt" DESC,
      "createdAt" DESC`,
    [clinicId]
  );

  return mapChannelTokenRows(result.rows);
}

async function findInstagramChannelByExternalId(externalId, client = null) {
  const safeExternalId = String(externalId || '').trim();
  if (!safeExternalId) return null;

  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE type = 'instagram'
       AND provider = 'instagram_graph'
       AND (
         "externalId" = $1
         OR "instagramUserId" = $1
       )
       AND LOWER(COALESCE(status, '')) = 'active'
     ORDER BY "updatedAt" DESC, "createdAt" DESC
     LIMIT 1`,
    [safeExternalId]
  );

  return mapChannelTokenRecord(result.rows[0] || null);
}

async function findInstagramChannelByPageId(pageId, client = null) {
  const safePageId = String(pageId || '').trim();
  if (!safePageId) return null;

  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE type = 'instagram'
       AND provider = 'instagram_graph'
       AND "externalPageId" = $1
       AND LOWER(COALESCE(status, '')) = 'active'
     ORDER BY "updatedAt" DESC, "createdAt" DESC
     LIMIT 1`,
    [safePageId]
  );

  return mapChannelTokenRecord(result.rows[0] || null);
}

async function findInstagramChannelByUserId(instagramUserId, client = null) {
  const safeInstagramUserId = String(instagramUserId || '').trim();
  if (!safeInstagramUserId) return null;

  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE type = 'instagram'
       AND provider = 'instagram_graph'
       AND "instagramUserId" = $1
       AND LOWER(COALESCE(status, '')) = 'active'
     ORDER BY "updatedAt" DESC, "createdAt" DESC
     LIMIT 1`,
    [safeInstagramUserId]
  );

  return mapChannelTokenRecord(result.rows[0] || null);
}

async function findInstagramChannelByAccountAlias(accountAlias, client = null) {
  const safeAccountAlias = String(accountAlias || '').trim();
  if (!safeAccountAlias) return null;

  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status
     FROM channels
     WHERE type = 'instagram'
       AND provider = 'instagram_graph'
       AND LOWER(COALESCE(status, '')) = 'active'
       AND COALESCE("connectionMetadata" -> 'instagramAccountAliases', '[]'::jsonb) @> jsonb_build_array($1::text)
     ORDER BY "updatedAt" DESC, "createdAt" DESC
     LIMIT 2`,
    [safeAccountAlias]
  );

  if (result.rows.length !== 1) return null;
  return mapChannelTokenRecord(result.rows[0]);
}

async function findInstagramChannelByRecipientId(recipientId, client = null) {
  const safeRecipientId = String(recipientId || '').trim();
  if (!safeRecipientId) return null;

  return (
    await findInstagramChannelByExternalId(safeRecipientId, client) ||
    await findInstagramChannelByPageId(safeRecipientId, client) ||
    await findInstagramChannelByUserId(safeRecipientId, client) ||
    await findInstagramChannelByAccountAlias(safeRecipientId, client) ||
    null
  );
}

async function listInstagramChannelsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status, "updatedAt", "createdAt"
     FROM channels
     WHERE "clinicId" = $1
       AND type = 'instagram'
       AND provider = 'instagram_graph'
     ORDER BY
       CASE WHEN LOWER(COALESCE(status, '')) = 'active' THEN 0 ELSE 1 END,
      "updatedAt" DESC,
      "createdAt" DESC`,
    [clinicId]
  );

  return mapChannelTokenRows(result.rows);
}

async function upsertInstagramChannel(input, client = null) {
  const safeExternalId = String(input.externalId || input.instagramUserId || '').trim() || null;
  const safePageId = String(input.externalPageId || '').trim() || null;

  const existingResult =
    safeExternalId || safePageId
      ? await dbQuery(
          client,
          `SELECT id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status, "updatedAt", "createdAt"
           FROM channels
           WHERE type = 'instagram'
             AND provider = 'instagram_graph'
             AND (
               ($1::text IS NOT NULL AND ("externalId" = $1 OR "instagramUserId" = $1))
               OR ($2::text IS NOT NULL AND "externalPageId" = $2)
             )
           ORDER BY
             CASE WHEN LOWER(COALESCE(status, '')) = 'active' THEN 0 ELSE 1 END,
             "updatedAt" DESC,
             "createdAt" DESC
           LIMIT 1`,
          [safeExternalId, safePageId]
        )
      : null;
  const existing = existingResult && existingResult.rows ? existingResult.rows[0] || null : null;

  if (existing) {
    if (existing.clinicId && input.clinicId && existing.clinicId !== input.clinicId) {
      const error = new Error('instagram_channel_already_bound_to_other_clinic');
      error.code = 'INSTAGRAM_CHANNEL_CROSS_CLINIC_CONFLICT';
      error.details = {
        existingChannelId: existing.id,
        existingClinicId: existing.clinicId,
        targetClinicId: input.clinicId,
        externalId: safeExternalId,
        externalPageId: safePageId
      };
      throw error;
    }

    const result = await dbQuery(
      client,
      `UPDATE channels
       SET type = 'instagram',
           provider = 'instagram_graph',
           "externalId" = COALESCE($2, "externalId"),
           "externalPageId" = COALESCE($3, "externalPageId"),
           "externalPageName" = COALESCE($4, "externalPageName"),
           "instagramUserId" = COALESCE($5, "instagramUserId"),
           "instagramUsername" = COALESCE($6, "instagramUsername"),
           "accessToken" = COALESCE($7, "accessToken"),
           status = $8,
           "connectionSource" = COALESCE($9, "connectionSource"),
           "connectionMetadata" = COALESCE($10, "connectionMetadata"),
           "updatedAt" = NOW()
       WHERE id = $1
       RETURNING id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status, "updatedAt", "createdAt"`,
      [
        existing.id,
        safeExternalId,
        safePageId,
        input.externalPageName || null,
        String(input.instagramUserId || '').trim() || null,
        String(input.instagramUsername || '').trim() || null,
        prepareAccessTokenForStorage(input.accessToken),
        input.status || 'active',
        input.connectionSource || 'instagram_oauth',
        input.connectionMetadata || null
      ]
    );

    return mapChannelTokenRecord(result.rows[0] || null);
  }

  const result = await dbQuery(
    client,
    `INSERT INTO channels (
      "clinicId",
      type,
      provider,
      "phoneNumberId",
      "externalId",
      "externalPageId",
      "externalPageName",
      "instagramUserId",
      "instagramUsername",
      "accessToken",
      status,
      "connectionSource",
      "connectionMetadata",
      "updatedAt"
    )
    VALUES ($1, 'instagram', 'instagram_graph', NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
    RETURNING id, "clinicId", type, provider, "phoneNumberId", "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", "displayPhoneNumber", "verifiedName", "wabaId", "accessToken", status, "updatedAt", "createdAt"`,
    [
      input.clinicId,
      safeExternalId,
      safePageId,
      input.externalPageName || null,
      String(input.instagramUserId || '').trim() || null,
      String(input.instagramUsername || '').trim() || null,
      prepareAccessTokenForStorage(input.accessToken),
      input.status || 'active',
      input.connectionSource || 'instagram_oauth',
      input.connectionMetadata || null
    ]
  );

  return mapChannelTokenRecord(result.rows[0] || null);
}

async function disconnectInstagramChannelByIdAndClinicId(channelId, clinicId, client = null) {
  const safeChannelId = String(channelId || '').trim();
  const safeClinicId = String(clinicId || '').trim();
  if (!safeChannelId || !safeClinicId) return null;

  const result = await dbQuery(
    client,
    `UPDATE channels
     SET status = 'inactive',
         "accessToken" = NULL,
         "connectionMetadata" = COALESCE("connectionMetadata", '{}'::jsonb) || jsonb_build_object(
           'disconnectedAt', NOW(),
           'credentialRetired', TRUE
         ),
         "updatedAt" = NOW()
     WHERE id = $1
       AND "clinicId" = $2
       AND type = 'instagram'
       AND provider = 'instagram_graph'
       AND LOWER(COALESCE(status, '')) = 'active'
     RETURNING id, "clinicId", type, provider, "externalId", "externalPageId", "externalPageName", "instagramUserId", "instagramUsername", status, "connectionSource", "connectionMetadata", "updatedAt", "createdAt"`,
    [safeChannelId, safeClinicId]
  );

  return result.rows.length === 1 ? result.rows[0] : null;
}

async function getClinicBusinessProfileById(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            name,
            timezone,
            "externalTenantId",
            settings,
            settings -> 'businessProfile' AS "businessProfile"
     FROM clinics
     WHERE id = $1
     LIMIT 1`,
    [clinicId]
  );

  return result.rows[0] || null;
}

async function getClinicWhatsAppSettingsById(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            name,
            timezone,
            "externalTenantId",
            settings,
            settings -> 'whatsapp' AS "whatsappSettings",
            settings -> 'whatsapp' ->> 'defaultChannelId' AS "defaultWhatsAppChannelId"
     FROM clinics
     WHERE id = $1
     LIMIT 1`,
    [clinicId]
  );

  return result.rows[0] || null;
}

async function updateClinicWhatsAppDefaultChannelId(clinicId, defaultChannelId, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE clinics
     SET settings = jsonb_set(
       jsonb_set(
         (
           (
             COALESCE(settings, '{}'::jsonb)
             #- '{portal,defaultWhatsAppChannelId}'
           )
           #- '{portal,selectedWhatsAppChannelId}'
         )
         #- '{whatsapp,primaryChannelId}',
         '{whatsapp}',
         COALESCE(
           CASE
             WHEN jsonb_typeof(settings -> 'whatsapp') = 'object' THEN settings -> 'whatsapp'
             ELSE '{}'::jsonb
           END,
           '{}'::jsonb
         ),
         true
       ),
       '{whatsapp,defaultChannelId}',
       to_jsonb($2::text),
       true
     ),
     "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id,
               name,
               timezone,
               "externalTenantId",
               settings,
               settings -> 'whatsapp' AS "whatsappSettings",
               settings -> 'whatsapp' ->> 'defaultChannelId' AS "defaultWhatsAppChannelId"`,
    [clinicId, defaultChannelId]
  );

  return result.rows[0] || null;
}

async function updateClinicBusinessProfileById(clinicId, businessProfile, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE clinics
     SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb),
       '{businessProfile}',
       $2::jsonb,
       true
     ),
     "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id,
               name,
               timezone,
               "externalTenantId",
               settings,
               settings -> 'businessProfile' AS "businessProfile"`,
    [clinicId, JSON.stringify(businessProfile || {})]
  );

  return result.rows[0] || null;
}

async function getClinicBotSettingsById(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id,
            name,
            timezone,
            "externalTenantId",
            settings,
            settings -> 'bot' AS "botSettings",
            settings -> 'bot' ->> 'mode' AS "botMode"
     FROM clinics
     WHERE id = $1
     LIMIT 1`,
    [clinicId]
  );

  return result.rows[0] || null;
}

async function updateClinicBotModeById(clinicId, botMode, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE clinics
     SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb),
       '{bot}',
       jsonb_set(
         COALESCE(
           CASE
             WHEN jsonb_typeof(settings -> 'bot') = 'object' THEN settings -> 'bot'
             ELSE '{}'::jsonb
           END,
           '{}'::jsonb
         ),
         '{mode}',
         to_jsonb($2::text),
         true
       ),
       true
     ),
     "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id,
               name,
               timezone,
               "externalTenantId",
               settings,
               settings -> 'bot' AS "botSettings",
               settings -> 'bot' ->> 'mode' AS "botMode"`,
    [clinicId, botMode]
  );

  return result.rows[0] || null;
}

async function updateClinicBotRuntimeConfigById(clinicId, runtimeConfig, client = null, mutationContext = {}) {
  const mutationSource = normalizeString(mutationContext && mutationContext.source);
  if (mutationSource !== BOT_RUNTIME_CONFIG_MUTATION_SOURCES.AUTHORIZED_ADMIN_CONFIGURATION) {
    const error = new Error('bot_runtime_config_mutation_unauthorized');
    error.code = 'BOT_RUNTIME_CONFIG_MUTATION_UNAUTHORIZED';
    error.mutationSource = mutationSource || null;
    throw error;
  }

  const result = await dbQuery(
    client,
    `UPDATE clinics
     SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb),
       '{bot}',
       jsonb_set(
         COALESCE(
           CASE
             WHEN jsonb_typeof(settings -> 'bot') = 'object' THEN settings -> 'bot'
             ELSE '{}'::jsonb
           END,
           '{}'::jsonb
         ),
         '{runtimeConfig}',
         $2::jsonb,
         true
       ),
       true
     ),
     "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id,
               name,
               timezone,
               "externalTenantId",
               settings,
               settings -> 'bot' AS "botSettings",
               settings -> 'bot' -> 'runtimeConfig' AS "botRuntimeConfig"`,
    [clinicId, JSON.stringify(runtimeConfig || {})]
  );

  return result.rows[0] || null;
}

async function updateClinicBotTransferConfigById(clinicId, transferConfig, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE clinics
     SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb),
       '{bot}',
       jsonb_set(
         COALESCE(
           CASE
             WHEN jsonb_typeof(settings -> 'bot') = 'object' THEN settings -> 'bot'
             ELSE '{}'::jsonb
           END,
           '{}'::jsonb
         ),
         '{transferConfig}',
         $2::jsonb,
         true
       ),
       true
     ),
     "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id,
               name,
               timezone,
               "externalTenantId",
               settings,
               settings -> 'bot' AS "botSettings",
               settings -> 'bot' -> 'transferConfig' AS "botTransferConfig"`,
    [clinicId, JSON.stringify(transferConfig || {})]
  );

  return result.rows[0] || null;
}

async function getClinicInventorySettingsById(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id, name, timezone, "externalTenantId", settings, settings -> 'inventory' AS "inventorySettings"
     FROM clinics
     WHERE id = $1
     LIMIT 1`,
    [clinicId]
  );

  return result.rows[0] || null;
}

async function updateClinicInventorySettingsById(clinicId, inventorySettings, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE clinics
     SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb),
       '{inventory}',
       $2::jsonb,
       true
     ),
     "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id, name, timezone, "externalTenantId", settings, settings -> 'inventory' AS "inventorySettings"`,
    [clinicId, JSON.stringify(inventorySettings || {})]
  );

  return result.rows[0] || null;
}

async function updateClinicBotConfigById(clinicId, botConfig, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE clinics
     SET settings = jsonb_set(
       COALESCE(settings, '{}'::jsonb),
       '{bot}',
       jsonb_set(
         COALESCE(
           CASE
             WHEN jsonb_typeof(settings -> 'bot') = 'object' THEN settings -> 'bot'
             ELSE '{}'::jsonb
           END,
           '{}'::jsonb
         ),
         '{config}',
         $2::jsonb,
         true
       ),
       true
     ),
     "updatedAt" = NOW()
     WHERE id = $1
     RETURNING id,
               name,
               timezone,
               "externalTenantId",
               settings,
               settings -> 'bot' AS "botSettings",
               settings -> 'bot' -> 'config' AS "botConfig"`,
    [clinicId, JSON.stringify(botConfig || {})]
  );

  return result.rows[0] || null;
}

module.exports = {
  BOT_RUNTIME_CONFIG_MUTATION_SOURCES,
  findChannelByPhoneNumberId,
  findWhatsAppChannelByPhoneNumberIdIncludingInactive,
  findChannelById,
  findChannelByIdAndClinicId,
  findClinicByExternalTenantId,
  updateClinicOperationalAlertsEnabledById,
  provisionCleanClinicForExternalTenant,
  getClinicPortalAccountConfigById,
  getClinicPortalSubaccountLimitById,
  updateClinicPortalPrimaryUserIdById,
  findPreferredWhatsAppChannelByClinicId,
  listWhatsAppChannelsByClinicId,
  findInstagramChannelByExternalId,
  findInstagramChannelByPageId,
  findInstagramChannelByUserId,
  findInstagramChannelByAccountAlias,
  findInstagramChannelByRecipientId,
  listInstagramChannelsByClinicId,
  upsertInstagramChannel,
  disconnectInstagramChannelByIdAndClinicId,
  getClinicWhatsAppSettingsById,
  updateClinicWhatsAppDefaultChannelId,
  getClinicBusinessProfileById,
  updateClinicBusinessProfileById,
  getClinicInventorySettingsById,
  updateClinicInventorySettingsById,
  getClinicBotSettingsById,
  updateClinicBotModeById,
  updateClinicBotConfigById,
  updateClinicBotRuntimeConfigById,
  updateClinicBotTransferConfigById
};

