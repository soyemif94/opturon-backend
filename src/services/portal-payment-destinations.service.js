const { resolvePortalTenantContext } = require('./portal-context.service');
const {
  listPaymentDestinationsByClinicId,
  findPaymentDestinationById,
  createPaymentDestination,
  updatePaymentDestination
} = require('../repositories/payment-destinations.repository');

const PAYMENT_DESTINATION_TYPES = new Set(['bank', 'wallet', 'cash_box', 'other']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeDestinationType(value) {
  const requested = normalizeString(value).toLowerCase();
  return PAYMENT_DESTINATION_TYPES.has(requested) ? requested : null;
}

function buildError(tenantId, reason, details) {
  return {
    ok: false,
    tenantId,
    reason,
    details: details || null
  };
}

async function listPortalPaymentDestinations(tenantId, options = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const destinations = await listPaymentDestinationsByClinicId(context.clinic.id, options);
  return {
    ok: true,
    tenantId: context.tenantId,
    clinic: context.clinic,
    paymentDestinations: destinations
  };
}

async function createPortalPaymentDestination(tenantId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const name = normalizeString(payload.name);
  const type = normalizeDestinationType(payload.type);
  const isActive = payload.isActive !== false;

  if (!name) {
    return buildError(context.tenantId, 'missing_payment_destination_name');
  }
  if (!type) {
    return buildError(context.tenantId, 'invalid_payment_destination_type');
  }

  try {
    const paymentDestination = await createPaymentDestination({
      clinicId: context.clinic.id,
      name,
      type,
      isActive
    });

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      paymentDestination
    };
  } catch (error) {
    if (error && error.code === '23505') {
      return buildError(context.tenantId, 'payment_destination_name_conflict');
    }
    throw error;
  }
}

async function patchPortalPaymentDestination(tenantId, destinationId, payload = {}) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic?.id) {
    return context;
  }

  const safeDestinationId = normalizeString(destinationId);
  const currentDestination = safeDestinationId
    ? await findPaymentDestinationById(safeDestinationId, context.clinic.id)
    : null;

  if (!safeDestinationId) {
    return buildError(context.tenantId, 'missing_payment_destination_id');
  }
  if (!currentDestination) {
    return buildError(context.tenantId, 'payment_destination_not_found');
  }

  const name = normalizeString(payload.name || currentDestination.name);
  const type = normalizeDestinationType(payload.type || currentDestination.type);
  const isActive = typeof payload.isActive === 'boolean' ? payload.isActive : currentDestination.isActive;

  if (!name) {
    return buildError(context.tenantId, 'missing_payment_destination_name');
  }
  if (!type) {
    return buildError(context.tenantId, 'invalid_payment_destination_type');
  }

  try {
    const paymentDestination = await updatePaymentDestination(
      safeDestinationId,
      context.clinic.id,
      {
        name,
        type,
        isActive
      }
    );

    if (!paymentDestination) {
      return buildError(context.tenantId, 'payment_destination_not_found');
    }

    return {
      ok: true,
      tenantId: context.tenantId,
      clinic: context.clinic,
      paymentDestination
    };
  } catch (error) {
    if (error && error.code === '23505') {
      return buildError(context.tenantId, 'payment_destination_name_conflict');
    }
    throw error;
  }
}

module.exports = {
  PAYMENT_DESTINATION_TYPES: Array.from(PAYMENT_DESTINATION_TYPES),
  listPortalPaymentDestinations,
  createPortalPaymentDestination,
  patchPortalPaymentDestination
};
