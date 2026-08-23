'use strict';

const INCIDENT = Object.freeze({
  channelId: '7f86db7a-0b3f-4aeb-9546-d0f2f921456a',
  phoneNumberId: '1070249406167861',
  wrongClinicId: 'a335961a-75c3-443b-a35f-5cc8dd243b1d',
  wrongTenantId: 'tenant_cliente_demo_02_20260312'
});

function normalize(value) {
  return String(value || '').trim();
}

function isWrongTenantMaintenanceTarget(tenantId) {
  return normalize(tenantId) === INCIDENT.wrongTenantId;
}

function isMaintainedChannel(input = {}) {
  const channelMatches = normalize(input.channelId) === INCIDENT.channelId;
  const phoneMatches = normalize(input.phoneNumberId) === INCIDENT.phoneNumberId;
  const clinicId = normalize(input.clinicId);
  return (channelMatches || phoneMatches) && (!clinicId || clinicId === INCIDENT.wrongClinicId);
}

function maintenanceError() {
  const error = new Error('WhatsApp ownership maintenance is active for this channel.');
  error.code = 'WHATSAPP_OWNERSHIP_MAINTENANCE';
  error.status = 503;
  return error;
}

function requireWrongTenantMaintenance(req, res, next) {
  if (!isWrongTenantMaintenanceTarget(req && req.params && req.params.tenantId)) {
    next();
    return;
  }

  res.set('Cache-Control', 'private, no-store');
  res.set('Retry-After', '300');
  res.status(503).json({ success: false, error: 'whatsapp_ownership_maintenance' });
}

function payloadTargetsMaintainedPhone(payload) {
  const entries = Array.isArray(payload && payload.entry) ? payload.entry : [];
  return entries.some((entry) => {
    const changes = Array.isArray(entry && entry.changes) ? entry.changes : [];
    return changes.some((change) => {
      const value = change && change.value ? change.value : {};
      const metadata = value && value.metadata ? value.metadata : {};
      return normalize(metadata.phone_number_id || metadata.phoneNumberId) === INCIDENT.phoneNumberId;
    });
  });
}

module.exports = {
  INCIDENT,
  isWrongTenantMaintenanceTarget,
  isMaintainedChannel,
  maintenanceError,
  requireWrongTenantMaintenance,
  payloadTargetsMaintainedPhone
};
