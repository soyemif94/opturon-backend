const { query } = require('../db/client');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function parseMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeProgram(row, clinicId = null) {
  if (!row) {
    return {
      id: null,
      clinicId,
      enabled: false,
      spendAmount: 1000,
      pointsAmount: 10,
      programText: 'Cada compra valida suma puntos para futuras recompensas.',
      redemptionPolicyText: 'El equipo puede canjear recompensas manualmente desde el panel.',
      createdAt: null,
      updatedAt: null
    };
  }

  return {
    id: row.id,
    clinicId: row.clinicId,
    enabled: row.enabled === true,
    spendAmount: Number(row.spendAmount || 0),
    pointsAmount: Number(row.pointsAmount || 0),
    programText: row.programText || 'Cada compra valida suma puntos para futuras recompensas.',
    redemptionPolicyText: row.redemptionPolicyText || 'El equipo puede canjear recompensas manualmente desde el panel.',
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function normalizeReward(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    name: row.name,
    description: row.description || null,
    pointsCost: Number(row.pointsCost || 0),
    active: row.active === true,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
}

function normalizeLedgerEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinicId,
    contactId: row.contactId,
    direction: row.direction,
    points: Number(row.points || 0),
    pointsDelta: Number(row.pointsDelta || 0),
    reason: row.reason || null,
    referenceType: row.referenceType || null,
    referenceId: row.referenceId || null,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt || null,
    contact: row.contactId
      ? {
          id: row.contactId,
          name: row.contactName || null,
          phone: row.contactPhone || null
        }
      : null
  };
}

function normalizeContactSummary(row, contactId) {
  return {
    contactId,
    currentPoints: Number(row?.currentPoints || 0),
    totalEarned: Number(row?.totalEarned || 0),
    totalRedeemed: Number(row?.totalRedeemed || 0),
    totalAdjusted: Number(row?.totalAdjusted || 0),
    lastMovementAt: row?.lastMovementAt || null
  };
}

function normalizeOverview(row) {
  return {
    enrolledCustomers: Number(row?.enrolledCustomers || 0),
    activeCustomers: Number(row?.activeCustomers || 0),
    pointsIssued: Number(row?.pointsIssued || 0),
    pointsRedeemed: Number(row?.pointsRedeemed || 0),
    outstandingPoints: Number(row?.outstandingPoints || 0),
    totalMovements: Number(row?.totalMovements || 0),
    totalRedemptions: Number(row?.totalRedemptions || 0),
    activeRewards: Number(row?.activeRewards || 0)
  };
}

async function findLoyaltyProgramByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId" AS "clinicId",
       enabled,
       "spendAmount" AS "spendAmount",
       "pointsAmount" AS "pointsAmount",
       "programText" AS "programText",
       "redemptionPolicyText" AS "redemptionPolicyText",
       "createdAt" AS "createdAt",
       "updatedAt" AS "updatedAt"
     FROM loyalty_programs
     WHERE "clinicId" = $1::uuid
     LIMIT 1`,
    [clinicId]
  );

  return normalizeProgram(result.rows[0] || null, clinicId);
}

async function upsertLoyaltyProgram(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO loyalty_programs (
       "clinicId",
       enabled,
       "spendAmount",
       "pointsAmount",
       "programText",
       "redemptionPolicyText"
     )
     VALUES ($1::uuid, $2, $3, $4, $5, $6)
     ON CONFLICT ("clinicId")
     DO UPDATE SET
       enabled = EXCLUDED.enabled,
       "spendAmount" = EXCLUDED."spendAmount",
       "pointsAmount" = EXCLUDED."pointsAmount",
       "programText" = EXCLUDED."programText",
       "redemptionPolicyText" = EXCLUDED."redemptionPolicyText",
       "updatedAt" = NOW()
     RETURNING
       id,
       "clinicId" AS "clinicId",
       enabled,
       "spendAmount" AS "spendAmount",
       "pointsAmount" AS "pointsAmount",
       "programText" AS "programText",
       "redemptionPolicyText" AS "redemptionPolicyText",
       "createdAt" AS "createdAt",
       "updatedAt" AS "updatedAt"`,
    [
      input.clinicId,
      input.enabled === true,
      input.spendAmount,
      input.pointsAmount,
      input.programText || null,
      input.redemptionPolicyText || null
    ]
  );

  return normalizeProgram(result.rows[0], input.clinicId);
}

