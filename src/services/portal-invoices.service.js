const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const { findContactByIdAndClinicId } = require('../repositories/contact.repository');
const { findOrderById } = require('../repositories/orders.repository');
const { findProductById } = require('../repositories/products.repository');
const {
  listInvoicesByClinicId,
  findInvoiceById,
  listInvoicesByParentInvoiceId,
  createInvoice,
  updateInvoice,
  updateInvoiceAccounting,
  voidInvoice,
  issueInvoice
} = require('../repositories/invoices.repository');
const { getClinicBusinessProfileById } = require('../repositories/tenant.repository');
const { createPayment } = require('../repositories/payments.repository');
const {
  createPaymentAllocation,
  listAllocationsByInvoiceId,
  sumRecordedAllocatedAmountsByInvoiceIds
} = require('../repositories/payment-allocations.repository');
const { calculateLineAmounts, quantizeDecimal, sumQuantized } = require('../utils/money');
const { calculateInvoiceReceivable } = require('./invoice-balance.service');

const INVOICE_STATUSES = new Set(['draft', 'issued', 'void']);
const INVOICE_TYPES = new Set(['invoice', 'credit_note']);
const DOCUMENT_MODES = new Set(['internal_only', 'external_provider', 'synced_external']);
const INITIAL_PAYMENT_STATUSES = new Set(['unpaid', 'partial', 'paid']);
const INITIAL_PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'card', 'other', 'combined']);
const PREFACT_DOCUMENT_KINDS = new Set(['internal_invoice', 'proforma', 'order_summary']);
const PREFACT_FISCAL_STATUSES = new Set(['draft', 'ready_for_accountant', 'delivered_to_accountant', 'invoiced_by_accountant']);
const TAX_ID_TYPES = new Set(['DNI', 'CUIT', 'CUIL', 'NONE']);
const SUGGESTED_VOUCHER_TYPES = new Set(['A', 'B', 'C', 'NONE']);
const NO_FISCAL_LEGEND = 'Documento interno no valido como factura fiscal';

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeCurrency(value, fallback = 'ARS') {
  return normalizeString(value || fallback).toUpperCase() || fallback;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeString(value);
  return allowed.has(normalized) ? normalized : fallback;
}

function inferTaxIdType(value) {
  const digits = normalizeString(value).replace(/\D/g, '');
  if (digits.length === 11) return 'CUIT';
  if (digits.length >= 7 && digits.length <= 8) return 'DNI';
  return 'NONE';
}

function mapLegacyDocumentKindToVoucherType(rawDocumentKind) {
  const normalized = normalizeString(rawDocumentKind).toLowerCase();
  if (normalized === 'invoice_a') return 'A';
  if (normalized === 'invoice_b') return 'B';
  if (normalized === 'invoice_c') return 'C';
  return 'NONE';
}

function buildIssuerSnapshot(clinic, businessProfile, invoice = {}) {
  const profile = businessProfile && typeof businessProfile === 'object' ? businessProfile : {};
  return {
    issuerLegalName: normalizeString(invoice.issuerLegalName || profile.legalName || profile.issuerLegalName || clinic?.name) || null,
    issuerTaxId: normalizeString(invoice.issuerTaxId || profile.taxId || profile.issuerTaxId) || null,
    issuerTaxIdType: normalizeEnum(invoice.issuerTaxIdType || profile.taxIdType, TAX_ID_TYPES, inferTaxIdType(invoice.issuerTaxId || profile.taxId)),
    issuerVatCondition: normalizeString(invoice.issuerVatCondition || profile.vatCondition || profile.issuerVatCondition) || null,
    issuerGrossIncomeNumber: normalizeString(invoice.issuerGrossIncomeNumber || profile.grossIncomeNumber) || null,
    issuerFiscalAddress: normalizeString(invoice.issuerFiscalAddress || profile.fiscalAddress || profile.address) || null,
    issuerCity: normalizeString(invoice.issuerCity || profile.city) || null,
    issuerProvince: normalizeString(invoice.issuerProvince || profile.province) || null,
    pointOfSaleSuggested: normalizeString(invoice.pointOfSaleSuggested || profile.pointOfSaleSuggested) || null,
    defaultSuggestedFiscalVoucherType: normalizeEnum(profile.defaultSuggestedFiscalVoucherType, SUGGESTED_VOUCHER_TYPES, 'NONE'),
    accountantName: normalizeString(profile.accountantName) || null,
    accountantEmail: normalizeString(profile.accountantEmail) || null
  };
}

function buildCustomerSnapshot(contact, invoice = {}) {
  const legalName =
    normalizeString(invoice.customerLegalName) ||
    normalizeString(contact?.companyName) ||
    normalizeString(contact?.name) ||
    null;
  const taxId = normalizeString(invoice.customerTaxId || contact?.taxId) || null;
  const taxIdType = normalizeEnum(
    invoice.customerTaxIdType || inferTaxIdType(taxId),
    TAX_ID_TYPES,
    taxId ? inferTaxIdType(taxId) : 'NONE'
  );

  return {
    customerLegalName: legalName,
    customerTaxId: taxId,
    customerTaxIdType: taxIdType,
    customerVatCondition: normalizeString(invoice.customerVatCondition || contact?.taxCondition) || null
  };
}

function buildAccountingSnapshot({ clinic, businessProfile, contact, invoice = {}, payload = {} }) {
  const metadata = normalizeMetadata(payload.metadata !== undefined ? payload.metadata : invoice.metadata);
  const issuer = buildIssuerSnapshot(clinic, businessProfile, invoice);
  const customer = buildCustomerSnapshot(contact, invoice);
  const rawDocumentKind = payload.documentKind || invoice.documentKind || metadata.documentKind;
  const documentKind = normalizeEnum(
    rawDocumentKind === 'invoice_a' || rawDocumentKind === 'invoice_b' || rawDocumentKind === 'invoice_c' || rawDocumentKind === 'delivery_note'
      ? (normalizeString(rawDocumentKind).toLowerCase() === 'delivery_note' ? 'order_summary' : 'internal_invoice')
      : rawDocumentKind,
    PREFACT_DOCUMENT_KINDS,
    invoice.documentKind || 'internal_invoice'
  );
  const suggestedVoucherFromPayload =
    payload.suggestedFiscalVoucherType ||
    invoice.suggestedFiscalVoucherType ||
    mapLegacyDocumentKindToVoucherType(rawDocumentKind);
  const normalizedSuggestedVoucher = normalizeEnum(suggestedVoucherFromPayload, SUGGESTED_VOUCHER_TYPES, 'NONE');
  const fallbackSuggestedVoucher = normalizeEnum(issuer.defaultSuggestedFiscalVoucherType, SUGGESTED_VOUCHER_TYPES, 'NONE');

  return {
    documentKind,
    fiscalStatus: normalizeEnum(payload.fiscalStatus || invoice.fiscalStatus, PREFACT_FISCAL_STATUSES, invoice.fiscalStatus || 'draft'),
    customerTaxId: normalizeString(payload.customerTaxId ?? customer.customerTaxId) || null,
    customerTaxIdType: normalizeEnum(payload.customerTaxIdType || customer.customerTaxIdType, TAX_ID_TYPES, customer.customerTaxIdType || 'NONE'),
    customerLegalName: normalizeString(payload.customerLegalName ?? customer.customerLegalName) || null,
    customerVatCondition: normalizeString(payload.customerVatCondition ?? customer.customerVatCondition) || null,
    issuerLegalName: normalizeString(payload.issuerLegalName ?? issuer.issuerLegalName) || null,
    issuerTaxId: normalizeString(payload.issuerTaxId ?? issuer.issuerTaxId) || null,
    issuerTaxIdType: normalizeEnum(payload.issuerTaxIdType || issuer.issuerTaxIdType, TAX_ID_TYPES, issuer.issuerTaxIdType || 'NONE'),
    issuerVatCondition: normalizeString(payload.issuerVatCondition ?? issuer.issuerVatCondition) || null,
    issuerGrossIncomeNumber: normalizeString(payload.issuerGrossIncomeNumber ?? issuer.issuerGrossIncomeNumber) || null,
    issuerFiscalAddress: normalizeString(payload.issuerFiscalAddress ?? issuer.issuerFiscalAddress) || null,
    issuerCity: normalizeString(payload.issuerCity ?? issuer.issuerCity) || null,
    issuerProvince: normalizeString(payload.issuerProvince ?? issuer.issuerProvince) || null,
    pointOfSaleSuggested: normalizeString(payload.pointOfSaleSuggested ?? issuer.pointOfSaleSuggested) || null,
    suggestedFiscalVoucherType:
      normalizedSuggestedVoucher && normalizedSuggestedVoucher !== 'NONE'
        ? normalizedSuggestedVoucher
        : fallbackSuggestedVoucher,
    accountantNotes: normalizeString(payload.accountantNotes ?? invoice.accountantNotes) || null,
    deliveredToAccountantAt: payload.deliveredToAccountantAt ?? invoice.deliveredToAccountantAt ?? null,
    invoicedByAccountantAt: payload.invoicedByAccountantAt ?? invoice.invoicedByAccountantAt ?? null,
    accountantReferenceNumber: normalizeString(payload.accountantReferenceNumber ?? invoice.accountantReferenceNumber) || null
  };
}

