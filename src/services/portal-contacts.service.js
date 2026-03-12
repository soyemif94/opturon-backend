const { resolvePortalTenantContext } = require('./portal-context.service');
const { listContactsByClinicId } = require('../repositories/contact.repository');

function normalizeContact(row) {
  return {
    id: row.id,
    clinicId: row.clinicId,
    waId: row.waId || null,
    phone: row.phone || null,
    name: row.name || row.waId || 'Contacto',
    optedOut: row.optedOut === true,
    lastInteractionAt: row.lastInteractionAt || row.updatedAt || null,
    conversationCount: Number(row.conversationCount || 0)
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

module.exports = {
  listPortalContacts
};
