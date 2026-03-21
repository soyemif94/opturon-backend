const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  listContactsByClinicId,
  findPortalContactById,
  createPortalContact,
  updatePortalContactById
} = require('../repositories/contact.repository');
const { listInvoicesByContactId } = require('../repositories/invoices.repository');
const { listPaymentsByContactId } = require('../repositories/payments.repository');
const {
  sumRecordedAllocatedAmountsByInvoiceIds,
  sumRecordedAllocatedAmountsByPaymentIds
} = require('../repositories/payment-allocations.repository');
const { buildContactFinancialSnapshot } = require('./contact-financial-snapshot.service');
const { calculateInvoiceReceivable, calculatePaymentAllocationSnapshot } = require('./invoice-balance.service');
const { getLoyaltyContactSnapshotByClinicId } = require('./portal-loyalty.service');

function normalizeNullableText(value) {
  const safeValue = String(value || '').trim();
  return safeValue ? safeValue : null;
}

function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

function normalizeContact(row) {
  const safeName = String(row.name || '').trim();

  return {
    id: row.id,
    clinicId: row.clinicId,
    waId: row.waId || null,
    phone: row.phone || null,
    name: safeName || row.companyName || row.waId || 'Contacto',
    email: row.email || null,
    whatsappPhone: row.whatsappPhone || null,
    taxId: row.taxId || null,
    taxCondition: row.taxCondition || null,
    companyName: row.companyName || null,
    notes: row.notes || null,
    status: row.status || 'active',
    optedOut: row.optedOut === true,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    lastInteractionAt: row.lastInteractionAt || row.updatedAt || null,
    conversationCount: Number(row.conversationCount || 0),
    financialSnapshot: {
      totalInvoiced: 0,
      totalCredited: 0,
      totalDocumentBalance: 0,
      totalPaid: 0,
      outstandingAmount: 0,
      unallocatedPayments: 0
    },
    relatedDocuments: [],
    relatedPayments: []
  };
}

function normalizeRelatedDocument(document, paidAmount = 0) {
  const receivable = calculateInvoiceReceivable({
    invoice: document,
    paidAmount
  });

  return {
    id: document.id,
    invoiceNumber: document.invoiceNumber || null,
    type: document.type || 'invoice',
    status: document.status || 'draft',
    currency: document.currency || 'ARS',
    totalAmount: Number(document.totalAmount || 0),
    paidAmount: Number(receivable.paidAmount || 0),
    outstandingAmount: Number(receivable.outstandingAmount || 0),
    issuedAt: document.issuedAt || null,
    createdAt: document.createdAt || null
  };
}

function normalizeRelatedPayment(payment, allocatedAmount = 0) {
  const allocationSnapshot = calculatePaymentAllocationSnapshot({ payment, allocatedAmount });

  return {
    id: payment.id,
    amount: Number(payment.amount || 0),
    currency: payment.currency || 'ARS',
    method: payment.method || 'other',
    status: payment.status || 'recorded',
    paidAt: payment.paidAt || null,
    allocatedAmount: Number(allocationSnapshot.allocatedAmount || 0),
    unallocatedAmount: Number(allocationSnapshot.unallocatedAmount || 0)
  };
}

async function listPortalContacts(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const contacts = await listContactsByClinicId(context.clinic.id);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    contacts: contacts.map(normalizeContact)
  };
}

async function createPortalContactRecord(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const name = String(payload && payload.name ? payload.name : '').trim();
  if (!name) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      reason: 'missing_contact_name'
    };
  }

  const email = normalizeNullableText(payload && payload.email);
  if (!isValidEmail(email)) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      reason: 'invalid_contact_email'
    };
  }

  const contact = await createPortalContact(context.clinic.id, {
    name,
    email,
    phone: normalizeNullableText(payload && payload.phone),
    whatsappPhone: normalizeNullableText(payload && payload.whatsappPhone),
    taxId: normalizeNullableText(payload && payload.taxId),
    taxCondition: normalizeNullableText(payload && payload.taxCondition),
    companyName: normalizeNullableText(payload && payload.companyName),
    notes: normalizeNullableText(payload && payload.notes)
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    contact: normalizeContact(contact)
  };
}

async function getPortalContactDetail(tenantId, contactId) {
  const safeContactId = String(contactId || '').trim();
  if (!safeContactId) {
    return {
      ok: false,
      tenantId: String(tenantId || '').trim() || null,
      reason: 'missing_contact_id'
    };
  }

  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const contact = await findPortalContactById(context.clinic.id, safeContactId);
  if (!contact) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      reason: 'contact_not_found'
    };
  }

  const [financialSnapshot, documents, payments, loyaltySnapshot] = await Promise.all([
    buildContactFinancialSnapshot({
      clinicId: context.clinic.id,
      contactId: contact.id
    }),
    listInvoicesByContactId(context.clinic.id, contact.id),
    listPaymentsByContactId(context.clinic.id, contact.id),
    getLoyaltyContactSnapshotByClinicId(context.clinic.id, contact.id)
  ]);

  const [paidByInvoiceId, allocatedByPaymentId] = await Promise.all([
    sumRecordedAllocatedAmountsByInvoiceIds(
      context.clinic.id,
      documents.map((document) => document.id).filter(Boolean)
    ),
    sumRecordedAllocatedAmountsByPaymentIds(
      context.clinic.id,
      payments.map((payment) => payment.id).filter(Boolean)
    )
  ]);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    contact: {
      ...normalizeContact(contact),
      financialSnapshot,
      loyalty: loyaltySnapshot,
      relatedDocuments: documents.map((document) => normalizeRelatedDocument(document, paidByInvoiceId[document.id] || 0)),
      relatedPayments: payments.map((payment) => normalizeRelatedPayment(payment, allocatedByPaymentId[payment.id] || 0))
    }
  };
}

async function updatePortalContact(tenantId, contactId, payload) {
  const safeContactId = String(contactId || '').trim();
  if (!safeContactId) {
    return {
      ok: false,
      tenantId: String(tenantId || '').trim() || null,
      reason: 'missing_contact_id'
    };
  }

  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const name = String(payload && payload.name ? payload.name : '').trim();
  if (!name) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      reason: 'missing_contact_name'
    };
  }

  const email = normalizeNullableText(payload && payload.email);
  if (!isValidEmail(email)) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      reason: 'invalid_contact_email'
    };
  }

  const existingContact = await findPortalContactById(context.clinic.id, safeContactId);
  if (!existingContact) {
    return {
      ok: false,
      tenantId: context.tenantId,
      clinic: context.clinic,
      reason: 'contact_not_found'
    };
  }

  const updatedContact = await updatePortalContactById(context.clinic.id, safeContactId, {
    name,
    email,
    phone: normalizeNullableText(payload && payload.phone),
    whatsappPhone: normalizeNullableText(payload && payload.whatsappPhone),
    taxId: normalizeNullableText(payload && payload.taxId),
    taxCondition: normalizeNullableText(payload && payload.taxCondition),
    companyName: normalizeNullableText(payload && payload.companyName),
    notes: normalizeNullableText(payload && payload.notes)
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    contact: normalizeContact(updatedContact || existingContact)
  };
}

module.exports = {
  listPortalContacts,
  createPortalContactRecord,
  getPortalContactDetail,
  updatePortalContact
};
