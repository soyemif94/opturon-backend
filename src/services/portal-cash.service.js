const { withTransaction } = require('../db/client');
const { quantizeDecimal, sumQuantized } = require('../utils/money');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findPortalUserByIdAndClinicId } = require('../repositories/portal-users.repository');
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

function normalizeString(value) {
  return String(value || '').trim();
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
    findPortalUserByIdAndClinicId(openedByUserId, context.clinic.id)
  ]);

  if (!destination || !isCashBoxDestination(destination)) {
    return buildError(context.tenantId, 'cash_box_destination_not_found');
  }
  if (!destination.isActive) {
    return buildError(context.tenantId, 'cash_box_destination_inactive');
  }
  if (!openedBy || openedBy.role === 'viewer') {
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
          openedByUserId,
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
  const countedAmount = quantizeDecimal(payload.countedAmount, 2, NaN);
  const notes = normalizeString(payload.notes) || null;

  if (!safeSessionId) {
    return buildError(context.tenantId, 'missing_cash_session_id');
  }
  if (!closedByUserId) {
    return buildError(context.tenantId, 'missing_closed_by_user_id');
  }
  if (!Number.isFinite(countedAmount) || countedAmount < 0) {
    return buildError(context.tenantId, 'invalid_cash_counted_amount');
  }

  const closedBy = await findPortalUserByIdAndClinicId(closedByUserId, context.clinic.id);
  if (!closedBy || closedBy.role === 'viewer') {
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
    const differenceAmount = quantizeDecimal(countedAmount - expectedAmount, 2, 0);

    const closedSession = await closeCashSession(
      safeSessionId,
      context.clinic.id,
      {
        closedByUserId,
        closedByNameSnapshot: closedBy.name,
        closedAt,
        countedAmount,
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
