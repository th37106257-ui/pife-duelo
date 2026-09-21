import assert from 'node:assert/strict';
import { WhatsAppPaymentBot } from '../server/src/payments/WhatsAppPaymentBot.js';

const sent = [];
const logs = [];
const processedMessages = new Set();
const deposits = [];
const player = '5511999991001';
const financialAdmin = '5511999990001';
const unauthorized = '5511999990002';
const account = {
  account_id: 'account-1', public_id: 'PD-8F4K2M', display_name: 'Jogador Teste', phone_normalized: player,
  available_balance_cents: 7500, reserved_balance_cents: 500, withdrawal_pending_balance_cents: 0,
};
const wallet = {
  config: { financialAdminNumbers: [financialAdmin], minWithdrawalAmountCents: 2000 },
  isEnabled: () => true,
  notice: () => '🧪 Ambiente de demonstração — nenhum dinheiro real está sendo movimentado.',
  getOrCreateAccount: async () => ({ ...account }),
  getAccount: async () => ({ ...account, available_balance_cents: 5500, withdrawal_pending_balance_cents: 2000 }),
  listHistory: async () => [{ public_reference: 'TX-ABC123', transaction_type: 'DEPOSIT_CREDITED', ledger_account: 'PLAYER_AVAILABLE', amount_cents: 2000 }],
  createDeposit: async (phone, amountCents, options) => {
    deposits.push({ phone, amountCents, options });
    return { public_reference: 'DEP-ABC123', amount_cents: amountCents, pix_copy_paste: '000201-TEST', pix_qr_code: 'QR-TEST' };
  },
  requestWithdrawal: async () => ({ public_reference: 'WD-ABC123', amount_cents: 2000 }),
  getStatus: async () => ({ mode: 'sandbox', provider: 'mock', accounts: 1, pending_deposits: 0, pending_withdrawals: 1 }),
};
const bot = new WhatsAppPaymentBot({
  paymentService: {
    isAdmin: () => false,
    store: {
      hasProcessedMessage: (id) => processedMessages.has(id),
      markMessageProcessed: (id) => processedMessages.add(id),
    },
  },
  entryService: { isAdmin: () => false },
  financialWalletService: wallet,
  logInfo: (event, payload) => logs.push({ event, payload }),
  evolutionClient: {
    isConfigured: () => true,
    sendWhatsAppMessage: async (phone, text) => { sent.push({ phone, text }); return { ok: true }; },
  },
});

const incoming = { phone: player, replyTo: player, pushName: 'Jogador Teste', text: 'menu', messageId: 'message-1' };
await bot.handleMenuCommand(incoming, { replyTo: player, originIp: 'test' });
assert.match(sent.at(-1).text, /1 .*Jogar[^]*2 .*Carteira[^]*3 .*Regras[^]*4 .*Suporte/);
assert.doesNotMatch(sent.at(-1).text, /PD-8F4K2M|sandbox|demonstra..o|nenhum dinheiro real/i);

function webhook(text, id) {
  return {
    event: 'messages.upsert', instance: 'pife-duelo-bot',
    data: { key: { remoteJid: `${player}@s.whatsapp.net`, fromMe: false, id }, message: { conversation: text } },
  };
}

const walletMenuResult = await bot.handleConnectivityWebhook(webhook('2', 'wallet-menu'), { originIp: 'test' });
assert.equal(walletMenuResult.type, 'financial_menu');
assert.match(sent.at(-1).text, /Carteira/);
assert.match(sent.at(-1).text, /Saldo: R\$\s*75,00/);
assert.doesNotMatch(sent.at(-1).text, /provider|webhook|sandbox|demonstra..o/i);

const depositHelp = await bot.handleConnectivityWebhook(webhook('1', 'wallet-deposit'), { originIp: 'test' });
assert.equal(depositHelp.type, 'financial_deposit_help');
assert.match(sent.at(-1).text, /Qual valor deseja adicionar/);
const guidedDeposit = await bot.handleConnectivityWebhook(webhook('5,00', 'wallet-deposit-value'), { originIp: 'test' });
assert.equal(guidedDeposit.type, 'financial_deposit_created');
assert.equal(deposits.at(-1).amountCents, 500);
assert.match(sent.at(-2).text, /Pix gerado[^]*R\$\s*5,00[^]*V.lido por 10 minutos[^]*pr.xima mensagem/i);
assert.doesNotMatch(sent.at(-2).text, /000201-TEST/);
assert.equal(sent.at(-1).text, '000201-TEST');

assert.equal((await bot.handleConnectivityWebhook(webhook('voltar', 'wallet-back'), { originIp: 'test' })).type, 'financial_menu');
assert.equal((await bot.handleConnectivityWebhook(webhook('2', 'wallet-history'), { originIp: 'test' })).type, 'financial_history');
assert.match(sent.at(-1).text, /\+ R\$\s*20,00\s+Depósito/);
assert.doesNotMatch(sent.at(-1).text, /DEPOSIT_CREDITED|ledger|transaction|TX-ABC123/i);
assert.equal((await bot.handleConnectivityWebhook(webhook('0', 'history-back'), { originIp: 'test' })).type, 'financial_menu');

await bot.handleFinancialCommand({ ...incoming, text: 'depositar 20' }, { replyTo: player, command: 'depositar 20', originIp: 'test' });
assert.match(sent.at(-2).text, /V.lido por 10 minutos/);
assert.doesNotMatch(sent.at(-2).text, /000201-TEST|Opera..o|webhook|sandbox|Asaas|provider/i);
assert.equal(sent.at(-1).text, '000201-TEST');
assert.equal(deposits.at(-1).amountCents, 2000);

