const { quantizeDecimal } = require('../utils/money');
const { listInvoicesByClinicId, listInvoicesByContactId } = require('../repositories/invoices.repository');
const { listPaymentsByClinicId, listPaymentsByContactId } = require('../repositories/payments.repository');
const {
  sumRecordedAllocatedAmountsByInvoiceIds,
  sumRecordedAllocatedAmountsByPaymentIds
} = require('../repositories/payment-allocations.repository');
const {
  normalizeInvoiceDocumentImpact,
  calculateInvoiceReceivable,
  calculatePaymentAllocationSnapshot
} = require('./invoice-balance.service');

function emptySnapshot() {
  return {
    totalInvoiced: 0,
    totalCredited: 0,
    totalDocumentBalance: 0,
    totalPaid: 0,
    outstandingAmount: 0,
    unallocatedPayments: 0
  };
}

function emptySignal() {
  return {
    outstandingAmount: 0,
    unallocatedPayments: 0,
    status: 'settled'
  };
}

function deriveSignal(snapshot) {
  const outstandingAmount = quantizeDecimal(snapshot && snapshot.outstandingAmount, 2, 0);
  const unallocatedPayments = quantizeDecimal(snapshot && snapshot.unallocatedPayments, 2, 0);

  if (outstandingAmount > 0) {
    return {
      outstandingAmount,
      unallocatedPayments,
      status: 'has_debt'
    };
  }

  if (unallocatedPayments > 0) {
    return {
      outstandingAmount,
      unallocatedPayments,
      status: 'unallocated_payment'
    };
  }

  return {
    outstandingAmount,
    unallocatedPayments,
    status: 'settled'
  };
}

async function buildContactFinancialSnapshot({ clinicId, contactId }) {
  if (!clinicId || !contactId) {
    return emptySnapshot();
  }

  const [invoices, payments] = await Promise.all([
    listInvoicesByContactId(clinicId, contactId),
    listPaymentsByContactId(clinicId, contactId)
  ]);

  if (!invoices.length && !payments.length) {
    return emptySnapshot();
  }

  const invoiceIds = invoices.map((invoice) => invoice.id).filter(Boolean);
  const paymentIds = payments.map((payment) => payment.id).filter(Boolean);

  const [paidByInvoiceId, allocatedByPaymentId] = await Promise.all([
    sumRecordedAllocatedAmountsByInvoiceIds(clinicId, invoiceIds),
    sumRecordedAllocatedAmountsByPaymentIds(clinicId, paymentIds)
  ]);

  const invoiceTotals = invoices.reduce(
    (acc, invoice) => {
      const impact = normalizeInvoiceDocumentImpact(invoice);
      const amount = Math.abs(Number(impact.amount || 0));
      const paidAmount = paidByInvoiceId[invoice.id] || 0;
      const receivable = calculateInvoiceReceivable({ invoice, paidAmount });
      const type = String(invoice.type || '').trim().toLowerCase();

      if (impact.affectsOperationalBalance && type === 'invoice') {
        acc.totalInvoiced = quantizeDecimal(acc.totalInvoiced + amount, 2, 0);
      }
      if (impact.affectsOperationalBalance && type === 'credit_note') {
        acc.totalCredited = quantizeDecimal(acc.totalCredited + amount, 2, 0);
      }

      acc.totalDocumentBalance = quantizeDecimal(
        acc.totalDocumentBalance + Number(impact.amount || 0),
        2,
        0
      );
      acc.totalPaid = quantizeDecimal(acc.totalPaid + Number(receivable.paidAmount || 0), 2, 0);
      acc.outstandingAmount = quantizeDecimal(
        acc.outstandingAmount + Number(receivable.outstandingAmount || 0),
        2,
        0
      );

      return acc;
    },
    emptySnapshot()
  );

  const unallocatedPayments = payments.reduce((sum, payment) => {
    const allocationSnapshot = calculatePaymentAllocationSnapshot({
      payment,
      allocatedAmount: allocatedByPaymentId[payment.id] || 0
    });
    return quantizeDecimal(sum + Number(allocationSnapshot.unallocatedAmount || 0), 2, 0);
  }, 0);

  return {
    ...invoiceTotals,
    unallocatedPayments
  };
}

async function buildContactFinancialSignalsByContactIds({ clinicId, contactIds }) {
  const ids = Array.isArray(contactIds) ? contactIds.filter(Boolean) : [];
  if (!clinicId || !ids.length) {
    return {};
  }

  const [invoices, payments] = await Promise.all([
    listInvoicesByClinicId(clinicId),
    listPaymentsByClinicId(clinicId)
  ]);

  const scopedInvoices = invoices.filter((invoice) => invoice.contactId && ids.includes(invoice.contactId));
  const scopedPayments = payments.filter((payment) => payment.contactId && ids.includes(payment.contactId));

  const [paidByInvoiceId, allocatedByPaymentId] = await Promise.all([
    sumRecordedAllocatedAmountsByInvoiceIds(clinicId, scopedInvoices.map((invoice) => invoice.id)),
    sumRecordedAllocatedAmountsByPaymentIds(clinicId, scopedPayments.map((payment) => payment.id))
  ]);

  const snapshots = ids.reduce((acc, id) => {
    acc[id] = emptySnapshot();
    return acc;
  }, {});

  for (const invoice of scopedInvoices) {
    const contactId = invoice.contactId;
    if (!contactId || !snapshots[contactId]) continue;

    const impact = normalizeInvoiceDocumentImpact(invoice);
    const amount = Math.abs(Number(impact.amount || 0));
    const paidAmount = paidByInvoiceId[invoice.id] || 0;
    const receivable = calculateInvoiceReceivable({ invoice, paidAmount });
    const type = String(invoice.type || '').trim().toLowerCase();

    if (impact.affectsOperationalBalance && type === 'invoice') {
      snapshots[contactId].totalInvoiced = quantizeDecimal(snapshots[contactId].totalInvoiced + amount, 2, 0);
    }
    if (impact.affectsOperationalBalance && type === 'credit_note') {
      snapshots[contactId].totalCredited = quantizeDecimal(snapshots[contactId].totalCredited + amount, 2, 0);
    }

    snapshots[contactId].totalDocumentBalance = quantizeDecimal(
      snapshots[contactId].totalDocumentBalance + Number(impact.amount || 0),
      2,
      0
    );
    snapshots[contactId].totalPaid = quantizeDecimal(
      snapshots[contactId].totalPaid + Number(receivable.paidAmount || 0),
      2,
      0
    );
    snapshots[contactId].outstandingAmount = quantizeDecimal(
      snapshots[contactId].outstandingAmount + Number(receivable.outstandingAmount || 0),
      2,
      0
    );
  }

  for (const payment of scopedPayments) {
    const contactId = payment.contactId;
    if (!contactId || !snapshots[contactId]) continue;

    const allocationSnapshot = calculatePaymentAllocationSnapshot({
      payment,
      allocatedAmount: allocatedByPaymentId[payment.id] || 0
    });

    snapshots[contactId].unallocatedPayments = quantizeDecimal(
      snapshots[contactId].unallocatedPayments + Number(allocationSnapshot.unallocatedAmount || 0),
      2,
      0
    );
  }

  return ids.reduce((acc, id) => {
    acc[id] = deriveSignal(snapshots[id] || emptySnapshot());
    return acc;
  }, {});
}

module.exports = {
  buildContactFinancialSnapshot,
  buildContactFinancialSignalsByContactIds
};
