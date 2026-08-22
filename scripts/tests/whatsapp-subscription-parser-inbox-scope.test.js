const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const envPath = path.join(rootDir, 'src', 'config', 'env.js');
const graphPath = path.join(rootDir, 'src', 'services', 'whatsapp-graph.client.js');
const wabaPath = path.join(rootDir, 'src', 'services', 'waba.service.js');

const graphCalls = [];
require.cache[envPath] = {
  id: envPath,
  filename: envPath,
  loaded: true,
  exports: {
    whatsappAppId: '3388083341350043',
    whatsappWabaId: '27184268844495361',
    whatsappPhoneNumberId: '1070249406167861',
    whatsappGraphVersion: 'v22.0',
    getWhatsAppGraphVersion: () => 'v22.0'
  }
};
require.cache[graphPath] = {
  id: graphPath,
  filename: graphPath,
  loaded: true,
  exports: {
    request: async (...args) => {
      graphCalls.push(args);
      return {
        ok: true,
        status: 200,
        data: {
          data: [
            {
              whatsapp_business_api_data: {
                id: '3388083341350043',
                name: 'Opturon Platform',
                link: 'https://www.opturon.com/'
              }
            }
          ]
        }
      };
    }
  }
};

const wabaService = require(wabaPath);
const { buildInboxChannelScope } = require(path.join(rootDir, 'src', 'services', 'portal-inbox.service.js'));

async function run() {
  const realPayload = {
    data: [
      {
        whatsapp_business_api_data: {
          id: '3388083341350043',
          name: 'Opturon Platform'
        }
      }
    ]
  };

  assert.strictEqual(wabaService.getAppIdentifier(realPayload.data[0]), '3388083341350043');
  assert.strictEqual(wabaService.isCurrentAppSubscribed(realPayload), true);
  assert.strictEqual(wabaService.isCurrentAppSubscribed({ data: [] }), false);
  assert.strictEqual(
    wabaService.isCurrentAppSubscribed({
      data: [{ whatsapp_business_api_data: { id: 'another-app' } }]
    }),
    false
  );
  assert.strictEqual(
    wabaService.getAppIdentifier({ whatsapp_business_api_data: { app_id: '3388083341350043' } }),
    null
  );
  assert.throws(
    () => wabaService.isCurrentAppSubscribed({ data: [{ id: '3388083341350043' }] }),
    /subscribed_apps_response_shape_unknown/
  );
  assert.throws(() => wabaService.isCurrentAppSubscribed({}), /subscribed_apps_response_invalid/);

  await wabaService.listSubscribedApps('27184268844495361', { requestId: 'test-read' });
  assert.strictEqual(graphCalls.length, 1);
  assert.strictEqual(graphCalls[0][0], 'GET');
  assert.strictEqual(graphCalls[0][1], '/27184268844495361/subscribed_apps');
  assert.strictEqual(graphCalls[0][2].query, undefined);

  graphCalls.length = 0;
  const result = await wabaService.ensureAppSubscribed({ requestId: 'test-existing' });
  assert.strictEqual(result.subscribedNow, false);
  assert.strictEqual(graphCalls.filter(([method]) => method === 'POST').length, 0);

  const canonicalId = '7f86db7a-0b3f-4aeb-9546-d0f2f921456a';
  const legacyId = 'b3ef8ab5-4610-4571-a91b-e34d10b98dfa';
  const canonicalScope = buildInboxChannelScope(
    { channel: { id: canonicalId, type: 'whatsapp', provider: 'whatsapp_cloud', status: 'active' } },
    'whatsapp'
  );
  assert.strictEqual(canonicalScope.channelScopeId, canonicalId);
  assert.strictEqual(canonicalScope.value, canonicalId);
  assert.match(canonicalScope.clause, /c\."channelId" = \$2::uuid/);
  assert.notStrictEqual(canonicalScope.value, legacyId);

  const inactiveScope = buildInboxChannelScope(
    { channel: { id: legacyId, type: 'whatsapp', provider: 'whatsapp_cloud', status: 'inactive' } },
    'whatsapp'
  );
  assert.strictEqual(inactiveScope.clause, 'AND FALSE');
  assert.strictEqual(inactiveScope.channelScopeId, null);

  const wabaSource = fs.readFileSync(wabaPath, 'utf8');
  const psSource = fs.readFileSync(path.join(rootDir, 'scripts', 'ps', 'waba_diagnose.ps1'), 'utf8');
  const inboxSource = fs.readFileSync(path.join(rootDir, 'src', 'services', 'portal-inbox.service.js'), 'utf8');
  assert.doesNotMatch(wabaSource, /subscribed_apps[^\n]*fields[=:]id,name/i);
  assert.match(psSource, /whatsapp_business_api_data\.id/);
  assert.doesNotMatch(psSource, /whatsapp_business_api_data\.app_id/);
  assert.doesNotMatch(psSource, /Invoke-GraphRequest\s+-Method\s+"POST"[^\n]*subscribed_apps/i);
  assert.match(inboxSource, /WHERE c\."clinicId" = \$1::uuid/);
  assert.match(inboxSource, /AND c\."channelId" = \$2::uuid/);

  console.log('whatsapp subscription parser and inbox scope regression: PASS');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
