const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findContactByIdAndClinicId } = require('../repositories/contact.repository');
const { findPaymentById } = require('../repositories/payments.repository');
const {
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
} = require('../repositories/loyalty.repository');

function normalizeString(value) {
  return String(value || '').trim();
}

function buildError(tenantId, reason, detail = null) {
  return {
    ok: false,
    tenantId,
    reason,
    detail
  };
}

function normalizeProgramPayload(payload = {}, fallback = {}) {
  const spendAmount = Number(payload.spendAmount ?? fallback.spendAmount ?? 1000);
  const pointsAmount = Number(payload.pointsAmount ?? fallback.pointsAmount ?? 10);
  return {
    enabled: payload.enabled !== undefined ? payload.enabled === true : fallback.enabled === true,
    spendAmount,
    pointsAmount,
    programText:
      normalizeString(payload.programText) ||
      normalizeString(fallback.programText) ||
      'Cada compra valida suma puntos para futuras recompensas.',
    redemptionPolicyText:
      normalizeString(payload.redemptionPolicyText) ||
      normalizeString(fallback.redemptionPolicyText) ||
      'El equipo puede canjear recompensas manualmente desde el panel.'
  };
}

function normalizeRewardPayload(payload = {}, fallback = {}) {
  return {
    name: normalizeString(payload.name ?? fallback.name),
    description: normalizeString(payload.description ?? fallback.description) || null,
    pointsCost: Number(payload.pointsCost ?? fallback.pointsCost),
    active: payload.active !== undefined ? payload.active === true : fallback.active !== false
  };
}

function calculateEarnedPoints(amount, program) {
  const spendAmount = Number(program?.spendAmount || 0);
  const pointsAmount = Number(program?.pointsAmount || 0);
  const safeAmount = Number(amount || 0);

  if (!program?.enabled || !Number.isFinite(spendAmount) || spendAmount <= 0) return 0;
  if (!Number.isFinite(pointsAmount) || pointsAmount <= 0) return 0;
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) return 0;

  return Math.floor(safeAmount / spendAmount) * pointsAmount;
}

function isUniqueViolation(error) {
  return Boolean(error && typeof error === 'object' && error.code === '23505');
}

let loyaltySavepointSequence = 0;

function nextLoyaltySavepointName() {
  loyaltySavepointSequence += 1;
  return `loyalty_sp_${Date.now()}_${loyaltySavepointSequence}`;
}

async function createLoyaltyLedgerEntryIdempotently(input, client, lookup, skippedReason) {
  const savepoint = nextLoyaltySavepointName();
  await client.query(`SAVEPOINT ${savepoint}`);

  try {
    const entry = await createLoyaltyLedgerEntry(input, client);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return {
      ok: true,
      entry,
      created: true,
      skipped: null
    };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (_) {
        // no-op
      }
      throw error;
    }

    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    const entry = await findLoyaltyLedgerEntryByReference(lookup, client);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);

    if (!entry) {
      throw error;
    }

    return {
      ok: true,
      entry,
      created: false,
      skipped: skippedReason
    };
  }
}

async function getPortalLoyaltyProgram(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const program = await findLoyaltyProgramByClinicId(context.clinic.id);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    program
  };
}

async function updatePortalLoyaltyProgram(tenantId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const current = await findLoyaltyProgramByClinicId(context.clinic.id);
  const nextProgram = normalizeProgramPayload(payload, current);

  if (!Number.isFinite(nextProgram.spendAmount) || nextProgram.spendAmount <= 0) {
    return buildError(context.tenantId, 'invalid_loyalty_spend_amount');
  }
  if (!Number.isInteger(nextProgram.pointsAmount) || nextProgram.pointsAmount <= 0) {
    return buildError(context.tenantId, 'invalid_loyalty_points_amount');
  }

  const program = await upsertLoyaltyProgram({
    clinicId: context.clinic.id,
    ...nextProgram
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    program
  };
}

async function listPortalLoyaltyRewards(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const rewards = await listLoyaltyRewardsByClinicId(context.clinic.id);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    rewards
  };
}

