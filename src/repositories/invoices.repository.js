const { query } = require('../db/client');
const { quantizeDecimal } = require('../utils/money');

function dbQuery(client, text, params) {
  if (client && typeof client.query === 'function') {
    return client.query(text, params);
  }
  return query(text, params);
}

function parseMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeInvoiceItem(item) {
  return {
    id: item.id,
    productId: item.productId || null,
    descriptionSnapshot: item.descriptionSnapshot,
    quantity: quantizeDecimal(item.quantity || 0, 3, 0),
    unitPrice: quantizeDecimal(item.unitPrice || 0, 2, 0),
    taxRate: quantizeDecimal(item.taxRate || 0, 2, 0),
    subtotalAmount: quantizeDecimal(item.subtotalAmount || 0, 2, 0),
    totalAmount: quantizeDecimal(item.totalAmount || 0, 2, 0),
    createdAt: item.createdAt || null
  };
}

function normalizeInvoice(row) {
  const items = Array.isArray(row.items) ? row.items.map(normalizeInvoiceItem) : [];

  return {
    id: row.id,
    clinicId: row.clinicId,
    contactId: row.contactId || null,
    orderId: row.orderId || null,
    parentInvoiceId: row.parentInvoiceId || null,
    invoiceNumber: row.invoiceNumber || null,
    internalDocumentNumber: row.internalDocumentNumber || null,
    type: row.type || 'invoice',
    status: row.status || 'draft',
    documentKind: row.documentKind || 'internal_invoice',
    fiscalStatus: row.fiscalStatus || 'draft',
    documentMode: row.documentMode || 'internal_only',
    providerStatus: row.providerStatus || null,
    currency: row.currency || 'ARS',
    subtotalAmount: quantizeDecimal(row.subtotalAmount || 0, 2, 0),
    taxAmount: quantizeDecimal(row.taxAmount || 0, 2, 0),
    totalAmount: quantizeDecimal(row.totalAmount || 0, 2, 0),
    issuedAt: row.issuedAt || null,
    dueAt: row.dueAt || null,
    externalProvider: row.externalProvider || null,
    externalReference: row.externalReference || null,
    customerTaxId: row.customerTaxId || null,
    customerTaxIdType: row.customerTaxIdType || 'NONE',
    customerLegalName: row.customerLegalName || null,
    customerVatCondition: row.customerVatCondition || null,
    issuerLegalName: row.issuerLegalName || null,
    issuerTaxId: row.issuerTaxId || null,
    issuerTaxIdType: row.issuerTaxIdType || 'NONE',
    issuerVatCondition: row.issuerVatCondition || null,
    issuerGrossIncomeNumber: row.issuerGrossIncomeNumber || null,
    issuerFiscalAddress: row.issuerFiscalAddress || null,
    issuerCity: row.issuerCity || null,
    issuerProvince: row.issuerProvince || null,
    pointOfSaleSuggested: row.pointOfSaleSuggested || null,
    suggestedFiscalVoucherType: row.suggestedFiscalVoucherType || 'NONE',
    accountantNotes: row.accountantNotes || null,
    deliveredToAccountantAt: row.deliveredToAccountantAt || null,
    invoicedByAccountantAt: row.invoicedByAccountantAt || null,
    accountantReferenceNumber: row.accountantReferenceNumber || null,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    contact: row.contactId
      ? {
          id: row.contactId,
          name: row.contactName || null,
          phone: row.contactPhone || null
        }
      : null,
    parentInvoice:
      row.parentInvoiceId
        ? {
            id: row.parentInvoiceId,
            invoiceNumber: row.parentInvoiceNumber || null,
            type: row.parentInvoiceType || null,
            status: row.parentInvoiceStatus || null,
            totalAmount: quantizeDecimal(row.parentInvoiceTotalAmount || 0, 2, 0)
          }
        : null,
    items
  };
}

