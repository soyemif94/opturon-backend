const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

function modulePath(relativePath) {
  return path.join(root, relativePath);
}

function mockModule(relativePath, exportsValue) {
  const resolved = require.resolve(modulePath(relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
  return resolved;
}

function clearModule(relativePath) {
  const resolved = require.resolve(modulePath(relativePath));
  delete require.cache[resolved];
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(body) {
      this.body = body;
      return body;
    }
  };
}

function loadAuthorization(overrides = {}) {
  const touched = [];
  touched.push(mockModule('src/services/portal-active-tenant.service.js', {
    hasPortalInternalAuth: () => true,
    findPortalActorContext: async () => ({
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: 'actor-own-tenant',
      isAdmin: true,
      accountScope: 'opturon_admin',
      ...overrides.actor
    })
  }));
  clearModule('src/middlewares/portal-admin-qa-inventory-authorization.middleware.js');
  const middleware = require(modulePath('src/middlewares/portal-admin-qa-inventory-authorization.middleware.js'));
  return { middleware, touched };
}

async function testAuthorization() {
  const { middleware, touched } = loadAuthorization();
  try {
    const request = {
      // The Admin workspace used to route the request need not be the
      // backend-resolved tenant of the portal actor. The selected client must
      // still be established by the active-tenant middleware.
      params: { tenantId: 'admin-workspace' },
      activeTenantId: 'tenant-controlled',
      activeTenantContext: {
        source: 'active_tenant',
        requestedTenantId: 'admin-workspace',
        activeTenantId: 'tenant-controlled',
        actorUserId: '11111111-1111-4111-8111-111111111111'
      },
      get: (header) => header === 'x-portal-actor-id' ? '11111111-1111-4111-8111-111111111111' : ''
    };
    let nextCalled = false;
    await middleware.requireAdminQaInventoryPermission(request, response(), () => { nextCalled = true; });
    assert.equal(nextCalled, true, 'Opturon Admin may use an active client tenant distinct from the actor tenant');

    const ownTenant = response();
    await middleware.requireAdminQaInventoryPermission(
      {
        ...request,
        activeTenantId: 'actor-own-tenant',
        activeTenantContext: { ...request.activeTenantContext, activeTenantId: 'actor-own-tenant' }
      },
      ownTenant,
      () => {}
    );
    assert.equal(ownTenant.statusCode, 403, 'the QA surface cannot target the actor tenant itself');

    const spoofed = response();
    await middleware.requireAdminQaInventoryPermission(
      {
        ...request,
        activeTenantContext: { ...request.activeTenantContext, actorUserId: 'other-actor' }
      },
      spoofed,
      () => {}
    );
    assert.equal(spoofed.statusCode, 403, 'actor forwarding must match the resolved active context');

    const spoofedHeader = response();
    await middleware.requireAdminQaInventoryPermission(
      {
        ...request,
        get: (header) => header === 'x-portal-actor-id' ? '22222222-2222-4222-8222-222222222222' : ''
      },
      spoofedHeader,
      () => {}
    );
    assert.equal(spoofedHeader.statusCode, 403, 'forwarded actor header must match the backend-resolved actor');

    const direct = response();
    await middleware.requireAdminQaInventoryPermission(
      {
        ...request,
        activeTenantId: 'admin-workspace',
        activeTenantContext: { ...request.activeTenantContext, source: 'requested_tenant', activeTenantId: null }
      },
      direct,
      () => {}
    );
    assert.equal(direct.statusCode, 403, 'Admin workspace cannot use this surface without an active client selection');
  } finally {
    clearModule('src/middlewares/portal-admin-qa-inventory-authorization.middleware.js');
    for (const resolved of touched) delete require.cache[resolved];
  }

  const { middleware: nonAdminMiddleware, touched: nonAdminTouched } = loadAuthorization({ actor: { isAdmin: false, accountScope: 'client' } });
  try {
    const denied = response();
    await nonAdminMiddleware.requireAdminQaInventoryPermission(
      {
        params: { tenantId: 'admin-workspace' },
        activeTenantId: 'tenant-controlled',
        activeTenantContext: {
          source: 'active_tenant',
          requestedTenantId: 'admin-workspace',
          activeTenantId: 'tenant-controlled',
          actorUserId: '11111111-1111-4111-8111-111111111111'
        },
        get: (header) => header === 'x-portal-actor-id' ? '11111111-1111-4111-8111-111111111111' : ''
      },
      denied,
      () => {}
    );
    assert.equal(denied.statusCode, 403, 'client actors are rejected');
  } finally {
    clearModule('src/middlewares/portal-admin-qa-inventory-authorization.middleware.js');
    for (const resolved of nonAdminTouched) delete require.cache[resolved];
  }
}

async function testInvalidActiveTenantIsRejectedBeforeQaAuthorization() {
  const touched = [];
  let received = null;
  touched.push(mockModule('src/services/portal-active-tenant.service.js', {
    resolveActiveTenantForRequest: async (req, requestedTenantId) => {
      received = { req, requestedTenantId };
      return {
        ok: false,
        status: 404,
        reason: 'active_tenant_not_found',
        tenantId: requestedTenantId,
        activeTenantId: 'missing-tenant'
      };
    }
  }));
  clearModule('src/middlewares/portal-active-tenant.middleware.js');

  try {
    const { applyPortalActiveTenant } = require(modulePath('src/middlewares/portal-active-tenant.middleware.js'));
    const request = { params: { tenantId: 'admin-workspace' } };
    const invalidTarget = response();
    let nextCalled = false;
    await applyPortalActiveTenant(request, invalidTarget, () => { nextCalled = true; });

    assert.equal(received.requestedTenantId, 'admin-workspace');
    assert.equal(invalidTarget.statusCode, 404, 'an invalid selected tenant stops before QA authorization');
    assert.equal(invalidTarget.body.error, 'active_tenant_not_found');
    assert.equal(nextCalled, false);
    assert.equal(request.activeTenantId, undefined);
  } finally {
    clearModule('src/middlewares/portal-active-tenant.middleware.js');
    for (const resolved of touched) delete require.cache[resolved];
  }
}

function loadService(stubs) {
  const touched = [];
  touched.push(mockModule('src/services/portal-products.service.js', {
    listPortalProducts: stubs.listPortalProducts,
    createPortalProduct: stubs.createPortalProduct
  }));
  touched.push(mockModule('src/services/inventory-lots.service.js', {
    listPortalInventoryLots: stubs.listPortalInventoryLots,
    getPortalInventoryLot: stubs.getPortalInventoryLot,
    createPortalInventoryLot: stubs.createPortalInventoryLot,
    adjustPortalInventoryLot: stubs.adjustPortalInventoryLot,
    listPortalInventoryLocations: stubs.listPortalInventoryLocations,
    createPortalInventoryLocation: stubs.createPortalInventoryLocation
  }));
  clearModule('src/services/admin-qa-inventory.service.js');
  return { service: require(modulePath('src/services/admin-qa-inventory.service.js')), touched };
}

function canonicalFixtures(constants) {
  const product = {
    id: '22222222-2222-4222-8222-222222222222',
    name: constants.QA_PRODUCT_NAME,
    sku: constants.QA_PRODUCT_SKU,
    unitPrice: 0,
    price: 0,
    status: 'active',
    inventoryTrackingMode: 'lot_based',
    metadata: { [constants.QA_METADATA_KEY]: { flow: constants.QA_FLOW, kind: 'product', version: 1, nonCommercial: true } }
  };
  const location = {
    id: '33333333-3333-4333-8333-333333333333',
    name: constants.QA_LOCATION_NAME,
    code: constants.QA_LOCATION_CODE,
    type: 'other',
    active: true,
    isPrimary: false
  };
  const lot = {
    id: '44444444-4444-4444-8444-444444444444',
    productId: product.id,
    locationId: location.id,
    lotNumber: constants.QA_LOT_NUMBER,
    expiresAt: constants.QA_EXPIRES_AT,
    initialQuantity: 1,
    availableQuantity: 1,
    committedQuantity: 0,
    status: 'active',
    operationalStatus: 'active',
    metadata: { [constants.QA_METADATA_KEY]: { flow: constants.QA_FLOW, kind: 'lot', version: 1, nonCommercial: true } }
  };
  return { product, location, lot };
}

async function testCanonicalServiceContracts() {
  let calls = [];
  let constants;
  let prerequisitesReady = false;
  let existingLot = null;
  let detailLot = null;
  let detailMovements = [];
  const stubs = {
    listPortalProducts: async () => ({
      ok: true,
      tenantId: 'tenant-controlled',
      products: prerequisitesReady ? [canonicalFixtures(constants).product] : []
    }),
    createPortalProduct: async (_tenantId, payload) => {
      calls.push({ operation: 'createProduct', payload });
      return { ok: true, tenantId: 'tenant-controlled', product: canonicalFixtures(constants).product };
    },
    listPortalInventoryLocations: async () => ({
      ok: true,
      tenantId: 'tenant-controlled',
      locations: prerequisitesReady ? [canonicalFixtures(constants).location] : []
    }),
    createPortalInventoryLocation: async (_tenantId, payload, actor) => {
      calls.push({ operation: 'createLocation', payload, actor });
      return { ok: true, tenantId: 'tenant-controlled', location: canonicalFixtures(constants).location };
    },
    listPortalInventoryLots: async () => ({
      ok: true,
      tenantId: 'tenant-controlled',
      lots: existingLot ? [existingLot] : []
    }),
    getPortalInventoryLot: async () => ({
      ok: true,
      tenantId: 'tenant-controlled',
      lot: detailLot || canonicalFixtures(constants).lot,
      movements: detailMovements
    }),
    createPortalInventoryLot: async (_tenantId, payload, actor) => {
      calls.push({ operation: 'createLot', payload, actor });
      return { ok: true, tenantId: 'tenant-controlled', lot: canonicalFixtures(constants).lot, idempotent: false };
    },
    adjustPortalInventoryLot: async (_tenantId, lotId, payload, actor) => {
      calls.push({ operation: 'rollbackLot', lotId, payload, actor });
      return {
        ok: true,
        tenantId: 'tenant-controlled',
        lot: { ...canonicalFixtures(constants).lot, availableQuantity: 0, status: 'depleted', operationalStatus: 'written_off' },
        movement: { id: '55555555-5555-4555-8555-555555555555' },
        idempotent: false
      };
    }
  };
  const { service, touched } = loadService(stubs);
  constants = service.__private__;
  const fixtures = canonicalFixtures(constants);
  const actor = { id: '11111111-1111-4111-8111-111111111111' };
  try {
    const product = await service.ensureQaProduct('tenant-controlled');
    assert.equal(product.ok, true);
    assert.equal(product.product.inventoryTrackingMode, 'lot_based');
    assert.equal(calls[0].payload.stock, undefined, 'normal product service itself forces stock to zero');
    assert.equal(calls[0].payload.metadata.catalog.inventoryTrackingMode, 'lot_based');
    assert.equal(calls[0].payload.unitPrice, 0);

    const location = await service.ensureQaLocation('tenant-controlled', actor);
    assert.equal(location.ok, true);
    assert.equal(calls[1].payload.code, constants.QA_LOCATION_CODE);
    assert.equal(calls[1].payload.active, true);
    assert.equal(calls[1].payload.isPrimary, undefined);

    prerequisitesReady = true;
    const created = await service.createQaLot('tenant-controlled', { productId: fixtures.product.id, locationId: fixtures.location.id }, actor);
    assert.equal(created.ok, true);
    const lotCall = calls.find((call) => call.operation === 'createLot');
    assert.equal(lotCall.payload.quantity, 1);
    assert.equal(lotCall.payload.expiresAt, constants.QA_EXPIRES_AT);
    assert.equal(lotCall.payload.lotNumber, constants.QA_LOT_NUMBER);
    assert.equal(lotCall.payload.idempotencyKey, constants.QA_LOT_CREATE_IDEMPOTENCY_KEY);
    assert.equal(lotCall.payload.operationalStatus, 'active');

    const foreign = await service.createQaLot('tenant-controlled', {
      productId: '66666666-6666-4666-8666-666666666666',
      locationId: fixtures.location.id
    }, actor);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.reason, 'qa_inventory_lot_target_mismatch', 'foreign UUIDs cannot become a QA lot');

    const createLotCallsBeforeConflict = calls.filter((call) => call.operation === 'createLot').length;
    existingLot = { ...fixtures.lot, committedQuantity: 1 };
    const committedFixture = await service.createQaLot('tenant-controlled', {
      productId: fixtures.product.id,
      locationId: fixtures.location.id
    }, actor);
    assert.equal(committedFixture.ok, false);
    assert.equal(committedFixture.reason, 'qa_inventory_lot_existing_state_conflict');
    assert.equal(
      calls.filter((call) => call.operation === 'createLot').length,
      createLotCallsBeforeConflict,
      'an altered existing fixture must never be incremented or recreated'
    );
    existingLot = { ...fixtures.lot, operationalStatus: 'blocked' };
    const blockedFixture = await service.createQaLot('tenant-controlled', {
      productId: fixtures.product.id,
      locationId: fixtures.location.id
    }, actor);
    assert.equal(blockedFixture.ok, false);
    assert.equal(blockedFixture.reason, 'qa_inventory_lot_existing_state_conflict');
    assert.equal(calls.filter((call) => call.operation === 'createLot').length, createLotCallsBeforeConflict);
    existingLot = null;

    const rolledBack = await service.rollbackQaLot('tenant-controlled', fixtures.lot.id, actor);
    assert.equal(rolledBack.ok, true);
    const rollbackCall = calls.find((call) => call.operation === 'rollbackLot');
    assert.equal(rollbackCall.payload.movementType, 'manual_decrease');
    assert.equal(rollbackCall.payload.quantity, 1);
    assert.equal(rollbackCall.payload.referenceType, 'inventory_manual_writeoff');
    assert.equal(rollbackCall.payload.idempotencyKey, constants.QA_LOT_ROLLBACK_IDEMPOTENCY_KEY);

    const rollbackCallsBeforeRetry = calls.filter((call) => call.operation === 'rollbackLot').length;
    detailLot = { ...fixtures.lot, availableQuantity: 0, status: 'depleted', operationalStatus: 'written_off' };
    detailMovements = [{
      movementType: 'manual_decrease',
      quantity: 1,
      referenceType: 'inventory_manual_writeoff',
      idempotencyKey: constants.QA_LOT_ROLLBACK_IDEMPOTENCY_KEY
    }];
    const retryRollback = await service.rollbackQaLot('tenant-controlled', fixtures.lot.id, actor);
    assert.equal(retryRollback.ok, true);
    assert.equal(retryRollback.idempotent, true);
    assert.equal(
      calls.filter((call) => call.operation === 'rollbackLot').length,
      rollbackCallsBeforeRetry,
      'normalized movement idempotencyKey makes rollback retry read-only'
    );
  } finally {
    clearModule('src/services/admin-qa-inventory.service.js');
    for (const resolved of touched) delete require.cache[resolved];
  }
}

