const { withTransaction } = require('../db/client');
const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  listSuppliersByTenantId,
  findSupplierById,
  findSupplierByTaxId,
  createSupplier,
  updateSupplier,
  setSupplierStatus,
  listSupplierLinkedProducts
} = require('../repositories/suppliers.repository');
const { createPortalUserAuditEvent } = require('../repositories/portal-user-audit.repository');

const SUPPLIER_STATUSES = new Set(['active', 'inactive']);
const SORT_VALUES = new Set(['name_asc', 'name_desc', 'updated_asc', 'updated_desc']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNullableText(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function normalizeNullableEmail(value) {
  const normalized = normalizeString(value).toLowerCase();
  return normalized || null;
}

function normalizeTaxId(value) {
  const raw = normalizeString(value);
  return raw || null;
}

function normalizeTaxIdKey(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  const compact = raw.replace(/[^a-z0-9]+/gi, '').toUpperCase();
  return compact || null;
}

function normalizePage(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildSupplierPayload(payload = {}, fallback = {}) {
  return {
    legalName: normalizeString(payload.legalName !== undefined ? payload.legalName : fallback.legalName),
    tradeName: normalizeNullableText(payload.tradeName !== undefined ? payload.tradeName : fallback.tradeName),
    taxId: normalizeTaxId(payload.taxId !== undefined ? payload.taxId : fallback.taxId),
    normalizedTaxId: normalizeTaxIdKey(payload.taxId !== undefined ? payload.taxId : fallback.taxId),
    email: normalizeNullableEmail(payload.email !== undefined ? payload.email : fallback.email),
    phone: normalizeNullableText(payload.phone !== undefined ? payload.phone : fallback.phone),
    address: normalizeNullableText(payload.address !== undefined ? payload.address : fallback.address),
    notes: normalizeNullableText(payload.notes !== undefined ? payload.notes : fallback.notes),
    status: SUPPLIER_STATUSES.has(normalizeString(payload.status).toLowerCase())
      ? normalizeString(payload.status).toLowerCase()
      : SUPPLIER_STATUSES.has(normalizeString(fallback.status).toLowerCase())
        ? normalizeString(fallback.status).toLowerCase()
        : 'active'
  };
}

function validateSupplierPayload(payload) {
  if (!payload.legalName) return 'missing_supplier_legal_name';
  if (payload.legalName.length > 160) return 'invalid_supplier_legal_name';
  if (payload.tradeName && payload.tradeName.length > 160) return 'invalid_supplier_trade_name';
  if (payload.taxId && payload.taxId.length > 120) return 'invalid_supplier_tax_id';
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(payload.email)) return 'invalid_supplier_email';
  if (payload.phone && payload.phone.length > 80) return 'invalid_supplier_phone';
  if (payload.address && payload.address.length > 500) return 'invalid_supplier_address';
  if (payload.notes && payload.notes.length > 2000) return 'invalid_supplier_notes';
  if (!SUPPLIER_STATUSES.has(payload.status)) return 'invalid_supplier_status';
  return null;
}

function computeChangedFields(current, next) {
  const changedFields = [];
  for (const field of ['legalName', 'tradeName', 'taxId', 'email', 'phone', 'address', 'notes', 'status']) {
    if ((current?.[field] || null) !== (next?.[field] || null)) {
      changedFields.push(field);
    }
  }
  return changedFields;
}

function buildActorMeta(actor = {}) {
  return {
    actorId: normalizeString(actor.actorId || actor.id) || null,
    actorName: normalizeString(actor.actorName || actor.name) || null
  };
}

async function listPortalSuppliers(tenantId, query = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const page = normalizePage(query.page, 1);
  const pageSize = normalizePage(query.pageSize, 20);
  const sort = normalizeString(query.sort).toLowerCase();
  const filters = {
    search: normalizeString(query.search) || null,
    status: normalizeString(query.status).toLowerCase() || null,
    sort: SORT_VALUES.has(sort) ? sort : 'name_asc',
    page,
    pageSize
  };
  const result = await listSuppliersByTenantId(context.clinic.id, filters);
  const items = result.items || [];
  const active = items.filter((supplier) => supplier.status === 'active').length;
  const inactive = items.filter((supplier) => supplier.status === 'inactive').length;

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    items,
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / result.pageSize))
    },
    filters,
    summary: {
      total: result.total,
      active: filters.status === 'active' ? result.total : active,
      inactive: filters.status === 'inactive' ? result.total : inactive
    }
  };
}

async function getPortalSupplierDetail(tenantId, supplierId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const safeSupplierId = normalizeString(supplierId);
  if (!safeSupplierId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_supplier_id' };
  }

  const supplier = await findSupplierById(safeSupplierId, context.clinic.id);
  if (!supplier) {
    return { ok: false, tenantId: context.tenantId, reason: 'supplier_not_found' };
  }

  const linkedProducts = await listSupplierLinkedProducts(safeSupplierId, context.clinic.id, null, 20);

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    supplier: {
      ...supplier,
      linkedProducts
    }
  };
}

