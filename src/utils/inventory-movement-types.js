const LEGACY_TO_CANONICAL_MOVEMENT_TYPE = Object.freeze({
  initial_stock: 'opening_balance',
  manual_adjustment_in: 'manual_increase',
  manual_adjustment_out: 'manual_decrease'
});

const INVENTORY_MOVEMENT_TYPE_CONSTRAINT_VALUES = Object.freeze([
  'initial_stock',
  'manual_adjustment_in',
  'manual_adjustment_out',
  'expired_writeoff',
  'cancellation',
  'purchase_receipt',
  'sale',
  'opening_balance',
  'manual_increase',
  'manual_decrease',
  'correction',
  'return_in',
  'return_out'
]);

function normalizeInventoryMovementTypeForApi(movementType) {
  const safeType = String(movementType || '').trim();
  return LEGACY_TO_CANONICAL_MOVEMENT_TYPE[safeType] || safeType;
}

module.exports = {
  INVENTORY_MOVEMENT_TYPE_CONSTRAINT_VALUES,
  normalizeInventoryMovementTypeForApi
};
