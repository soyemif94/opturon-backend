const { quantizeDecimal } = require('../utils/money');

function normalizeInvoiceDocumentImpact(invoice) {
  if (!invoice || typeof invoice !== 'object') {
    return {
      affectsOperationalBalance: false,
      sign: 'none',
      amount: 0
    };
  }

  const status = String(invoice.status || '').trim().toLowerCase();
  const type = String(invoice.type || '').trim().toLowerCase();
  const totalAmount = quantizeDecimal(invoice.totalAmount || 0, 2, 0);

  if (status !== 'issued') {
    return {
      affectsOperationalBalance: false,
      sign: 'none',
      amount: 0
    };
  }

  if (type === 'credit_note') {
    return {
      affectsOperationalBalance: true,
      sign: 'negative',
      amount: totalAmount
    };
  }

  return {
    affectsOperationalBalance: true,
    sign: 'positive',
    amount: totalAmount
  };
}

function normalizePaymentImpact(payment) {
  if (!payment || typeof payment !== 'object') {
    return {
      affectsOutstanding: false,
      amount: 0
    };
  }

  const status = String(payment.status || '').trim().toLowerCase();
  if (status !== 'recorded') {
    return {
      affectsOutstanding: false,
      amount: 0
    };
  }

  return {
    affectsOutstanding: true,
    amount: quantizeDecimal(payment.amount || 0, 2, 0)
  };
}

function calculatePaymentAllocationSnapshot({ payment, allocatedAmount = 0 }) {
  const paymentImpact = normalizePaymentImpact(payment);
  const safeAllocatedAmount = quantizeDecimal(allocatedAmount || 0, 2, 0);

  if (!paymentImpact.affectsOutstanding) {
    return {
      paymentImpact,
      allocatedAmount: 0,
      unallocatedAmount: 0
    };
  }

  return {
    paymentImpact,
    allocatedAmount: safeAllocatedAmount,
    unallocatedAmount: quantizeDecimal(paymentImpact.amount - safeAllocatedAmount, 2, 0)
  };
}

function calculateReceivableStatus({ invoice, documentBalanceImpact, paidAmount, outstandingAmount }) {
  const safeOutstandingAmount = quantizeDecimal(outstandingAmount || 0, 2, 0);
  const safePaidAmount = quantizeDecimal(paidAmount || 0, 2, 0);
  const type = String((invoice && invoice.type) || '').trim().toLowerCase();

  if (!documentBalanceImpact.affectsOperationalBalance || type === 'credit_note') {
    return 'not_applicable';
  }

  if (safeOutstandingAmount < 0) {
    return 'overpaid';
  }

  if (safeOutstandingAmount === 0) {
    return 'paid';
  }

  if (safePaidAmount > 0) {
    return 'partially_paid';
  }

  return 'unpaid';
}

function calculateInvoiceReceivable({ invoice, paidAmount = 0 }) {
  const documentBalanceImpact = normalizeInvoiceDocumentImpact(invoice);
  const safePaidAmount = quantizeDecimal(paidAmount || 0, 2, 0);
  const type = String((invoice && invoice.type) || '').trim().toLowerCase();

  if (!documentBalanceImpact.affectsOperationalBalance || type === 'credit_note') {
    return {
      documentBalanceImpact,
      paidAmount: 0,
      outstandingAmount: 0,
      receivableStatus: 'not_applicable'
    };
  }

  const outstandingAmount = quantizeDecimal(documentBalanceImpact.amount - safePaidAmount, 2, 0);
  const receivableStatus = calculateReceivableStatus({
    invoice,
    documentBalanceImpact,
    paidAmount: safePaidAmount,
    outstandingAmount
  });

  return {
    documentBalanceImpact,
    paidAmount: safePaidAmount,
    outstandingAmount,
    receivableStatus
  };
}

module.exports = {
  normalizeInvoiceDocumentImpact,
  normalizePaymentImpact,
  calculatePaymentAllocationSnapshot,
  calculateReceivableStatus,
  calculateInvoiceReceivable
};