async function createPortalSupplier(tenantId, payload = {}, actor = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const next = buildSupplierPayload(payload);
  const reason = validateSupplierPayload(next);
  if (reason) return { ok: false, tenantId: context.tenantId, reason };

  const actorMeta = buildActorMeta(actor);

  try {
    const created = await withTransaction(async (client) => {
      if (next.normalizedTaxId) {
        const duplicate = await findSupplierByTaxId(context.clinic.id, next.normalizedTaxId, client);
        if (duplicate) {
          return { duplicate: true };
        }
      }

      const supplier = await createSupplier(
        {
          tenantId: context.clinic.id,
          ...next,
          createdBy: actorMeta.actorId,
          updatedBy: actorMeta.actorId
        },
        client
      );

      await createPortalUserAuditEvent({
        tenantId: context.tenantId,
        clinicId: context.clinic.id,
        actorUserId: actorMeta.actorId,
        action: 'supplier_created',
        payload: {
          supplierId: supplier.id,
          changedFields: ['legalName', 'tradeName', 'taxId', 'email', 'phone', 'address', 'notes', 'status'],
          actor: actorMeta,
          tenantId: context.tenantId
        }
      }, client);

      return { supplier };
    });

    if (created.duplicate) {
      return { ok: false, tenantId: context.tenantId, reason: 'duplicate_supplier_tax_id' };
    }

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      supplier: created.supplier
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return { ok: false, tenantId: context.tenantId, reason: 'duplicate_supplier_tax_id' };
    }
    throw error;
  }
}

async function updatePortalSupplier(tenantId, supplierId, payload = {}, actor = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const safeSupplierId = normalizeString(supplierId);
  if (!safeSupplierId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_supplier_id' };
  }

  const current = await findSupplierById(safeSupplierId, context.clinic.id);
  if (!current) {
    return { ok: false, tenantId: context.tenantId, reason: 'supplier_not_found' };
  }

  const next = buildSupplierPayload(payload, current);
  const reason = validateSupplierPayload(next);
  if (reason) return { ok: false, tenantId: context.tenantId, reason };

  const changedFields = computeChangedFields(current, next);
  const actorMeta = buildActorMeta(actor);

  try {
    const updated = await withTransaction(async (client) => {
      if (next.normalizedTaxId) {
        const duplicate = await findSupplierByTaxId(context.clinic.id, next.normalizedTaxId, client);
        if (duplicate && duplicate.id !== safeSupplierId) {
          return { duplicate: true };
        }
      }

      const supplier = await updateSupplier(
        safeSupplierId,
        context.clinic.id,
        {
          ...next,
          updatedBy: actorMeta.actorId
        },
        client
      );

      await createPortalUserAuditEvent({
        tenantId: context.tenantId,
        clinicId: context.clinic.id,
        actorUserId: actorMeta.actorId,
        action: 'supplier_updated',
        payload: {
          supplierId: safeSupplierId,
          changedFields,
          actor: actorMeta,
          tenantId: context.tenantId
        }
      }, client);

      return { supplier };
    });

    if (updated.duplicate) {
      return { ok: false, tenantId: context.tenantId, reason: 'duplicate_supplier_tax_id' };
    }

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      supplier: updated.supplier
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === '23505') {
      return { ok: false, tenantId: context.tenantId, reason: 'duplicate_supplier_tax_id' };
    }
    throw error;
  }
}

async function setPortalSupplierStatus(tenantId, supplierId, payload = {}, actor = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) return context;

  const safeSupplierId = normalizeString(supplierId);
  if (!safeSupplierId) {
    return { ok: false, tenantId: context.tenantId, reason: 'missing_supplier_id' };
  }

  const status = normalizeString(payload.status).toLowerCase();
  if (!SUPPLIER_STATUSES.has(status)) {
    return { ok: false, tenantId: context.tenantId, reason: 'invalid_supplier_status' };
  }

  const current = await findSupplierById(safeSupplierId, context.clinic.id);
  if (!current) {
    return { ok: false, tenantId: context.tenantId, reason: 'supplier_not_found' };
  }

  const actorMeta = buildActorMeta(actor);
  const updated = await withTransaction(async (client) => {
    const supplier = await setSupplierStatus(safeSupplierId, context.clinic.id, status, actorMeta.actorId, client);
    await createPortalUserAuditEvent({
      tenantId: context.tenantId,
      clinicId: context.clinic.id,
      actorUserId: actorMeta.actorId,
      action: status === 'inactive' ? 'supplier_deactivated' : 'supplier_reactivated',
      payload: {
        supplierId: safeSupplierId,
        changedFields: ['status'],
        actor: actorMeta,
        tenantId: context.tenantId
      }
    }, client);
    return supplier;
  });

  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    supplier: updated
  };
}

module.exports = {
  listPortalSuppliers,
  getPortalSupplierDetail,
  createPortalSupplier,
  updatePortalSupplier,
  setPortalSupplierStatus,
  buildSupplierPayload,
  validateSupplierPayload,
  normalizeTaxIdKey
};