async function listLoyaltyRewardsByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId" AS "clinicId",
       name,
       description,
       "pointsCost" AS "pointsCost",
       active,
       "createdAt" AS "createdAt",
       "updatedAt" AS "updatedAt"
     FROM loyalty_rewards
     WHERE "clinicId" = $1::uuid
     ORDER BY active DESC, "pointsCost" ASC, "createdAt" ASC`,
    [clinicId]
  );

  return result.rows.map(normalizeReward);
}

async function findLoyaltyRewardById(rewardId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       id,
       "clinicId" AS "clinicId",
       name,
       description,
       "pointsCost" AS "pointsCost",
       active,
       "createdAt" AS "createdAt",
       "updatedAt" AS "updatedAt"
     FROM loyalty_rewards
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     LIMIT 1`,
    [rewardId, clinicId]
  );

  return normalizeReward(result.rows[0] || null);
}

async function createLoyaltyReward(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO loyalty_rewards (
       "clinicId",
       name,
       description,
       "pointsCost",
       active,
       "updatedAt"
     )
     VALUES ($1::uuid, $2, $3, $4, $5, NOW())
     RETURNING id`,
    [input.clinicId, input.name, input.description || null, input.pointsCost, input.active !== false]
  );

  return findLoyaltyRewardById(result.rows[0].id, input.clinicId, client);
}

async function updateLoyaltyReward(rewardId, clinicId, input, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE loyalty_rewards
     SET
       name = $3,
       description = $4,
       "pointsCost" = $5,
       active = $6,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [rewardId, clinicId, input.name, input.description || null, input.pointsCost, input.active !== false]
  );

  if (!result.rows[0]) return null;
  return findLoyaltyRewardById(rewardId, clinicId, client);
}

async function createLoyaltyLedgerEntry(input, client = null) {
  const result = await dbQuery(
    client,
    `INSERT INTO loyalty_points_ledger (
       "clinicId",
       "contactId",
       direction,
       points,
       "pointsDelta",
       reason,
       "referenceType",
       "referenceId",
       metadata
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      input.clinicId,
      input.contactId,
      input.direction,
      input.points,
      input.pointsDelta,
      input.reason,
      input.referenceType || null,
      input.referenceId || null,
      JSON.stringify(input.metadata || {})
    ]
  );

  return findLoyaltyLedgerEntryById(result.rows[0].id, input.clinicId, client);
}

async function findLoyaltyLedgerEntryById(entryId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       l.id,
       l."clinicId" AS "clinicId",
       l."contactId" AS "contactId",
       l.direction,
       l.points,
       l."pointsDelta" AS "pointsDelta",
       l.reason,
       l."referenceType" AS "referenceType",
       l."referenceId" AS "referenceId",
       l.metadata,
       l."createdAt" AS "createdAt",
       c.name AS "contactName",
       c.phone AS "contactPhone"
     FROM loyalty_points_ledger l
     INNER JOIN contacts c
       ON c.id = l."contactId"
      AND c."clinicId" = l."clinicId"
     WHERE l.id = $1::uuid
       AND l."clinicId" = $2::uuid
     LIMIT 1`,
    [entryId, clinicId]
  );

  return normalizeLedgerEntry(result.rows[0] || null);
}

async function findLoyaltyLedgerEntryByReference({ clinicId, referenceType, referenceId, direction }, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       l.id,
       l."clinicId" AS "clinicId",
       l."contactId" AS "contactId",
       l.direction,
       l.points,
       l."pointsDelta" AS "pointsDelta",
       l.reason,
       l."referenceType" AS "referenceType",
       l."referenceId" AS "referenceId",
       l.metadata,
       l."createdAt" AS "createdAt",
       c.name AS "contactName",
       c.phone AS "contactPhone"
     FROM loyalty_points_ledger l
     INNER JOIN contacts c
       ON c.id = l."contactId"
      AND c."clinicId" = l."clinicId"
     WHERE l."clinicId" = $1::uuid
       AND l."referenceType" = $2
       AND l."referenceId" = $3
       AND l.direction = $4
     LIMIT 1`,
    [clinicId, referenceType, referenceId, direction]
  );

  return normalizeLedgerEntry(result.rows[0] || null);
}

