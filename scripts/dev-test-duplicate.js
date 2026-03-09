require('dotenv').config();

const { query, closePool } = require('../src/db/client');
const { processInboundMessages } = require('../src/conversations/conversation.service');
const { upsertContact } = require('../src/repositories/contact.repository');
const conversationRepo = require('../src/conversations/conversation.repo');

async function getFirstChannel() {
  const result = await query(
    `SELECT id, "clinicId", "phoneNumberId"
     FROM channels
     WHERE status = 'active'
     ORDER BY "createdAt" ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function countConversationReplyJobs() {
  const result = await query(
    `SELECT COUNT(*)::int AS total
     FROM jobs
     WHERE type = 'conversation_reply'`
  );
  return result.rows[0] ? Number(result.rows[0].total) : 0;
}

async function testMissingWaMessageId(channel) {
  const before = await countConversationReplyJobs();

  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'dev-test',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: {
                phone_number_id: channel.phoneNumberId
              },
              contacts: [
                {
                  wa_id: '5492990001111',
                  profile: { name: 'No Id Test' }
                }
              ],
              messages: [
                {
                  from: '5492990001111',
                  type: 'text',
                  text: { body: 'hola sin id' }
                }
              ]
            }
          }
        ]
      }
    ]
  };

  const result = await processInboundMessages({
    body: payload,
    headers: {},
    requestId: 'dev-test-missing-id'
  });

  const after = await countConversationReplyJobs();
  return {
    before,
    after,
    delta: after - before,
    result
  };
}

async function testOutboundDuplicate(channel) {
  const waFrom = `549299${Date.now().toString().slice(-7)}`;
  const waTo = String(channel.phoneNumberId);
  const contact = await upsertContact({
    clinicId: channel.clinicId,
    waId: waFrom,
    phone: waFrom,
    name: 'Outbound Duplicate'
  });

  const conversation = await conversationRepo.upsertConversation({
    waFrom,
    waTo,
    clinicId: channel.clinicId,
    channelId: channel.id,
    contactId: contact.id
  });

  const fixedWaMessageId = `wamid.OUTBOUND.TEST.${Date.now()}`;

  const first = await conversationRepo.insertOutboundMessage({
    conversationId: conversation.id,
    waMessageId: fixedWaMessageId,
    from: waTo,
    to: waFrom,
    type: 'text',
    text: 'first insert',
    raw: { test: 'first' }
  });

  const second = await conversationRepo.insertOutboundMessage({
    conversationId: conversation.id,
    waMessageId: fixedWaMessageId,
    from: waTo,
    to: waFrom,
    type: 'text',
    text: 'second insert',
    raw: { test: 'second' }
  });

  return { fixedWaMessageId, first, second };
}

async function main() {
  const channel = await getFirstChannel();
  if (!channel) {
    throw new Error('No active channel found. Run npm run db:seed first.');
  }

  const missingId = await testMissingWaMessageId(channel);
  const outboundDuplicate = await testOutboundDuplicate(channel);

  console.log(
    JSON.stringify(
      {
        success: true,
        tests: {
          missingWaMessageId: {
            ignored: Number(missingId.result.ignoredMissingWaMessageId || 0) >= 1,
            enqueuedDelta: missingId.delta,
            result: missingId.result
          },
          outboundDuplicate: {
            firstInserted: !!(outboundDuplicate.first && outboundDuplicate.first.inserted),
            secondInserted: !!(outboundDuplicate.second && outboundDuplicate.second.inserted),
            secondReason: outboundDuplicate.second ? outboundDuplicate.second.reason || null : null,
            fixedWaMessageId: outboundDuplicate.fixedWaMessageId
          }
        }
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: error.message
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
