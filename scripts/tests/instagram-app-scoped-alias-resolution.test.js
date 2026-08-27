const assert = require('assert');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const modulePath = (relativePath) => path.join(rootDir, relativePath);

function mockModule(relativePath, exportsValue) {
  const fullPath = modulePath(relativePath);
  require.cache[fullPath] = {
    id: fullPath,
    filename: fullPath,
    loaded: true,
    exports: exportsValue
  };
}

const canonicalId = '28349497618013118';
const aliasId = '17841430256503922';
const targetChannel = {
  id: 'f56dba0a-c082-4b2b-8bb4-fd0a3e755960',
  clinicId: '7759e87c-cdfe-4339-aee9-cca3cdd392a9',
  type: 'instagram',
  provider: 'instagram_graph',
  externalId: canonicalId,
  externalPageId: null,
  instagramUserId: canonicalId,
  instagramUsername: 'opturonads',
  status: 'active',
  aliases: [aliasId]
};

let channels = [targetChannel];

function activeInstagramChannels() {
  return channels.filter((channel) =>
    channel.type === 'instagram' && channel.provider === 'instagram_graph' && channel.status === 'active'
  );
}

mockModule('src/db/client.js', {
  query: async (sql, params) => {
    const id = String(params[0]);
    const active = activeInstagramChannels();
    let rows;

    if (sql.includes('"externalId" = $1')) {
      rows = active.filter((channel) => channel.externalId === id).slice(0, 1);
    } else if (sql.includes('"externalPageId" = $1')) {
      rows = active.filter((channel) => channel.externalPageId === id).slice(0, 1);
    } else if (sql.includes('"instagramUserId" = $1')) {
      rows = active.filter((channel) => channel.instagramUserId === id).slice(0, 1);
    } else if (sql.includes("instagramAccountAliases")) {
      rows = active.filter((channel) => channel.aliases.includes(id)).slice(0, 2);
    } else {
      throw new Error('unexpected_query');
    }

    return { rows: rows.map(({ aliases, ...channel }) => ({ ...channel })) };
  }
});

mockModule('src/utils/secret-crypto.js', {
  maybeDecryptSecret: (value) => value,
  maybeEncryptSecret: (value) => value
});

delete require.cache[modulePath('src/repositories/tenant.repository.js')];
const { findInstagramChannelByRecipientId } = require(modulePath('src/repositories/tenant.repository.js'));

async function run() {
  channels = [targetChannel];
  assert.strictEqual((await findInstagramChannelByRecipientId(canonicalId)).id, targetChannel.id);
  assert.strictEqual((await findInstagramChannelByRecipientId(aliasId)).id, targetChannel.id);
  assert.strictEqual(await findInstagramChannelByRecipientId('unknown-id'), null);

  channels = [
    targetChannel,
    {
      ...targetChannel,
      id: 'foreign-channel',
      clinicId: 'foreign-clinic',
      externalId: 'foreign-canonical',
      instagramUserId: 'foreign-canonical',
      aliases: [aliasId]
    }
  ];
  assert.strictEqual(await findInstagramChannelByRecipientId(aliasId), null);

  channels = [
    targetChannel,
    {
      ...targetChannel,
      id: 'inactive-foreign-channel',
      clinicId: 'foreign-clinic',
      externalId: 'inactive-foreign-canonical',
      instagramUserId: 'inactive-foreign-canonical',
      aliases: [aliasId],
      status: 'inactive'
    }
  ];
  assert.strictEqual((await findInstagramChannelByRecipientId(aliasId)).id, targetChannel.id);

  console.log('instagram-app-scoped-alias-resolution.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