function baseInvoiceSelect() {
  return `SELECT
       i.id,
       i."clinicId",
       i."contactId",
       i."orderId",
       i."parentInvoiceId",
       i."invoiceNumber",
       i."internalDocumentNumber",
       i.type,
       i.status,
       i."documentKind",
       i."fiscalStatus",
       i."documentMode",
       i."providerStatus",
       i.currency,
       i."subtotalAmount",
       i."taxAmount",
       i."totalAmount",
       i."issuedAt",
       i."dueAt",
       i."externalProvider",
       i."externalReference",
       i."customerTaxId",
       i."customerTaxIdType",
       i."customerLegalName",
       i."customerVatCondition",
       i."issuerLegalName",
       i."issuerTaxId",
       i."issuerTaxIdType",
       i."issuerVatCondition",
       i."issuerGrossIncomeNumber",
       i."issuerFiscalAddress",
       i."issuerCity",
       i."issuerProvince",
       i."pointOfSaleSuggested",
       i."suggestedFiscalVoucherType",
       i."accountantNotes",
       i."deliveredToAccountantAt",
       i."invoicedByAccountantAt",
       i."accountantReferenceNumber",
       i.metadata,
       i."createdAt",
       i."updatedAt",
       c.name AS "contactName",
       c.phone AS "contactPhone",
       parent."invoiceNumber" AS "parentInvoiceNumber",
       parent.type AS "parentInvoiceType",
       parent.status AS "parentInvoiceStatus",
       parent."totalAmount" AS "parentInvoiceTotalAmount",
       COALESCE(items.items, '[]'::json) AS items
     FROM invoices i
     LEFT JOIN contacts c ON c.id = i."contactId"
     LEFT JOIN invoices parent ON parent.id = i."parentInvoiceId"
     LEFT JOIN LATERAL (
       SELECT json_agg(
         json_build_object(
           'id', ii.id,
           'productId', ii."productId",
           'descriptionSnapshot', ii."descriptionSnapshot",
           'quantity', ii.quantity,
           'unitPrice', ii."unitPrice",
           'taxRate', ii."taxRate",
           'subtotalAmount', ii."subtotalAmount",
           'totalAmount', ii."totalAmount",
           'createdAt', ii."createdAt"
         )
         ORDER BY ii."createdAt" ASC
       ) AS items
       FROM invoice_items ii
       WHERE ii."invoiceId" = i.id
     ) items ON TRUE`;
}

async function listInvoicesByClinicId(clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${baseInvoiceSelect()}
     WHERE i."clinicId" = $1::uuid
     ORDER BY i."createdAt" DESC`,
    [clinicId]
  );

  return result.rows.map(normalizeInvoice);
}

async function listInvoicesByContactId(clinicId, contactId, client = null) {
  const result = await dbQuery(
    client,
    `${baseInvoiceSelect()}
     WHERE i."clinicId" = $1::uuid
       AND i."contactId" = $2::uuid
     ORDER BY i."createdAt" DESC`,
    [clinicId, contactId]
  );

  return result.rows.map(normalizeInvoice);
}

async function findInvoiceById(invoiceId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${baseInvoiceSelect()}
     WHERE i.id = $1::uuid
       AND i."clinicId" = $2::uuid
     LIMIT 1`,
    [invoiceId, clinicId]
  );

  return result.rows[0] ? normalizeInvoice(result.rows[0]) : null;
}

