function normalizeLotOperationalStatus(row = {}) {
  const operational = String(row.operationalStatus || '').trim().toLowerCase();
  if (operational === 'blocked' || operational === 'written_off' || operational === 'active') {
    return operational;
  }

  const legacyStatus = String(row.status || '').trim().toLowerCase();
  if (legacyStatus === 'quarantined') return 'blocked';
  if (legacyStatus === 'expired') return 'active';
  if (legacyStatus === 'depleted') return 'active';
  if (legacyStatus === 'cancelled') return 'cancelled';
  return 'active';
}

function resolveLotPhysicalQuantity(row = {}) {
  const displayStatus = deriveLotDisplayStatus(row);
  if (displayStatus === 'written_off' || displayStatus === 'cancelled') return 0;
  return Number(row.availableQuantity || 0);
}

function resolveLotCommercialAvailableQuantity(row = {}, expirationStatus = '') {
  if (!isLotCommerciallyAvailable(row, expirationStatus)) return 0;
  return Math.max(0, Number(row.availableQuantity || 0) - Number(row.committedQuantity || 0));
}

function resolveLotStatusAfterRestore(row = {}, nextAvailableQuantity) {
  const quantity = Number(nextAvailableQuantity || 0);
  const legacyStatus = String(row.legacyStatus || row.status || '').trim().toLowerCase();

  if (legacyStatus === 'cancelled') return 'cancelled';
  if (legacyStatus === 'quarantined') return 'quarantined';
  if (legacyStatus === 'expired') return 'expired';
  if (quantity <= 0) return 'depleted';
  return 'active';
}

function validateLotStateConsistency(row = {}) {
  const legacyStatus = String(row.legacyStatus || row.status || '').trim().toLowerCase();
  const operationalStatus = normalizeLotOperationalStatus(row);
  const availableQuantity = Number(row.availableQuantity || 0);

  if (operationalStatus === 'written_off' && availableQuantity > 0) return 'inventory_lot_invalid_written_off_quantity';
  if (operationalStatus !== 'blocked' && (row.blockedAt || row.blockedBy || row.blockReason)) {
    return 'inventory_lot_invalid_block_metadata';
  }
  if (operationalStatus === 'active' && (row.writtenOffAt || row.writtenOffBy || row.writeoffReason)) {
    return 'inventory_lot_invalid_written_off_metadata';
  }
  if (operationalStatus === 'blocked' && availableQuantity <= 0) return 'inventory_lot_invalid_blocked_without_quantity';
  if (legacyStatus === 'quarantined' && operationalStatus !== 'blocked') return 'inventory_lot_invalid_quarantine_mapping';
  return null;
}

function deriveLotDisplayStatus(row = {}) {
  const legacyStatus = String(row.status || '').trim().toLowerCase();
  const operationalStatus = normalizeLotOperationalStatus(row);
  const availableQuantity = Number(row.availableQuantity || 0);

  if (legacyStatus === 'cancelled') return 'cancelled';
  if (operationalStatus === 'written_off') return 'written_off';
  if (operationalStatus === 'blocked') return 'blocked';
  if (availableQuantity <= 0 || legacyStatus === 'depleted') return 'depleted';
  return 'active';
}

function isLotCommerciallyAvailable(row = {}, expirationStatus = '') {
  const displayStatus = deriveLotDisplayStatus(row);
  if (displayStatus !== 'active') return false;
  if (expirationStatus === 'expired') return false;
  return Number(row.availableQuantity || 0) > 0;
}

module.exports = {
  normalizeLotOperationalStatus,
  deriveLotDisplayStatus,
  isLotCommerciallyAvailable,
  resolveLotPhysicalQuantity,
  resolveLotCommercialAvailableQuantity,
  resolveLotStatusAfterRestore,
  validateLotStateConsistency
};
