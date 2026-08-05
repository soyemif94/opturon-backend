const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function mockModule(relativePath, exportsValue) {
  const resolved = require.resolve(path.join(root, relativePath));
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue
  };
  return resolved;
}

function clearModule(relativePath) {
  const resolved = require.resolve(path.join(root, relativePath));
  delete require.cache[resolved];
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

async function main() {
  const touched = [];

  try {
    touched.push(
      mockModule('src/services/tenant-policy.service.js', {
        resolveTenantPolicyByExternalTenantId: async (tenantId) => {
          if (tenantId === 'tenant-admin') {
            return {
              ok: true,
              tenantId,
              clinic: {
                settings: {
                  portal: {
                    accountScope: 'opturon_admin'
                  }
                }
              },
              policy: {
                enabledModules: {},
                capabilities: []
              }
            };
          }

          return {
            ok: true,
            tenantId,
            clinic: {
              settings: {
                portal: {
                  accountScope: 'client'
                }
              }
            },
            policy: {
              enabledModules: {},
              capabilities: []
            }
          };
        },
        isModuleEnabled: () => false
      })
    );

    touched.push(
      mockModule('src/services/tenant-operating-profile.service.js', {
        MODULE_TO_CAPABILITY: {
          inbox: 'inbox',
          inventory: 'inventory'
        }
      })
    );

    const middlewarePath = path.join(root, 'src/middlewares/portal-module-gate.middleware.js');
    delete require.cache[require.resolve(middlewarePath)];
    const { requirePortalModule, requirePortalCapability } = require(middlewarePath);

    let nextCalled = false;
    const adminReq = {
      params: { tenantId: 'tenant-admin' }
    };
    const adminRes = createResponse();
    await requirePortalModule('inbox')(adminReq, adminRes, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(adminRes.body, null);

    nextCalled = false;
    const clientReq = {
      params: { tenantId: 'tenant-client' }
    };
    const clientRes = createResponse();
    await requirePortalModule('inbox')(clientReq, clientRes, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(clientRes.statusCode, 403);
    assert.deepEqual(clientRes.body, {
      success: false,
      error: 'tenant_module_disabled',
      tenantId: 'tenant-client',
      module: 'inbox'
    });

    nextCalled = false;
    const capabilityRes = createResponse();
    await requirePortalCapability('inventory')(adminReq, capabilityRes, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(capabilityRes.body, null);

    console.log('portal-module-gate-opturon-admin.test.js passed');
  } finally {
    clearModule('src/middlewares/portal-module-gate.middleware.js');
    for (const resolved of touched) {
      delete require.cache[resolved];
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
