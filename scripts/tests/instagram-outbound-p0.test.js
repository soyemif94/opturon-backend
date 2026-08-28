const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveInstagramMessagingHost,
  sendInstagramTextMessage
} = require('../../src/integrations/instagram/instagram.service');
const { extractMetaInboundMessages } = require('../../src/webhooks/meta.webhook');

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

async function captureWarnings(run) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(String(line));
  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }
  return warnings.map((line) => JSON.parse(line));
}

const instagramChannel = {
  id: 'channel-ig', provider: 'instagram_graph', status: 'active', accessToken: 'secret-token',
  instagramUserId: 'ig-business-1', externalId: 'ig-business-1', externalPageId: 'ig-business-1',
  connectionMetadata: { oauthProvider: 'instagram_login' }
};

test('instagram outbound happy path uses the recipient-scoped Messaging API contract', async () => {
  let observed;
  const result = await sendInstagramTextMessage({
    channel: instagramChannel, recipientId: 'igsid-1', text: 'Hola',
    fetchImpl: async (url, options) => { observed = { url, options }; return response(200, { recipient_id: 'igsid-1', message_id: 'mid.1' }); }
  });
  assert.equal(result.messageId, 'mid.1');
  assert.match(observed.url, /^https:\/\/graph\.instagram\.com\/v\d+\.\d+\/ig-business-1\/messages\?/);
  assert.deepEqual(JSON.parse(observed.options.body), { recipient: { id: 'igsid-1' }, message: { text: 'Hola' } });
  assert.doesNotMatch(JSON.stringify(observed.options.headers), /secret-token/);
});

test('existing Facebook Login channel remains compatible without recreation', () => {
  assert.equal(resolveInstagramMessagingHost({ ...instagramChannel, externalPageId: 'page-1', connectionMetadata: {} }), 'graph.facebook.com');
});

test('new Instagram Login channel selects graph.instagram.com', () => {
  assert.equal(resolveInstagramMessagingHost(instagramChannel), 'graph.instagram.com');
});

test('Meta API non-transient error fails closed without retry', async () => {
  let calls = 0;
  await assert.rejects(() => sendInstagramTextMessage({
    channel: instagramChannel, recipientId: 'igsid-1', text: 'Hola',
    fetchImpl: async () => { calls += 1; return response(400, { error: { message: 'denied', code: 10 } }); }
  }), /denied/);
  assert.equal(calls, 1);
});

test('Meta 400 response logs structured provider details without credentials or raw body', async () => {
  const warnings = await captureWarnings(async () => {
    await assert.rejects(() => sendInstagramTextMessage({
      channel: instagramChannel,
      recipientId: 'igsid-1',
      text: 'Hola',
      requestId: 'req-400',
      fetchImpl: async () => response(400, {
        error: {
          type: 'OAuthException',
          code: 190,
          error_subcode: 463,
          message: 'Invalid access_token=secret-token',
          fbtrace_id: 'trace-400'
        },
        access_token: 'secret-token',
        raw_debug: 'must-not-be-logged'
      })
    }), /Invalid/);
  });
  const providerLog = warnings.find((entry) => entry.message === 'instagram_message_send_provider_error');
  assert.deepEqual({
    requestId: providerLog.requestId,
    correlationId: providerLog.correlationId,
    channelId: providerLog.channelId,
    provider: providerLog.provider,
    recipientIgsid: providerLog.recipientIgsid,
    providerEndpoint: providerLog.providerEndpoint,
    providerHttpStatus: providerLog.providerHttpStatus,
    providerErrorType: providerLog.providerErrorType,
    providerErrorCode: providerLog.providerErrorCode,
    providerErrorSubcode: providerLog.providerErrorSubcode,
    providerErrorMessage: providerLog.providerErrorMessage,
    providerFbtraceId: providerLog.providerFbtraceId
  }, {
    requestId: 'req-400',
    correlationId: 'req-400',
    channelId: 'channel-ig',
    provider: 'instagram',
    recipientIgsid: 'igsid-1',
    providerEndpoint: providerLog.providerEndpoint,
    providerHttpStatus: 400,
    providerErrorType: 'OAuthException',
    providerErrorCode: '190',
    providerErrorSubcode: '463',
    providerErrorMessage: 'Invalid [REDACTED]',
    providerFbtraceId: 'trace-400'
  });
  assert.match(providerLog.providerEndpoint, /^https:\/\/graph\.instagram\.com\/v\d+\.\d+\/:instagramAccountId\/messages$/);
  assert.ok(providerLog.ts);
  assert.doesNotMatch(JSON.stringify(warnings), /secret-token|must-not-be-logged|access_token/);
});

