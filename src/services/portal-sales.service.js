const { DateTime } = require('luxon');
const { query } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { listOrdersByClinicId } = require('../repositories/orders.repository');
const { listPaymentsByClinicId } = require('../repositories/payments.repository');

function buildError(tenantId, reason) {
  return {
    ok: false,
    tenantId,
    reason
  };
}

function toDateTime(value, timezone) {
  if (!value) return null;
  const date = DateTime.fromISO(String(value), { zone: 'utc' });
  if (!date.isValid) return null;
  return timezone ? date.setZone(timezone) : date;
}

function isToday(value, timezone) {
  const date = toDateTime(value, timezone);
  if (!date) return false;
  return date.hasSame(DateTime.now().setZone(timezone || 'utc'), 'day');
}

function isCurrentMonth(value, timezone) {
  const date = toDateTime(value, timezone);
  if (!date) return false;
  return date.hasSame(DateTime.now().setZone(timezone || 'utc'), 'month');
}

function isClosedOrder(order) {
  return String(order?.status || '').toLowerCase() !== 'cancelled' && String(order?.paymentStatus || '').toLowerCase() === 'paid';
}

function isActiveOpportunity(order) {
  const status = String(order?.status || '').toLowerCase();
  const paymentStatus = String(order?.paymentStatus || '').toLowerCase();
  if (status === 'cancelled') return false;
  if (paymentStatus === 'paid') return false;
  return true;
}

function deriveCommercialStage(order) {
  const status = String(order?.status || '').toLowerCase();
  const paymentStatus = String(order?.paymentStatus || '').toLowerCase();

  if (status === 'cancelled') {
    return {
      key: 'lost',
      label: 'Operacion perdida',
      collectionLabel: 'Sin cobro'
    };
  }

  if (paymentStatus === 'paid') {
    return {
      key: 'won',
      label: 'Cierre logrado',
      collectionLabel: 'Cobrada'
    };
  }

  if (status === 'confirmed') {
    return {
      key: 'negotiation',
      label: 'Cierre pendiente',
      collectionLabel: 'Pendiente de cobro'
    };
  }

  if (status === 'draft') {
    return {
      key: 'new',
      label: 'Nueva oportunidad',
      collectionLabel: 'Sin cobro'
    };
  }

  return {
    key: 'active',
    label: 'En seguimiento',
    collectionLabel: paymentStatus === 'pending' ? 'Pendiente de cobro' : 'Sin cobro'
  };
}

async function countActiveSalesConversations(clinicId) {
  const result = await query(
    `SELECT COUNT(DISTINCT c.id)::int AS total
     FROM orders o
     INNER JOIN conversations c
       ON c.id = o."conversationId"
      AND c."clinicId" = o."clinicId"
     WHERE o."clinicId" = $1::uuid
       AND o.status <> 'cancelled'
       AND c.status <> 'closed'`,
    [clinicId]
  );

  return Number(result.rows[0]?.total || 0);
}

async function listResponsiblePerformance(clinicId) {
  const result = await query(
    `SELECT
       NULLIF(c.context->>'portalAssignedTo', '') AS "responsibleId",
       COALESCE(NULLIF(c.context->>'portalAssignedTo', ''), 'Sin responsable') AS "responsibleLabel",
       COUNT(*) FILTER (
         WHERE o.status <> 'cancelled'
           AND COALESCE(o."paymentStatus", '') = 'paid'
       )::int AS "closedSales",
       COUNT(*) FILTER (
         WHERE o.status <> 'cancelled'
           AND COALESCE(o."paymentStatus", '') <> 'paid'
       )::int AS "openOpportunities",
       COALESCE(SUM(o."totalAmount") FILTER (
         WHERE o.status <> 'cancelled'
           AND COALESCE(o."paymentStatus", '') = 'paid'
       ), 0) AS "closedRevenue"
     FROM orders o
     INNER JOIN conversations c
       ON c.id = o."conversationId"
      AND c."clinicId" = o."clinicId"
     WHERE o."clinicId" = $1::uuid
       AND NULLIF(c.context->>'portalAssignedTo', '') IS NOT NULL
     GROUP BY NULLIF(c.context->>'portalAssignedTo', ''), COALESCE(NULLIF(c.context->>'portalAssignedTo', ''), 'Sin responsable')
     ORDER BY "closedRevenue" DESC, "closedSales" DESC, "openOpportunities" DESC`,
    [clinicId]
  );

  return result.rows.map((row) => ({
    responsibleId: row.responsibleId || null,
    responsibleName: row.responsibleLabel || 'Sin responsable',
    closedSales: Number(row.closedSales || 0),
    openOpportunities: Number(row.openOpportunities || 0),
    closedRevenue: Number(row.closedRevenue || 0)
  }));
}