async function testControllerContracts() {
  const calls = [];
  const touched = [];
  touched.push(mockModule('src/services/admin-qa-inventory.service.js', {
    ensureQaProduct: async () => ({ ok: true, product: { id: 'product' }, idempotent: true }),
    ensureQaLocation: async () => ({ ok: true, location: { id: 'location' }, idempotent: true }),
    createQaLot: async (...args) => { calls.push(args); return { ok: true, lot: { id: 'lot' }, idempotent: false }; },
    rollbackQaLot: async (...args) => { calls.push(args); return { ok: true, lot: { id: 'lot' }, movement: null, idempotent: true }; }
  }));
  clearModule('src/controllers/portal-admin-qa-inventory.controller.js');
  const controller = require(modulePath('src/controllers/portal-admin-qa-inventory.controller.js'));
  const requestBase = {
    params: { tenantId: 'admin-workspace', lotId: '44444444-4444-4444-8444-444444444444' },
    activeTenantId: 'tenant-controlled',
    query: {},
    adminQaInventoryActor: { id: 'actor' }
  };
  try {
    const badProduct = response();
    await controller.postAdminQaInventoryProduct({ ...requestBase, body: { actorId: 'spoofed' } }, badProduct);
    assert.equal(badProduct.statusCode, 400);

    const badLot = response();
    await controller.postAdminQaInventoryLot({ ...requestBase, body: { productId: 'bad', locationId: 'bad', quantity: 99 } }, badLot);
    assert.equal(badLot.statusCode, 400);

    const goodLot = response();
    await controller.postAdminQaInventoryLot({
      ...requestBase,
      body: { productId: '22222222-2222-4222-8222-222222222222', locationId: '33333333-3333-4333-8333-333333333333' }
    }, goodLot);
    assert.equal(goodLot.statusCode, 201, JSON.stringify(goodLot.body));
    assert.equal(calls[0][0], 'tenant-controlled', 'controller forwards resolved active tenant only');
    assert.equal(calls[0][2].id, 'actor', 'actor comes from authorization middleware, never body');

    const badRollback = response();
    await controller.postAdminQaInventoryLotRollback({ ...requestBase, body: { reason: 'spoofed' } }, badRollback);
    assert.equal(badRollback.statusCode, 400);
  } finally {
    clearModule('src/controllers/portal-admin-qa-inventory.controller.js');
    for (const resolved of touched) delete require.cache[resolved];
  }
}

