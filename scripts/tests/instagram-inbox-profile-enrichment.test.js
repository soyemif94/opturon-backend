const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function withMockedModules(mocks, run) {
  const touched = [];

  try {
    Object.entries(mocks).forEach(([relativePath, exports]) => {
      const resolved = require.resolve(path.join(root, relativePath));
      touched.push({ resolved, previous: require.cache[resolved] });
      require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports
      };
    });

    return run();
  } finally {
    touched.reverse().forEach(({ resolved, previous }) => {
      if (previous) {
        require.cache[resolved] = previous;
      } else {
        delete require.cache[resolved];
      }
    });
  }
}

async function testInstagramProfileHelpers() {
  const originalFetch = global.fetch;
  const { chooseInstagramDisplayName, isInstagramProfileStale, maybeEnrichInstagramContactProfile } = require(path.join(
    root,
    'src/integrations/instagram/instagram-profile.service.js'
  ));

  try {
    assert.strictEqual(
      chooseInstagramDisplayName(
        {
          name: 'Nombre CRM',
          waId: '1597415198563263',
          metadata: {
            instagramProfile: {
              name: 'Provider Name',
              username: 'provider.user'
            }
          }
        },
        {
          name: 'Provider Name',
          username: 'provider.user',
          profilePicUrl: 'https://cdn.example/avatar.jpg'
        }
      ),
      'Nombre CRM'
    );

    assert.strictEqual(
      isInstagramProfileStale(
        {
          metadata: {
            instagramProfile: {
              providerProfileFetchedAt: '2026-08-28T11:00:00.000Z'
            }
          }
        },
        24 * 60 * 60 * 1000,
        new Date('2026-08-28T12:00:00.000Z')
      ),
      false
    );

    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          name: 'Opturon Platform',
          username: 'opturon.agency',
          profile_pic: 'https://cdn.example/opturon.jpg'
        })
    });

    const enriched = await maybeEnrichInstagramContactProfile({
      contact: {
        waId: '1597415198563263',
        name: null,
        profileImageUrl: null,
        metadata: {}
      },
      channel: {
        id: 'channel-instagram-1',
        instagramUserId: '28349497618013118',
        accessToken: 'secret-token'
      },
      igsid: '1597415198563263',
      now: new Date('2026-08-29T00:00:00.000Z')
    });

    assert.strictEqual(enriched.changed, true);
    assert.strictEqual(enriched.contactPatch.name, 'Opturon Platform');
    assert.strictEqual(enriched.contactPatch.metadata.instagramProfile.username, 'opturon.agency');
    assert.strictEqual(enriched.contactPatch.profileImageUrl, 'https://cdn.example/opturon.jpg');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testProcessInboundMessagesSuccessAndFailSoft() {
  const events = [
    {
      channelType: 'instagram',
      channelProvider: 'instagram_graph',
      externalChannelId: '28349497618013118',
      pageId: '28349497618013118',
      fromId: '1597415198563263',
      toId: '28349497618013118',
      providerMessageId: 'mid-success',
      type: 'text',
      text: 'hola',
      name: null,
      raw: {}
    },
    {
      channelType: 'instagram',
      channelProvider: 'instagram_graph',
      externalChannelId: '28349497618013118',
      pageId: '28349497618013118',
      fromId: '1408706051142012',
      toId: '28349497618013118',
      providerMessageId: 'mid-fail-soft',
      type: 'text',
      text: 'hola 2',
      name: null,
      raw: {}
    }
  ];

  const upsertCalls = [];
  const insertedMessages = [];
  let enrichmentCalls = 0;

  await withMockedModules(
    {
      'src/repositories/tenant.repository.js': {
        findChannelByPhoneNumberId: async () => null,
        findInstagramChannelByExternalId: async () => ({
          id: 'channel-instagram-1',
          clinicId: 'clinic-1',
          provider: 'instagram_graph',
          externalId: '28349497618013118',
          accessToken: 'secret-token'
        }),
        findInstagramChannelByPageId: async () => null
      },
      'src/repositories/contact.repository.js': {
        findContactByWaId: async (clinicId, waId) => ({
          id: `contact-${waId}`,
          clinicId,
          waId,
          name: null,
          profileImageUrl: null,
          metadata: {}
        }),
        upsertContact: async (input) => {
          upsertCalls.push(input);
          return {
            id: `contact-${input.waId}`,
            clinicId: input.clinicId,
            waId: input.waId,
            name: input.name,
            profileImageUrl: input.profileImageUrl,
            metadata: input.metadata || {}
          };
        }
      },
      'src/conversations/conversation.repo.js': {
        findInboundMessageByProviderId: async () => null,
        upsertConversation: async ({ clinicId, channelId, contactId }) => ({
          id: `conversation-${contactId}`,
          clinicId,
          channelId,
          contactId
        }),
        insertInboundMessage: async ({ conversationId, waMessageId }) => {
          insertedMessages.push({ conversationId, waMessageId });
          return {
            inserted: true,
            row: {
              id: `message-${waMessageId}`
            }
          };
        },
        enqueueJob: async () => null
      },
      'src/webhooks/meta.webhook.js': {
        extractMetaInboundMessages: () => events
      },
      'src/db/client.js': {
        withTransaction: async (callback) => callback({})
      },
      'src/utils/logger.js': {
        logInfo: () => null,
        logWarn: () => null,
        logError: () => null
      },
      'src/integrations/instagram/instagram-profile.service.js': {
        maybeEnrichInstagramContactProfile: async ({ igsid }) => {
          enrichmentCalls += 1;
          if (igsid === '1597415198563263') {
            return {
              changed: true,
              status: 'enriched',
              contactPatch: {
                name: 'Opturon Platform',
                profileImageUrl: 'https://cdn.example/opturon.jpg',
                metadata: {
                  instagramProfile: {
                    senderIgsid: igsid,
                    username: 'opturon.agency',
                    name: 'Opturon Platform',
                    providerProfilePicUrl: 'https://cdn.example/opturon.jpg',
                    providerProfileFetchedAt: '2026-08-29T00:00:00.000Z'
                  }
                }
              }
            };
          }

          return {
            changed: false,
            status: 'lookup_failed',
            contactPatch: null
          };
        }
      }
    },
    async () => {
      const servicePath = require.resolve(path.join(root, 'src/conversations/conversation.service.js'));
      delete require.cache[servicePath];
      const { processInboundMessages } = require(servicePath);
      const result = await processInboundMessages({ body: {}, headers: {}, requestId: 'req-1' });

      assert.deepStrictEqual(result, {
        received: 2,
        enqueued: 0,
        duplicates: 0,
        unrouted: 0,
        ignoredMissingWaMessageId: 0
      });
    }
  );

  assert.strictEqual(enrichmentCalls, 2);
  assert.strictEqual(upsertCalls.length, 2);
  assert.strictEqual(insertedMessages.length, 2);
  assert.strictEqual(upsertCalls[0].phone, null);
  assert.strictEqual(upsertCalls[0].waId, '1597415198563263');
  assert.strictEqual(upsertCalls[0].name, 'Opturon Platform');
  assert.strictEqual(upsertCalls[0].metadata.instagramProfile.username, 'opturon.agency');
  assert.strictEqual(upsertCalls[0].profileImageUrl, 'https://cdn.example/opturon.jpg');
  assert.strictEqual(upsertCalls[1].name, null);
}

async function main() {
  await testInstagramProfileHelpers();
  await testProcessInboundMessagesSuccessAndFailSoft();
  console.log('instagram-inbox-profile-enrichment tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