async function listInvoicesByParentInvoiceId(parentInvoiceId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${baseInvoiceSelect()}
     WHERE i."parentInvoiceId" = $1::uuid
       AND i."clinicId" = $2::uuid
     ORDER BY i."createdAt" DESC`,
    [parentInvoiceId, clinicId]
  );

  return result.rows.map(normalizeInvoice);
}

async function findInvoiceByOrderId(orderId, clinicId, client = null) {
  const result = await dbQuery(
    client,
    `${baseInvoiceSelect()}
     WHERE i."orderId" = $1::uuid
       AND i."clinicId" = $2::uuid
       AND i.type = 'invoice'
       AND i.status <> 'void'
     ORDER BY i."createdAt" DESC
     LIMIT 1`,
    [orderId, clinicId]
  );

  return result.rows[0] ? normalizeInvoice(result.rows[0]) : null;
}

async function lockInvoiceById(invoiceId, clinicId, client) {
  const result = await dbQuery(
    client,
    `SELECT id
     FROM invoices
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     FOR UPDATE`,
    [invoiceId, clinicId]
  );

  return Boolean(result.rows[0]);
}

async function createInvoice(input, client = null) {
  const subtotalAmount = quantizeDecimal(input.subtotalAmount || 0, 2, 0);
  const taxAmount = quantizeDecimal(input.taxAmount || 0, 2, 0);
  const totalAmount = quantizeDecimal(input.totalAmount || 0, 2, 0);
  const finalStatus = input.status || 'draft';
  const result = await dbQuery(
    client,
    `INSERT INTO invoices (
       "clinicId",
       "contactId",
       "orderId",
       "parentInvoiceId",
       "invoiceNumber",
       type,
       status,
       "documentKind",
       "fiscalStatus",
       "documentMode",
       "providerStatus",
       currency,
       "subtotalAmount",
       "taxAmount",
       "totalAmount",
       "issuedAt",
       "dueAt",
       "externalProvider",
       "externalReference",
       "customerTaxId",
       "customerTaxIdType",
       "customerLegalName",
       "customerVatCondition",
       "issuerLegalName",
       "issuerTaxId",
       "issuerTaxIdType",
       "issuerVatCondition",
       "issuerGrossIncomeNumber",
       "issuerFiscalAddress",
       "issuerCity",
       "issuerProvince",
       "pointOfSaleSuggested",
       "suggestedFiscalVoucherType",
       "accountantNotes",
       "deliveredToAccountantAt",
       "invoicedByAccountantAt",
       "accountantReferenceNumber",
       metadata,
       "updatedAt"
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38::jsonb, NOW())
     RETURNING id`,
    [
      input.clinicId,
      input.contactId || null,
      input.orderId || null,
      input.parentInvoiceId || null,
      input.invoiceNumber || null,
      input.type || 'invoice',
      'draft',
      input.documentKind || 'internal_invoice',
      input.fiscalStatus || 'draft',
      input.documentMode || 'internal_only',
      input.providerStatus || null,
      input.currency || 'ARS',
      subtotalAmount,
      taxAmount,
      totalAmount,
      input.issuedAt || null,
      input.dueAt || null,
      input.externalProvider || null,
      input.externalReference || null,
      input.customerTaxId || null,
      input.customerTaxIdType || 'NONE',
      input.customerLegalName || null,
      input.customerVatCondition || null,
      input.issuerLegalName || null,
      input.issuerTaxId || null,
      input.issuerTaxIdType || 'NONE',
      input.issuerVatCondition || null,
      input.issuerGrossIncomeNumber || null,
      input.issuerFiscalAddress || null,
      input.issuerCity || null,
      input.issuerProvince || null,
      input.pointOfSaleSuggested || null,
      input.suggestedFiscalVoucherType || 'NONE',
      input.accountantNotes || null,
      input.deliveredToAccountantAt || null,
      input.invoicedByAccountantAt || null,
      input.accountantReferenceNumber || null,
      JSON.stringify(input.metadata || {})
    ]
  );

  const invoiceId = result.rows[0].id;
  await dbQuery(
    client,
    `UPDATE invoices
     SET "internalDocumentNumber" = COALESCE(
       "internalDocumentNumber",
       'OPT-' || LPAD(nextval('opturon_internal_document_number_seq')::text, 8, '0')
     ),
         "updatedAt" = NOW()
     WHERE id = $1::uuid`,
    [invoiceId]
  );
  await replaceInvoiceItems(invoiceId, input.items || [], client);
  if (finalStatus !== 'draft') {
    await dbQuery(
      client,
      `UPDATE invoices
       SET status = $2,
           "updatedAt" = NOW()
       WHERE id = $1::uuid`,
      [invoiceId, finalStatus]
    );
  }
  return findInvoiceById(invoiceId, input.clinicId, client);
}

async function replaceInvoiceItems(invoiceId, items = [], client = null) {
  await dbQuery(
    client,
    `DELETE FROM invoice_items
     WHERE "invoiceId" = $1::uuid`,
    [invoiceId]
  );

  for (const item of items) {
    await dbQuery(
      client,
      `INSERT INTO invoice_items (
         "invoiceId",
         "productId",
         "descriptionSnapshot",
         quantity,
         "unitPrice",
         "taxRate",
         "subtotalAmount",
         "totalAmount"
       )
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
      [
        invoiceId,
        item.productId || null,
        item.descriptionSnapshot,
        item.quantity,
        item.unitPrice,
        item.taxRate,
        item.subtotalAmount,
        item.totalAmount
      ]
    );
  }
}

