function hasColumn(columnSet, tableName, columnName) {
  return columnSet.has(`${tableName}.${columnName}`);
}

function hasConstraint(constraintSet, name) {
  return constraintSet.has(String(name || '').trim());
}

function deriveInventoryLotSchemaCapabilities({ columns = [], tables = [], constraints = [] } = {}) {
  const columnSet = new Set(
    columns.map((row) => `${String(row.table_name || '').trim()}.${String(row.column_name || '').trim()}`)
  );
  const tableSet = new Set(tables.map((row) => String(row.table_name || '').trim()));
  const constraintSet = new Set(constraints.map((row) => String(row.constraint_name || '').trim()));

  const hasLocationId = hasColumn(columnSet, 'inventory_lots', 'locationId');
  const hasNormalizedLotNumber = hasColumn(columnSet, 'inventory_lots', 'normalizedLotNumber');
  const hasOperationalStatus = hasColumn(columnSet, 'inventory_lots', 'operationalStatus');
  const hasBlockingMetadata = ['blockedAt', 'blockedBy', 'blockReason'].every((column) =>
    hasColumn(columnSet, 'inventory_lots', column)
  );
  const hasWriteoffMetadata = ['writtenOffAt', 'writtenOffBy', 'writeoffReason'].every((column) =>
    hasColumn(columnSet, 'inventory_lots', column)
  );
  const hasLotOperations = tableSet.has('inventory_lot_operations');

  let schemaPhase = 'pre_d3';
  if (hasLocationId || hasNormalizedLotNumber || hasOperationalStatus || hasLotOperations) {
    schemaPhase = 'partial_d3';
  }
  if (
    hasLocationId &&
    hasNormalizedLotNumber &&
    hasOperationalStatus &&
    hasBlockingMetadata &&
    hasWriteoffMetadata &&
    hasLotOperations
  ) {
    schemaPhase = 'full_d3';
  }

  return {
    hasLocationId,
    hasNormalizedLotNumber,
    hasOperationalStatus,
    hasBlockingMetadata,
    hasWriteoffMetadata,
    hasLotOperations,
    hasInventoryLocations: tableSet.has('inventory_locations'),
    hasInventoryLocationsActive: hasColumn(columnSet, 'inventory_locations', 'active'),
    hasInventoryLocationsCode: hasColumn(columnSet, 'inventory_locations', 'code'),
    hasInventoryLocationsName: hasColumn(columnSet, 'inventory_locations', 'name'),
    hasInventoryLocationsPrimary: hasColumn(columnSet, 'inventory_locations', 'isPrimary'),
    hasInventoryLocationsTenantUniq: hasConstraint(constraintSet, 'uniq_inventory_locations_id_tenant'),
    hasInventoryLotLocationConstraint: hasConstraint(constraintSet, 'fk_inventory_lots_location_tenant'),
    hasInventoryLotOperationalStatusConstraint: hasConstraint(constraintSet, 'chk_inventory_lots_operational_status'),
    hasInventoryLotOperationsStatusConstraint: hasConstraint(constraintSet, 'chk_inventory_lot_operations_status'),
    hasInventoryLotOperationsProductConstraint: hasConstraint(constraintSet, 'fk_inventory_lot_operations_product_tenant'),
    hasInventoryLotOperationsLotConstraint: hasConstraint(constraintSet, 'fk_inventory_lot_operations_lot_tenant_product'),
    columnsPresent: {
      locationId: hasLocationId,
      normalizedLotNumber: hasNormalizedLotNumber,
      operationalStatus: hasOperationalStatus,
      blockedAt: hasColumn(columnSet, 'inventory_lots', 'blockedAt'),
      blockedBy: hasColumn(columnSet, 'inventory_lots', 'blockedBy'),
      blockReason: hasColumn(columnSet, 'inventory_lots', 'blockReason'),
      writtenOffAt: hasColumn(columnSet, 'inventory_lots', 'writtenOffAt'),
      writtenOffBy: hasColumn(columnSet, 'inventory_lots', 'writtenOffBy'),
      writeoffReason: hasColumn(columnSet, 'inventory_lots', 'writeoffReason')
    },
    tablesPresent: {
      inventoryLocations: tableSet.has('inventory_locations'),
      inventoryLotOperations: hasLotOperations
    },
    schemaPhase
  };
}

async function detectInventoryLotSchemaCapabilities(queryable) {
  const columnsResult = await queryable.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'inventory_lots' AND column_name IN (
           'locationId',
           'normalizedLotNumber',
           'operationalStatus',
           'blockedAt',
           'blockedBy',
           'blockReason',
           'writtenOffAt',
           'writtenOffBy',
           'writeoffReason'
         ))
         OR (table_name = 'inventory_locations' AND column_name IN ('id', 'tenantId', 'code', 'name', 'isPrimary', 'active'))
         OR (table_name = 'inventory_lot_operations' AND column_name IN (
           'id',
           'tenantId',
           'productId',
           'lotId',
           'operationType',
           'idempotencyKey',
           'status'
         ))
       )`
  );
  const tablesResult = await queryable.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('inventory_locations', 'inventory_lot_operations')`
  );
  const constraintsResult = await queryable.query(
    `SELECT constraint_name
     FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND constraint_name IN (
         'uniq_inventory_locations_id_tenant',
         'fk_inventory_lots_location_tenant',
         'chk_inventory_lots_operational_status',
         'chk_inventory_lot_operations_status',
         'fk_inventory_lot_operations_product_tenant',
         'fk_inventory_lot_operations_lot_tenant_product'
       )`
  );

  return deriveInventoryLotSchemaCapabilities({
    columns: columnsResult.rows,
    tables: tablesResult.rows,
    constraints: constraintsResult.rows
  });
}

module.exports = {
  deriveInventoryLotSchemaCapabilities,
  detectInventoryLotSchemaCapabilities
};