await bot.handleFinancialCommand(
  { ...incoming, text: 'sacar 20 EMAIL chave-secreta@example.test | Jogador Teste' },
  { replyTo: player, command: 'sacar 20 email chave-secreta@example.test | jogador teste', originIp: 'test' },
);
assert.ok(sent.some((message) => message.phone === financialAdmin && message.text.includes('chave-secreta@example.test')));
assert.ok(!sent.some((message) => message.phone === unauthorized && message.text.includes('chave-secreta@example.test')));
assert.ok(!sent.filter((message) => message.phone === player).some((message) => message.text.includes('chave-secreta@example.test')));

const webhookDeposit = await bot.handleConnectivityWebhook(webhook('depositar 1', 'financial-deposit-one'), { originIp: 'test' });
assert.equal(webhookDeposit.type, 'financial_deposit_created');
assert.equal(deposits.at(-1).amountCents, 100);
assert.equal(deposits.at(-1).options.idempotencyKey, 'whatsapp:financial-deposit-one:deposit');
assert.match(sent.at(-2).text, /R\$\s*1,00/);
assert.equal(sent.at(-1).text, '000201-TEST');
assert.ok(logs.some((item) => item.event === 'BOT_HANDLER_SELECTED' && item.payload.handler === 'financial_wallet'));

for (const variant of ['saldo', 'Saldo', 'SALDO', '  saldo  ']) {
  const balanceResult = await bot.handleConnectivityWebhook(webhook(variant, `balance-${variant.trim()}-${Math.random()}`), { originIp: 'test' });
  assert.equal(balanceResult.type, 'financial_balance');
  assert.match(sent.at(-1).text, /Seu saldo/);
  assert.match(sent.at(-1).text, /R\$\s*75,00/);
  assert.doesNotMatch(sent.at(-1).text, /sandbox|demonstra..o|nenhum dinheiro real|ledger|provider/i);
  assert.ok(!sent.at(-1).text.includes('account-1'));
}

bot.safeEntryEnabled = true;
bot.matchQueue = {
  isConfigured: () => true,
  joinFinancialQueue: async () => ({ blocked: true, reason: 'FINANCIAL_INSUFFICIENT_BALANCE' }),
};
assert.equal((await bot.handleConnectivityWebhook(webhook('jogar', 'play-insufficient'), { originIp: 'test' })).type, 'whatsapp_tables_sent');
assert.equal((await bot.handleConnectivityWebhook(webhook('2', 'table-insufficient'), { originIp: 'test' })).type, 'financial_insufficient_balance');
assert.match(sent.at(-1).text, /Saldo insuficiente[^]*Recarregue para continuar/i);
assert.equal((await bot.handleConnectivityWebhook(webhook('1', 'insufficient-recharge'), { originIp: 'test' })).type, 'financial_deposit_help');
assert.equal((await bot.handleConnectivityWebhook(webhook('0', 'deposit-back'), { originIp: 'test' })).type, 'financial_menu');
assert.equal((await bot.handleConnectivityWebhook(webhook('0', 'wallet-root-back'), { originIp: 'test' })).type, 'whatsapp_menu_sent');

const failedSent = [];
const failedLogs = [];
const failedBot = new WhatsAppPaymentBot({
  paymentService: { store: { hasProcessedMessage: () => false, markMessageProcessed: () => {} } },
  financialWalletService: {
    ...wallet,
    createDeposit: async () => { throw new Error('ASAAS_REQUEST_FAILED:400'); },
  },
  logWarn: (event, payload) => failedLogs.push({ event, payload }),
  evolutionClient: {
    isConfigured: () => true,
    sendWhatsAppMessage: async (phone, text) => { failedSent.push({ phone, text }); return { ok: true }; },
  },
});
const failedDeposit = await failedBot.handleConnectivityWebhook(webhook('depositar 1', 'financial-deposit-failed'), { originIp: 'test' });
assert.equal(failedDeposit.type, 'financial_deposit_failed');
assert.match(failedSent.at(-1).text, /Não foi possível gerar o Pix agora/);
assert.ok(failedLogs.some((item) => item.event === 'FINANCIAL_DEPOSIT_CREATE_REJECTED'));

const emailSecret = 'email-pix-privado@example.test';
const evpSecret = '123e4567-e89b-12d3-a456-426614174000';
await bot.handleConnectivityWebhook(webhook(`sacar 20 EMAIL ${emailSecret} | Jogador Teste`, 'financial-log-email'), { originIp: 'test' });
await bot.handleConnectivityWebhook(webhook(`sacar 20 EVP ${evpSecret} | Jogador Teste`, 'financial-log-evp'), { originIp: 'test' });
const serializedLogs = JSON.stringify(logs);
assert.ok(!serializedLogs.includes(emailSecret));
assert.ok(!serializedLogs.includes(evpSecret));
assert.ok(logs.some((item) => item.event === 'WHATSAPP_MESSAGE_TEXT'
  && item.payload.command === '[financial-command-redacted]'
  && item.payload.financialAction === 'withdrawal_request'));

const denied = await bot.handleSafeEntryAdminCommand(unauthorized, 'admin financeiro status', { replyTo: unauthorized });
assert.equal(denied.type, 'entry_admin_unauthorized');
const allowed = await bot.handleSafeEntryAdminCommand(financialAdmin, 'admin financeiro status', { replyTo: financialAdmin });
assert.equal(allowed.type, 'financial_admin_status');
assert.match(sent.at(-1).text, /STATUS FINANCEIRO/);

console.log('Financial WhatsApp menu and admin authorization tests passed.');