async function updateInvoice(invoiceId, clinicId, payload, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE invoices
     SET
       "contactId" = $3::uuid,
       "orderId" = $4::uuid,
       "parentInvoiceId" = $5::uuid,
       "invoiceNumber" = $6,
       type = $7,
       status = $8,
       "documentKind" = $9,
       "fiscalStatus" = $10,
       "documentMode" = $11,
       "providerStatus" = $12,
       currency = $13,
       "subtotalAmount" = $14,
       "taxAmount" = $15,
       "totalAmount" = $16,
       "issuedAt" = $17,
       "dueAt" = $18,
       "externalProvider" = $19,
       "externalReference" = $20,
       "customerTaxId" = $21,
       "customerTaxIdType" = $22,
       "customerLegalName" = $23,
       "customerVatCondition" = $24,
       "issuerLegalName" = $25,
       "issuerTaxId" = $26,
       "issuerTaxIdType" = $27,
       "issuerVatCondition" = $28,
       "issuerGrossIncomeNumber" = $29,
       "issuerFiscalAddress" = $30,
       "issuerCity" = $31,
       "issuerProvince" = $32,
       "pointOfSaleSuggested" = $33,
       "suggestedFiscalVoucherType" = $34,
       "accountantNotes" = $35,
       "deliveredToAccountantAt" = $36,
       "invoicedByAccountantAt" = $37,
       "accountantReferenceNumber" = $38,
       metadata = $39::jsonb,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [
      invoiceId,
      clinicId,
      payload.contactId || null,
      payload.orderId || null,
      payload.parentInvoiceId || null,
      payload.invoiceNumber || null,
      payload.type,
      payload.status,
      payload.documentKind || 'internal_invoice',
      payload.fiscalStatus || 'draft',
      payload.documentMode,
      payload.providerStatus || null,
      payload.currency,
      quantizeDecimal(payload.subtotalAmount || 0, 2, 0),
      quantizeDecimal(payload.taxAmount || 0, 2, 0),
      quantizeDecimal(payload.totalAmount || 0, 2, 0),
      payload.issuedAt || null,
      payload.dueAt || null,
      payload.externalProvider || null,
      payload.externalReference || null,
      payload.customerTaxId || null,
      payload.customerTaxIdType || 'NONE',
      payload.customerLegalName || null,
      payload.customerVatCondition || null,
      payload.issuerLegalName || null,
      payload.issuerTaxId || null,
      payload.issuerTaxIdType || 'NONE',
      payload.issuerVatCondition || null,
      payload.issuerGrossIncomeNumber || null,
      payload.issuerFiscalAddress || null,
      payload.issuerCity || null,
      payload.issuerProvince || null,
      payload.pointOfSaleSuggested || null,
      payload.suggestedFiscalVoucherType || 'NONE',
      payload.accountantNotes || null,
      payload.deliveredToAccountantAt || null,
      payload.invoicedByAccountantAt || null,
      payload.accountantReferenceNumber || null,
      JSON.stringify(payload.metadata || {})
    ]
  );

  if (!result.rows[0]) return null;
  await replaceInvoiceItems(invoiceId, payload.items || [], client);
  return findInvoiceById(invoiceId, clinicId, client);
}

