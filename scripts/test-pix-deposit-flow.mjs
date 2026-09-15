import assert from 'node:assert/strict';
import { WhatsAppPaymentBot } from '../server/src/payments/WhatsAppPaymentBot.js';

const phone = 'test-player';
const calls = [];
const sent = [];
const wallet = {
  isEnabled: () => false,
  config: { pixDepositsEnabled: true },
  notice: () => '',
  createDeposit: async (_phone, amount, options) => {
    calls.push({ amount, options });
    return { amount_cents: amount, public_reference: 'DEP-TEST', pix_copy_paste: 'MOCK' };
  },
};
const bot = new WhatsAppPaymentBot({ financialWalletService: wallet, logInfo: () => {}, logWarn: () => {}, logError: () => {},
  evolutionClient: { sendWhatsAppMessage: async (_phone, text) => { sent.push(text); return { ok: true }; } },
});
const run = (command, messageId = 'same-message') => bot.handleFinancialCommand(
  { phone, messageId }, { replyTo: phone, command, originIp: null },
);
assert.equal((await run('depositar 1'))?.type, 'financial_deposit_unavailable');
wallet.isEnabled = () => true;
for (const command of ['depositar 1', 'depositar 1,00', 'depositar 1.00', 'Depositar 1', 'DEPOSITAR 1', ' depositar 1', 'depositar    1']) {
  assert.equal((await run(command)).type, 'financial_deposit_created');
  assert.equal(calls.at(-1).amount, 100);
}
for (const command of ['depositar', 'depositar abc', 'depositar -1', 'depositar 0', 'depositar 1,2,3', 'depositar 9007199254740992']) {
  const before = calls.length;
  assert.equal((await run(command)).type, 'financial_deposit_invalid');
  assert.equal(calls.length, before);
}
assert.equal((await run('depositar 1', '')).type, 'financial_deposit_missing_message_id');
wallet.config.pixDepositsEnabled = false;
assert.equal((await run('depositar 1')).type, 'financial_deposit_unavailable');
wallet.config.pixDepositsEnabled = true;
wallet.createDeposit = async () => { throw new Error('UNTRUSTED_PRIVATE_DETAILS'); };
assert.equal((await run('depositar 1')).type, 'financial_deposit_failed');
assert.ok(!sent.join('').includes('UNTRUSTED_PRIVATE_DETAILS'));
console.log('Pix deposit command scenarios passed.');

// Integration through Evolution parsing, real wallet/repository code and an in-memory SQL adapter.
const { createRequire } = await import('node:module');
const { readFileSync } = await import('node:fs');
const { PostgresFinancialRepository } = await import('../server/src/financial/PostgresFinancialRepository.js');
const { FinancialWalletService } = await import('../server/src/financial/FinancialWalletService.js');
const { MockPaymentProvider } = await import('../server/src/financial/paymentProviders/MockPaymentProvider.js');
const require = createRequire(new URL('../server/package.json', import.meta.url));
const db = require('pg-mem').newDb();
const { Pool } = db.adapters.createPg();
const pool = new Pool();
const migration = readFileSync(new URL('../server/src/financial/migrations/001_financial_wallet.sql', import.meta.url), 'utf8')
  .replace(/CREATE OR REPLACE FUNCTION reject_financial_ledger_mutation[\s\S]*?FOR EACH ROW EXECUTE FUNCTION reject_financial_ledger_mutation\(\);/m, '')
  .replace(/CREATE OR REPLACE FUNCTION reject_confirmed_transaction_mutation[\s\S]*?FOR EACH ROW EXECUTE FUNCTION reject_confirmed_transaction_mutation\(\);/m, '')
  .replace(/ CHECK \([^\r\n]+\)/g, '');
await pool.query(migration);
const repository = new PostgresFinancialRepository({ pool, manageTransactions: false, serializableTransactions: false });
const provider = new MockPaymentProvider();
const service = new FinancialWalletService({ repository, provider,
  config: { ready: true, pixDepositsEnabled: true, mode: 'sandbox', provider: 'mock' } });
let sendFails = true;
const integration = new WhatsAppPaymentBot({ financialWalletService: service,
  safeEntryEnabled: true, entryService: { store: { hasProcessedMessage: () => true } },
  logInfo: () => {}, logWarn: () => {}, logError: () => {},
  evolutionClient: { sendWhatsAppMessage: async () => ({ ok: !sendFails }) },
});
const fakePhone = '5511' + '99991001';
const payload = (id, text = 'depositar 1') => ({ event: 'MESSAGES_UPSERT', data: {
  key: { id, remoteJid: fakePhone + '@s.whatsapp.net', fromMe: false }, message: { conversation: text },
} });
const failedSend = await integration.handleWebhook(payload('integration-one'));
assert.equal(failedSend.type, 'financial_deposit_created');
assert.equal(failedSend.decision, 'reply_failed');
sendFails = false;
assert.equal((await integration.handleWebhook(payload('integration-one'))).decision, 'reply_sent');
assert.equal(provider.payments.size, 1);
assert.equal((await pool.query('SELECT * FROM financial_deposits')).rows.length, 1);
assert.equal(Number((await service.getAccount(fakePhone)).available_balance_cents), 0);
const paymentId = [...provider.payments.keys()][0];
const event = { headers: { 'asaas-access-token': provider.webhookToken },
  payload: { id: 'test-event', event: 'PAYMENT_RECEIVED', payment: { id: paymentId } } };
await assert.rejects(() => service.processPaymentWebhook({ ...event, headers: {} }), /UNAUTHORIZED/);
provider.markPaid(paymentId);
await service.processPaymentWebhook(event);
assert.equal((await service.processPaymentWebhook(event)).duplicate, true);
assert.equal(Number((await service.getAccount(fakePhone)).available_balance_cents), 100);
assert.equal((await integration.handleWebhook(payload('integration-one'))).decision, 'reply_sent');
assert.equal(provider.payments.size, 1);
assert.equal((await pool.query('SELECT status FROM financial_deposits')).rows[0].status, 'CREDITED');
const query = repository.query.bind(repository);
repository.query = async () => { throw new Error('PRIVATE_DATABASE_DETAIL'); };
assert.equal((await integration.handleWebhook(payload('database-down'))).type, 'financial_deposit_failed');
repository.query = query;
provider.createOrFindCustomer = async () => { throw new Error('PRIVATE_PROVIDER_DETAIL'); };
assert.equal((await integration.handleWebhook(payload('provider-down'))).type, 'financial_deposit_failed');
await pool.end();
console.log('Evolution -> wallet -> mock charge -> send retry -> authenticated webhook -> single credit passed.');

const { AsaasSandboxProvider } = await import('../server/src/financial/paymentProviders/AsaasSandboxProvider.js');
const sandbox = new AsaasSandboxProvider({ apiKey: '$aact_hmlg_test_only', timeoutMs: 5,
  fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }),
});
await assert.rejects(() => sandbox.request('/customers'), /ASAAS_REQUEST_TIMEOUT/);
sandbox.fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
await assert.rejects(() => sandbox.request('/customers'), /ASAAS_INVALID_JSON/);
sandbox.fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
await assert.rejects(() => sandbox.request('/customers'), /ASAAS_REQUEST_FAILED:503/);
console.log('Asaas timeout, invalid JSON and HTTP failure mocks passed; no network used.');
