const MANUAL_LOT_WRITEOFF_REFERENCE_TYPE = 'inventory_manual_writeoff';
const MANUAL_LOT_WRITEOFF_MOVEMENT_TYPES = new Set(['manual_adjustment_out', 'manual_decrease']);

function normalizeString(value) {
  return String(value || '').trim();
}

function isManualLotWriteoffReference(referenceType) {
  return normalizeString(referenceType) === MANUAL_LOT_WRITEOFF_REFERENCE_TYPE;
}

function resolveLotAdjustmentSemantics(adjustment = {}) {
  const movementType = normalizeString(adjustment.movementType).toLowerCase();
  const isExpiredWriteoff = movementType === 'expired_writeoff';
  const isManualWriteoff = isManualLotWriteoffReference(adjustment.referenceType) && MANUAL_LOT_WRITEOFF_MOVEMENT_TYPES.has(movementType);
  const isWriteoff = isExpiredWriteoff || isManualWriteoff;

  return {
    isExpiredWriteoff,
    isManualWriteoff,
    isWriteoff,
    writeoffKind: isExpiredWriteoff ? 'expired' : isManualWriteoff ? 'manual' : null,
    operationType: isWriteoff ? 'writeoff' : 'increment_lot',
    auditAction: isWriteoff ? 'inventory_stock_written_off' : 'inventory_stock_adjusted'
  };
}

module.exports = {
  MANUAL_LOT_WRITEOFF_REFERENCE_TYPE,
  MANUAL_LOT_WRITEOFF_MOVEMENT_TYPES,
  isManualLotWriteoffReference,
  resolveLotAdjustmentSemantics
};
