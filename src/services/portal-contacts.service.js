const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  createContact,
  updateContact,
  findContactByIdentity,
  findContactByIdAndClinicId,
  listContactsByClinicId
} = require('../repositories/contact.repository');
const { listInvoicesByContactId } = require('../repositories/invoices.repository');
const { listPaymentsByContactId } = require('../repositories/payments.repository');
const { buildContactFinancialSnapshot, buildContactFinancialSignalsByContactIds } = require('./contact-financial-snapshot.service');
const { sumRecordedAllocatedAmountsByInvoiceIds, sumRecordedAllocatedAmountsByPaymentIds } = require('../repositories/payment-allocations.repository');
const { calculateInvoiceReceivable, calculatePaymentAllocationSnapshot } = require('./invoice-balance.service');
const { getLoyaltyContactSnapshotByClinicId } = require('./portal-loyalty.service');

const CONTACT_STATUSES = new Set(['active', 'archived']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeContact(row) {
  const displayName =
    row.name ||
    row.fullName ||
    row.companyName ||
    row.email ||
    row.phone ||
    row.whatsappPhone ||
    row.waId ||
    'Contacto';

  return {
    id: row.id,
    clinicId: row.clinicId,
    waId: row.waId || null,
    phone: row.phone || null,
    whatsappPhone: row.whatsappPhone || row.phone || null,
    email: row.email || null,
    name: displayName,
    fullName: row.fullName || row.name || row.companyName || displayName,
    taxId: row.taxId || null,
    taxCondition: row.taxCondition || null,
    companyName: row.companyName || null,
    notes: row.notes || null,
    metadata: normalizeMetadata(row.metadata),
    status: row.status || 'active',
    optedOut: row.optedOut === true,
    lastInteractionAt: row.lastInteractionAt || row.updatedAt || null,
    conversationCount: Number(row.conversationCount || 0),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
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

function buildContactPayload(payload) {
  const requestedStatus = normalizeString(payload && payload.status).toLowerCase();

  return {
    waId: normalizeString(payload && payload.waId) || null,
    phone: normalizeString(payload && payload.phone) || null,
    whatsappPhone: normalizeString(payload && payload.whatsappPhone) || normalizeString(payload && payload.phone) || null,
    email: normalizeString(payload && payload.email) || null,
    name: normalizeString(payload && (payload.fullName || payload.name)),
    taxId: normalizeString(payload && (payload.taxId || payload.documentNumber)) || null,
    taxCondition: normalizeString(payload && payload.taxCondition) || null,
    companyName: normalizeString(payload && payload.companyName) || null,
    notes: normalizeString(payload && payload.notes) || null,
    metadata: normalizeMetadata(payload && payload.metadata),
    status: CONTACT_STATUSES.has(requestedStatus) ? requestedStatus : 'active'
  };
}

function hasValidEmail(email) {
  const safeEmail = normalizeString(email);
  return !safeEmail || safeEmail.includes('@');
}

async function listPortalContacts(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const contacts = await listContactsByClinicId(context.clinic.id);
  const signalsByContactId = await buildContactFinancialSignalsByContactIds({
    clinicId: context.clinic.id,
    contactIds: contacts.map((contact) => contact.id)
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    contacts: contacts.map((contact) => ({
      ...normalizeContact(contact),
      financialSignal: signalsByContactId[contact.id] || {
        outstandingAmount: 0,
        unallocatedPayments: 0,
        status: 'settled'
      }
    }))
  };
}

async function getPortalContactDetail(tenantId, contactId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeContactId = normalizeString(contactId);
  if (!safeContactId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_contact_id' };
  }

  const contact = await findContactByIdAndClinicId(safeContactId, context.clinic.id);
  if (!contact) {
    return { ok: false, tenantId: context.tenantId, reason: 'contact_not_found' };
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

async function createPortalContact(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const contact = buildContactPayload(payload);
  if (!contact.name && !contact.companyName) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_contact_name' };
  }
  if (!hasValidEmail(contact.email)) {
    return { ok: false, tenantId: context.tenantId, reason: 'invalid_contact_email' };
  }

  const existing = await findContactByIdentity({
    clinicId: context.clinic.id,
    waId: contact.waId,
    email: contact.email,
    taxId: contact.taxId,
    phone: contact.phone,
    whatsappPhone: contact.whatsappPhone
  });
  if (existing) {
    return {
      ok: false,
      tenantId: context.tenantId,
      reason: 'duplicate_contact_identity'
    };
  }

  try {
    const created = await withTransaction((client) =>
      createContact(
        {
          clinicId: context.clinic.id,
          name: contact.name || contact.companyName,
          ...contact
        },
        client
      )
    );

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      contact: normalizeContact(created)
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return {
        ok: false,
        tenantId: context.tenantId,
        reason: 'duplicate_contact_identity'
      };
    }
    throw error;
  }
}

async function updatePortalContact(tenantId, contactId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeContactId = normalizeString(contactId);
  if (!safeContactId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_contact_id' };
  }

  const existingContact = await findContactByIdAndClinicId(safeContactId, context.clinic.id);
  if (!existingContact) {
    return { ok: false, tenantId: context.tenantId, reason: 'contact_not_found' };
  }

  const contact = buildContactPayload({
    ...existingContact,
    ...(payload || {})
  });

  if (!contact.name && !contact.companyName) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_contact_name' };
  }
  if (!hasValidEmail(contact.email)) {
    return { ok: false, tenantId: context.tenantId, reason: 'invalid_contact_email' };
  }

  const duplicate = await findContactByIdentity({
    clinicId: context.clinic.id,
    waId: contact.waId,
    email: contact.email,
    taxId: contact.taxId,
    phone: contact.phone,
    whatsappPhone: contact.whatsappPhone,
    excludeContactId: existingContact.id
  });
  if (duplicate) {
    return {
      ok: false,
      tenantId: context.tenantId,
      reason: 'duplicate_contact_identity'
    };
  }

  const updated = await withTransaction((client) =>
    updateContact(
      existingContact.id,
      context.clinic.id,
      {
        ...contact,
        name: contact.name || contact.companyName
      },
      client
    )
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    contact: {
      ...normalizeContact(updated),
      financialSnapshot: await buildContactFinancialSnapshot({
        clinicId: context.clinic.id,
        contactId: updated.id
      })
    }
  };
}

module.exports = {
  listPortalContacts,
  getPortalContactDetail,
  createPortalContact,
  updatePortalContact
};