async function createPortalLoyaltyReward(tenantId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const rewardPayload = normalizeRewardPayload(payload);
  if (!rewardPayload.name) {
    return buildError(context.tenantId, 'missing_loyalty_reward_name');
  }
  if (!Number.isInteger(rewardPayload.pointsCost) || rewardPayload.pointsCost <= 0) {
    return buildError(context.tenantId, 'invalid_loyalty_reward_points_cost');
  }

  const reward = await createLoyaltyReward({
    clinicId: context.clinic.id,
    ...rewardPayload
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    reward
  };
}

async function updatePortalLoyaltyReward(tenantId, rewardId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeRewardId = normalizeString(rewardId);
  if (!safeRewardId) {
    return buildError(context.tenantId, 'missing_loyalty_reward_id');
  }

  const current = await findLoyaltyRewardById(safeRewardId, context.clinic.id);
  if (!current) {
    return buildError(context.tenantId, 'loyalty_reward_not_found');
  }

  const rewardPayload = normalizeRewardPayload(payload, current);
  if (!rewardPayload.name) {
    return buildError(context.tenantId, 'missing_loyalty_reward_name');
  }
  if (!Number.isInteger(rewardPayload.pointsCost) || rewardPayload.pointsCost <= 0) {
    return buildError(context.tenantId, 'invalid_loyalty_reward_points_cost');
  }

  const reward = await updateLoyaltyReward(safeRewardId, context.clinic.id, rewardPayload);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    reward
  };
}

async function getPortalLoyaltyContactDetail(tenantId, contactId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeContactId = normalizeString(contactId);
  if (!safeContactId) {
    return buildError(context.tenantId, 'missing_contact_id');
  }

  const contact = await findContactByIdAndClinicId(safeContactId, context.clinic.id);
  if (!contact) {
    return buildError(context.tenantId, 'contact_not_found');
  }

  const [summary, ledger] = await Promise.all([
    getLoyaltyContactSummary(context.clinic.id, contact.id),
    listLoyaltyLedgerByContactId(context.clinic.id, contact.id, 50)
  ]);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    contact: {
      id: contact.id,
      name: contact.name || contact.fullName || 'Contacto',
      phone: contact.phone || null
    },
    loyalty: {
      summary,
      ledger
    }
  };
}

async function getPortalLoyaltyOverview(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const [program, rewards, summary, recentMovements] = await Promise.all([
    findLoyaltyProgramByClinicId(context.clinic.id),
    listLoyaltyRewardsByClinicId(context.clinic.id),
    getLoyaltyOverview(context.clinic.id),
    listRecentLoyaltyLedgerByClinicId(context.clinic.id, 12)
  ]);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    overview: {
      program,
      rewards,
      summary,
      recentMovements
    }
  };
}

async function redeemPortalLoyaltyReward(tenantId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const contactId = normalizeString(payload.contactId);
  const rewardId = normalizeString(payload.rewardId);
  const notes = normalizeString(payload.notes) || null;

  if (!contactId) {
    return buildError(context.tenantId, 'missing_contact_id');
  }
  if (!rewardId) {
    return buildError(context.tenantId, 'missing_loyalty_reward_id');
  }

  const [contact, reward] = await Promise.all([
    findContactByIdAndClinicId(contactId, context.clinic.id),
    findLoyaltyRewardById(rewardId, context.clinic.id)
  ]);

  if (!contact) {
    return buildError(context.tenantId, 'contact_not_found');
  }
  if (!reward) {
    return buildError(context.tenantId, 'loyalty_reward_not_found');
  }
  if (!reward.active) {
    return buildError(context.tenantId, 'loyalty_reward_inactive');
  }

  const redemption = await withTransaction(async (client) => {
    const lockedContact = await lockLoyaltyContactById(context.clinic.id, contact.id, client);
    if (!lockedContact) {
      return buildError(context.tenantId, 'contact_not_found');
    }

    const rewardSnapshot = await findLoyaltyRewardById(reward.id, context.clinic.id, client);
    if (!rewardSnapshot) {
      return buildError(context.tenantId, 'loyalty_reward_not_found');
    }
    if (!rewardSnapshot.active) {
      return buildError(context.tenantId, 'loyalty_reward_inactive');
    }

    const summary = await getLoyaltyContactSummary(context.clinic.id, contact.id, client);
    if (summary.currentPoints < rewardSnapshot.pointsCost) {
      return buildError(context.tenantId, 'insufficient_loyalty_points');
    }

    const entry = await createLoyaltyLedgerEntry(
      {
        clinicId: context.clinic.id,
        contactId: contact.id,
        direction: 'redeem',
        points: rewardSnapshot.pointsCost,
        pointsDelta: -Math.abs(rewardSnapshot.pointsCost),
        reason: `Canje manual: ${rewardSnapshot.name}`,
        referenceType: 'reward',
        referenceId: rewardSnapshot.id,
        metadata: {
          reward: {
            id: rewardSnapshot.id,
            name: rewardSnapshot.name,
            pointsCost: rewardSnapshot.pointsCost
          },
          notes
        }
      },
      client
    );

    const nextSummary = await getLoyaltyContactSummary(context.clinic.id, contact.id, client);
    return {
      ok: true,
      entry,
      nextSummary
    };
  });

  if (!redemption.ok) {
    return redemption;
  }

  const ledger = await listLoyaltyLedgerByContactId(context.clinic.id, contact.id, 20);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    redemption: redemption.entry,
    contact: {
      id: contact.id,
      name: contact.name || contact.fullName || 'Contacto'
    },
    loyalty: {
      summary: redemption.nextSummary,
      ledger
    }
  };
}