function buildInvoiceMissingDataFlags(invoice) {
  const flags = [];
  if (!normalizeString(invoice.customerTaxId)) flags.push('missing_customer_tax_id');
  if (!normalizeString(invoice.customerVatCondition)) flags.push('missing_customer_vat_condition');
  if (!normalizeString(invoice.customerLegalName)) flags.push('missing_customer_legal_name');
  if (!normalizeString(invoice.issuerLegalName)) flags.push('missing_issuer_legal_name');
  if (!normalizeString(invoice.issuerTaxId)) flags.push('missing_issuer_tax_id');
  if (!normalizeString(invoice.issuerVatCondition)) flags.push('missing_issuer_vat_condition');
  if (!normalizeString(invoice.pointOfSaleSuggested)) flags.push('missing_point_of_sale');
  if (!normalizeString(invoice.suggestedFiscalVoucherType) || normalizeString(invoice.suggestedFiscalVoucherType) === 'NONE') {
    flags.push('missing_suggested_voucher_type');
  }
  return flags;
}

function applyFiscalStatusTimestamps(snapshot, previousInvoice) {
  const nextSnapshot = { ...snapshot };
  if (nextSnapshot.fiscalStatus === 'draft' || nextSnapshot.fiscalStatus === 'ready_for_accountant') {
    nextSnapshot.deliveredToAccountantAt = null;
    nextSnapshot.invoicedByAccountantAt = null;
  } else if (nextSnapshot.fiscalStatus === 'delivered_to_accountant') {
    nextSnapshot.deliveredToAccountantAt = previousInvoice?.deliveredToAccountantAt || new Date().toISOString();
    nextSnapshot.invoicedByAccountantAt = null;
  } else if (nextSnapshot.fiscalStatus === 'invoiced_by_accountant') {
    nextSnapshot.deliveredToAccountantAt = previousInvoice?.deliveredToAccountantAt || new Date().toISOString();
    nextSnapshot.invoicedByAccountantAt = previousInvoice?.invoicedByAccountantAt || new Date().toISOString();
  }
  return nextSnapshot;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateLabel(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

function formatMoneyLabel(amount, currency) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: normalizeCurrency(currency, 'ARS'),
    maximumFractionDigits: 2
  }).format(Number.isFinite(Number(amount)) ? Number(amount) : 0);
}

function buildInvoiceDocumentFilename(invoice) {
  return `${invoice.internalDocumentNumber || invoice.invoiceNumber || invoice.id}.html`;
}

function buildInvoiceCsvFilename() {
  const stamp = new Date().toISOString().slice(0, 10);
  return `opturon-prefacturacion-${stamp}.csv`;
}

function buildInvoiceBundleFilename() {
  const stamp = new Date().toISOString().slice(0, 10);
  return `opturon-comprobantes-lote-${stamp}.html`;
}

function buildInvoiceDownloadFilename(invoice, format = 'json') {
  const baseName = invoice.internalDocumentNumber || invoice.invoiceNumber || invoice.id;
  const extension = normalizeString(format).toLowerCase() === 'document' ? 'html' : 'json';
  return `${baseName}.${extension}`;
}

