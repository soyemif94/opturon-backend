const {
  ensureQaProduct,
  ensureQaLocation,
  createQaLot,
  rollbackQaLot
} = require('../services/admin-qa-inventory.service');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tenantId(req) {
  return String(req.activeTenantId || req.params.tenantId || '').trim();
}

function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || '').trim());
}

function hasNoQuery(req) {
  return !req.query || Object.keys(req.query).length === 0;
}

function invalidRequest(res, error) {
  noStore(res);
  return res.status(400).json({ success: false, error });
}

function errorStatus(reason) {
  if (String(reason || '').includes('conflict') || String(reason || '').includes('mismatch') || String(reason || '').includes('not_rollback_eligible')) {
    return 409;
  }
  if (String(reason || '').includes('not_ready') || String(reason || '').includes('not_found')) return 404;
  return 400;
}

function sendResult(res, result, dataKey, created = false) {
  noStore(res);
  if (!result.ok) {
    return res.status(errorStatus(result.reason)).json({
      success: false,
      error: result.reason,
      tenantId: result.tenantId || null
    });
  }

  return res.status(created && result.idempotent !== true ? 201 : 200).json({
    success: true,
    data: {
      [dataKey]: result[dataKey],
      ...(dataKey === 'lot' ? { movement: result.movement || null } : {}),
      idempotent: result.idempotent === true
    }
  });
}

async function postAdminQaInventoryProduct(req, res) {
  if (!hasNoQuery(req)) return invalidRequest(res, 'qa_inventory_query_not_allowed');
  if (!hasExactKeys(req.body || {}, [])) return invalidRequest(res, 'qa_inventory_product_payload_invalid');
  try {
    return sendResult(res, await ensureQaProduct(tenantId(req)), 'product', true);
  } catch (error) {
    noStore(res);
    return res.status(500).json({ success: false, error: 'portal_admin_qa_inventory_product_failed', details: error.message });
  }
}

async function postAdminQaInventoryLocation(req, res) {
  if (!hasNoQuery(req)) return invalidRequest(res, 'qa_inventory_query_not_allowed');
  if (!hasExactKeys(req.body || {}, [])) return invalidRequest(res, 'qa_inventory_location_payload_invalid');
  try {
    return sendResult(res, await ensureQaLocation(tenantId(req), req.adminQaInventoryActor), 'location', true);
  } catch (error) {
    noStore(res);
    return res.status(500).json({ success: false, error: 'portal_admin_qa_inventory_location_failed', details: error.message });
  }
}

async function postAdminQaInventoryLot(req, res) {
  if (!hasNoQuery(req)) return invalidRequest(res, 'qa_inventory_query_not_allowed');
  if (!hasExactKeys(req.body, ['productId', 'locationId']) || !isUuid(req.body.productId) || !isUuid(req.body.locationId)) {
    return invalidRequest(res, 'qa_inventory_lot_payload_invalid');
  }
  try {
    return sendResult(res, await createQaLot(tenantId(req), req.body, req.adminQaInventoryActor), 'lot', true);
  } catch (error) {
    noStore(res);
    return res.status(500).json({ success: false, error: 'portal_admin_qa_inventory_lot_failed', details: error.message });
  }
}

async function postAdminQaInventoryLotRollback(req, res) {
  if (!hasNoQuery(req)) return invalidRequest(res, 'qa_inventory_query_not_allowed');
  if (!hasExactKeys(req.body || {}, []) || !isUuid(req.params.lotId)) {
    return invalidRequest(res, 'qa_inventory_lot_rollback_payload_invalid');
  }
  try {
    return sendResult(res, await rollbackQaLot(tenantId(req), req.params.lotId, req.adminQaInventoryActor), 'lot');
  } catch (error) {
    noStore(res);
    return res.status(500).json({ success: false, error: 'portal_admin_qa_inventory_lot_rollback_failed', details: error.message });
  }
}

module.exports = {
  postAdminQaInventoryProduct,
  postAdminQaInventoryLocation,
  postAdminQaInventoryLot,
  postAdminQaInventoryLotRollback,
  __private__: {
    tenantId,
    hasExactKeys,
    hasNoQuery,
    isUuid
  }
};
