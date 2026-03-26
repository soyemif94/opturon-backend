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

function parseContext(context) {
  return context && typeof context === 'object' && !Array.isArray(context) ? context : {};
}

function normalizeString(value) {
  return String(value || '').trim();
}

function deriveConversationCommercialStage(conversation) {
  const context = parseContext(conversation.context);
  const stage = normalizeString(context.portalDealStage).toLowerCase();

  if (stage === 'lost') {
    return {
      key: 'lost',
      label: 'Operacion perdida',
      collectionLabel: 'Sin cobro'
    };
  }

  if (stage === 'won') {
    return {
      key: 'won',
      label: 'Cierre logrado',
      collectionLabel: 'Pendiente de cobro'
    };
  }

  if (stage === 'proposal') {
    return {
      key: 'negotiation',
      label: 'Propuesta activa',
      collectionLabel: 'Pendiente de cobro'
    };
  }

  if (stage === 'qualified') {
    return {
      key: 'active',
      label: 'En seguimiento',
      collectionLabel: 'Sin cobro'
    };
  }

  return {
    key: 'new',
    label: 'Nueva oportunidad',
    collectionLabel: 'Sin cobro'
  };
}

function hasCommercialConversationSignal(conversation) {
  const context = parseContext(conversation.context);
  return Boolean(
    normalizeString(context.portalAssignedTo) ||
    normalizeString(context.portalAssignedToUserId) ||
    normalizeString(context.portalDealStage) ||
    String(context.portalPriority || '').trim().toLowerCase() === 'hot'
  );
}

function isOpenOpportunityRecord(opportunity) {
  return opportunity.commercialStage !== 'won' && opportunity.commercialStage !== 'lost';
}

function isActiveSalesConversation(opportunity) {
  return Boolean(opportunity.conversationId) && isOpenOpportunityRecord(opportunity) && String(opportunity.status || '').toLowerCase() !== 'closed';
}

async function listConversationSalesCandidates(clinicId) {
  const result = await query(
    `SELECT
       c.id,
       c.status,
       c.context,
       c."contactId",
       c."lastInboundAt",
       c."lastOutboundAt",
       c."updatedAt",
       ct.name AS "contactName",
       COALESCE(ct.phone, ct."whatsappPhone", ct."waId") AS "contactPhone",
       EXISTS(
         SELECT 1
         FROM orders o
         WHERE o."clinicId" = c."clinicId"
           AND o."conversationId" = c.id
           AND o.status <> 'cancelled'
       ) AS "hasLinkedOrder"
     FROM conversations c
     INNER JOIN contacts ct
       ON ct.id = c."contactId"
     WHERE c."clinicId" = $1::uuid
     ORDER BY COALESCE(c."lastInboundAt", c."lastOutboundAt", c."updatedAt") DESC, c."updatedAt" DESC`,
    [clinicId]
  );

  return result.rows;
}

async function listConversationCommercialContextByIds(clinicId, conversationIds) {
  const safeIds = Array.isArray(conversationIds) ? conversationIds.filter(Boolean) : [];
  if (!safeIds.length) {
    return {};
  }

  const result = await query(
    `SELECT
       c.id,
       c.status,
       c.context
     FROM conversations c
     WHERE c."clinicId" = $1::uuid
       AND c.id = ANY($2::uuid[])`,
    [clinicId, safeIds]
  );

  return result.rows.reduce((acc, row) => {
    acc[row.id] = {
      status: row.status || null,
      context: parseContext(row.context)
    };
    return acc;
  }, {});
}

async function listConversationResponseMetrics(clinicId) {
  const result = await query(
    `SELECT
       c.id,
       c.context,
       COUNT(*)::int AS "totalMessages",
       COUNT(*) FILTER (
         WHERE m.direction = 'outbound'
           AND COALESCE(m.raw->'ai'->>'used', 'false') <> 'true'
       )::int AS "humanResponses",
       COUNT(*) FILTER (
         WHERE m.direction = 'outbound'
           AND COALESCE(m.raw->'ai'->>'used', 'false') = 'true'
       )::int AS "automatedResponses"
     FROM conversations c
     LEFT JOIN conversation_messages m
       ON m."conversationId" = c.id
     WHERE c."clinicId" = $1::uuid
     GROUP BY c.id, c.context`,
    [clinicId]
  );

  return result.rows.reduce((acc, row) => {
    acc[row.id] = {
      totalMessages: Number(row.totalMessages || 0),
      humanResponses: Number(row.humanResponses || 0),
      automatedResponses: Number(row.automatedResponses || 0),
      responsible: buildResponsible(row.context)
    };
    return acc;
  }, {});
}