async function getLoyaltyContactSnapshotByClinicId(clinicId, contactId) {
  const [summary, recentMovements] = await Promise.all([
    getLoyaltyContactSummary(clinicId, contactId),
    listLoyaltyLedgerByContactId(clinicId, contactId, 5)
  ]);

  return {
    summary,
    recentMovements
  };
}

async function awardLoyaltyPointsForPayment(clinicId, paymentId, client = null) {
  const payment = await findPaymentById(paymentId, clinicId, client);
  if (!payment) {
    return { ok: false, reason: 'payment_not_found' };
  }
  if (String(payment.status || '').toLowerCase() !== 'recorded') {
    return { ok: true, skipped: 'payment_not_recorded' };
  }
  if (!payment.contactId) {
    return { ok: true, skipped: 'payment_without_contact' };
  }

  const lockedContact = await lockLoyaltyContactById(clinicId, payment.contactId, client);
  if (!lockedContact) {
    return { ok: true, skipped: 'payment_contact_not_found' };
  }

  const [program, existing] = await Promise.all([
    findLoyaltyProgramByClinicId(clinicId, client),
    findLoyaltyLedgerEntryByReference(
      {
        clinicId,
        referenceType: 'payment',
        referenceId: payment.id,
        direction: 'earn'
      },
      client
    )
  ]);

  if (existing) {
    return { ok: true, skipped: 'payment_already_awarded', entry: existing };
  }

  const earnedPoints = calculateEarnedPoints(payment.amount, program);
  if (earnedPoints <= 0) {
    return { ok: true, skipped: 'payment_does_not_generate_points' };
  }

  const result = await createLoyaltyLedgerEntryIdempotently(
    {
      clinicId,
      contactId: payment.contactId,
      direction: 'earn',
      points: earnedPoints,
      pointsDelta: earnedPoints,
      reason: 'Compra acreditada',
      referenceType: 'payment',
      referenceId: payment.id,
      metadata: {
        payment: {
          id: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          paidAt: payment.paidAt
        }
      }
    },
    client,
    {
      clinicId,
      referenceType: 'payment',
      referenceId: payment.id,
      direction: 'earn'
    },
    'payment_already_awarded'
  );

  return { ok: true, entry: result.entry, skipped: result.skipped || null };
}

async function reverseLoyaltyPointsForVoidedPayment(clinicId, paymentId, client = null) {
  const payment = await findPaymentById(paymentId, clinicId, client);
  if (!payment || !payment.contactId) {
    return { ok: true, skipped: 'payment_without_contact' };
  }

  const lockedContact = await lockLoyaltyContactById(clinicId, payment.contactId, client);
  if (!lockedContact) {
    return { ok: true, skipped: 'payment_contact_not_found' };
  }

  const [existingEarn, existingReverse] = await Promise.all([
    findLoyaltyLedgerEntryByReference(
      {
        clinicId,
        referenceType: 'payment',
        referenceId: payment.id,
        direction: 'earn'
      },
      client
    ),
    findLoyaltyLedgerEntryByReference(
      {
        clinicId,
        referenceType: 'payment',
        referenceId: payment.id,
        direction: 'reverse'
      },
      client
    )
  ]);

  if (!existingEarn) {
    return { ok: true, skipped: 'payment_without_loyalty_entry' };
  }
  if (existingReverse) {
    return { ok: true, skipped: 'payment_already_reversed', entry: existingReverse };
  }

  const result = await createLoyaltyLedgerEntryIdempotently(
    {
      clinicId,
      contactId: payment.contactId,
      direction: 'reverse',
      points: existingEarn.points,
      pointsDelta: -Math.abs(existingEarn.points),
      reason: 'Reversa por anulacion de cobro',
      referenceType: 'payment',
      referenceId: payment.id,
      metadata: {
        payment: {
          id: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status
        },
        reversedEarnEntryId: existingEarn.id
      }
    },
    client,
    {
      clinicId,
      referenceType: 'payment',
      referenceId: payment.id,
      direction: 'reverse'
    },
    'payment_already_reversed'
  );

  return { ok: true, entry: result.entry, skipped: result.skipped || null };
}

module.exports = {
  getPortalLoyaltyProgram,
  updatePortalLoyaltyProgram,
  listPortalLoyaltyRewards,
  createPortalLoyaltyReward,
  updatePortalLoyaltyReward,
  getPortalLoyaltyContactDetail,
  getPortalLoyaltyOverview,
  redeemPortalLoyaltyReward,
  getLoyaltyContactSnapshotByClinicId,
  awardLoyaltyPointsForPayment,
  reverseLoyaltyPointsForVoidedPayment
};