function formatDateTimeLabel(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatInvoiceFlagLabel(flag) {
  const normalized = normalizeString(flag);
  const labels = {
    missing_customer_tax_id: 'Falta CUIT/DNI cliente',
    missing_customer_vat_condition: 'Falta condicion IVA cliente',
    missing_customer_legal_name: 'Falta razon social cliente',
    missing_issuer_legal_name: 'Falta razon social emisor',
    missing_issuer_tax_id: 'Falta CUIT emisor',
    missing_issuer_vat_condition: 'Falta condicion IVA emisor',
    missing_point_of_sale: 'Falta punto de venta',
    missing_suggested_voucher_type: 'Falta tipo sugerido'
  };
  return labels[normalized] || normalized;
}

function formatInvoiceReceivableStatusLabel(value) {
  const normalized = normalizeString(value);
  if (normalized === 'paid') return 'Cobrado';
  if (normalized === 'partial') return 'Parcial';
  if (normalized === 'pending') return 'Pendiente';
  if (normalized === 'overdue') return 'Vencido';
  return normalized || '-';
}

function formatInvoiceFiscalStatusLabel(value) {
  const normalized = normalizeString(value);
  if (normalized === 'draft') return 'Borrador';
  if (normalized === 'ready_for_accountant') return 'Listo para contador';
  if (normalized === 'delivered_to_accountant') return 'Entregado al contador';
  if (normalized === 'invoiced_by_accountant') return 'Facturado por contador';
  return normalized || '-';
}

function formatInvoiceDocumentKindLabel(value) {
  const normalized = normalizeString(value);
  if (normalized === 'internal_invoice') return 'Comprobante interno';
  if (normalized === 'proforma') return 'Proforma';
  if (normalized === 'order_summary') return 'Resumen de pedido';
  return normalized || '-';
}

function buildInvoiceDocumentContent(invoice, clinic) {
  const businessProfile = clinic?.businessProfile && typeof clinic.businessProfile === 'object' ? clinic.businessProfile : {};
  const issueDate = invoice.issuedAt || invoice.createdAt;
  const rows = Array.isArray(invoice.items)
    ? invoice.items.map((item) => `
      <tr>
        <td>${escapeHtml(item.descriptionSnapshot)}</td>
        <td style="text-align:right">${escapeHtml(item.quantity)}</td>
        <td style="text-align:right">${escapeHtml(formatMoneyLabel(item.unitPrice, invoice.currency))}</td>
        <td style="text-align:right">${escapeHtml(formatMoneyLabel(item.totalAmount, invoice.currency))}</td>
      </tr>`).join('')
    : '';

  return `
    <div class="banner">${escapeHtml(NO_FISCAL_LEGEND)}</div>
    <div class="top">
      <div class="card">
        <h2>Emisor</h2>
        <h1>${escapeHtml(invoice.issuerLegalName || clinic?.name || 'Opturon')}</h1>
        <div class="muted">CUIT/DNI: ${escapeHtml(invoice.issuerTaxId || '-')}</div>
        <div class="muted">Tipo ID: ${escapeHtml(invoice.issuerTaxIdType || 'NONE')}</div>
        <div class="muted">Condicion IVA: ${escapeHtml(invoice.issuerVatCondition || '-')}</div>
        <div class="muted">IIBB: ${escapeHtml(invoice.issuerGrossIncomeNumber || '-')}</div>
        <div class="muted">Direccion fiscal: ${escapeHtml(invoice.issuerFiscalAddress || businessProfile.address || '-')}</div>
        <div class="muted">Ciudad / Provincia: ${escapeHtml([invoice.issuerCity, invoice.issuerProvince].filter(Boolean).join(' / ') || '-')}</div>
      </div>
      <div class="card">
        <h2>Documento interno</h2>
        <h1>${escapeHtml(invoice.internalDocumentNumber || invoice.id)}</h1>
        <div class="muted">Tipo: ${escapeHtml(invoice.documentKind)}</div>
        <div class="muted">Estado contable: ${escapeHtml(invoice.fiscalStatus)}</div>
        <div class="muted">Fecha: ${escapeHtml(formatDateLabel(issueDate))}</div>
        <div class="muted">Punto de venta sugerido: ${escapeHtml(invoice.pointOfSaleSuggested || '-')}</div>
      </div>
    </div>
    <div class="top">
      <div class="card">
        <h2>Cliente</h2>
        <div>${escapeHtml(invoice.customerLegalName || invoice.contact?.name || 'Consumidor final')}</div>
        <div class="muted">Identificacion: ${escapeHtml(invoice.customerTaxId || '-')} (${escapeHtml(invoice.customerTaxIdType || 'NONE')})</div>
        <div class="muted">Condicion IVA: ${escapeHtml(invoice.customerVatCondition || '-')}</div>
      </div>
      <div class="card">
        <h2>Referencia contable</h2>
        <div class="muted">Comprobante sugerido: ${escapeHtml(invoice.suggestedFiscalVoucherType || 'NONE')}</div>
        <div class="muted">Estado de cobro: ${escapeHtml(invoice.receivableStatus || '-')}</div>
        <div class="muted">Ref. contador: ${escapeHtml(invoice.accountantReferenceNumber || '-')}</div>
        <div class="muted">Entregado al contador: ${escapeHtml(formatDateLabel(invoice.deliveredToAccountantAt))}</div>
        <div class="muted">Facturado por contador: ${escapeHtml(formatDateLabel(invoice.invoicedByAccountantAt))}</div>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Detalle</th>
          <th style="text-align:right">Cantidad</th>
          <th style="text-align:right">Unitario</th>
          <th style="text-align:right">Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div><span>Subtotal</span><strong>${escapeHtml(formatMoneyLabel(invoice.subtotalAmount, invoice.currency))}</strong></div>
      <div><span>Impuestos</span><strong>${escapeHtml(formatMoneyLabel(invoice.taxAmount, invoice.currency))}</strong></div>
      <div><span>Total</span><strong>${escapeHtml(formatMoneyLabel(invoice.totalAmount, invoice.currency))}</strong></div>
    </div>
    <div class="notes">
      <h2>Notas para contador</h2>
      <div>${escapeHtml(invoice.accountantNotes || 'Sin observaciones')}</div>
    </div>
  `;
}

function buildInvoiceDocumentHtml(invoice, clinic) {
  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(invoice.internalDocumentNumber || invoice.id)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; color: #16202a; }
      .banner { border: 1px solid #d97706; background: #fff7ed; color: #9a3412; padding: 12px 16px; border-radius: 12px; font-weight: 700; margin-bottom: 20px; }
      .top { display:flex; justify-content:space-between; gap:24px; margin-bottom:24px; }
      .card { border:1px solid #e5e7eb; border-radius:16px; padding:16px; flex:1; }
      h1 { margin:0 0 8px; font-size:24px; }
      h2 { margin:0 0 8px; font-size:14px; text-transform:uppercase; color:#64748b; letter-spacing:.08em; }
      table { width:100%; border-collapse:collapse; margin-top:20px; }
      th, td { border-bottom:1px solid #e5e7eb; padding:12px 8px; text-align:left; }
      th { font-size:12px; text-transform:uppercase; color:#64748b; letter-spacing:.08em; }
      .totals { margin-top:24px; width:320px; margin-left:auto; }
      .totals div { display:flex; justify-content:space-between; padding:6px 0; }
      .muted { color:#64748b; }
      .notes { margin-top:24px; border:1px solid #e5e7eb; border-radius:16px; padding:16px; }
    </style>
  </head>
  <body>${buildInvoiceDocumentContent(invoice, clinic)}</body>
</html>`;
}

function buildInvoicesBundleHtml(invoices, clinic) {
  const sections = (Array.isArray(invoices) ? invoices : [])
    .map(
      (invoice, index) => `
      <section class="document-sheet">
        <div class="sheet-index">Comprobante ${index + 1} de ${invoices.length}</div>
        ${buildInvoiceDocumentContent(invoice, clinic)}
      </section>`
    )
    .join('');

  const summary = (Array.isArray(invoices) ? invoices : [])
    .map(
      (invoice) => `
        <tr>
          <td>${escapeHtml(invoice.internalDocumentNumber || invoice.invoiceNumber || invoice.id)}</td>
          <td>${escapeHtml(invoice.customerLegalName || invoice.contact?.name || 'Sin cliente')}</td>
          <td>${escapeHtml(formatDateLabel(invoice.issuedAt || invoice.createdAt))}</td>
          <td style="text-align:right">${escapeHtml(formatMoneyLabel(invoice.totalAmount, invoice.currency))}</td>
          <td>${escapeHtml(formatInvoiceFiscalStatusLabel(invoice.fiscalStatus))}</td>
        </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>Lote de comprobantes internos</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; color: #16202a; background: #f8fafc; }
      .bundle-shell { max-width: 1180px; margin: 0 auto; }
      .bundle-cover { background: white; border: 1px solid #e5e7eb; border-radius: 18px; padding: 24px; margin-bottom: 24px; }
      .bundle-cover h1 { margin: 0 0 8px; font-size: 28px; }
      .bundle-cover p { margin: 0; color: #475569; }
      .bundle-summary { width: 100%; border-collapse: collapse; margin-top: 20px; }
      .bundle-summary th, .bundle-summary td { border-bottom: 1px solid #e5e7eb; padding: 10px 8px; text-align: left; }
      .bundle-summary th { font-size: 12px; text-transform: uppercase; color: #64748b; letter-spacing: .08em; }
      .document-sheet { background: white; border: 1px solid #e5e7eb; border-radius: 18px; padding: 24px; margin-bottom: 20px; page-break-after: always; }
      .document-sheet:last-child { page-break-after: auto; }
      .sheet-index { display: inline-block; margin-bottom: 12px; padding: 6px 10px; border-radius: 999px; background: #e2e8f0; color: #334155; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
      .banner { border: 1px solid #d97706; background: #fff7ed; color: #9a3412; padding: 12px 16px; border-radius: 12px; font-weight: 700; margin-bottom: 20px; }
      .top { display:flex; justify-content:space-between; gap:24px; margin-bottom:24px; }
      .card { border:1px solid #e5e7eb; border-radius:16px; padding:16px; flex:1; }
      h2 { margin:0 0 8px; font-size:14px; text-transform:uppercase; color:#64748b; letter-spacing:.08em; }
      h1 { margin:0 0 8px; font-size:24px; }
      table { width:100%; border-collapse:collapse; margin-top:20px; }
      th, td { border-bottom:1px solid #e5e7eb; padding:12px 8px; text-align:left; }
      th { font-size:12px; text-transform:uppercase; color:#64748b; letter-spacing:.08em; }
      .totals { margin-top:24px; width:320px; margin-left:auto; }
      .totals div { display:flex; justify-content:space-between; padding:6px 0; }
      .muted { color:#64748b; }
      .notes { margin-top:24px; border:1px solid #e5e7eb; border-radius:16px; padding:16px; }
    </style>
  </head>
  <body>
    <div class="bundle-shell">
      <section class="bundle-cover">
        <h1>Lote de comprobantes internos</h1>
        <p>Pre-facturacion contable lista para revision y entrega al contador.</p>
        <p style="margin-top: 6px;">Documentos incluidos: ${escapeHtml(invoices.length)}</p>
        <table class="bundle-summary">
          <thead>
            <tr>
              <th>Comprobante</th>
              <th>Cliente</th>
              <th>Fecha</th>
              <th style="text-align:right">Total</th>
              <th>Estado contable</th>
            </tr>
          </thead>
          <tbody>${summary}</tbody>
        </table>
      </section>
      ${sections}
    </div>
  </body>
</html>`;
}

function filterInvoicesForAccountant(invoices, filters = {}) {
  const fiscalStatus = normalizeString(filters.fiscalStatus);
  const contactId = normalizeString(filters.contactId);
  const search = normalizeString(filters.search).toLowerCase();
  const documentKind = normalizeString(filters.documentKind);
  const deliveredFilter = normalizeString(filters.deliveredFilter).toLowerCase();
  const incompleteOnly = ['1', 'true', 'yes'].includes(normalizeString(filters.incompleteOnly).toLowerCase());
  const dateFrom = normalizeString(filters.dateFrom);
  const dateTo = normalizeString(filters.dateTo);

  return (Array.isArray(invoices) ? invoices : []).filter((invoice) => {
    if (fiscalStatus && fiscalStatus !== 'all' && invoice.fiscalStatus !== fiscalStatus) return false;
    if (contactId && contactId !== 'all' && invoice.contactId !== contactId) return false;
    if (documentKind && documentKind !== 'all' && invoice.documentKind !== documentKind) return false;
    if (deliveredFilter === 'delivered' && !invoice.deliveredToAccountantAt) return false;
    if (deliveredFilter === 'pending' && invoice.deliveredToAccountantAt) return false;
    if (incompleteOnly && (!Array.isArray(invoice.missingDataFlags) || invoice.missingDataFlags.length === 0)) return false;
    const referenceDate = invoice.issuedAt || invoice.createdAt;
    if (dateFrom && referenceDate && new Date(referenceDate) < new Date(`${dateFrom}T00:00:00.000Z`)) return false;
    if (dateTo && referenceDate && new Date(referenceDate) > new Date(`${dateTo}T23:59:59.999Z`)) return false;
    if (!search) return true;
    const haystack = [
      invoice.internalDocumentNumber,
      invoice.invoiceNumber,
      invoice.customerLegalName,
      invoice.customerTaxId,
      invoice.contact?.name,
      invoice.fiscalStatus
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(search);
  });
}

function buildInvoicesCsv(invoices) {
  const header = [
    'Fecha',
    'Comprobante interno',
    'Numero interno',
    'Cliente',
    'CUIT/DNI',
    'Condicion IVA cliente',
    'Emisor',
    'CUIT emisor',
    'Tipo documento',
    'Tipo sugerido',
    'Subtotal',
    'Total',
    'Estado pago',
    'Estado contable',
    'Entregado a contador',
    'Facturado por contador',
    'Referencia contador',
    'Notas contador',
    'Faltantes detectados'
  ];

  const formatCsvAmount = (value) => quantizeDecimal(value || 0, 2, 0).toFixed(2).replace('.', ',');
  const rows = invoices.map((invoice) => [
    formatDateLabel(invoice.issuedAt || invoice.createdAt),
    invoice.internalDocumentNumber || '',
    invoice.invoiceNumber || '',
    invoice.customerLegalName || invoice.contact?.name || '',
    invoice.customerTaxId || '',
    invoice.customerVatCondition || '',
    invoice.issuerLegalName || '',
    invoice.issuerTaxId || '',
    formatInvoiceDocumentKindLabel(invoice.documentKind),
    normalizeString(invoice.suggestedFiscalVoucherType) || '-',
    formatCsvAmount(invoice.subtotalAmount || 0),
    formatCsvAmount(invoice.totalAmount || 0),
    formatInvoiceReceivableStatusLabel(invoice.receivableStatus),
    formatInvoiceFiscalStatusLabel(invoice.fiscalStatus),
    formatDateTimeLabel(invoice.deliveredToAccountantAt),
    formatDateTimeLabel(invoice.invoicedByAccountantAt),
    invoice.accountantReferenceNumber || '',
    (invoice.accountantNotes || '').replace(/\r?\n/g, ' '),
    (Array.isArray(invoice.missingDataFlags) ? invoice.missingDataFlags : []).map(formatInvoiceFlagLabel).join(' | ')
  ]);

  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(';'))
    .join('\n');
  return `\uFEFFsep=;\n${csv}`;
}

function normalizeInitialPaymentMethod(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'combined') {
    return 'other';
  }
  if (INITIAL_PAYMENT_METHODS.has(normalized)) {
    return normalized;
  }
  return 'bank_transfer';
}

function buildError(tenantId, reason, details) {
  return {
    ok: false,
    tenantId,
    reason,
    details: details || null
  };
}

function normalizeInvoiceItemInput(item, fallbackCurrency, type) {
  const quantity = quantizeDecimal(item && item.quantity, 3, NaN);
  const baseUnitPrice = quantizeDecimal(item && item.unitPrice, 2, NaN);
  const taxRate = quantizeDecimal((item && item.taxRate) ?? 0, 2, NaN);
  const signedUnitPrice = type === 'credit_note' ? quantizeDecimal(-Math.abs(baseUnitPrice), 2, NaN) : baseUnitPrice;
  const lineAmounts = calculateLineAmounts({ unitPrice: signedUnitPrice, quantity, taxRate, quantityScale: 3 });
  const subtotalAmount = quantizeDecimal((item && item.subtotalAmount) ?? (lineAmounts && lineAmounts.subtotalAmount), 2, NaN);
  const totalAmount = quantizeDecimal((item && item.totalAmount) ?? (lineAmounts && lineAmounts.totalAmount), 2, NaN);

  return {
    productId: normalizeString(item && item.productId) || null,
    descriptionSnapshot: normalizeString(item && item.descriptionSnapshot),
    quantity,
    unitPrice: signedUnitPrice,
    taxRate,
    subtotalAmount,
    totalAmount,
    currency: normalizeCurrency(item && item.currency, fallbackCurrency)
  };
}

async function resolveScopedInvoice(invoiceId, clinicId) {
  const safeInvoiceId = normalizeString(invoiceId);
  if (!safeInvoiceId) return null;
  return findInvoiceById(safeInvoiceId, clinicId);
}

async function resolveInvoiceAssociations({ clinicId, contactId, orderId, parentInvoiceId, tenantId }) {
  let contact = null;
  let order = null;
  let parentInvoice = null;

  if (contactId) {
    contact = await findContactByIdAndClinicId(contactId, clinicId);
    if (!contact) {
      return buildError(tenantId, 'contact_not_found');
    }
  }

  if (orderId) {
    order = await findOrderById(orderId, clinicId);
    if (!order) {
      return buildError(tenantId, 'order_not_found');
    }
    if (contactId && order.contactId && order.contactId !== contactId) {
      return buildError(tenantId, 'invoice_order_contact_scope_mismatch');
    }
    if (!contact && order.contactId) {
      contact = await findContactByIdAndClinicId(order.contactId, clinicId);
    }
  }

  if (parentInvoiceId) {
    parentInvoice = await findInvoiceById(parentInvoiceId, clinicId);
    if (!parentInvoice) {
      return buildError(tenantId, 'parent_invoice_not_found');
    }
  }

  return {
    ok: true,
    contact,
    order,
    parentInvoice
  };
}

function buildInvoiceLifecycleView(invoice) {
  return {
    canEdit: invoice.status === 'draft',
    canIssue: invoice.status === 'draft',
    canVoid: invoice.status === 'draft' || invoice.status === 'issued',
    internalStatus: invoice.status,
    providerStatus: invoice.providerStatus || null,
    documentMode: invoice.documentMode
  };
}

function enrichInvoiceView(invoice) {
  const receivable = calculateInvoiceReceivable({
    invoice,
    paidAmount: invoice && invoice.paidAmount ? invoice.paidAmount : 0
  });
  const missingDataFlags = buildInvoiceMissingDataFlags(invoice);

  return {
    ...invoice,
    lifecycle: buildInvoiceLifecycleView(invoice),
    noFiscal: true,
    noFiscalLegend: NO_FISCAL_LEGEND,
    missingDataFlags,
    accountingComplete: missingDataFlags.length === 0,
    balanceImpact: receivable.documentBalanceImpact,
    paidAmount: receivable.paidAmount,
    outstandingAmount: receivable.outstandingAmount,
    receivableStatus: receivable.receivableStatus
  };
}

async function attachReceivables(clinicId, invoices) {
  const items = Array.isArray(invoices) ? invoices : [];
  const invoiceIds = items.map((invoice) => invoice.id).filter(Boolean);
  const paidByInvoiceId = await sumRecordedAllocatedAmountsByInvoiceIds(clinicId, invoiceIds);

  return items.map((invoice) => ({
    ...invoice,
    paidAmount: paidByInvoiceId[invoice.id] || 0
  }));
}

function validateInvoiceMode(payload) {
  const documentMode = DOCUMENT_MODES.has(normalizeString(payload.documentMode).toLowerCase())
    ? normalizeString(payload.documentMode).toLowerCase()
    : 'internal_only';

  if (documentMode === 'internal_only' && (payload.externalProvider || payload.externalReference || payload.providerStatus)) {
    return null;
  }

  return documentMode;
}

function buildInvoicePayload(payload = {}, fallback = {}) {
  const requestedType = normalizeString(payload.type || fallback.type).toLowerCase();
  const type = INVOICE_TYPES.has(requestedType) ? requestedType : 'invoice';
  const requestedStatus = normalizeString(payload.status || fallback.status).toLowerCase();
  const status = INVOICE_STATUSES.has(requestedStatus) ? requestedStatus : 'draft';
  const requestedDocumentMode = normalizeString(payload.documentMode || fallback.documentMode).toLowerCase();
  const documentMode = DOCUMENT_MODES.has(requestedDocumentMode)
    ? requestedDocumentMode
    : fallback.documentMode || 'internal_only';

  return {
    contactId: normalizeString(payload.contactId ?? fallback.contactId) || null,
    orderId: normalizeString(payload.orderId ?? fallback.orderId) || null,
    parentInvoiceId: normalizeString(payload.parentInvoiceId ?? fallback.parentInvoiceId) || null,
    invoiceNumber: normalizeString(payload.invoiceNumber ?? fallback.invoiceNumber) || null,
    type,
    status,
    documentMode,
    providerStatus: normalizeString(payload.providerStatus ?? fallback.providerStatus) || null,
    currency: normalizeCurrency(payload.currency ?? fallback.currency, 'ARS'),
    issuedAt: payload.issuedAt !== undefined ? payload.issuedAt : fallback.issuedAt || null,
    dueAt: payload.dueAt !== undefined ? payload.dueAt : fallback.dueAt || null,
    externalProvider: normalizeString(payload.externalProvider ?? fallback.externalProvider) || null,
    externalReference: normalizeString(payload.externalReference ?? fallback.externalReference) || null,
    metadata: normalizeMetadata(payload.metadata !== undefined ? payload.metadata : fallback.metadata)
  };
}

function normalizeInitialPaymentPlan(invoice, metadata) {
  const rawPlan = metadata && typeof metadata === 'object' ? metadata.initialPaymentPlan : null;
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    return null;
  }

  const status = normalizeString(rawPlan.status).toLowerCase();
  if (!INITIAL_PAYMENT_STATUSES.has(status) || status === 'unpaid') {
    return null;
  }

  const invoiceTotal = quantizeDecimal(invoice && invoice.totalAmount, 2, 0);
  const absoluteTotal = Math.abs(invoiceTotal);
  if (!(absoluteTotal > 0) || invoice.type !== 'invoice') {
    return null;
  }

  const requestedAmount =
    status === 'paid'
      ? absoluteTotal
      : quantizeDecimal(rawPlan.amount, 2, NaN);

  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount > absoluteTotal) {
    return null;
  }

  return {
    status,
    amount: requestedAmount,
    method: normalizeInitialPaymentMethod(rawPlan.method),
    notes: normalizeString(rawPlan.notes) || null
  };
}

function validateLifecycleRules({ currentInvoice = null, nextPayload, isVoidAction = false, isIssueAction = false }) {
  if (!currentInvoice) {
    return null;
  }

  if (isVoidAction) {
    if (currentInvoice.status === 'void') return 'invoice_already_void';
    return null;
  }

  if (isIssueAction) {
    if (currentInvoice.status === 'issued') return 'invoice_already_issued';
    if (currentInvoice.status === 'void') return 'void_invoice_cannot_be_issued';
    if (currentInvoice.status !== 'draft') return 'invoice_not_issuable_in_current_status';
    return null;
  }

  if (currentInvoice.status !== 'draft') {
    return 'invoice_not_editable_in_current_status';
  }

  const requestedStatus = normalizeString(nextPayload && nextPayload.status).toLowerCase();
  if (requestedStatus === 'void') {
    return 'invoice_void_requires_dedicated_action';
  }
  if (requestedStatus === 'issued') {
    return 'invoice_issue_requires_dedicated_action';
  }

  return null;
}

async function buildInvoiceItems({ clinicId, tenantId, payloadItems, fallbackOrder, currency, type }) {
  let items;
  if (Array.isArray(payloadItems) && payloadItems.length > 0) {
    items = [];
    for (const rawItem of payloadItems) {
      const item = normalizeInvoiceItemInput(rawItem, currency, type);
      if (
        !item.descriptionSnapshot ||
        !Number.isFinite(item.quantity) ||
        item.quantity <= 0 ||
        !Number.isFinite(item.unitPrice) ||
        !Number.isFinite(item.taxRate) ||
        item.taxRate < 0
      ) {
        return buildError(tenantId, 'invalid_invoice_item');
      }

      if (type === 'invoice' && item.unitPrice < 0) {
        return buildError(tenantId, 'invalid_invoice_item');
      }
      if (type === 'credit_note' && item.unitPrice > 0) {
        return buildError(tenantId, 'invalid_credit_note_item');
      }

      if (item.productId) {
        const product = await findProductById(item.productId, clinicId);
        if (!product) {
          return buildError(tenantId, 'invoice_item_product_not_found');
        }
      }

      items.push({
        productId: item.productId,
        descriptionSnapshot: item.descriptionSnapshot,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxRate: item.taxRate,
        subtotalAmount: item.subtotalAmount,
        totalAmount: item.totalAmount
      });
    }
  } else if (fallbackOrder) {
    items = (fallbackOrder.items || []).map((item) => {
      const quantity = quantizeDecimal(item.quantity || 0, 3, 0);
      const baseUnitPrice = quantizeDecimal(item.unitPrice || item.priceSnapshot || 0, 2, 0);
      const unitPrice = type === 'credit_note' ? quantizeDecimal(-Math.abs(baseUnitPrice), 2, 0) : baseUnitPrice;
      const taxRate = quantizeDecimal(item.taxRate || 0, 2, 0);
      const amounts = calculateLineAmounts({ unitPrice, quantity, taxRate, quantityScale: 3 });

      return {
        productId: item.productId || null,
        descriptionSnapshot: item.descriptionSnapshot || item.nameSnapshot,
        quantity,
        unitPrice,
        taxRate,
        subtotalAmount: amounts.subtotalAmount,
        totalAmount: amounts.totalAmount
      };
    });
  } else {
    return buildError(tenantId, 'missing_invoice_items');
  }

  return {
    ok: true,
    items
  };
}

function validateInvoiceStructure({ payload, items, order, parentInvoice, tenantId }) {
  const subtotalAmount = sumQuantized(items.map((item) => item.subtotalAmount), 2);
  const totalAmount = sumQuantized(items.map((item) => item.totalAmount), 2);
  const taxAmount = quantizeDecimal(totalAmount - subtotalAmount, 2, 0);

  if (payload.type === 'invoice' && (subtotalAmount < 0 || taxAmount < 0 || totalAmount < 0)) {
    return buildError(tenantId, 'invalid_invoice_amount_sign');
  }

  if (payload.type === 'credit_note') {
    if (!payload.parentInvoiceId) {
      return buildError(tenantId, 'credit_note_requires_parent_invoice');
    }
    if (!parentInvoice) {
      return buildError(tenantId, 'parent_invoice_not_found');
    }
    if (parentInvoice.type !== 'invoice') {
      return buildError(tenantId, 'credit_note_parent_invalid');
    }
    if (subtotalAmount > 0 || taxAmount > 0 || totalAmount > 0) {
      return buildError(tenantId, 'credit_note_amount_sign_invalid');
    }
  }

  if (payload.type === 'invoice' && payload.parentInvoiceId) {
    return buildError(tenantId, 'invoice_cannot_have_parent_invoice');
  }

  if (order) {
    const orderSubtotal = quantizeDecimal(order.subtotalAmount || 0, 2, 0);
    const orderTax = quantizeDecimal(order.taxAmount || 0, 2, 0);
    const orderTotal = quantizeDecimal(order.totalAmount || 0, 2, 0);
    if (payload.type === 'invoice' && (orderSubtotal !== subtotalAmount || orderTax !== taxAmount || orderTotal !== totalAmount)) {
      return buildError(tenantId, 'invoice_order_amount_mismatch');
    }
  }

  return {
    ok: true,
    subtotalAmount,
    taxAmount,
    totalAmount
  };
}

async function validateInvoiceForIssue({ invoice, tenantId }) {
  const associationResult = await resolveInvoiceAssociations({
    clinicId: invoice.clinicId,
    contactId: invoice.contactId,
    orderId: invoice.orderId,
    parentInvoiceId: invoice.parentInvoiceId,
    tenantId
  });
  if (!associationResult.ok) return associationResult;

  const items = Array.isArray(invoice.items) ? invoice.items : [];
  if (!items.length) {
    return buildError(tenantId, 'missing_invoice_items');
  }

  const structureResult = validateInvoiceStructure({
    payload: invoice,
    items,
    order: associationResult.order,
    parentInvoice: associationResult.parentInvoice,
    tenantId
  });
  if (!structureResult.ok) return structureResult;

  return {
    ok: true,
    associationResult,
    structureResult
  };
}

async function listPortalInvoices(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const invoices = await listInvoicesByClinicId(context.clinic.id);
  const withReceivables = await attachReceivables(context.clinic.id, invoices);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    invoices: withReceivables.map(enrichInvoiceView)
  };
}

async function getPortalInvoiceDetail(tenantId, invoiceId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const invoice = await resolveScopedInvoice(invoiceId, context.clinic.id);
  if (!invoice) {
    return { ok: false, tenantId: context.tenantId, reason: 'invoice_not_found' };
  }
  const paidByInvoiceId = await sumRecordedAllocatedAmountsByInvoiceIds(context.clinic.id, [invoice.id]);
  const allocations = await listAllocationsByInvoiceId(invoice.id, context.clinic.id);
  const relatedCreditNotesRaw =
    invoice.type === 'invoice'
      ? await listInvoicesByParentInvoiceId(invoice.id, context.clinic.id)
      : [];
  const relatedCreditNotesWithReceivables =
    relatedCreditNotesRaw.length > 0
      ? await attachReceivables(context.clinic.id, relatedCreditNotesRaw)
      : [];
  const relatedCreditNotes = relatedCreditNotesWithReceivables.map(enrichInvoiceView);
  const withReceivable = {
    ...invoice,
    paidAmount: paidByInvoiceId[invoice.id] || 0
  };

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    invoice: {
      ...enrichInvoiceView(withReceivable),
      allocations,
      relatedCreditNotes
    }
  };
}

async function listPortalInvoiceAllocations(tenantId, invoiceId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeInvoiceId = normalizeString(invoiceId);
  if (!safeInvoiceId) {
    return buildError(context.tenantId, 'missing_invoice_id');
  }

  const invoice = await resolveScopedInvoice(safeInvoiceId, context.clinic.id);
  if (!invoice) {
    return buildError(context.tenantId, 'invoice_not_found');
  }

  const allocations = await listAllocationsByInvoiceId(invoice.id, context.clinic.id);
  const paidByInvoiceId = await sumRecordedAllocatedAmountsByInvoiceIds(context.clinic.id, [invoice.id]);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    invoice: enrichInvoiceView({
      ...invoice,
      paidAmount: paidByInvoiceId[invoice.id] || 0
    }),
    allocations
  };
}

async function createPortalInvoice(tenantId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }
  const clinicRecord = await getClinicBusinessProfileById(context.clinic.id);

  const requestedStatus = normalizeString(payload && payload.status).toLowerCase();
  const allowImmediateIssue = requestedStatus === 'issued';
  const invoicePayload = buildInvoicePayload(
    {
      ...(payload || {}),
      status: 'draft'
    }
  );
  const mode = validateInvoiceMode(invoicePayload);
  if (!mode) {
    return buildError(context.tenantId, 'invalid_invoice_document_mode');
  }
  invoicePayload.documentMode = mode;

  const associationResult = await resolveInvoiceAssociations({
    clinicId: context.clinic.id,
    contactId: invoicePayload.contactId,
    orderId: invoicePayload.orderId,
    parentInvoiceId: invoicePayload.parentInvoiceId,
    tenantId: context.tenantId
  });
  if (!associationResult.ok) return associationResult;

  const itemsResult = await buildInvoiceItems({
    clinicId: context.clinic.id,
    tenantId: context.tenantId,
    payloadItems: payload && payload.items,
    fallbackOrder: associationResult.order,
    currency: invoicePayload.currency,
    type: invoicePayload.type
  });
  if (!itemsResult.ok) return itemsResult;

  const structureResult = validateInvoiceStructure({
    payload: invoicePayload,
    items: itemsResult.items,
    order: associationResult.order,
    parentInvoice: associationResult.parentInvoice,
    tenantId: context.tenantId
  });
  if (!structureResult.ok) return structureResult;
  const accountingSnapshot = applyFiscalStatusTimestamps(
    buildAccountingSnapshot({
      clinic: clinicRecord || context.clinic,
      businessProfile: clinicRecord?.businessProfile,
      contact: associationResult.contact,
      payload: payload || {}
    }),
    null
  );

  try {
    const invoice = await withTransaction(async (client) => {
      const created = await createInvoice(
        {
          clinicId: context.clinic.id,
          contactId: associationResult.contact ? associationResult.contact.id : null,
          orderId: associationResult.order ? associationResult.order.id : null,
          parentInvoiceId: associationResult.parentInvoice ? associationResult.parentInvoice.id : null,
          invoiceNumber: invoicePayload.invoiceNumber,
          type: invoicePayload.type,
          status: 'draft',
          documentMode: invoicePayload.documentMode,
          providerStatus: invoicePayload.providerStatus,
          currency: associationResult.order ? associationResult.order.currency : invoicePayload.currency,
          subtotalAmount: structureResult.subtotalAmount,
          taxAmount: structureResult.taxAmount,
          totalAmount: structureResult.totalAmount,
          issuedAt: null,
          dueAt: invoicePayload.dueAt,
          externalProvider: invoicePayload.externalProvider,
          externalReference: invoicePayload.externalReference,
          documentKind: accountingSnapshot.documentKind,
          fiscalStatus: accountingSnapshot.fiscalStatus,
          customerTaxId: accountingSnapshot.customerTaxId,
          customerTaxIdType: accountingSnapshot.customerTaxIdType,
          customerLegalName: accountingSnapshot.customerLegalName,
          customerVatCondition: accountingSnapshot.customerVatCondition,
          issuerLegalName: accountingSnapshot.issuerLegalName,
          issuerTaxId: accountingSnapshot.issuerTaxId,
          issuerTaxIdType: accountingSnapshot.issuerTaxIdType,
          issuerVatCondition: accountingSnapshot.issuerVatCondition,
          issuerGrossIncomeNumber: accountingSnapshot.issuerGrossIncomeNumber,
          issuerFiscalAddress: accountingSnapshot.issuerFiscalAddress,
          issuerCity: accountingSnapshot.issuerCity,
          issuerProvince: accountingSnapshot.issuerProvince,
          pointOfSaleSuggested: accountingSnapshot.pointOfSaleSuggested,
          suggestedFiscalVoucherType: accountingSnapshot.suggestedFiscalVoucherType,
          accountantNotes: accountingSnapshot.accountantNotes,
          deliveredToAccountantAt: accountingSnapshot.deliveredToAccountantAt,
          invoicedByAccountantAt: accountingSnapshot.invoicedByAccountantAt,
          accountantReferenceNumber: accountingSnapshot.accountantReferenceNumber,
          metadata: invoicePayload.metadata,
          items: itemsResult.items
        },
        client
      );

      if (!allowImmediateIssue) {
        return created;
      }

      const issueMetadata = {
        ...normalizeMetadata(created.metadata),
        issueFlow: {
          mode: 'create_and_issue_compat',
          at: new Date().toISOString()
        }
      };

      return issueInvoice(
        created.id,
        context.clinic.id,
        {
          issuedAt: payload && payload.issuedAt ? payload.issuedAt : new Date().toISOString(),
          providerStatus: created.providerStatus || null,
          metadata: issueMetadata
        },
        client
      );
    });

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      invoice: enrichInvoiceView(invoice)
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return buildError(context.tenantId, 'duplicate_invoice_number');
    }
    throw error;
  }
}

async function updatePortalInvoice(tenantId, invoiceId, payload) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;
  const clinicRecord = await getClinicBusinessProfileById(context.clinic.id);

  const currentInvoice = await resolveScopedInvoice(invoiceId, context.clinic.id);
  if (!currentInvoice) {
    return buildError(context.tenantId, 'invoice_not_found');
  }

  const lifecycleError = validateLifecycleRules({ currentInvoice, nextPayload: payload, isVoidAction: false });
  if (lifecycleError) {
    return buildError(context.tenantId, lifecycleError);
  }

  const invoicePayload = buildInvoicePayload(
    {
      ...(payload || {}),
      status: 'draft'
    },
    currentInvoice
  );
  const mode = validateInvoiceMode(invoicePayload);
  if (!mode) {
    return buildError(context.tenantId, 'invalid_invoice_document_mode');
  }
  invoicePayload.documentMode = mode;

  const associationResult = await resolveInvoiceAssociations({
    clinicId: context.clinic.id,
    contactId: invoicePayload.contactId,
    orderId: invoicePayload.orderId,
    parentInvoiceId: invoicePayload.parentInvoiceId,
    tenantId: context.tenantId
  });
  if (!associationResult.ok) return associationResult;

  const itemsResult = await buildInvoiceItems({
    clinicId: context.clinic.id,
    tenantId: context.tenantId,
    payloadItems: payload && payload.items,
    fallbackOrder: associationResult.order,
    currency: invoicePayload.currency,
    type: invoicePayload.type
  });
  if (!itemsResult.ok) return itemsResult;

  const structureResult = validateInvoiceStructure({
    payload: invoicePayload,
    items: itemsResult.items,
    order: associationResult.order,
    parentInvoice: associationResult.parentInvoice,
    tenantId: context.tenantId
  });
  if (!structureResult.ok) return structureResult;
  const accountingSnapshot = applyFiscalStatusTimestamps(
    buildAccountingSnapshot({
      clinic: clinicRecord || context.clinic,
      businessProfile: clinicRecord?.businessProfile,
      contact: associationResult.contact,
      invoice: currentInvoice,
      payload: payload || {}
    }),
    currentInvoice
  );

  try {
    const invoice = await withTransaction((client) =>
      updateInvoice(
        currentInvoice.id,
        context.clinic.id,
        {
          contactId: associationResult.contact ? associationResult.contact.id : null,
          orderId: associationResult.order ? associationResult.order.id : null,
          parentInvoiceId: associationResult.parentInvoice ? associationResult.parentInvoice.id : null,
          invoiceNumber: invoicePayload.invoiceNumber,
          type: invoicePayload.type,
          status: 'draft',
          documentMode: invoicePayload.documentMode,
          providerStatus: invoicePayload.providerStatus,
          currency: associationResult.order ? associationResult.order.currency : invoicePayload.currency,
          subtotalAmount: structureResult.subtotalAmount,
          taxAmount: structureResult.taxAmount,
          totalAmount: structureResult.totalAmount,
          issuedAt: currentInvoice.issuedAt,
          dueAt: invoicePayload.dueAt,
          externalProvider: invoicePayload.externalProvider,
          externalReference: invoicePayload.externalReference,
          documentKind: accountingSnapshot.documentKind,
          fiscalStatus: accountingSnapshot.fiscalStatus,
          customerTaxId: accountingSnapshot.customerTaxId,
          customerTaxIdType: accountingSnapshot.customerTaxIdType,
          customerLegalName: accountingSnapshot.customerLegalName,
          customerVatCondition: accountingSnapshot.customerVatCondition,
          issuerLegalName: accountingSnapshot.issuerLegalName,
          issuerTaxId: accountingSnapshot.issuerTaxId,
          issuerTaxIdType: accountingSnapshot.issuerTaxIdType,
          issuerVatCondition: accountingSnapshot.issuerVatCondition,
          issuerGrossIncomeNumber: accountingSnapshot.issuerGrossIncomeNumber,
          issuerFiscalAddress: accountingSnapshot.issuerFiscalAddress,
          issuerCity: accountingSnapshot.issuerCity,
          issuerProvince: accountingSnapshot.issuerProvince,
          pointOfSaleSuggested: accountingSnapshot.pointOfSaleSuggested,
          suggestedFiscalVoucherType: accountingSnapshot.suggestedFiscalVoucherType,
          accountantNotes: accountingSnapshot.accountantNotes,
          deliveredToAccountantAt: accountingSnapshot.deliveredToAccountantAt,
          invoicedByAccountantAt: accountingSnapshot.invoicedByAccountantAt,
          accountantReferenceNumber: accountingSnapshot.accountantReferenceNumber,
          metadata: invoicePayload.metadata,
          items: itemsResult.items
        },
        client
      )
    );

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      invoice: enrichInvoiceView(invoice)
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return buildError(context.tenantId, 'duplicate_invoice_number');
    }
    throw error;
  }
}

async function issuePortalInvoice(tenantId, invoiceId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const currentInvoice = await resolveScopedInvoice(invoiceId, context.clinic.id);
  if (!currentInvoice) {
    return buildError(context.tenantId, 'invoice_not_found');
  }

  const lifecycleError = validateLifecycleRules({ currentInvoice, nextPayload: payload, isIssueAction: true });
  if (lifecycleError) {
    return buildError(context.tenantId, lifecycleError);
  }

  const validationResult = await validateInvoiceForIssue({
    invoice: currentInvoice,
    tenantId: context.tenantId
  });
  if (!validationResult.ok) return validationResult;

  const nextProviderStatus = normalizeString(payload.providerStatus) || currentInvoice.providerStatus || null;
  const nextMetadata = {
    ...normalizeMetadata(currentInvoice.metadata),
    ...normalizeMetadata(payload.metadata),
    issueFlow: {
      mode: 'explicit_issue_action',
      at: new Date().toISOString()
    }
  };
  const initialPaymentPlan = normalizeInitialPaymentPlan(currentInvoice, nextMetadata);

  const invoice = await withTransaction(async (client) => {
    const issuedInvoice = await issueInvoice(
      currentInvoice.id,
      context.clinic.id,
      {
        issuedAt: payload.issuedAt || new Date().toISOString(),
        providerStatus: nextProviderStatus,
        metadata: nextMetadata
      },
      client
    );

    if (!initialPaymentPlan) {
      return issuedInvoice;
    }

    const createdPayment = await createPayment(
      {
        clinicId: context.clinic.id,
        contactId: issuedInvoice.contactId || null,
        invoiceId: issuedInvoice.id,
        amount: initialPaymentPlan.amount,
        currency: issuedInvoice.currency,
        method: initialPaymentPlan.method,
        status: 'recorded',
        paidAt: payload.issuedAt || issuedInvoice.issuedAt || new Date().toISOString(),
        externalReference: null,
        notes: initialPaymentPlan.notes,
        metadata: {
          source: 'invoice_initial_payment_plan',
          initialPaymentStatus: initialPaymentPlan.status
        }
      },
      client
    );

    await createPaymentAllocation(
      {
        clinicId: context.clinic.id,
        paymentId: createdPayment.id,
        invoiceId: issuedInvoice.id,
        amount: initialPaymentPlan.amount
      },
      client
    );

    return findInvoiceById(issuedInvoice.id, context.clinic.id, client);
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    invoice: enrichInvoiceView(invoice)
  };
}

async function updatePortalInvoiceAccounting(tenantId, invoiceId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const currentInvoice = await resolveScopedInvoice(invoiceId, context.clinic.id);
  if (!currentInvoice) {
    return buildError(context.tenantId, 'invoice_not_found');
  }

  const clinicRecord = await getClinicBusinessProfileById(context.clinic.id);
  const contact = currentInvoice.contactId
    ? await findContactByIdAndClinicId(currentInvoice.contactId, context.clinic.id)
    : null;
  const accountingSnapshot = applyFiscalStatusTimestamps(
    buildAccountingSnapshot({
      clinic: clinicRecord || context.clinic,
      businessProfile: clinicRecord?.businessProfile,
      contact,
      invoice: currentInvoice,
      payload
    }),
    currentInvoice
  );

  try {
    const updated = await withTransaction((client) =>
      updateInvoiceAccounting(currentInvoice.id, context.clinic.id, accountingSnapshot, client)
    );

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      invoice: enrichInvoiceView(updated)
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return buildError(context.tenantId, 'duplicate_internal_document_number');
    }
    throw error;
  }
}

async function updatePortalInvoicesBulkStatus(tenantId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const invoiceIds = Array.isArray(payload.invoiceIds)
    ? payload.invoiceIds.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  const fiscalStatus = normalizeEnum(payload.fiscalStatus, PREFACT_FISCAL_STATUSES, '');
  if (!invoiceIds.length) {
    return buildError(context.tenantId, 'missing_invoice_ids');
  }
  if (!fiscalStatus) {
    return buildError(context.tenantId, 'invalid_fiscal_status');
  }

  const clinicRecord = await getClinicBusinessProfileById(context.clinic.id);
  const updatedInvoices = await withTransaction(async (client) => {
    const updated = [];
    for (const invoiceId of invoiceIds) {
      const currentInvoice = await findInvoiceById(invoiceId, context.clinic.id, client);
      if (!currentInvoice) continue;
      const contact = currentInvoice.contactId
        ? await findContactByIdAndClinicId(currentInvoice.contactId, context.clinic.id)
        : null;
      const accountingSnapshot = applyFiscalStatusTimestamps(
        buildAccountingSnapshot({
          clinic: clinicRecord || context.clinic,
          businessProfile: clinicRecord?.businessProfile,
          contact,
          invoice: currentInvoice,
          payload: { fiscalStatus }
        }),
        currentInvoice
      );
      const nextInvoice = await updateInvoiceAccounting(currentInvoice.id, context.clinic.id, accountingSnapshot, client);
      if (nextInvoice) {
        const paidByInvoiceId = await sumRecordedAllocatedAmountsByInvoiceIds(context.clinic.id, [nextInvoice.id]);
        updated.push(enrichInvoiceView({ ...nextInvoice, paidAmount: paidByInvoiceId[nextInvoice.id] || 0 }));
      }
    }
    return updated;
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    fiscalStatus,
    updatedInvoices
  };
}

async function voidPortalInvoice(tenantId, invoiceId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const currentInvoice = await resolveScopedInvoice(invoiceId, context.clinic.id);
  if (!currentInvoice) {
    return buildError(context.tenantId, 'invoice_not_found');
  }

  const lifecycleError = validateLifecycleRules({ currentInvoice, nextPayload: payload, isVoidAction: true });
  if (lifecycleError) {
    return buildError(context.tenantId, lifecycleError);
  }

  const nextProviderStatus = normalizeString(payload.providerStatus) || currentInvoice.providerStatus || null;
  const nextMetadata = {
    ...normalizeMetadata(currentInvoice.metadata),
    ...normalizeMetadata(payload.metadata),
    voidedAt: new Date().toISOString(),
    voidReason: normalizeString(payload.reason) || null
  };

  const invoice = await withTransaction((client) =>
    voidInvoice(
      currentInvoice.id,
      context.clinic.id,
      {
        providerStatus: nextProviderStatus,
        metadata: nextMetadata
      },
      client
    )
  );

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    invoice: enrichInvoiceView(invoice)
  };
}

async function exportPortalInvoicesCsv(tenantId, filters = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const invoices = await listInvoicesByClinicId(context.clinic.id);
  const withReceivables = await attachReceivables(context.clinic.id, invoices);
  const enriched = withReceivables.map(enrichInvoiceView);
  const filtered = filterInvoicesForAccountant(enriched, filters);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    filename: buildInvoiceCsvFilename(),
    csv: buildInvoicesCsv(filtered),
    invoices: filtered
  };
}

async function downloadPortalInvoicesBundle(tenantId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const invoiceIds = Array.isArray(payload.invoiceIds)
    ? payload.invoiceIds.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  if (!invoiceIds.length) {
    return buildError(context.tenantId, 'missing_invoice_ids');
  }

  const clinicRecord = await getClinicBusinessProfileById(context.clinic.id);
  const invoices = [];

  for (const invoiceId of invoiceIds) {
    const detailResult = await getPortalInvoiceDetail(tenantId, invoiceId);
    if (detailResult.ok && detailResult.invoice) {
      invoices.push(detailResult.invoice);
    }
  }

  if (!invoices.length) {
    return buildError(context.tenantId, 'invoice_not_found');
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    invoices,
    filename: buildInvoiceBundleFilename(),
    contentType: 'text/html; charset=utf-8',
    body: buildInvoicesBundleHtml(invoices, clinicRecord || context.clinic)
  };
}

async function renderPortalInvoiceDocument(tenantId, invoiceId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const detailResult = await getPortalInvoiceDetail(tenantId, invoiceId);
  if (!detailResult.ok) return detailResult;
  const clinicRecord = await getClinicBusinessProfileById(context.clinic.id);
  const invoice = detailResult.invoice;

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    filename: buildInvoiceDocumentFilename(invoice),
    html: buildInvoiceDocumentHtml(invoice, clinicRecord || context.clinic),
    invoice
  };
}

async function downloadPortalInvoice(tenantId, invoiceId, format = 'json') {
  const safeFormat = normalizeString(format).toLowerCase() === 'document' ? 'document' : 'json';

  if (safeFormat === 'document') {
    const documentResult = await renderPortalInvoiceDocument(tenantId, invoiceId);
    if (!documentResult.ok) return documentResult;

    return {
      ...documentResult,
      filename: buildInvoiceDownloadFilename(documentResult.invoice, 'document'),
      contentType: 'text/html; charset=utf-8',
      body: documentResult.html
    };
  }

  const detailResult = await getPortalInvoiceDetail(tenantId, invoiceId);
  if (!detailResult.ok) return detailResult;

  return {
    ok: true,
    tenantId: detailResult.tenantId,
    clinic: detailResult.clinic,
    invoice: detailResult.invoice,
    filename: buildInvoiceDownloadFilename(detailResult.invoice, 'json'),
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(
      {
        tenantId: detailResult.tenantId,
        invoice: detailResult.invoice
      },
      null,
      2
    )
  };
}

module.exports = {
  INVOICE_STATUSES: Array.from(INVOICE_STATUSES),
  INVOICE_TYPES: Array.from(INVOICE_TYPES),
  DOCUMENT_MODES: Array.from(DOCUMENT_MODES),
  PREFACT_DOCUMENT_KINDS: Array.from(PREFACT_DOCUMENT_KINDS),
  PREFACT_FISCAL_STATUSES: Array.from(PREFACT_FISCAL_STATUSES),
  TAX_ID_TYPES: Array.from(TAX_ID_TYPES),
  SUGGESTED_VOUCHER_TYPES: Array.from(SUGGESTED_VOUCHER_TYPES),
  NO_FISCAL_LEGEND,
  listPortalInvoices,
  getPortalInvoiceDetail,
  listPortalInvoiceAllocations,
  createPortalInvoice,
  updatePortalInvoice,
  updatePortalInvoiceAccounting,
  updatePortalInvoicesBulkStatus,
  issuePortalInvoice,
  voidPortalInvoice,
  exportPortalInvoicesCsv,
  downloadPortalInvoicesBundle,
  renderPortalInvoiceDocument,
  downloadPortalInvoice
};