function buildResponsible(context) {
  const safeContext = parseContext(context);
  const name = normalizeString(safeContext.portalAssignedTo);
  if (!name) return null;

  return {
    id: normalizeString(safeContext.portalAssignedToUserId) || name,
    name
  };
}

function mapSalesRow(order, conversationSnapshot = null) {
  const commercialStage = deriveCommercialStage(order);
  const conversationContext = parseContext(conversationSnapshot && conversationSnapshot.context);
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
    responsible: buildResponsible(conversationContext),
    conversationId: order.conversationId || null
  };
}

function mapConversationOpportunity(conversation) {
  const commercialStage = deriveConversationCommercialStage(conversation);
  const responsible = buildResponsible(conversation.context);

  return {
    id: `conversation:${conversation.id}`,
    contactId: conversation.contactId || null,
    customer: {
      id: conversation.contactId || null,
      name: conversation.contactName || 'Cliente',
      phone: conversation.contactPhone || null
    },
    status: conversation.status || 'open',
    paymentStatus: 'pending',
    commercialStage: commercialStage.key,
    commercialStageLabel: commercialStage.label,
    collectionStatusLabel: commercialStage.collectionLabel,
    amount: 0,
    currency: 'ARS',
    lastActivityAt: conversation.lastInboundAt || conversation.lastOutboundAt || conversation.updatedAt || null,
    source: 'inbox',
    responsible,
    conversationId: conversation.id
  };
}

function getOpportunityIdentity(opportunity) {
  const contactId = normalizeString(opportunity && opportunity.contactId);
  if (contactId) return `contact:${contactId}`;

  const phone = normalizeString(opportunity && opportunity.customer && opportunity.customer.phone);
  if (phone) return `phone:${phone}`;

  return '';
}

function mergeOpenOpportunities(opportunities) {
  const grouped = new Map();

  for (const opportunity of opportunities) {
    const key = getOpportunityIdentity(opportunity);
    if (!key) {
      grouped.set(`orphan:${opportunity.id}`, opportunity);
      continue;
    }

    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...opportunity });
      continue;
    }

    const currentActivity = current.lastActivityAt ? new Date(current.lastActivityAt).getTime() : 0;
    const nextActivity = opportunity.lastActivityAt ? new Date(opportunity.lastActivityAt).getTime() : 0;
    const primary = nextActivity >= currentActivity ? opportunity : current;
    const secondary = primary === opportunity ? current : opportunity;

    grouped.set(key, {
      ...primary,
      customer: primary.customer || secondary.customer,
      responsible: primary.responsible || secondary.responsible || null,
      amount: Number(current.amount || 0) + Number(opportunity.amount || 0),
      currency: primary.currency || secondary.currency || 'ARS',
      source: primary.source || secondary.source || null,
      conversationId: primary.conversationId || secondary.conversationId || null,
      paymentStatus:
        normalizeString(primary.paymentStatus).toLowerCase() === 'pending' ||
        normalizeString(secondary.paymentStatus).toLowerCase() === 'pending'
          ? 'pending'
          : primary.paymentStatus || secondary.paymentStatus || 'pending'
    });
  }

  return Array.from(grouped.values());
}

function consolidateActiveOpportunities(opportunities) {
  const open = [];
  const closed = [];

  for (const opportunity of opportunities) {
    if (isOpenOpportunityRecord(opportunity)) {
      open.push(opportunity);
    } else {
      closed.push(opportunity);
    }
  }

  return [...mergeOpenOpportunities(open), ...closed];
}

async function buildUnifiedSalesOpportunities(clinicId) {
  const [orders, conversations] = await Promise.all([
    listOrdersByClinicId(clinicId),
    listConversationSalesCandidates(clinicId)
  ]);

  const conversationSnapshotsById = await listConversationCommercialContextByIds(
    clinicId,
    orders.map((order) => order.conversationId).filter(Boolean)
  );

  const orderConversationIds = new Set(orders.map((order) => order.conversationId).filter(Boolean));
  const orderOpportunities = orders
    .filter((order) => String(order?.status || '').toLowerCase() !== 'cancelled')
    .map((order) => mapSalesRow(order, conversationSnapshotsById[order.conversationId] || null));

  const conversationOpportunities = conversations
    .filter((conversation) => !conversation.hasLinkedOrder)
    .filter((conversation) => !orderConversationIds.has(conversation.id))
    .filter((conversation) => hasCommercialConversationSignal(conversation))
    .map(mapConversationOpportunity);

  return consolidateActiveOpportunities([...orderOpportunities, ...conversationOpportunities]).sort((a, b) => {
    const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
    const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
    return bTime - aTime;
  });
}

