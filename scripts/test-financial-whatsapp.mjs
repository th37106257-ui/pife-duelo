import assert from 'node:assert/strict';
import { WhatsAppPaymentBot } from '../server/src/payments/WhatsAppPaymentBot.js';

const sent = [];
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
  listHistory: async () => [{ public_reference: 'TX-ABC123', transaction_type: 'DEPOSIT_CREDITED', amount_cents: 2000 }],
  createDeposit: async () => ({ public_reference: 'DEP-ABC123', amount_cents: 2000, pix_copy_paste: '000201-TEST', pix_qr_code: 'QR-TEST' }),
  requestWithdrawal: async () => ({ public_reference: 'WD-ABC123', amount_cents: 2000 }),
  getStatus: async () => ({ mode: 'sandbox', provider: 'mock', accounts: 1, pending_deposits: 0, pending_withdrawals: 1 }),
};
const bot = new WhatsAppPaymentBot({
  paymentService: { isAdmin: () => false },
  entryService: { isAdmin: () => false },
  financialWalletService: wallet,
  evolutionClient: {
    isConfigured: () => true,
    sendWhatsAppMessage: async (phone, text) => { sent.push({ phone, text }); return { ok: true }; },
  },
});

const incoming = { phone: player, replyTo: player, pushName: 'Jogador Teste', text: 'menu', messageId: 'message-1' };
await bot.handleMenuCommand(incoming, { replyTo: player, originIp: 'test' });
assert.match(sent.at(-1).text, /PD-8F4K2M/);
assert.match(sent.at(-1).text, /Saldo dispon.vel: R\$\s*75,00/);
assert.match(sent.at(-1).text, /nenhum dinheiro real/);

await bot.handleFinancialCommand({ ...incoming, text: 'depositar 20' }, { replyTo: player, command: 'depositar 20', originIp: 'test' });
assert.match(sent.at(-1).text, /000201-TEST/);
assert.match(sent.at(-1).text, /webhook autenticado/);

await bot.handleFinancialCommand(
  { ...incoming, text: 'sacar 20 EMAIL chave-secreta@example.test | Jogador Teste' },
  { replyTo: player, command: 'sacar 20 email chave-secreta@example.test | jogador teste', originIp: 'test' },
);
assert.ok(sent.some((message) => message.phone === financialAdmin && message.text.includes('chave-secreta@example.test')));
assert.ok(!sent.some((message) => message.phone === unauthorized && message.text.includes('chave-secreta@example.test')));
assert.ok(!sent.filter((message) => message.phone === player).some((message) => message.text.includes('chave-secreta@example.test')));

const denied = await bot.handleSafeEntryAdminCommand(unauthorized, 'admin financeiro status', { replyTo: unauthorized });
assert.equal(denied.type, 'entry_admin_unauthorized');
const allowed = await bot.handleSafeEntryAdminCommand(financialAdmin, 'admin financeiro status', { replyTo: financialAdmin });
assert.equal(allowed.type, 'financial_admin_status');
assert.match(sent.at(-1).text, /STATUS FINANCEIRO/);

console.log('Financial WhatsApp menu and admin authorization tests passed.');
