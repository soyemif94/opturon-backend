const crypto = require('crypto');
const { DateTime } = require('luxon');

function shorten(value) {
  const text = String(value || '');
  return text.length <= 12 ? text : `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStatus(value, fallback = 'unknown') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  if (/^\d{4}-\d{2}-\d{2}T/.test(normalized)) return normalized.slice(0, 10);
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : normalized.slice(0, 10);
}

function getTenantTodayISO(timezone, now = DateTime.utc()) {
  return now.setZone(String(timezone || 'UTC')).toISODate();
}

function isLotExpired(expiresAt, todayISO) {
  const safeDate = toDateOnly(expiresAt);
  if (!safeDate) return false;
  return safeDate < String(todayISO || '');
}

function resolveLotState(row, options = {}) {
  const timezone = String(options.timezone || 'UTC');
  const todayISO = options.todayISO || getTenantTodayISO(timezone);
  const status = normalizeStatus(row.status);
  const availableQuantity = normalizeNumber(row.availableQuantity ?? row.available_quantity);
  const committedQuantity = normalizeNumber(row.committedQuantity ?? row.committed_quantity);
  const expiresAt = toDateOnly(row.expiresAt ?? row.expires_at);
  const expired = isLotExpired(expiresAt, todayISO);
  const cancelled = status === 'cancelled';
  const quarantined = status === 'quarantined';
  const operationallyActive = !cancelled && !quarantined && status !== 'depleted' && status !== 'written_off';
  const physicalQuantity = cancelled ? 0 : availableQuantity;
  const expectedProductStockContribution = operationallyActive && !expired ? availableQuantity : 0;
  const commercialAvailableContribution = operationallyActive && !expired
    ? Math.max(0, availableQuantity - committedQuantity)
    : 0;
  const fefoEligible = operationallyActive && !expired && availableQuantity > 0;

  return {
    lotId: row.id || row.lotId || null,
    status,
    availableQuantity,
    committedQuantity,
    expiresAt,
    expired,
    cancelled,
    quarantined,
    active: operationallyActive && availableQuantity > 0,
    fefoEligible,
    commercialEligible: commercialAvailableContribution > 0,
    physicalQuantity,
    expectedProductStockContribution,
    commercialAvailableContribution,
    lastMovementAt: row.lastMovementAt || row.last_movement_at || null,
    lastAllocationAt: row.lastAllocationAt || row.last_allocation_at || null
  };
}

function buildRepairFingerprint(input = {}) {
  const payload = JSON.stringify(input);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function summarizeLedgerConsistency(lots, movements, allocations) {
  const movementGroups = new Map();
  for (const movement of movements) {
    const key = String(movement.lotId || movement.lot_id || '');
    if (!movementGroups.has(key)) movementGroups.set(key, []);
    movementGroups.get(key).push(movement);
  }

  const activeAllocations = allocations.filter((allocation) => {
    const status = normalizeStatus(allocation.status);
    return status === 'allocated' || status === 'consumed';
  });

  const lotMismatches = [];
  for (const lot of lots) {
    const movementList = (movementGroups.get(String(lot.lotId || '')) || []).slice().sort((left, right) => {
      const leftKey = `${left.createdAt || left.created_at || ''}:${left.movementId || left.id || ''}`;
      const rightKey = `${right.createdAt || right.created_at || ''}:${right.movementId || right.id || ''}`;
      return leftKey.localeCompare(rightKey);
    });
    if (!movementList.length) continue;
    const lastMovement = movementList[movementList.length - 1];
    const lastQuantityAfter = normalizeNumber(lastMovement.quantityAfter ?? lastMovement.quantity_after, NaN);
    if (Number.isFinite(lastQuantityAfter) && Math.abs(lastQuantityAfter - lot.availableQuantity) > 0.0001) {
      lotMismatches.push({
        lotId: shorten(lot.lotId),
        expectedFromLedger: lastQuantityAfter,
        currentLotQuantity: lot.availableQuantity
      });
    }
  }

  const allocationOverflow = lots
    .filter((lot) => lot.committedQuantity > lot.availableQuantity)
    .map((lot) => ({
      lotId: shorten(lot.lotId),
      committedQuantity: lot.committedQuantity,
      availableQuantity: lot.availableQuantity
    }));

  return {
    status: lotMismatches.length === 0 && allocationOverflow.length === 0 ? 'consistent' : 'inconsistent',
    lotMismatches,
    allocationOverflow,
    activeAllocationCount: activeAllocations.length
  };
}

function determineRootCause(summary) {
  if (summary.ledgerConsistency.status !== 'consistent') return 'lot_quantity_inconsistent';
  if (summary.allocationCount > 0 && summary.activeAllocationCount > 0) return 'allocation_inconsistent';

  const allEligibleExpired = summary.lots.length > 0 && summary.lots.every((lot) => {
    if (lot.cancelled) return true;
    if (lot.availableQuantity <= 0) return true;
    return lot.expired === true;
  });

  if (
    allEligibleExpired &&
    summary.expectedProductStock === 0 &&
    summary.productStock === summary.physicalTotal &&
    summary.diffExpected === summary.productStock
  ) {
    return 'stock_semantics_changed';
  }

  return 'unknown_historical_divergence';
}

function summarizeProductStockDivergence(record, lotRows = [], movementRows = [], allocationRows = [], options = {}) {
  const timezone = String(record.timezone || options.timezone || 'UTC');
  const todayISO = options.todayISO || getTenantTodayISO(timezone);
  const lots = lotRows.map((row) => resolveLotState(row, { timezone, todayISO }));
  const movements = movementRows.map((row) => ({
    movementId: row.id || row.movementId || null,
    lotId: row.lotId || row.lot_id || null,
    movementType: row.movementType || row.movement_type || null,
    quantity: normalizeNumber(row.quantity),
    quantityBefore: row.quantityBefore ?? row.quantity_before,
    quantityAfter: row.quantityAfter ?? row.quantity_after,
    createdAt: row.createdAt || row.created_at || null,
    referenceType: row.referenceType || row.reference_type || null
  }));
  const allocations = allocationRows.map((row) => ({
    allocationId: row.id || row.allocationId || null,
    lotId: row.lotId || row.lot_id || null,
    quantity: normalizeNumber(row.quantity),
    status: row.status || null,
    createdAt: row.createdAt || row.created_at || null,
    releasedAt: row.releasedAt || row.released_at || null
  }));

  const productStock = normalizeNumber(record.productStock ?? record.product_stock);
  const physicalTotal = lots.reduce((sum, lot) => sum + lot.physicalQuantity, 0);
  const committedTotal = lots.reduce((sum, lot) => sum + lot.committedQuantity, 0);
  const expectedProductStock = lots.reduce((sum, lot) => sum + lot.expectedProductStockContribution, 0);
  const commercialAvailableTotal = lots.reduce((sum, lot) => sum + lot.commercialAvailableContribution, 0);
  const expiredPhysicalTotal = lots.reduce((sum, lot) => sum + (lot.expired ? lot.physicalQuantity : 0), 0);
  const quarantinedPhysicalTotal = lots.reduce((sum, lot) => sum + (lot.quarantined ? lot.physicalQuantity : 0), 0);
  const cancelledPhysicalTotal = lots.reduce((sum, lot) => sum + (lot.cancelled ? normalizeNumber(lot.availableQuantity) : 0), 0);
  const uncommittedPhysicalTotal = lots.reduce((sum, lot) => sum + Math.max(0, lot.physicalQuantity - lot.committedQuantity), 0);

  const ledgerConsistency = summarizeLedgerConsistency(lots, movements, allocations);
  const activeAllocationCount = ledgerConsistency.activeAllocationCount;
  const rootCauseCode = determineRootCause({
    lots,
    productStock,
    physicalTotal,
    expectedProductStock,
    diffExpected: productStock - expectedProductStock,
    ledgerConsistency,
    allocationCount: allocations.length,
    activeAllocationCount
  });

  const repairSafe =
    normalizeStatus(record.trackingMode || record.tracking_mode) === 'lot_based' &&
    !record.deletedAt &&
    ledgerConsistency.status === 'consistent' &&
    activeAllocationCount === 0;

  const fingerprint = buildRepairFingerprint({
    productId: record.productId || record.product_id,
    tenantId: record.tenantId || record.tenant_id,
    productStock,
    updatedAt: record.updatedAt || record.updated_at || null,
    lots: lots.map((lot) => ({
      lotId: lot.lotId,
      availableQuantity: lot.availableQuantity,
      committedQuantity: lot.committedQuantity,
      status: lot.status,
      expiresAt: lot.expiresAt,
      lastMovementAt: lot.lastMovementAt,
      lastAllocationAt: lot.lastAllocationAt
    })),
    lastMovementId: movements.length ? movements[movements.length - 1].movementId : null,
    lastAllocationId: allocations.length ? allocations[allocations.length - 1].allocationId : null
  });

  return {
    tenantId: record.tenantId || record.tenant_id,
    productId: record.productId || record.product_id,
    timezone,
    todayISO,
    trackingMode: normalizeStatus(record.trackingMode || record.tracking_mode),
    productStatus: normalizeStatus(record.productStatus || record.product_status, 'unknown'),
    deletedAt: record.deletedAt || record.deleted_at || null,
    productStock,
    lotCount: lots.length,
    movementCount: movements.length,
    allocationCount: allocations.length,
    physicalTotal,
    committedTotal,
    expectedProductStock,
    commercialAvailableTotal,
    uncommittedPhysicalTotal,
    expiredPhysicalTotal,
    quarantinedPhysicalTotal,
    cancelledPhysicalTotal,
    diffPhysical: productStock - physicalTotal,
    diffCommercial: productStock - commercialAvailableTotal,
    diffExpected: productStock - expectedProductStock,
    expectedSemantics: 'active_non_cancelled_non_expired_available_quantity',
    activeAllocationCount,
    ledgerConsistency,
    rootCauseCode,
    sourceOfTruth: repairSafe ? 'LOTS' : 'UNRESOLVED',
    repairSafe,
    fingerprint,
    lots,
    movements,
    allocations
  };
}

module.exports = {
  buildRepairFingerprint,
  determineRootCause,
  getTenantTodayISO,
  isLotExpired,
  resolveLotState,
  shorten,
  summarizeLedgerConsistency,
  summarizeProductStockDivergence
};
