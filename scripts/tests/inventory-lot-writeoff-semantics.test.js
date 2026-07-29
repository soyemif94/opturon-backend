const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  MANUAL_LOT_WRITEOFF_REFERENCE_TYPE,
  resolveLotAdjustmentSemantics
} = require('../../src/utils/inventory-lot-writeoff');

const root = path.resolve(__dirname, '..', '..');
const service = fs.readFileSync(path.join(root, 'src/services/inventory-lots.service.js'), 'utf8');
const repository = fs.readFileSync(path.join(root, 'src/repositories/inventory.repository.js'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'src/controllers/portal.controller.js'), 'utf8');

assert.deepStrictEqual(
  resolveLotAdjustmentSemantics({
    movementType: 'manual_decrease',
    referenceType: MANUAL_LOT_WRITEOFF_REFERENCE_TYPE
  }),
  {
    isExpiredWriteoff: false,
    isManualWriteoff: true,
    isWriteoff: true,
    writeoffKind: 'manual',
    operationType: 'writeoff',
    auditAction: 'inventory_stock_written_off'
  }
);

assert.deepStrictEqual(
  resolveLotAdjustmentSemantics({
    movementType: 'expired_writeoff',
    referenceType: null
  }),
  {
    isExpiredWriteoff: true,
    isManualWriteoff: false,
    isWriteoff: true,
    writeoffKind: 'expired',
    operationType: 'writeoff',
    auditAction: 'inventory_stock_written_off'
  }
);

assert.deepStrictEqual(
  resolveLotAdjustmentSemantics({
    movementType: 'manual_adjustment_out',
    referenceType: null
  }),
  {
    isExpiredWriteoff: false,
    isManualWriteoff: false,
    isWriteoff: false,
    writeoffKind: null,
    operationType: 'increment_lot',
    auditAction: 'inventory_stock_adjusted'
  }
);

assert(service.includes("inventory_lot_not_expired"), 'adjustment service must reject expired_writeoff for future lots');
assert(service.includes("const completedWriteoff = semantics.isWriteoff && after === 0;"), 'service must only mark written_off on completed writeoff');
assert(service.includes("writeoffReason: completedWriteoff ? adjustment.reason : lot.writeoffReason"), 'service must preserve manual reason only on completed writeoff');
assert(service.includes("writeoffKind: semantics.writeoffKind"), 'service must persist writeoff kind metadata');
assert(repository.includes("if (normalizedType === 'manual_decrease' && safeMetadata.auditAction === 'inventory_stock_written_off') return 'manual_writeoff';"), 'history must expose manual writeoff as distinct type');
assert(controller.includes("result.reason === 'inventory_lot_not_expired'"), 'controller must surface non-expired writeoff as conflict');

console.log('inventory-lot-writeoff-semantics.test.js passed');
