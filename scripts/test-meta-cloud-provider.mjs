import assert from 'node:assert/strict';
import { MetaCloudClient, handleMetaWebhookEvent, verifyMetaWebhook } from '../server/src/payments/MetaCloudClient.js';

const verifyOk = verifyMetaWebhook({
  'hub.mode': 'subscribe',
  'hub.verify_token': 'verify-secret',
  'hub.challenge': 'challenge-123',
}, 'verify-secret');
assert.equal(verifyOk.ok, true);
assert.equal(verifyOk.challenge, 'challenge-123');

const verifyFail = verifyMetaWebhook({
  'hub.mode': 'subscribe',
  'hub.verify_token': 'wrong-token',
  'hub.challenge': 'challenge-123',
}, 'verify-secret');
assert.equal(verifyFail.ok, false);
assert.equal(verifyFail.reason, 'invalid_meta_webhook_verification');

const parsed = handleMetaWebhookEvent({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'entry-1',
    changes: [{
      field: 'messages',
      value: {
        metadata: {
          phone_number_id: '123456789',
          display_phone_number: '5521999999999',
        },
        contacts: [{
          wa_id: '5521888888888',
          profile: { name: 'Jogador Teste' },
        }],
        messages: [{
          id: 'wamid-test-1',
          from: '5521888888888',
          timestamp: '1',
          type: 'text',
          text: { body: 'oi' },
        }],
      },
    }],
  }],
});
assert.equal(parsed.messageCount, 1);
assert.equal(parsed.statusCount, 0);
assert.equal(parsed.messages[0].phone, '5521888888888');
assert.equal(parsed.messages[0].payload.event, 'MESSAGES_UPSERT');
assert.equal(parsed.messages[0].payload.data.key.fromMe, false);
assert.equal(parsed.messages[0].payload.data.message.conversation, 'oi');

let fetchCalled = false;
const unconfiguredClient = new MetaCloudClient({
  fetchImpl: async () => {
    fetchCalled = true;
    throw new Error('fetch_should_not_be_called_when_unconfigured');
  },
});
const blockedSend = await unconfiguredClient.sendMetaCloudMessage('5521888888888', 'teste');
assert.equal(blockedSend.ok, false);
assert.equal(blockedSend.sent, false);
assert.equal(blockedSend.reason, 'META_CLOUD_NOT_CONFIGURED');
assert.equal(fetchCalled, false);
assert.deepEqual(blockedSend.configurationErrors, [
  'META_WHATSAPP_TOKEN',
  'META_PHONE_NUMBER_ID',
  'META_VERIFY_TOKEN',
  'META_APP_SECRET',
  'META_GRAPH_API_VERSION',
]);

let requestUrl = '';
let requestBody = null;
const configuredClient = new MetaCloudClient({
  token: 'test-token',
  phoneNumberId: '123456789',
  verifyToken: 'verify-secret',
  appSecret: 'app-secret',
  graphApiVersion: 'v23.0',
  fetchImpl: async (url, options) => {
    requestUrl = String(url);
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        messaging_product: 'whatsapp',
        contacts: [{ input: '5521888888888', wa_id: '5521888888888' }],
        messages: [{ id: 'wamid-sent-1' }],
      }),
    };
  },
});
assert.equal(configuredClient.isConfigured(), true);
const sent = await configuredClient.sendMetaCloudMessage('5521888888888', 'teste pife');
assert.equal(sent.ok, true);
assert.equal(sent.sent, true);
assert.equal(sent.provider, 'meta_cloud');
assert.ok(requestUrl.includes('/v23.0/123456789/messages'));
assert.equal(requestBody.messaging_product, 'whatsapp');
assert.equal(requestBody.to, '5521888888888');
assert.equal(requestBody.text.body, 'teste pife');

console.log('Meta Cloud provider: verificação, parser e envio protegido validados.');
