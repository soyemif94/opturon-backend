function normalizePortalUserRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'editor') return 'seller';
  return normalized;
}

function isOperationalPortalAssigneeRole(value) {
  const role = normalizePortalUserRole(value);
  return role === 'manager' || role === 'seller';
}

module.exports = {
  normalizePortalUserRole,
  isOperationalPortalAssigneeRole
};
