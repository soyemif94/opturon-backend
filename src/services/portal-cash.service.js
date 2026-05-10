const { createHash } = require('node:crypto');
const { withTransaction } = require('../db/client');
const { quantizeDecimal, sumQuantized } = require('../utils/money');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findPortalUserByIdAndClinicId } = require('../repositories/portal-users.repository');
const { getClinicPortalAccountConfigById } = require('../repositories/tenant.repository');
const { findPortalActorContext } = require('./portal-active-tenant.service');
const {
  listPaymentDestinationsByClinicId,
  findPaymentDestinationById
} = require('../repositories/payment-destinations.repository');
const {
  listCashSessionsByClinicId,
  findCashSessionById,
  findOpenCashSessionByDestinationId,
  createCashSession,
  closeCashSession
} = require('../repositories/cash-sessions.repository');
const { listCashCountableOrdersByDestinationAndRange } = require('../repositories/orders.repository');

const TRUSTED_CASH_TENANT_ROLES = new Set(['owner', 'manager', 'seller']);
const TRUSTED_CASH_GLOBAL_ROLES = new Set(['superadmin', 'ops_admin']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeRole(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeOptionalAmount(value) {
  const normalized = quantizeDecimal(value, 2, NaN);
  return Number.isFinite(normalized) ? normalized : null;
}

function buildError(tenantId, reason, details) {
  return {
    ok: false,
    tenantId,
    reason,
    details: details || null
  };
}

function isCashBoxDestination(destination) {
  return Boolean(destination && destination.type === 'cash_box');
}

function buildDeterministicUuid(seed) {
  const digest = createHash('sha1').update(String(seed || '')).digest('hex').slice(0, 32).split('');
  digest[12] = '5';
  digest[16] = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8).join('')}-${digest.slice(8, 12).join('')}-${digest.slice(12, 16).join('')}-${digest.slice(16, 20).join('')}-${digest.slice(20, 32).join('')}`;
}

function normalizeTrustedActor(payload = {}) {
  const name = normalizeString(payload.actorName);
  const email = normalizeEmail(payload.actorEmail);
  const globalRole = normalizeRole(payload.actorGlobalRole);
  const tenantRole = normalizeRole(payload.actorTenantRole);

  return {
    name: name || null,
    email: email || null,
    globalRole: globalRole || null,
    tenantRole: tenantRole || null
  };
}

function canUseTrustedCashActor(actor) {
  if (!actor) return false;
  if (TRUSTED_CASH_TENANT_ROLES.has(normalizeRole(actor.tenantRole))) {
    return true;
  }
  return TRUSTED_CASH_GLOBAL_ROLES.has(normalizeRole(actor.globalRole));
}

async function resolveCashActor(context, actorUserId, payload = {}) {
  const directActor = await findPortalUserByIdAndClinicId(actorUserId, context.clinic.id);
  if (directActor && directActor.role !== 'viewer') {
    return {
      ok: true,
      userId: directActor.id,
      name: directActor.name,
      source: 'portal_user'
    };
  }

  const accountConfig = await getClinicPortalAccountConfigById(context.clinic.id);
  if (!accountConfig || accountConfig.accountScope !== 'opturon_admin') {
    return { ok: false };
  }

  const trustedActor = normalizeTrustedActor(payload);
  if (!canUseTrustedCashActor(trustedActor)) {
    return { ok: false };
  }

  const scopedActor = await findPortalActorContext(actorUserId);
  if (scopedActor && scopedActor.isAdmin && normalizeRole(scopedActor.role) !== 'viewer') {
    return {
      ok: true,
      userId: scopedActor.id,
      name: scopedActor.name || trustedActor.name || trustedActor.email || 'Opturon Admin',
      source: 'admin_actor'
    };
  }

  const syntheticSeed = `${context.tenantId}:${trustedActor.email || actorUserId}:${trustedActor.globalRole || trustedActor.tenantRole || 'cash'}`;
  return {
    ok: true,
    userId: buildDeterministicUuid(syntheticSeed),
    name: trustedActor.name || trustedActor.email || 'Opturon Admin',
    source: 'trusted_internal_actor'
  };
}

async function buildSessionMetrics(session, clinicId, client = null) {
  const orders = await listCashCountableOrdersByDestinationAndRange(
    clinicId,
    session.paymentDestinationId,
    session.openedAt,
    session.closedAt || null,
    client
  );

  const salesAmount = sumQuantized(
    orders.map((order) => Number(order.totalAmount ?? order.total ?? 0)),
    2
  );
  const expectedAmountCurrent = quantizeDecimal(Number(session.openingAmount || 0) + salesAmount, 2, 0);

  return {
    ordersCount: orders.length,
    salesAmount,
    expectedAmountCurrent,
    recentOrders: orders.slice(0, 8).map((order) => ({
      id: order.id,
      customerName:
        order.customerType === 'final_consumer'
          ? 'Consumidor final'
          : order.customerName || (order.contact && order.contact.name) || 'Cliente sin nombre',
      totalAmount: quantizeDecimal(order.totalAmount ?? order.total ?? 0, 2, 0),
      currency: order.currency || 'ARS',
      createdAt: order.createdAt,
      sellerName:
        (order.seller && order.seller.name) ||
        order.sellerNameSnapshot ||
        (order.source === 'bot' ? 'Bot' : 'Sin asignar')
    }))
  };
}

async function enrichSession(session, destination, clinicId, client = null) {
  const metrics = await buildSessionMetrics(session, clinicId, client);

  return {
    ...session,
    paymentDestination: destination
      ? {
          id: destination.id,
          name: destination.name,
          type: destination.type,
          isActive: destination.isActive
        }
      : null,
    metrics,
    lifecycle: {
      canClose: session.status === 'open',
      canReopen: false
    }
  };
}

async function listPortalCashOverview(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const [destinations, sessions] = await Promise.all([
    listPaymentDestinationsByClinicId(context.clinic.id, { includeInactive: true }),
    listCashSessionsByClinicId(context.clinic.id)
  ]);

  const cashBoxes = destinations.filter(isCashBoxDestination);
  const destinationById = new Map(cashBoxes.map((destination) => [destination.id, destination]));
  const openSessionByDestinationId = new Map(
    sessions.filter((session) => session.status === 'open').map((session) => [session.paymentDestinationId, session])
  );

  const cashBoxesWithStatus = [];
  for (const destination of cashBoxes) {
    const currentSession = openSessionByDestinationId.get(destination.id) || null;
    cashBoxesWithStatus.push({
      ...destination,
      currentSession: currentSession ? await enrichSession(currentSession, destination, context.clinic.id) : null
    });
  }

  const recentClosedSessions = [];
  for (const session of sessions.filter((item) => item.status === 'closed').slice(0, 12)) {
    recentClosedSessions.push(
      await enrichSession(session, destinationById.get(session.paymentDestinationId) || null, context.clinic.id)
    );
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    cashBoxes: cashBoxesWithStatus,
    recentClosedSessions
  };
}

async function openPortalCashSession(tenantId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const paymentDestinationId = normalizeString(payload.paymentDestinationId);
  const openedByUserId = normalizeString(payload.openedByUserId);
  const openingAmount = quantizeDecimal(payload.openingAmount, 2, NaN);
  const notes = normalizeString(payload.notes) || null;

  if (!paymentDestinationId) {
    return buildError(context.tenantId, 'missing_cash_box_destination_id');
  }
  if (!openedByUserId) {
    return buildError(context.tenantId, 'missing_opened_by_user_id');
  }
  if (!Number.isFinite(openingAmount) || openingAmount < 0) {
    return buildError(context.tenantId, 'invalid_cash_opening_amount');
  }

  const [destination, openedBy] = await Promise.all([
    findPaymentDestinationById(paymentDestinationId, context.clinic.id),
    resolveCashActor(context, openedByUserId, payload)
  ]);

  if (!destination || !isCashBoxDestination(destination)) {
    return buildError(context.tenantId, 'cash_box_destination_not_found');
  }
  if (!destination.isActive) {
    return buildError(context.tenantId, 'cash_box_destination_inactive');
  }
  if (!openedBy || openedBy.ok !== true || !openedBy.userId || !openedBy.name) {
    return buildError(context.tenantId, 'cash_open_user_not_found');
  }

  try {
    const session = await withTransaction(async (client) => {
      const existingOpen = await findOpenCashSessionByDestinationId(paymentDestinationId, context.clinic.id, client);
      if (existingOpen) {
        return buildError(context.tenantId, 'cash_session_already_open');
      }

      return createCashSession(
        {
          clinicId: context.clinic.id,
          paymentDestinationId,
          openedByUserId: openedBy.userId,
          openedByNameSnapshot: openedBy.name,
          openingAmount,
          notes
        },
        client
      );
    });

    if (session && session.ok === false) {
      return session;
    }

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      session: await enrichSession(session, destination, context.clinic.id)
    };
  } catch (error) {
    if (error && error.code === '23505') {
      return buildError(context.tenantId, 'cash_session_already_open');
    }
    throw error;
  }
}

async function closePortalCashSession(tenantId, sessionId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeSessionId = normalizeString(sessionId);
  const closedByUserId = normalizeString(payload.closedByUserId);
  const rawCashCountedAmount = normalizeOptionalAmount(payload.cashCountedAmount);
  const rawTransferCountedAmount = normalizeOptionalAmount(payload.transferCountedAmount);
  const rawTotalCountedAmount =
    normalizeOptionalAmount(payload.totalCountedAmount) ?? normalizeOptionalAmount(payload.countedAmount);
  const cashCountedAmount = rawCashCountedAmount ?? rawTotalCountedAmount ?? 0;
  const transferCountedAmount = rawTransferCountedAmount ?? 0;
  const totalCountedAmount = rawTotalCountedAmount ?? sumQuantized([cashCountedAmount, transferCountedAmount], 2);
  const notes = normalizeString(payload.notes) || null;

  if (!safeSessionId) {
    return buildError(context.tenantId, 'missing_cash_session_id');
  }
  if (!closedByUserId) {
    return buildError(context.tenantId, 'missing_closed_by_user_id');
  }
  if (
    cashCountedAmount < 0 ||
    transferCountedAmount < 0 ||
    totalCountedAmount < 0
  ) {
    return buildError(context.tenantId, 'invalid_cash_counted_amount', 'cash_counted_amount_or_transfer_counted_amount_invalid');
  }

  const closedBy = await resolveCashActor(context, closedByUserId, payload);
  if (!closedBy || closedBy.ok !== true || !closedBy.userId || !closedBy.name) {
    return buildError(context.tenantId, 'cash_close_user_not_found');
  }

  const result = await withTransaction(async (client) => {
    const currentSession = await findCashSessionById(safeSessionId, context.clinic.id, client);
    if (!currentSession) {
      return buildError(context.tenantId, 'cash_session_not_found');
    }
    if (currentSession.status !== 'open') {
      return buildError(context.tenantId, 'cash_session_not_open');
    }

    const destination = await findPaymentDestinationById(currentSession.paymentDestinationId, context.clinic.id, client);
    if (!destination || !isCashBoxDestination(destination)) {
      return buildError(context.tenantId, 'cash_box_destination_not_found');
    }

    const closedAt = new Date().toISOString();
    const metrics = await buildSessionMetrics(
      {
        ...currentSession,
        closedAt
      },
      context.clinic.id,
      client
    );
    const expectedAmount = metrics.expectedAmountCurrent;
    const differenceAmount = quantizeDecimal(totalCountedAmount - expectedAmount, 2, 0);

    const closedSession = await closeCashSession(
      safeSessionId,
      context.clinic.id,
      {
        closedByUserId: closedBy.userId,
        closedByNameSnapshot: closedBy.name,
        closedAt,
        cashCountedAmount,
        transferCountedAmount,
        countedAmount: totalCountedAmount,
        expectedAmount,
        differenceAmount,
        notes
      },
      client
    );

    if (!closedSession) {
      return buildError(context.tenantId, 'cash_session_not_open');
    }

    return {
      ok: true,
      session: await enrichSession(closedSession, destination, context.clinic.id, client)
    };
  });

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    session: result.session
  };
}

module.exports = {
  listPortalCashOverview,
  openPortalCashSession,
  closePortalCashSession
};