function summarizeResponsiblePerformance(opportunities, responseMetricsByConversationId = {}) {
  const grouped = new Map();

  for (const opportunity of opportunities) {
    if (!opportunity.responsible?.name) continue;

    const key = `${opportunity.responsible.id || opportunity.responsible.name}:${opportunity.responsible.name}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        responsibleId: opportunity.responsible.id || null,
        responsibleName: opportunity.responsible.name,
        closedSales: 0,
        openOpportunities: 0,
        closedRevenue: 0,
        humanResponses: 0
      });
    }

    const target = grouped.get(key);
    if (opportunity.paymentStatus === 'paid') {
      target.closedSales += 1;
      target.closedRevenue += Number(opportunity.amount || 0);
    } else if (isOpenOpportunityRecord(opportunity)) {
      target.openOpportunities += 1;
    }
  }

  const countedConversations = new Set();
  for (const opportunity of opportunities) {
    const conversationId = normalizeString(opportunity.conversationId);
    if (!conversationId || countedConversations.has(conversationId)) continue;

    const metrics = responseMetricsByConversationId[conversationId];
    if (!metrics || !metrics.humanResponses) continue;

    const responsible = opportunity.responsible?.name ? opportunity.responsible : metrics.responsible;
    if (!responsible?.name) continue;

    const key = `${responsible.id || responsible.name}:${responsible.name}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        responsibleId: responsible.id || null,
        responsibleName: responsible.name,
        closedSales: 0,
        openOpportunities: 0,
        closedRevenue: 0,
        humanResponses: 0
      });
    }

    grouped.get(key).humanResponses += Number(metrics.humanResponses || 0);
    countedConversations.add(conversationId);
  }

  return Array.from(grouped.values()).sort((left, right) => {
    if (right.humanResponses !== left.humanResponses) return right.humanResponses - left.humanResponses;
    if (right.closedRevenue !== left.closedRevenue) return right.closedRevenue - left.closedRevenue;
    if (right.closedSales !== left.closedSales) return right.closedSales - left.closedSales;
    return right.openOpportunities - left.openOpportunities;
  });
}

async function getSalesSummary(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const [orders, payments, opportunities] = await Promise.all([
    listOrdersByClinicId(context.clinic.id),
    listPaymentsByClinicId(context.clinic.id),
    buildUnifiedSalesOpportunities(context.clinic.id)
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
  const activeOpportunities = opportunities.filter(isOpenOpportunityRecord);
  const closedOrders = orders.filter(isClosedOrder);
  const activeSalesConversations = new Set(
    opportunities.filter(isActiveSalesConversation).map((item) => item.conversationId).filter(Boolean)
  ).size;
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

  const [orders, opportunities, responseMetricsByConversationId] = await Promise.all([
    listOrdersByClinicId(context.clinic.id),
    buildUnifiedSalesOpportunities(context.clinic.id),
    listConversationResponseMetrics(context.clinic.id)
  ]);

  const closedOrders = orders.filter(isClosedOrder);
  const openOpportunities = opportunities.filter(isOpenOpportunityRecord);
  const activeSalesConversations = new Set(
    opportunities.filter(isActiveSalesConversation).map((item) => item.conversationId).filter(Boolean)
  ).size;
  const responsiblePerformance = summarizeResponsiblePerformance(opportunities, responseMetricsByConversationId);
  const opportunityConversationIds = new Set(opportunities.map((item) => normalizeString(item.conversationId)).filter(Boolean));
  const responseStats = Array.from(opportunityConversationIds).reduce(
    (acc, conversationId) => {
      const metrics = responseMetricsByConversationId[conversationId];
      if (!metrics) return acc;
      acc.humanResponsesCount += Number(metrics.humanResponses || 0);
      acc.automatedResponsesCount += Number(metrics.automatedResponses || 0);
      acc.totalConversationMessagesCount += Number(metrics.totalMessages || 0);
      return acc;
    },
    {
      humanResponsesCount: 0,
      automatedResponsesCount: 0,
      totalConversationMessagesCount: 0
    }
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    metrics: {
      closedSalesCount: closedOrders.length,
      openOpportunitiesCount: openOpportunities.length,
      activeSalesConversations,
      humanResponsesCount: responseStats.humanResponsesCount,
      automatedResponsesCount: responseStats.automatedResponsesCount,
      totalConversationMessagesCount: responseStats.totalConversationMessagesCount,
      responsiblePerformance
    }
  };
}

async function listSalesOpportunities(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const opportunities = await buildUnifiedSalesOpportunities(context.clinic.id);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    opportunities
  };
}

module.exports = {
  getSalesSummary,
  getSalesMetrics,
  listSalesOpportunities
};