function mapSalesRow(order) {
  const commercialStage = deriveCommercialStage(order);
  return {
    id: order.id,
    contactId: order.contactId || null,
    customer: {
      id: order.contact?.id || order.contactId || null,
      name: order.customerName || order.contact?.name || 'Cliente',
      phone: order.customerPhone || order.contact?.phone || null
    },
    status: order.status || 'draft',
    paymentStatus: order.paymentStatus || 'pending',
    commercialStage: commercialStage.key,
    commercialStageLabel: commercialStage.label,
    collectionStatusLabel: commercialStage.collectionLabel,
    amount: Number(order.totalAmount ?? order.total ?? 0),
    currency: order.currency || 'ARS',
    lastActivityAt: order.updatedAt || order.createdAt || null,
    source: order.source || null,
    responsible: null,
    conversationId: order.conversationId || null
  };
}

async function getSalesSummary(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const [orders, payments, activeSalesConversations] = await Promise.all([
    listOrdersByClinicId(context.clinic.id),
    listPaymentsByClinicId(context.clinic.id),
    countActiveSalesConversations(context.clinic.id)
  ]);

  const timezone = context.clinic.timezone || 'UTC';
  const recordedPayments = payments.filter((payment) => String(payment.status || '').toLowerCase() === 'recorded');
  const commercialOrders = orders.filter((order) => String(order?.status || '').toLowerCase() !== 'cancelled');
  const salesToday = recordedPayments
    .filter((payment) => isToday(payment.paidAt || payment.createdAt, timezone))
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const salesMonth = recordedPayments
    .filter((payment) => isCurrentMonth(payment.paidAt || payment.createdAt, timezone))
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const activeOpportunities = orders.filter(isActiveOpportunity);
  const closedOrders = orders.filter(isClosedOrder);
  const closeRate = commercialOrders.length ? Number(((closedOrders.length / commercialOrders.length) * 100).toFixed(1)) : 0;
  const averageTicket = closedOrders.length
    ? Number((closedOrders.reduce((sum, order) => sum + Number(order.totalAmount ?? order.total ?? 0), 0) / closedOrders.length).toFixed(2))
    : 0;

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    summary: {
      salesToday,
      salesMonth,
      activeOpportunities: activeOpportunities.length,
      closeRate,
      averageTicket,
      activeSalesConversations
    }
  };
}

async function getSalesMetrics(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const [orders, responsiblePerformance, activeSalesConversations] = await Promise.all([
    listOrdersByClinicId(context.clinic.id),
    listResponsiblePerformance(context.clinic.id),
    countActiveSalesConversations(context.clinic.id)
  ]);

  const closedOrders = orders.filter(isClosedOrder);
  const openOrders = orders.filter(isActiveOpportunity);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    metrics: {
      closedSalesCount: closedOrders.length,
      openOpportunitiesCount: openOrders.length,
      activeSalesConversations,
      responsiblePerformance
    }
  };
}

async function listSalesOpportunities(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const orders = await listOrdersByClinicId(context.clinic.id);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    opportunities: orders.map(mapSalesRow)
  };
}

module.exports = {
  getSalesSummary,
  getSalesMetrics,
  listSalesOpportunities
};
