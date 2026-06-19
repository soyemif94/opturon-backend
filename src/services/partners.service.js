const { hashSync, compareSync } = require('bcryptjs');
const { withTransaction } = require('../db/client');
const {
  listPartners,
  findPartnerById,
  findPartnerByEmail,
  findRawPartnerAuthByEmail,
  createPartnerAccount,
  createPartnerProfile,
  createPartnerRelationship,
  endActivePartnerRelationship,
  updatePartnerStatus,
  touchPartnerLogin,
  findClinicTenantByExternalTenantId,
  findActiveAttributionByTenantId,
  findAttributionById,
  listPartnerAttributions,
  createPartnerAttribution,
  cancelActiveAttribution,
  listCommissionPlans,
  findCommissionPlanByCode,
  createCommissionPlan,
  countPlanVersions,
  createCommissionPlanVersion,
  findCommissionPlanVersionById,
  findPublishedCommissionPlanVersion,
  listPartnerCommissionEntries,
  findCommissionEntriesBySource,
  findCommissionEntryById,
  createCommissionEntry,
  markCommissionEntryReversed,
  sumGeneratedCommissionsForPartner,
  countActivePartnerAttributions,
  createRankEvaluation,
  closeActiveRankHistory,
  createRankHistory,
  listRankHistory,
  createPartnerAuditLog,
  listPartnerAuditLog
} = require('../repositories/partners.repository');

const PARTNER_STATUSES = new Set(['invited', 'active', 'suspended', 'disabled']);
const DEFAULT_COMMISSION_CAP_PERCENT = '15.00';
const SUPPORTED_EVENT_TYPES = new Set(['subscription_signup_accredited', 'subscription_recurring_accredited']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeStatus(value, fallback = 'active') {
  const normalized = normalizeString(value).toLowerCase();
  return PARTNER_STATUSES.has(normalized) ? normalized : fallback;
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function buildPartnerCode(displayName, email) {
  const emailLocal = normalizeEmail(email).split('@')[0] || '';
  const base = slugify(displayName) || slugify(emailLocal) || 'partner';
  return `ptn_${base}`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizeString(value));
}

function parseMoneyToCents(value) {
  const normalized = normalizeString(value).replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [wholePart, decimalPart = ''] = unsigned.split('.');
  const cents = (Number(wholePart) * 100) + Number((decimalPart + '00').slice(0, 2));
  return negative ? -cents : cents;
}

function centsToMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const safe = Math.abs(Number(cents) || 0);
  return `${sign}${Math.floor(safe / 100)}.${String(safe % 100).padStart(2, '0')}`;
}

function parsePercentToBasisPoints(value) {
  const cents = parseMoneyToCents(value);
  if (cents === null || cents < 0) return null;
  return cents;
}

function basisPointsToPercentString(basisPoints) {
  return centsToMoney(basisPoints);
}