async function main() {
  await testAuthorization();
  await testInvalidActiveTenantIsRejectedBeforeQaAuthorization();
  await testCanonicalServiceContracts();
  await testControllerContracts();

  const routes = require('node:fs').readFileSync(modulePath('src/routes/portal.routes.js'), 'utf8');
  const qaServiceSource = require('node:fs').readFileSync(modulePath('src/services/admin-qa-inventory.service.js'), 'utf8');
  assert.match(routes, /admin-qa-inventory\/products'[\s\S]*requirePortalInternalAuth[\s\S]*requireAdminQaInventoryPermission[\s\S]*catalogModule[\s\S]*inventoryCapability/);
  assert.match(routes, /admin-qa-inventory\/lots\/:lotId\/rollback'[\s\S]*requirePortalInternalAuth[\s\S]*requireAdminQaInventoryPermission/);
  const genericInventoryRouteLines = routes
    .split(/\r?\n/)
    .filter((line) => line.includes("'/tenants/:tenantId/inventory/"));
  assert.ok(genericInventoryRouteLines.length > 0);
  assert.ok(
    genericInventoryRouteLines.every((line) => !line.includes('requireAdminQaInventoryPermission')),
    'generic inventory routes remain unchanged'
  );
  assert.doesNotMatch(qaServiceSource, /require\(['"]\.\/(?:portal-operational-alerts|operational-alert|portal-whatsapp|whatsapp)/i);
  assert.doesNotMatch(qaServiceSource, /\b(?:INSERT|UPDATE|DELETE)\b[\s\S]*\b(?:operational_alert|whatsapp)/i);
  console.log('Admin QA inventory safety tests PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