async function lockLoyaltyContactById(clinicId, contactId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT id
     FROM contacts
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     FOR UPDATE`,
    [contactId, clinicId]
  );

  return result.rows[0] ? { id: result.rows[0].id, clinicId, contactId } : null;
}

async function listLoyaltyLedgerByContactId(clinicId, contactId, limit = 50, client = null) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 50), 200));
  const result = await dbQuery(
    client,
    `SELECT
       l.id,
       l."clinicId" AS "clinicId",
       l."contactId" AS "contactId",
       l.direction,
       l.points,
       l."pointsDelta" AS "pointsDelta",
       l.reason,
       l."referenceType" AS "referenceType",
       l."referenceId" AS "referenceId",
       l.metadata,
       l."createdAt" AS "createdAt",
       c.name AS "contactName",
       c.phone AS "contactPhone"
     FROM loyalty_points_ledger l
     INNER JOIN contacts c
       ON c.id = l."contactId"
      AND c."clinicId" = l."clinicId"
     WHERE l."clinicId" = $1::uuid
       AND l."contactId" = $2::uuid
     ORDER BY l."createdAt" DESC
     LIMIT $3`,
    [clinicId, contactId, safeLimit]
  );

  return result.rows.map(normalizeLedgerEntry);
}

async function listRecentLoyaltyLedgerByClinicId(clinicId, limit = 10, client = null) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 10), 100));
  const result = await dbQuery(
    client,
    `SELECT
       l.id,
       l."clinicId" AS "clinicId",
       l."contactId" AS "contactId",
       l.direction,
       l.points,
       l."pointsDelta" AS "pointsDelta",
       l.reason,
       l."referenceType" AS "referenceType",
       l."referenceId" AS "referenceId",
       l.metadata,
       l."createdAt" AS "createdAt",
       c.name AS "contactName",
       c.phone AS "contactPhone"
     FROM loyalty_points_ledger l
     INNER JOIN contacts c
       ON c.id = l."contactId"
      AND c."clinicId" = l."clinicId"
     WHERE l."clinicId" = $1::uuid
     ORDER BY l."createdAt" DESC
     LIMIT $2`,
    [clinicId, safeLimit]
  );

  return result.rows.map(normalizeLedgerEntry);
}

async function getLoyaltyContactSummary(clinicId, contactId, client = null) {
  const result = await dbQuery(
    client,
    `SELECT
       COALESCE(SUM(l."pointsDelta"), 0)::int AS "currentPoints",
       COALESCE(SUM(CASE WHEN l."pointsDelta" > 0 THEN l."pointsDelta" ELSE 0 END), 0)::int AS "totalEarned",
       COALESCE(SUM(CASE WHEN l.direction = 'redeem' THEN ABS(l."pointsDelta") ELSE 0 END), 0)::int AS "totalRedeemed",
       COALESCE(SUM(CASE WHEN l.direction IN ('adjust', 'reverse') THEN ABS(l."pointsDelta") ELSE 0 END), 0)::int AS "totalAdjusted",
       MAX(l."createdAt") AS "lastMovementAt"
     FROM loyalty_points_ledger l
     WHERE l."clinicId" = $1::uuid
       AND l."contactId" = $2::uuid`,
    [clinicId, contactId]
  );

  return normalizeContactSummary(result.rows[0] || null, contactId);
}

async function getLoyaltyOverview(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `WITH ledger AS (
       SELECT
         "contactId",
         "pointsDelta",
         direction
       FROM loyalty_points_ledger
       WHERE "clinicId" = $1::uuid
     ),
     balances AS (
       SELECT
         "contactId",
         COALESCE(SUM("pointsDelta"), 0)::int AS balance
       FROM ledger
       GROUP BY "contactId"
     )
     SELECT
       COALESCE((SELECT COUNT(*)::int FROM balances), 0) AS "enrolledCustomers",
       COALESCE((SELECT COUNT(*)::int FROM balances WHERE balance > 0), 0) AS "activeCustomers",
       COALESCE((SELECT SUM(CASE WHEN "pointsDelta" > 0 THEN "pointsDelta" ELSE 0 END)::int FROM ledger), 0) AS "pointsIssued",
       COALESCE((SELECT SUM(CASE WHEN direction = 'redeem' THEN ABS("pointsDelta") ELSE 0 END)::int FROM ledger), 0) AS "pointsRedeemed",
       COALESCE((SELECT SUM(balance)::int FROM balances WHERE balance > 0), 0) AS "outstandingPoints",
       COALESCE((SELECT COUNT(*)::int FROM ledger), 0) AS "totalMovements",
       COALESCE((SELECT COUNT(*)::int FROM ledger WHERE direction = 'redeem'), 0) AS "totalRedemptions",
       COALESCE((SELECT COUNT(*)::int FROM loyalty_rewards WHERE "clinicId" = $1::uuid AND active = TRUE), 0) AS "activeRewards"`,
    [clinicId]
  );

  return normalizeOverview(result.rows[0] || null);
}

module.exports = {
  findLoyaltyProgramByClinicId,
  upsertLoyaltyProgram,
  listLoyaltyRewardsByClinicId,
  findLoyaltyRewardById,
  createLoyaltyReward,
  updateLoyaltyReward,
  findLoyaltyLedgerEntryByReference,
  lockLoyaltyContactById,
  createLoyaltyLedgerEntry,
  listLoyaltyLedgerByContactId,
  listRecentLoyaltyLedgerByClinicId,
  getLoyaltyContactSummary,
  getLoyaltyOverview
};