async function updateInvoiceAccounting(invoiceId, clinicId, payload, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE invoices
     SET
       "documentKind" = $3,
       "fiscalStatus" = $4,
       "customerTaxId" = $5,
       "customerTaxIdType" = $6,
       "customerLegalName" = $7,
       "customerVatCondition" = $8,
       "issuerLegalName" = $9,
       "issuerTaxId" = $10,
       "issuerTaxIdType" = $11,
       "issuerVatCondition" = $12,
       "issuerGrossIncomeNumber" = $13,
       "issuerFiscalAddress" = $14,
       "issuerCity" = $15,
       "issuerProvince" = $16,
       "pointOfSaleSuggested" = $17,
       "suggestedFiscalVoucherType" = $18,
       "accountantNotes" = $19,
       "deliveredToAccountantAt" = $20,
       "invoicedByAccountantAt" = $21,
       "accountantReferenceNumber" = $22,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [
      invoiceId,
      clinicId,
      payload.documentKind || 'internal_invoice',
      payload.fiscalStatus || 'draft',
      payload.customerTaxId || null,
      payload.customerTaxIdType || 'NONE',
      payload.customerLegalName || null,
      payload.customerVatCondition || null,
      payload.issuerLegalName || null,
      payload.issuerTaxId || null,
      payload.issuerTaxIdType || 'NONE',
      payload.issuerVatCondition || null,
      payload.issuerGrossIncomeNumber || null,
      payload.issuerFiscalAddress || null,
      payload.issuerCity || null,
      payload.issuerProvince || null,
      payload.pointOfSaleSuggested || null,
      payload.suggestedFiscalVoucherType || 'NONE',
      payload.accountantNotes || null,
      payload.deliveredToAccountantAt || null,
      payload.invoicedByAccountantAt || null,
      payload.accountantReferenceNumber || null
    ]
  );

  if (!result.rows[0]) return null;
  return findInvoiceById(invoiceId, clinicId, client);
}

async function voidInvoice(invoiceId, clinicId, payload = {}, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE invoices
     SET
       status = 'void',
       "providerStatus" = COALESCE($3, "providerStatus"),
       metadata = $4::jsonb,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [
      invoiceId,
      clinicId,
      payload.providerStatus || null,
      JSON.stringify(payload.metadata || {})
    ]
  );

  if (!result.rows[0]) return null;
  return findInvoiceById(invoiceId, clinicId, client);
}

async function issueInvoice(invoiceId, clinicId, payload = {}, client = null) {
  const result = await dbQuery(
    client,
    `UPDATE invoices
     SET
       status = 'issued',
       "issuedAt" = COALESCE($3, "issuedAt", NOW()),
       "providerStatus" = COALESCE($4, "providerStatus"),
       metadata = $5::jsonb,
       "updatedAt" = NOW()
     WHERE id = $1::uuid
       AND "clinicId" = $2::uuid
     RETURNING id`,
    [
      invoiceId,
      clinicId,
      payload.issuedAt || null,
      payload.providerStatus || null,
      JSON.stringify(payload.metadata || {})
    ]
  );

  if (!result.rows[0]) return null;
  return findInvoiceById(invoiceId, clinicId, client);
}

module.exports = {
  listInvoicesByClinicId,
  listInvoicesByContactId,
  findInvoiceById,
  findInvoiceByOrderId,
  listInvoicesByParentInvoiceId,
  lockInvoiceById,
  createInvoice,
  updateInvoice,
  updateInvoiceAccounting,
  voidInvoice,
  issueInvoice
};