function compareMoneyStrings(a, b) {
  const left = parseMoneyToCents(a);
  const right = parseMoneyToCents(b);
  if (left === null || right === null) return 0;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function isUniqueViolation(error) {
  return Boolean(error && typeof error === 'object' && error.code === '23505');
}

function buildPartnerAuthUser(partner) {
  if (!partner) return null;
  return {
    id: partner.id,
    email: partner.email,
    name: partner.profile.displayName,
    globalRole: 'partner',
    accountScope: 'partner',
    partnerId: partner.id
  };
}

function normalizePlanRules(rawRules, maxPayoutPercent = DEFAULT_COMMISSION_CAP_PERCENT) {
  const safeRules = rawRules && typeof rawRules === 'object' && !Array.isArray(rawRules) ? rawRules : null;
  const maxPayoutBasisPoints = parsePercentToBasisPoints(maxPayoutPercent);
  if (!safeRules || maxPayoutBasisPoints === null) {
    throw new Error('invalid_partner_commission_rules');
  }

  const recurringCapPercent = basisPointsToPercentString(
    parsePercentToBasisPoints(safeRules.recurringCapPercent ?? maxPayoutPercent) ?? -1
  );
  if (parsePercentToBasisPoints(recurringCapPercent) !== maxPayoutBasisPoints) {
    throw new Error('invalid_partner_commission_rules');
  }

  const rankConfigsInput = Array.isArray(safeRules.rankConfigs) ? safeRules.rankConfigs : [];
  if (rankConfigsInput.length === 0) {
    throw new Error('invalid_partner_commission_rules');
  }

  const rankConfigs = rankConfigsInput.map((config) => {
    const code = normalizeString(config && config.code).toLowerCase();
    const ownSignupBasisPoints = parsePercentToBasisPoints(config && config.ownSignupRatePercent);
    const ownRecurringBasisPoints = parsePercentToBasisPoints(config && config.ownRecurringRatePercent);
    const lineRecurringRateBasisPoints = Array.isArray(config && config.lineRecurringRatePercentByDepth)
      ? config.lineRecurringRatePercentByDepth.map((value) => parsePercentToBasisPoints(value))
      : [];

    if (
      !code ||
      ownSignupBasisPoints === null ||
      ownRecurringBasisPoints === null ||
      ownRecurringBasisPoints > maxPayoutBasisPoints ||
      lineRecurringRateBasisPoints.some((value) => value === null || value < 0 || value > maxPayoutBasisPoints)
    ) {
      throw new Error('invalid_partner_commission_rules');
    }

    return {
      code,
      ownSignupRatePercent: basisPointsToPercentString(ownSignupBasisPoints),
      ownRecurringRatePercent: basisPointsToPercentString(ownRecurringBasisPoints),
      lineRecurringRatePercentByDepth: lineRecurringRateBasisPoints.map((value) => basisPointsToPercentString(value)),
      rankOrder: Math.max(0, Number(config && config.rankOrder) || 0)
    };
  });

  const rankThresholds = Array.isArray(safeRules.rankThresholds) && safeRules.rankThresholds.length > 0
    ? safeRules.rankThresholds.map((threshold) => ({
      code: normalizeString(threshold && threshold.code).toLowerCase(),
      minActiveClients: Math.max(0, Number(threshold && threshold.minActiveClients) || 0),
      minGeneratedCommission: centsToMoney(Math.max(0, parseMoneyToCents(threshold && threshold.minGeneratedCommission) || 0))
    }))
    : rankConfigs.map((config) => ({
      code: config.code,
      minActiveClients: 0,
      minGeneratedCommission: '0.00'
    }));

  return {
    recurringCapPercent,
    eligibleEventTypes: Array.from(SUPPORTED_EVENT_TYPES),
    requireAccreditedPayment: true,
    disallowRecruitmentPayout: true,
    rankConfigs,
    rankThresholds
  };
}

function assertPartnerPassword(password) {
  if (password.length < 8) {
    return false;
  }
  return true;
}

function getRankConfigByCode(rules, rankCode) {
  const safeCode = normalizeString(rankCode).toLowerCase();
  return rules.rankConfigs.find((config) => config.code === safeCode) || rules.rankConfigs[0] || null;
}

function getPartnerRankCode(partner) {
  return normalizeString(partner && partner.currentRankCode).toLowerCase() || 'asesor';
}

function getPartnerRecurringLineRateBasisPoints(rules, partner, depthFromPartner) {
  const config = getRankConfigByCode(rules, getPartnerRankCode(partner));
  if (!config) return null;
  return parsePercentToBasisPoints(config.lineRecurringRatePercentByDepth[depthFromPartner - 1] || '0.00');
}

function getPartnerOwnEventRateBasisPoints(rules, partner, eventType) {
  const config = getRankConfigByCode(rules, getPartnerRankCode(partner));
  if (!config) return null;
  if (eventType === 'subscription_signup_accredited') {
    return parsePercentToBasisPoints(config.ownSignupRatePercent);
  }
  if (eventType === 'subscription_recurring_accredited') {
    return parsePercentToBasisPoints(config.ownRecurringRatePercent);
  }
  return null;
}

async function appendAuditLog(input, client = null) {
  return createPartnerAuditLog(input, client);
}

async function createPartner(input, options = {}) {
  const email = normalizeEmail(input && input.email);
  const password = normalizeString(input && input.password);
  const displayName = normalizeString(input && input.displayName);
  const legalName = normalizeString(input && input.legalName) || null;
  const phone = normalizeString(input && input.phone) || null;
  const notes = normalizeString(input && input.notes) || null;
  const sponsorPartnerId = normalizeString(input && input.sponsorPartnerId) || null;
  const actorStaffUserId = isUuid(options.actorStaffUserId) ? options.actorStaffUserId : null;
  const status = normalizeStatus(input && input.status, password ? 'active' : 'invited');

  if (!email || !email.includes('@')) return { ok: false, reason: 'invalid_partner_email' };
  if (!displayName || displayName.length < 2) return { ok: false, reason: 'invalid_partner_display_name' };
  if (!assertPartnerPassword(password)) return { ok: false, reason: 'invalid_partner_password' };

  return withTransaction(async (client) => {
    const existing = await findPartnerByEmail(email, client);
    if (existing) {
      return { ok: false, reason: 'partner_email_already_exists' };
    }

    if (sponsorPartnerId) {
      const sponsor = await findPartnerById(sponsorPartnerId, client);
      if (!sponsor) return { ok: false, reason: 'partner_sponsor_not_found' };
      if (sponsor.status !== 'active') return { ok: false, reason: 'partner_sponsor_inactive' };
    }

    const createdAccount = await createPartnerAccount(
      {
        email,
        passwordHash: hashSync(password, 10),
        status
      },
      client
    );

    const codeBase = buildPartnerCode(displayName, email);
    await createPartnerProfile(
      {
        partnerId: createdAccount.id,
        code: `${codeBase}_${createdAccount.id.slice(0, 8)}`,
        displayName,
        legalName,
        phone,
        notes,
        metadata: {}
      },
      client
    );

    if (sponsorPartnerId) {
      await createPartnerRelationship(
        {
          partnerId: createdAccount.id,
          sponsorPartnerId,
          createdByStaffUserId: actorStaffUserId
        },
        client
      );
    }

    const partner = await findPartnerById(createdAccount.id, client);
    await appendAuditLog(
      {
        partnerId: createdAccount.id,
        entityType: 'partner_account',
        entityId: createdAccount.id,
        action: 'partner_created',
        reason: status,
        actorType: actorStaffUserId ? 'staff' : 'system',
        actorStaffUserId,
        metadata: { sponsorPartnerId }
      },
      client
    );

    return {
      ok: true,
      partner
    };
  });
}

async function listPartnersForAdmin() {
  return {
    ok: true,
    partners: await listPartners()
  };
}

async function getPartnerDetails(partnerId) {
  const partner = await findPartnerById(partnerId);
  if (!partner) return { ok: false, reason: 'partner_not_found' };

  const [attributions, commissionEntries, rankHistory, audit] = await Promise.all([
    listPartnerAttributions(partnerId),
    listPartnerCommissionEntries(partnerId),
    listRankHistory(partnerId),
    listPartnerAuditLog(partnerId, 30)
  ]);

  return {
    ok: true,
    partner,
    attributions,
    commissionEntries,
    rankHistory,
    audit
  };
}

async function changePartnerStatus(partnerId, status, options = {}) {
  const normalizedStatus = normalizeStatus(status, null);
  if (!normalizedStatus) return { ok: false, reason: 'invalid_partner_status' };

  return withTransaction(async (client) => {
    const partner = await findPartnerById(partnerId, client);
    if (!partner) return { ok: false, reason: 'partner_not_found' };

    await updatePartnerStatus(partnerId, normalizedStatus, client);
    await appendAuditLog(
      {
        partnerId,
        entityType: 'partner_account',
        entityId: partnerId,
        action: 'partner_status_changed',
        reason: normalizedStatus,
        actorType: isUuid(options.actorStaffUserId) ? 'staff' : 'system',
        actorStaffUserId: isUuid(options.actorStaffUserId) ? options.actorStaffUserId : null,
        metadata: { previousStatus: partner.status }
      },
      client
    );

    return {
      ok: true,
      partner: await findPartnerById(partnerId, client)
    };
  });
}

async function assignPartnerSponsor(partnerId, sponsorPartnerId, options = {}) {
  return withTransaction(async (client) => {
    const partner = await findPartnerById(partnerId, client);
    if (!partner) return { ok: false, reason: 'partner_not_found' };
    if (sponsorPartnerId) {
      const sponsor = await findPartnerById(sponsorPartnerId, client);
      if (!sponsor) return { ok: false, reason: 'partner_sponsor_not_found' };
      if (sponsor.id === partnerId) return { ok: false, reason: 'partner_sponsor_self_reference' };
      if (sponsor.status !== 'active') return { ok: false, reason: 'partner_sponsor_inactive' };

      const visited = new Set([String(partnerId)]);
      let current = sponsor;
      while (current) {
        if (visited.has(String(current.id))) {
          return { ok: false, reason: 'partner_sponsor_cycle_detected' };
        }
        visited.add(String(current.id));
        if (!current.sponsorPartnerId) break;
        current = await findPartnerById(current.sponsorPartnerId, client);
      }
    }

    await endActivePartnerRelationship(partnerId, new Date().toISOString(), client);
    if (sponsorPartnerId) {
      await createPartnerRelationship(
        {
          partnerId,
          sponsorPartnerId,
          createdByStaffUserId: isUuid(options.actorStaffUserId) ? options.actorStaffUserId : null
        },
        client
      );
    }

    await appendAuditLog(
      {
        partnerId,
        entityType: 'partner_relationship',
        entityId: partnerId,
        action: 'partner_sponsor_assigned',
        reason: sponsorPartnerId ? 'active' : 'cleared',
        actorType: isUuid(options.actorStaffUserId) ? 'staff' : 'system',
        actorStaffUserId: isUuid(options.actorStaffUserId) ? options.actorStaffUserId : null,
        metadata: { sponsorPartnerId }
      },
      client
    );

    return {
      ok: true,
      partner: await findPartnerById(partnerId, client)
    };
  });
}

async function attributeTenantToPartner(partnerId, payload, options = {}) {
  const tenantId = normalizeString(payload && payload.tenantId);
  const attributionSource = normalizeString(payload && payload.attributionSource) || 'manual_admin';
  const notes = normalizeString(payload && payload.notes) || null;
  const actorStaffUserId = isUuid(options.actorStaffUserId) ? options.actorStaffUserId : null;

  if (!tenantId) return { ok: false, reason: 'missing_tenant_id' };

  return withTransaction(async (client) => {
    const partner = await findPartnerById(partnerId, client);
    if (!partner) return { ok: false, reason: 'partner_not_found' };

    const clinic = await findClinicTenantByExternalTenantId(tenantId, client);
    if (!clinic) return { ok: false, reason: 'tenant_not_found' };

    const existingActive = await findActiveAttributionByTenantId(tenantId, client);
    if (existingActive && String(existingActive.partnerId) !== String(partnerId)) {
      return { ok: false, reason: 'tenant_already_attributed', partnerId: existingActive.partnerId };
    }

    if (existingActive && String(existingActive.partnerId) === String(partnerId)) {
      return { ok: true, attribution: existingActive, partner };
    }

    let attribution;
    try {
      attribution = await createPartnerAttribution(
        {
          partnerId,
          clinicId: clinic.id,
          tenantId,
          attributionSource,
          notes,
          createdByStaffUserId: actorStaffUserId
        },
        client
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrentActive = await findActiveAttributionByTenantId(tenantId, client);
        return {
          ok: false,
          reason: 'tenant_already_attributed',
          partnerId: concurrentActive ? concurrentActive.partnerId : null
        };
      }
      throw error;
    }

    await appendAuditLog(
      {
        partnerId,
        tenantId,
        entityType: 'partner_client_attribution',
        entityId: attribution.id,
        action: 'partner_tenant_attributed',
        reason: attributionSource,
        actorType: actorStaffUserId ? 'staff' : 'system',
        actorStaffUserId,
        metadata: {
          clinicId: clinic.id,
          clinicName: clinic.name || null
        }
      },
      client
    );

    return {
      ok: true,
      attribution,
      partner: await findPartnerById(partnerId, client)
    };
  });
}

async function createCommissionPlanWithVersion(payload, options = {}) {
  const code = normalizeString(payload && payload.code).toLowerCase();
  const name = normalizeString(payload && payload.name);
  const currency = normalizeString(payload && payload.currency).toUpperCase() || 'ARS';
  const status = normalizeString(payload && payload.status).toLowerCase() === 'published' ? 'published' : 'draft';
  const actorStaffUserId = isUuid(options.actorStaffUserId) ? options.actorStaffUserId : null;
  const maxPayoutPercent = basisPointsToPercentString(
    parsePercentToBasisPoints(payload && payload.maxPayoutPercent ? payload.maxPayoutPercent : DEFAULT_COMMISSION_CAP_PERCENT) ?? 1500
  );

  if (!code || !name) return { ok: false, reason: 'invalid_partner_commission_plan' };

  let rules;
  try {
    rules = normalizePlanRules(payload && payload.rules, maxPayoutPercent);
  } catch {
    return { ok: false, reason: 'invalid_partner_commission_rules' };
  }

  return withTransaction(async (client) => {
    const existing = await findCommissionPlanByCode(code, client);
    if (existing) return { ok: false, reason: 'partner_commission_plan_code_exists' };

    const plan = await createCommissionPlan(
      {
        code,
        name,
        status: status === 'published' ? 'active' : 'draft',
        createdByStaffUserId: actorStaffUserId
      },
      client
    );
    const version = await createCommissionPlanVersion(
      {
        planId: plan.id,
        versionNumber: 1,
        status,
        currency,
        rules,
        maxPayoutPercent,
        effectiveFrom: payload && payload.effectiveFrom ? payload.effectiveFrom : null,
        effectiveTo: payload && payload.effectiveTo ? payload.effectiveTo : null,
        publishedAt: status === 'published' ? new Date().toISOString() : null,
        createdByStaffUserId: actorStaffUserId
      },
      client
    );

    await appendAuditLog(
      {
        entityType: 'partner_commission_plan',
        entityId: plan.id,
        action: 'partner_commission_plan_created',
        reason: code,
        actorType: actorStaffUserId ? 'staff' : 'system',
        actorStaffUserId,
        metadata: { versionId: version.id }
      },
      client
    );

    return { ok: true, plan, version };
  });
}

async function addCommissionPlanVersion(planCode, payload, options = {}) {
  const actorStaffUserId = isUuid(options.actorStaffUserId) ? options.actorStaffUserId : null;
  const currency = normalizeString(payload && payload.currency).toUpperCase() || 'ARS';
  const status = normalizeString(payload && payload.status).toLowerCase() === 'published' ? 'published' : 'draft';
  const maxPayoutPercent = basisPointsToPercentString(
    parsePercentToBasisPoints(payload && payload.maxPayoutPercent ? payload.maxPayoutPercent : DEFAULT_COMMISSION_CAP_PERCENT) ?? 1500
  );

  let rules;
  try {
    rules = normalizePlanRules(payload && payload.rules, maxPayoutPercent);
  } catch {
    return { ok: false, reason: 'invalid_partner_commission_rules' };
  }

  return withTransaction(async (client) => {
    const plan = await findCommissionPlanByCode(normalizeString(planCode).toLowerCase(), client);
    if (!plan) return { ok: false, reason: 'partner_commission_plan_not_found' };

    const versionNumber = (await countPlanVersions(plan.id, client)) + 1;
    const version = await createCommissionPlanVersion(
      {
        planId: plan.id,
        versionNumber,
        status,
        currency,
        rules,
        maxPayoutPercent,
        effectiveFrom: payload && payload.effectiveFrom ? payload.effectiveFrom : null,
        effectiveTo: payload && payload.effectiveTo ? payload.effectiveTo : null,
        publishedAt: status === 'published' ? new Date().toISOString() : null,
        createdByStaffUserId: actorStaffUserId
      },
      client
    );

    await appendAuditLog(
      {
        entityType: 'partner_commission_plan_version',
        entityId: version.id,
        action: 'partner_commission_plan_version_created',
        reason: String(version.versionNumber),
        actorType: actorStaffUserId ? 'staff' : 'system',
        actorStaffUserId,
        metadata: { planId: plan.id, planCode: plan.code }
      },
      client
    );

    return { ok: true, plan, version };
  });
}

async function listCommissionPlansForAdmin() {
  return {
    ok: true,
    plans: await listCommissionPlans()
  };
}

async function resolveSimulationContext(event, client = null) {
  const tenantId = normalizeString(event && event.tenantId);
  if (!tenantId) return { ok: false, reason: 'missing_tenant_id' };
  const attribution = await findActiveAttributionByTenantId(tenantId, client);
  if (!attribution) return { ok: false, reason: 'partner_attribution_not_found' };
  const partner = await findPartnerById(attribution.partnerId, client);
  if (!partner || partner.status !== 'active') return { ok: false, reason: 'partner_not_active' };
  return { ok: true, attribution, partner };
}

function buildPeriodKey(eventAt) {
  const date = new Date(eventAt);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function calculateCommissionAmountCents(basisAmountCents, rateBasisPoints) {
  return Math.round((basisAmountCents * rateBasisPoints) / 10000);
}

async function buildPartnerChain(rootPartnerId, client = null) {
  const chain = [];
  const visited = new Set();
  let current = await findPartnerById(rootPartnerId, client);
  if (!current) return chain;
  while (current) {
    if (visited.has(String(current.id))) {
      const error = new Error('partner_hierarchy_cycle_detected');
      error.code = 'PARTNER_HIERARCHY_CYCLE_DETECTED';
      throw error;
    }
    visited.add(String(current.id));
    chain.push(current);
    if (!current.sponsorPartnerId) break;
    current = await findPartnerById(current.sponsorPartnerId, client);
  }
  return chain;
}

async function simulateCommissionEntries(payload, options = {}) {
  const planVersion = payload && payload.planVersionId
    ? await findCommissionPlanVersionById(payload.planVersionId)
    : await findPublishedCommissionPlanVersion(null);
  if (!planVersion) return { ok: false, reason: 'partner_commission_plan_version_not_found' };

  const rules = normalizePlanRules(planVersion.rules, planVersion.maxPayoutPercent);
  const eventType = normalizeString(payload && payload.eventType).toLowerCase();
  const sourceType = normalizeString(payload && payload.sourceType) || 'subscription';
  const sourceRef = normalizeString(payload && payload.sourceRef);
  const sourceEventId = normalizeString(payload && payload.sourceEventId) || sourceRef;
  const eventAt = normalizeString(payload && payload.eventAt) || new Date().toISOString();
  const basisAmountCents = parseMoneyToCents(payload && payload.basisAmount);
  const paymentStatus = normalizeString(payload && payload.paymentStatus).toLowerCase();
  const reversed = payload && payload.reversed === true;

  if (!sourceRef || !sourceEventId) return { ok: false, reason: 'missing_partner_commission_source_ref' };
  if (basisAmountCents === null || basisAmountCents < 0) return { ok: false, reason: 'invalid_partner_commission_basis_amount' };
  if (!SUPPORTED_EVENT_TYPES.has(eventType)) return { ok: false, reason: 'unsupported_partner_commission_event_type' };
  if (paymentStatus !== 'accredited' || reversed) return { ok: false, reason: 'partner_commission_payment_not_eligible' };

  return withTransaction(async (client) => {
    const context = await resolveSimulationContext(payload, client);
    if (!context.ok) return context;

    let chain;
    try {
      chain = await buildPartnerChain(context.partner.id, client);
    } catch (error) {
      if (error && error.code === 'PARTNER_HIERARCHY_CYCLE_DETECTED') {
        return { ok: false, reason: 'partner_hierarchy_cycle_detected' };
      }
      throw error;
    }
    const maxPayoutBasisPoints = parsePercentToBasisPoints(planVersion.maxPayoutPercent);
    const recurringCapBasisPoints = parsePercentToBasisPoints(rules.recurringCapPercent);
    const entries = [];
    let accumulatedRecurringBasisPoints = 0;

    for (let index = 0; index < chain.length; index += 1) {
      const partner = chain[index];
      const isRootPartner = index === 0;
      const payoutKind = isRootPartner
        ? (eventType === 'subscription_signup_accredited' ? 'own_signup' : 'own_recurring')
        : 'line_recurring_rebate';
      const rateBasisPoints = isRootPartner
        ? getPartnerOwnEventRateBasisPoints(rules, partner, eventType)
        : eventType === 'subscription_recurring_accredited'
          ? getPartnerRecurringLineRateBasisPoints(rules, partner, index)
          : 0;

      if (rateBasisPoints === null || rateBasisPoints < 0) {
        return { ok: false, reason: 'invalid_partner_commission_rules' };
      }
      if (!isRootPartner && eventType === 'subscription_signup_accredited') {
        continue;
      }
      if (rateBasisPoints === 0) {
        continue;
      }

      if (eventType === 'subscription_recurring_accredited') {
        accumulatedRecurringBasisPoints += rateBasisPoints;
        if (
          recurringCapBasisPoints === null ||
          maxPayoutBasisPoints === null ||
          accumulatedRecurringBasisPoints > recurringCapBasisPoints ||
          accumulatedRecurringBasisPoints > maxPayoutBasisPoints
        ) {
          return { ok: false, reason: 'partner_commission_cap_exceeded' };
        }
      }

      entries.push({
        partnerId: partner.id,
        attributionId: context.attribution.id,
        planVersionId: planVersion.id,
        clinicId: context.attribution.clinicId,
        tenantId: context.attribution.tenantId,
        sourceType,
        sourceRef,
        sourceEventId,
        eventType,
        eventAt,
        periodKey: buildPeriodKey(eventAt),
        status: options.persist ? 'generated' : 'simulated',
        currency: planVersion.currency,
        planCodeSnapshot: planVersion.planCode,
        planVersionNumberSnapshot: planVersion.versionNumber,
        payoutKind,
        paymentStatus: 'accredited',
        basisAmount: centsToMoney(basisAmountCents),
        commissionRate: basisPointsToPercentString(rateBasisPoints),
        commissionAmount: centsToMoney(calculateCommissionAmountCents(basisAmountCents, rateBasisPoints)),
        depthLevel: index,
        idempotencyKey: `${sourceType}:${sourceRef}:${sourceEventId}:${partner.id}:${index}:${options.persist ? 'generated' : 'simulated'}`,
        details: {
          sponsorPartnerId: partner.sponsorPartnerId || null,
          planCode: planVersion.planCode,
          planVersionNumber: planVersion.versionNumber,
          planName: planVersion.planName || null,
          partnerRankCode: getPartnerRankCode(partner),
          recurringCapPercent: rules.recurringCapPercent,
          paymentStatus: 'accredited',
          lineDepth: index
        }
      });
    }

    const persistedEntries = [];
    if (options.persist) {
      const existing = await findCommissionEntriesBySource(sourceType, sourceRef, sourceEventId, client);
      if (existing.length > 0) {
        return { ok: true, simulation: existing, planVersion, reusedExisting: true };
      }

      for (const entry of entries) {
        // Idempotency is also enforced by SQL, but we keep write ordering explicit.
        persistedEntries.push(await createCommissionEntry(
          {
            ...entry,
            createdByStaffUserId: isUuid(options.actorStaffUserId) ? options.actorStaffUserId : null
          },
          client
        ));
      }

      await appendAuditLog(
        {
          partnerId: context.partner.id,
          tenantId: context.attribution.tenantId,
          entityType: 'partner_commission_entry',
          entityId: sourceRef,
          action: 'partner_commission_generated',
          reason: sourceType,
          actorType: isUuid(options.actorStaffUserId) ? 'staff' : 'system',
          actorStaffUserId: isUuid(options.actorStaffUserId) ? options.actorStaffUserId : null,
          metadata: { sourceEventId, count: persistedEntries.length }
        },
        client
      );
    }

    return {
      ok: true,
      planVersion,
      simulation: options.persist ? persistedEntries : entries,
      reusedExisting: false
    };
  });
}

async function reverseCommissionEntries(payload, options = {}) {
  const entryId = normalizeString(payload && payload.entryId);
  const actorStaffUserId = isUuid(options.actorStaffUserId) ? options.actorStaffUserId : null;
  if (!entryId) return { ok: false, reason: 'missing_partner_commission_entry_id' };

  return withTransaction(async (client) => {
    const entry = await findCommissionEntryById(entryId, client);
    if (!entry) return { ok: false, reason: 'partner_commission_entry_not_found' };
    if (entry.status === 'reversed') return { ok: false, reason: 'partner_commission_entry_already_reversed' };

    const reversal = await createCommissionEntry(
      {
        partnerId: entry.partnerId,
        attributionId: entry.attributionId,
        planVersionId: entry.planVersionId,
        clinicId: entry.clinicId,
        tenantId: entry.tenantId,
        sourceType: entry.sourceType,
        sourceRef: entry.sourceRef,
        sourceEventId: `${entry.sourceEventId}:reversal`,
        eventType: `${entry.eventType}_reversal`,
        eventAt: new Date().toISOString(),
        periodKey: buildPeriodKey(new Date().toISOString()),
        status: 'reversed',
        currency: entry.currency,
        planCodeSnapshot: entry.planCodeSnapshot,
        planVersionNumberSnapshot: entry.planVersionNumberSnapshot,
        payoutKind: entry.payoutKind,
        paymentStatus: 'accredited',
        basisAmount: entry.basisAmount,
        commissionRate: entry.commissionRate,
        commissionAmount: centsToMoney(-Math.abs(parseMoneyToCents(entry.commissionAmount) || 0)),
        depthLevel: entry.depthLevel,
        idempotencyKey: `${entry.idempotencyKey}:reversal`,
        reversalOfEntryId: entry.id,
        details: {
          reversedEntryId: entry.id,
          reason: normalizeString(payload && payload.reason) || 'manual_reverse'
        },
        createdByStaffUserId: actorStaffUserId
      },
      client
    );

    await markCommissionEntryReversed(entry.id, client);
    await appendAuditLog(
      {
        partnerId: entry.partnerId,
        tenantId: entry.tenantId,
        entityType: 'partner_commission_entry',
        entityId: entry.id,
        action: 'partner_commission_reversed',
        reason: normalizeString(payload && payload.reason) || 'manual_reverse',
        actorType: actorStaffUserId ? 'staff' : 'system',
        actorStaffUserId,
        metadata: { reversalEntryId: reversal.id }
      },
      client
    );

    return { ok: true, reversedEntry: reversal };
  });
}

async function evaluatePartnerRank(partnerId, payload, options = {}) {
  const actorStaffUserId = isUuid(options.actorStaffUserId) ? options.actorStaffUserId : null;
  const planVersion = payload && payload.planVersionId
    ? await findCommissionPlanVersionById(payload.planVersionId)
    : await findPublishedCommissionPlanVersion(null);
  if (!planVersion) return { ok: false, reason: 'partner_commission_plan_version_not_found' };

  const rules = normalizePlanRules(planVersion.rules, planVersion.maxPayoutPercent);
  const windowStart = normalizeString(payload && payload.windowStart) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const windowEnd = normalizeString(payload && payload.windowEnd) || new Date().toISOString();

  return withTransaction(async (client) => {
    const partner = await findPartnerById(partnerId, client);
    if (!partner) return { ok: false, reason: 'partner_not_found' };

    const activeClients = await countActivePartnerAttributions(partnerId, client);
    const generatedCommission = await sumGeneratedCommissionsForPartner(partnerId, windowStart, windowEnd, client);
    let currentRank = rules.rankThresholds[0];
    let nextRank = null;

    for (let index = 0; index < rules.rankThresholds.length; index += 1) {
      const threshold = rules.rankThresholds[index];
      const qualifiesClients = activeClients >= threshold.minActiveClients;
      const qualifiesCommission = compareMoneyStrings(generatedCommission, threshold.minGeneratedCommission) >= 0;
      if (qualifiesClients && qualifiesCommission) {
        currentRank = threshold;
        nextRank = rules.rankThresholds[index + 1] || null;
      }
    }

    const evaluation = await createRankEvaluation(
      {
        partnerId,
        planVersionId: planVersion.id,
        currentRankCode: currentRank.code,
        nextRankCode: nextRank ? nextRank.code : null,
        metrics: {
          activeClients,
          generatedCommission,
          thresholdMatched: currentRank
        },
        windowStart,
        windowEnd,
        createdByStaffUserId: actorStaffUserId
      },
      client
    );

    await closeActiveRankHistory(partnerId, evaluation.evaluatedAt, client);
    await createRankHistory(
      {
        partnerId,
        rankCode: currentRank.code,
        effectiveFrom: evaluation.evaluatedAt,
        evaluationId: evaluation.id,
        notes: 'partner_rank_evaluated',
        createdByStaffUserId: actorStaffUserId
      },
      client
    );

    await appendAuditLog(
      {
        partnerId,
        entityType: 'partner_rank_evaluation',
        entityId: evaluation.id,
        action: 'partner_rank_evaluated',
        reason: currentRank.code,
        actorType: actorStaffUserId ? 'staff' : 'system',
        actorStaffUserId,
        metadata: evaluation.metrics
      },
      client
    );

    return {
      ok: true,
      evaluation,
      partner: await findPartnerById(partnerId, client)
    };
  });
}

async function authenticatePartnerUser(email, password) {
  const safeEmail = normalizeEmail(email);
  const safePassword = String(password || '');
  if (!safeEmail || !safePassword) return { ok: false, reason: 'invalid_credentials' };

  const partner = await findRawPartnerAuthByEmail(safeEmail);
  if (!partner || !partner.passwordHash || partner.status !== 'active') {
    return { ok: false, reason: 'invalid_credentials' };
  }

  let valid = false;
  try {
    valid = compareSync(safePassword, partner.passwordHash);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'invalid_credentials' };

  await touchPartnerLogin(partner.id);
  const hydrated = await findPartnerById(partner.id);
  return {
    ok: true,
    user: buildPartnerAuthUser(hydrated)
  };
}

async function getPartnerAuthUserByEmail(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) return { ok: false, reason: 'invalid_email' };

  const partner = await findPartnerByEmail(safeEmail);
  if (!partner || partner.status !== 'active') {
    return { ok: true, user: null };
  }

  return {
    ok: true,
    user: buildPartnerAuthUser(partner)
  };
}

async function getPartnerMe(partnerId) {
  const details = await getPartnerDetails(partnerId);
  if (!details.ok) return details;
  return {
    ok: true,
    partner: details.partner
  };
}

async function getPartnerSummary(partnerId) {
  const partner = await findPartnerById(partnerId);
  if (!partner) return { ok: false, reason: 'partner_not_found' };
  const attributions = await listPartnerAttributions(partnerId);
  const commissions = await listPartnerCommissionEntries(partnerId, { status: 'generated' });
  const totalCommissionCents = commissions.reduce((total, item) => total + (parseMoneyToCents(item.commissionAmount) || 0), 0);
  return {
    ok: true,
    partner,
    summary: {
      activeClients: attributions.filter((item) => item.status === 'active').length,
      generatedCommissions: centsToMoney(totalCommissionCents),
      latestRank: partner.currentRankCode || 'starter'
    }
  };
}

async function getPartnerClients(partnerId) {
  const partner = await findPartnerById(partnerId);
  if (!partner) return { ok: false, reason: 'partner_not_found' };
  return {
    ok: true,
    partner,
    clients: await listPartnerAttributions(partnerId)
  };
}

async function getPartnerRankProgress(partnerId) {
  const details = await getPartnerDetails(partnerId);
  if (!details.ok) return details;
  const latestEvaluation = details.rankHistory[0] || null;
  return {
    ok: true,
    partner: details.partner,
    rankHistory: details.rankHistory,
    latestEvaluation
  };
}

module.exports = {
  createPartner,
  listPartnersForAdmin,
  getPartnerDetails,
  changePartnerStatus,
  assignPartnerSponsor,
  attributeTenantToPartner,
  createCommissionPlanWithVersion,
  addCommissionPlanVersion,
  listCommissionPlansForAdmin,
  simulateCommissionEntries,
  reverseCommissionEntries,
  evaluatePartnerRank,
  authenticatePartnerUser,
  getPartnerAuthUserByEmail,
  getPartnerMe,
  getPartnerSummary,
  getPartnerClients,
  getPartnerRankProgress
};
