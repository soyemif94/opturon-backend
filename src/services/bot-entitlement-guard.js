const { resolveEffectiveEntitlements, canBotRespond, canBotTool, canCapability } = require('./effective-entitlements');

async function loadEntitlements(clinicId) {
  const { query } = require('../db/client');
  const rowResult = await query('SELECT settings FROM clinics WHERE id=$1', [clinicId]);
  return resolveEffectiveEntitlements(rowResult.rows[0]?.settings);
}
async function botAllowedNow(clinicId, channel) {
  return canBotRespond(await loadEntitlements(clinicId), channel, clinicId);
}
async function toolAllowedNow(clinicId, tool) {
  const entitlements = await loadEntitlements(clinicId);
  return canCapability(entitlements, 'channels.whatsapp') && canBotTool(entitlements, tool);
}
// Only automatic/Bot callers use these adapters. Human portal services keep
// their own module guards and never require botActive to operate manually.
function guardedBotTool(fn, tool, clinicIdFromArgs, denied = null) {
  return async (...args) => {
    const clinicId = clinicIdFromArgs(...args);
    if (!clinicId || !await toolAllowedNow(clinicId, tool)) return typeof denied === 'function' ? denied() : denied;
    return fn(...args);
  };
}
function guardedProducts(repository) {
  async function project(products, clinicId) {
    if (await toolAllowedNow(clinicId, 'inventory')) return products;
    return products.map(product => {
      if (!product) return product;
      const metadata = product.metadata && typeof product.metadata === 'object' ? product.metadata : {};
      const catalog = metadata.catalog && typeof metadata.catalog === 'object' ? metadata.catalog : {};
      return { ...product, stock: null, stockVisible: false, cost: null,
        defaultSupplierId: null, defaultSupplier: null, defaultSupplierLegacyName: null,
        defaultSupplierStatus: null, inventoryTrackingMode: null, expirationDate: null,
        metadata: {
          ...(typeof metadata.shortDescription === 'string' ? { shortDescription: metadata.shortDescription } : {}),
          ...(typeof catalog.shortDescription === 'string' ? { catalog: { shortDescription: catalog.shortDescription } } : {})
        } };
    });
  }
  return {
    listProductsByClinicId: guardedBotTool(async (clinicId, ...args) => project(await repository.listProductsByClinicId(clinicId, ...args), clinicId), 'catalog', id => id, () => []),
    findProductById: guardedBotTool(async (id, clinicId, ...args) => (await project([await repository.findProductById(id, clinicId, ...args)], clinicId))[0], 'catalog', (_id, clinicId) => clinicId)
  };
}
module.exports = { loadEntitlements, botAllowedNow, toolAllowedNow, guardedBotTool, guardedProducts };