test('Meta 401 and 403 responses preserve sanitized status and error identity', async () => {
  for (const status of [401, 403]) {
    const warnings = await captureWarnings(async () => {
      await assert.rejects(() => sendInstagramTextMessage({
        channel: instagramChannel,
        recipientId: 'igsid-1',
        text: 'Hola',
        fetchImpl: async () => response(status, { error: { type: 'OAuthException', code: status, message: 'Denied' } })
      }), /Denied/);
    });
    const providerLog = warnings.find((entry) => entry.message === 'instagram_message_send_provider_error');
    assert.equal(providerLog.providerHttpStatus, status);
    assert.equal(providerLog.providerErrorType, 'OAuthException');
    assert.equal(providerLog.providerErrorCode, String(status));
    assert.equal(providerLog.providerErrorMessage, 'Denied');
  }
});

test('malformed provider response logs metadata only and never the raw body', async () => {
  const rawBody = 'upstream-secret-raw-body';
  const warnings = await captureWarnings(async () => {
    await assert.rejects(() => sendInstagramTextMessage({
      channel: instagramChannel,
      recipientId: 'igsid-1',
      text: 'Hola',
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        json: async () => { throw new Error(rawBody); }
      })
    }), /instagram_message_send_failed/);
  });
  const providerLogs = warnings.filter((entry) => entry.message === 'instagram_message_send_provider_error');
  assert.equal(providerLogs.length, 2);
  assert.equal(providerLogs[0].providerHttpStatus, 502);
  assert.equal(providerLogs[0].providerErrorMessage, null);
  assert.doesNotMatch(JSON.stringify(warnings), new RegExp(rawBody));
});

test('Instagram send observability introduces no database dependency or write', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/integrations/instagram/instagram.service.js'), 'utf8');
  assert.doesNotMatch(source, /conversationRepo|tenantRepository|\.query\s*\(|INSERT\s+INTO|UPDATE\s+channels/i);
});

test('transient Meta API response is retried once', async () => {
  let calls = 0;
  const result = await sendInstagramTextMessage({
    channel: instagramChannel, recipientId: 'igsid-1', text: 'Hola',
    fetchImpl: async () => { calls += 1; return calls === 1 ? response(503, {}) : response(200, { message_id: 'mid.retry' }); }
  });
  assert.equal(calls, 2);
  assert.equal(result.messageId, 'mid.retry');
});

test('missing credential is rejected before any network call', async () => {
  let calls = 0;
  await assert.rejects(() => sendInstagramTextMessage({
    channel: { ...instagramChannel, accessToken: '' }, recipientId: 'igsid-1', text: 'Hola', fetchImpl: async () => { calls += 1; }
  }), /instagram_channel_missing_credentials/);
  assert.equal(calls, 0);
});

test('outbound echo is excluded while regular Instagram inbound remains accepted', () => {
  const base = { object: 'instagram', entry: [{ id: 'ig-business-1', messaging: [] }] };
  base.entry[0].messaging.push(
    { sender: { id: 'ig-business-1' }, recipient: { id: 'igsid-1' }, message: { mid: 'mid.1', text: 'Hola', is_echo: true } },
    { sender: { id: 'igsid-1' }, recipient: { id: 'ig-business-1' }, message: { mid: 'mid.2', text: 'Respuesta' } }
  );
  const events = extractMetaInboundMessages(base);
  assert.equal(events.length, 1);
  assert.equal(events[0].providerMessageId, 'mid.2');
});

test('portal send preserves tenant, conversation and channel isolation contracts', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/services/portal-inbox.service.js'), 'utf8');
  assert.match(source, /getConversationByIdAndClinicId\(conversationId, context\.clinic\.id\)/);
  assert.match(source, /findChannelByIdAndClinicId\(conversation\.channelId, context\.clinic\.id\)/);
  assert.match(source, /runtimeProvider !== 'whatsapp_cloud' && runtimeProvider !== 'instagram_graph'/);
  assert.match(source, /String\(runtimeChannel\.status[\s\S]{0,320}conversation_channel_inactive/);
  assert.match(source, /clinicId: context\.clinic\.id,[\s\S]{0,80}channelId: runtimeChannel\.id/);
});

test('portal send persists provider id and idempotency key in the same conversation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/services/portal-inbox.service.js'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../../db/migrations/078_instagram_outbound_idempotency.sql'), 'utf8');
  assert.match(source, /waMessageId: sendResult && sendResult\.messageId/);
  assert.match(source, /raw->>'portalIdempotencyKey'/);
  assert.match(source, /portalIdempotencyKey: idempotencyKey/);
  assert.match(migration, /CREATE UNIQUE INDEX/);
});

test('controller forwards idempotency and maps inactive or missing credentials to conflict', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/controllers/portal.controller.js'), 'utf8');
  assert.match(source, /sendPortalMessage\(tenantId, conversationId, text, \{ idempotencyKey \}\)/);
  assert.match(source, /conversation_channel_missing_credentials/);
});

test('new OAuth persistence records the provider while preserving encrypted repository storage', () => {
  const service = fs.readFileSync(path.join(__dirname, '../../src/services/portal-instagram.service.js'), 'utf8');
  const repo = fs.readFileSync(path.join(__dirname, '../../src/repositories/tenant.repository.js'), 'utf8');
  assert.match(service, /oauthProvider: providerOverride \|\| null/);
  assert.match(repo, /prepareAccessTokenForStorage\(input\.accessToken\)/);
});
