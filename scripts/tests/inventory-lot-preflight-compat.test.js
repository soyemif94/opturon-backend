const assert = require('assert');

const {
  assessMigrationReadiness,
  buildChecksFromCounts,
  classifyLocationProposal,
  normalizeText
} = require('../lib/inventory-lot-preflight');
const { assertReadOnlySql } = require('../lib/postgres-cli');

function findCheck(checks, name) {
  return checks.find((check) => check.name === name);
}

const baseCounts = {
  totalLots: 7,
  lotBasedProducts: 4,
  negativeAvailable: 0,
  committedNegative: 0,
  committedGtPhysical: 0,
  productStockDivergent: 0,
  lotBasedWithBaseBalance: 0,
  legacyWithLots: 0,
  cancelledFefoEligible: 0,
  expiredUsedRecently: 0,
  invalidAllocations: 0,
  tombstoneProductWithActiveLot: 0,
  movementTenantMismatch: 0,
  allocationTenantMismatch: 0,
  approximateDuplicatePhysicalIdentity: 1,
  approximateConflictingPhysicalIdentity: 0,
  missingLocationId: 0,
  locationTenantMismatch: 0,
  missingNormalizedLotNumber: 0,
  duplicatePhysicalIdentity: 0,
  conflictingPhysicalIdentity: 0,
  inactiveLocationReferenced: 0,
  writtenOffWithQuantity: 0,
  blockMetadataWithoutBlockedStatus: 0,
  activeWithWriteoffMetadata: 0,
  invalidOperationalStatus: 0,
  operationalStatusNull: 0,
  quarantinedCompatibility: 0,
  duplicateLotOperations: 0,
  invalidOperationStatus: 0,
  emptyIdempotencyKey: 0,
  lotOperationTenantMismatch: 0,
  orphanLotOperation: 0
};

const preChecks = buildChecksFromCounts(
  {
    hasLocationId: false,
    hasNormalizedLotNumber: false,
    hasOperationalStatus: false,
    hasBlockingMetadata: false,
    hasWriteoffMetadata: false,
    hasLotOperations: false
  },
  baseCounts
);

assert.strictEqual(findCheck(preChecks, 'missing_location_id').status, 'skipped_schema_not_available');
assert.strictEqual(findCheck(preChecks, 'written_off_with_quantity').requiredMigration, '068');
assert.strictEqual(findCheck(preChecks, 'duplicate_lot_operations').requiredMigration, '069');
assert.strictEqual(findCheck(preChecks, 'approximate_duplicate_physical_identity_pre067').confidence, 'approximate');

const post067Checks = buildChecksFromCounts(
  {
    hasLocationId: true,
    hasNormalizedLotNumber: true,
    hasOperationalStatus: false,
    hasBlockingMetadata: false,
    hasWriteoffMetadata: false,
    hasLotOperations: false
  },
  { ...baseCounts, duplicatePhysicalIdentity: 2 }
);

assert.strictEqual(findCheck(post067Checks, 'duplicate_physical_identity').status, 'findings');
assert.strictEqual(findCheck(post067Checks, 'missing_location_id').status, 'passed');
assert.strictEqual(findCheck(post067Checks, 'written_off_with_quantity').status, 'skipped_schema_not_available');

const fullChecks = buildChecksFromCounts(
  {
    hasLocationId: true,
    hasNormalizedLotNumber: true,
    hasOperationalStatus: true,
    hasBlockingMetadata: true,
    hasWriteoffMetadata: true,
    hasLotOperations: true
  },
  { ...baseCounts, writtenOffWithQuantity: 1, duplicateLotOperations: 1 }
);

assert.strictEqual(findCheck(fullChecks, 'written_off_with_quantity').status, 'findings');
assert.strictEqual(findCheck(fullChecks, 'duplicate_lot_operations').status, 'findings');

const readinessReady = assessMigrationReadiness(preChecks.map((check) => ({
  ...check,
  status: check.status === 'findings' ? 'passed' : check.status
})));
assert.strictEqual(readinessReady.migrationReadiness, 'review_required');

const readinessReview = assessMigrationReadiness(preChecks);
assert.strictEqual(readinessReview.migrationReadiness, 'review_required');

const readinessBlocked = assessMigrationReadiness(fullChecks);
assert.strictEqual(readinessBlocked.migrationReadiness, 'blocked');

assert.strictEqual(normalizeText(' Deposito   Principal '), 'DEPOSITO PRINCIPAL');

const tenantLocations = [
  { id: 'loc-1', tenantId: 'tenant-1', code: 'A1', name: 'Deposito Principal', active: true },
  { id: 'loc-2', tenantId: 'tenant-1', code: 'SEC', name: 'Secundario', active: false },
  { id: 'loc-3', tenantId: 'tenant-1', code: 'DUP', name: 'Duplicado', active: true },
  { id: 'loc-4', tenantId: 'tenant-1', code: 'DUP2', name: 'Duplicado', active: true }
];
const allLocations = tenantLocations.concat([
  { id: 'loc-x', tenantId: 'tenant-2', code: 'OTRO', name: 'Otra', active: true },
  { id: 'loc-y', tenantId: 'tenant-2', code: 'REMOTO', name: 'Remoto', active: true }
]);

assert.strictEqual(
  classifyLocationProposal(
    { id: 'lot-1', tenantId: 'tenant-1', warehouseName: 'Deposito Principal', locationName: null, locationId: null },
    tenantLocations,
    allLocations,
    { hasLocationId: false }
  ).classification,
  'exact_match'
);

assert.strictEqual(
  classifyLocationProposal(
    { id: 'lot-2', tenantId: 'tenant-1', warehouseName: 'Duplicado', locationName: null, locationId: null },
    tenantLocations,
    allLocations,
    { hasLocationId: false }
  ).classification,
  'ambiguous_match'
);

assert.strictEqual(
  classifyLocationProposal(
    { id: 'lot-3', tenantId: 'tenant-1', warehouseName: 'Secundario', locationName: null, locationId: null },
    tenantLocations,
    allLocations,
    { hasLocationId: false }
  ).classification,
  'inactive_location'
);

assert.strictEqual(
  classifyLocationProposal(
    { id: 'lot-4', tenantId: 'tenant-1', warehouseName: 'Remoto', locationName: null, locationId: null },
    tenantLocations,
    allLocations,
    { hasLocationId: false }
  ).classification,
  'tenant_mismatch'
);

assert.strictEqual(
  classifyLocationProposal(
    { id: 'lot-5', tenantId: 'tenant-1', warehouseName: 'Sin match', locationName: null, locationId: null },
    tenantLocations,
    allLocations,
    { hasLocationId: false }
  ).classification,
  'no_match'
);

assert.strictEqual(
  classifyLocationProposal(
    { id: 'lot-6', tenantId: 'tenant-1', warehouseName: 'Deposito Principal', locationName: null, locationId: 'loc-1' },
    tenantLocations,
    allLocations,
    { hasLocationId: true }
  ).classification,
  'already_assigned'
);

assert.throws(() => assertReadOnlySql('UPDATE inventory_lots SET status = \'x\''), /read_only_query_contains_write/);
assert.doesNotThrow(() => assertReadOnlySql('SELECT COUNT(*) FROM inventory_lots'));
assert.doesNotThrow(() => assertReadOnlySql('WITH scoped AS (SELECT 1) SELECT * FROM scoped'));

console.log('inventory-lot-preflight-compat.test.js passed');
