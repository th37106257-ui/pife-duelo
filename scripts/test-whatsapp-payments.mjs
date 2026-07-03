import assert from 'node:assert/strict';
import { PaymentStore } from '../server/src/payments/PaymentStore.js';
import { PaymentService } from '../server/src/payments/PaymentService.js';
import { buildEvolutionMessageDiagnostic, WhatsAppPaymentBot } from '../server/src/payments/WhatsAppPaymentBot.js';
import { EvolutionClient } from '../server/src/payments/EvolutionClient.js';

let now = Date.parse('2026-06-20T12:00:00.000Z');
const adminPhone = '5511999990000';
const playerPhone = '5511888880000';
const unauthorizedPhone = '5511777770000';
const sentMessages = [];
const store = new PaymentStore();
const paymentService = new PaymentService({
  store,
  adminNumbers: [adminPhone],
  accessSecret: 'test-secret-with-enough-entropy',
  publicGameUrl: 'https://pife-duelo.example',
  clock: () => now,
  tokenFactory: () => `token-${store.listPayments().length}-${now}`,
});
const evolutionClient = {
  isConfigured: () => true,
  sendText: async (phone, text) => {
    sentMessages.push({ phone, text: String(text) });
    return { ok: true };
  },
};
const bot = new WhatsAppPaymentBot({
  paymentService,
  evolutionClient,
  pixKey: 'pix-chave-teste',
  pixReceiver: 'Pife Duelo Teste',
  adminNumbers: [adminPhone],
  clock: () => now,
});

const connectivityMessages = [];
const connectivityBot = new WhatsAppPaymentBot({
  evolutionClient: {
    isConfigured: () => true,
    sendText: async (phone, text) => connectivityMessages.push({ phone, text }),
  },
  adminNumbers: [adminPhone],
  supportNumber: '55 11 99999-1111',
  publicGameUrl: 'https://pife-duelo.example',
});

function advance() {
  now += 4000;
}

function webhook({ phone, id, text = '', receipt = false }) {
  const message = receipt
    ? { imageMessage: { caption: text } }
    : { conversation: text };
  return {
    event: 'messages.upsert',
    instance: 'pife-duelo',
    data: {
      key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id },
      message,
    },
  };
}

async function sendIncoming(input) {
  advance();
  return bot.handleWebhook(webhook(input), { originIp: '127.0.0.1' });
}

let connectivitySequence = 0;
async function sendConnectivity(text, phone = playerPhone) {
  connectivitySequence += 1;
  return connectivityBot.handleConnectivityWebhook(webhook({
    phone,
    id: `connectivity-${connectivitySequence}`,
    text,
  }), { originIp: '127.0.0.1' });
}

const connectivityReply = await sendConnectivity('oi');
assert.equal(connectivityReply.type, 'whatsapp_menu_sent');
assert.equal(connectivityReply.state, 'idle');
assert.match(connectivityMessages.at(-1).text, /Bem-vindo ao Pife Duelo/);
assert.match(connectivityMessages.at(-1).text, /1\uFE0F\u20E3 Jogar valendo/);
assert.match(connectivityMessages.at(-1).text, /2\uFE0F\u20E3 Modo teste gr/);

const safeTables = await sendConnectivity('1');
assert.equal(safeTables.type, 'whatsapp_tables_sent');
assert.equal(safeTables.state, 'choosing_table');
assert.match(connectivityMessages.at(-1).text, /Mesa R\$2,00/);
assert.match(connectivityMessages.at(-1).text, /Mesa R\$20,00/);

const safeTableTwo = await sendConnectivity('1');
assert.equal(safeTableTwo.type, 'whatsapp_table_selected_safe');
assert.equal(safeTableTwo.selectedTable, 2);
assert.equal(connectivityBot.getConversationState(playerPhone).state, 'table_selected');
assert.match(connectivityMessages.at(-1).text, /Mesa selecionada: R\$2,00/);
assert.match(connectivityMessages.at(-1).text, /modo seguro\/desligado/);

for (const [option, amount] of [['2', 5], ['3', 10], ['4', 20]]) {
  await sendConnectivity('menu');
  await sendConnectivity('1');
  const selection = await sendConnectivity(option);
  assert.equal(selection.type, 'whatsapp_table_selected_safe');
  assert.equal(selection.selectedTable, amount);
  assert.match(connectivityMessages.at(-1).text, new RegExp(`Mesa selecionada: R\\$${amount},00`));
}

await sendConnectivity('ol\u00e1');
const testModeByOptionTwo = await sendConnectivity('2');
assert.equal(testModeByOptionTwo.type, 'whatsapp_test_mode_link_sent');
assert.equal(testModeByOptionTwo.testModeLink, 'https://pife-duelo.example/?mode=test');
assert.match(connectivityMessages.at(-1).text, /Modo Teste gr/);
assert.match(connectivityMessages.at(-1).text, /Sem Pix/);
assert.match(connectivityMessages.at(-1).text, /https:\/\/pife-duelo\.example\/\?mode=test/);

await sendConnectivity('come\u00e7ar');
const safeRules = await sendConnectivity('3');
assert.equal(safeRules.type, 'whatsapp_rules_sent');
assert.match(connectivityMessages.at(-1).text, /Tempo por jogada: 60 segundos/);

await sendConnectivity('iniciar');
const safeSupport = await sendConnectivity('4');
assert.equal(safeSupport.type, 'whatsapp_support_sent');
assert.match(connectivityMessages.at(-1).text, /Suporte Pife Duelo/);
assert.match(connectivityMessages.at(-1).text, /https:\/\/wa\.me\/5511999991111\?text=Ol%C3%A1,%20preciso%20de%20suporte%20no%20Pife%20Duelo/);

const safeSupportByText = await sendConnectivity('ajuda');
assert.equal(safeSupportByText.type, 'whatsapp_support_sent');
assert.match(connectivityMessages.at(-1).text, /print do erro/);

const invalidSafeOption = await sendConnectivity('qualquer coisa');
assert.equal(invalidSafeOption.type, 'whatsapp_invalid_option');
assert.match(connectivityMessages.at(-1).text, /Digite menu/);

const lidPayload = webhook({ phone: playerPhone, id: 'lid-1', text: 'oi' });
lidPayload.data.key.remoteJid = '123456789012@lid';
lidPayload.data.sender = `${playerPhone}@s.whatsapp.net`;
const lidReply = await connectivityBot.handleConnectivityWebhook(lidPayload, { originIp: '127.0.0.1' });
assert.equal(lidReply.type, 'whatsapp_menu_sent');
assert.equal(connectivityMessages.at(-1).phone, playerPhone, 'Mensagens recebidas por @lid devem ser respondidas no numero real do jogador.');
assert.equal(connectivityBot.getConversationState(playerPhone).state, 'idle', 'O estado interno continua vinculado ao número real do jogador.');

const lidAltPayload = webhook({ phone: playerPhone, id: 'lid-alt-1', text: 'oi' });
lidAltPayload.data.key.remoteJid = `${playerPhone}@s.whatsapp.net`;
lidAltPayload.data.key.remoteJidAlt = '210987654321@lid';
const lidAltReply = await connectivityBot.handleConnectivityWebhook(lidAltPayload, { originIp: '127.0.0.1' });
assert.equal(lidAltReply.type, 'whatsapp_menu_sent');
assert.equal(connectivityMessages.at(-1).phone, playerPhone, 'Quando remoteJidAlt trouxer @lid, a resposta deve priorizar o numero real do jogador.');
assert.equal(connectivityBot.getConversationState(playerPhone).state, 'idle');

assert.equal(store.listPayments().length, 0, 'Menu seguro n\u00e3o cria pagamento.');
assert.ok(connectivityMessages.every(({ text }) => !/chave pix|access=/i.test(text)), 'Menu seguro n\u00e3o envia Pix nem link pago.');

const outgoingDiagnostic = buildEvolutionMessageDiagnostic({
  ...webhook({ phone: playerPhone, id: 'outgoing-1', text: 'oi' }),
  data: {
    ...webhook({ phone: playerPhone, id: 'outgoing-1', text: 'oi' }).data,
    key: { remoteJid: `${playerPhone}@s.whatsapp.net`, fromMe: true, id: 'outgoing-1' },
  },
});
assert.equal(outgoingDiagnostic.decision, 'ignored_from_me');
assert.equal(outgoingDiagnostic.reason, 'key_from_me_true');
assert.doesNotMatch(outgoingDiagnostic.remoteJid, new RegExp(playerPhone));
const outgoingResult = await connectivityBot.handleConnectivityWebhook({
  ...webhook({ phone: playerPhone, id: 'outgoing-1', text: 'oi' }),
  data: {
    ...webhook({ phone: playerPhone, id: 'outgoing-1', text: 'oi' }).data,
    key: { remoteJid: `${playerPhone}@s.whatsapp.net`, fromMe: true, id: 'outgoing-1' },
  },
});
assert.equal(outgoingResult.decision, 'ignored_from_me');

const incomingFalseString = webhook({ phone: playerPhone, id: 'incoming-string-false', text: 'oi' });
incomingFalseString.data.key.fromMe = 'false';
const incomingStringResult = await connectivityBot.handleConnectivityWebhook(incomingFalseString);
assert.equal(incomingStringResult.decision, 'reply_sent', 'Somente o booleano true deve indicar fromMe.');

const emptyMessagePayload = webhook({ phone: playerPhone, id: 'empty-1', text: '' });
const emptyMessageResult = await connectivityBot.handleConnectivityWebhook(emptyMessagePayload);
assert.equal(emptyMessageResult.decision, 'ignored_invalid');
assert.equal(emptyMessageResult.reason, 'empty_text');

const groupPayload = webhook({ phone: playerPhone, id: 'group-1', text: 'oi' });
groupPayload.data.key.remoteJid = '120363000000000000@g.us';
groupPayload.data.key.participant = `${playerPhone}@s.whatsapp.net`;
const groupResult = await connectivityBot.handleConnectivityWebhook(groupPayload);
assert.equal(groupResult.decision, 'ignored_invalid');
assert.equal(groupResult.reason, 'group_not_supported');

const menu = await sendIncoming({ phone: playerPhone, id: 'msg-1', text: 'oi' });
assert.equal(menu.type, 'menu_sent');
assert.ok(sentMessages.at(-1).text.startsWith('🎴 Pife Duelo online.'));
assert.match(sentMessages.at(-1).text, /Escolha uma mesa/i);

const table = await sendIncoming({ phone: playerPhone, id: 'msg-2', text: '5' });
assert.equal(table.type, 'table_selected');
let payment = paymentService.getPayment(table.paymentId);
assert.equal(payment.status, 'pending');
assert.equal(payment.selectedTable, 5);
assert.equal(payment.receiptReceived, false);
assert.equal(paymentService.validateAccessToken('not-a-token'), null);

const receipt = await sendIncoming({ phone: playerPhone, id: 'msg-3', receipt: true });
assert.equal(receipt.type, 'receipt_received');
payment = paymentService.getPayment(table.paymentId);
assert.equal(payment.status, 'pending', 'Comprovante nunca confirma automaticamente.');
assert.equal(payment.receiptReceived, true);

const lockedTable = await sendIncoming({ phone: playerPhone, id: 'msg-4', text: '10' });
assert.equal(lockedTable.type, 'table_selection_failed');
assert.equal(lockedTable.error, 'TABLE_LOCKED_AFTER_RECEIPT');
assert.equal(paymentService.getPayment(table.paymentId).selectedTable, 5);

const pending = await sendIncoming({ phone: adminPhone, id: 'msg-5', text: '/admin pendentes' });
assert.equal(pending.type, 'admin_pending_list');
assert.match(sentMessages.at(-1).text, new RegExp(`#${table.paymentId}`));
assert.doesNotMatch(sentMessages.at(-1).text, new RegExp(playerPhone));
assert.match(sentMessages.at(-1).text, /\*+0000/);

const unauthorized = await sendIncoming({ phone: unauthorizedPhone, id: 'msg-6', text: `/admin confirmar ${table.paymentId}` });
assert.equal(unauthorized.type, 'admin_unauthorized');
assert.equal(sentMessages.at(-1).text, 'Comando não autorizado.');
assert.equal(paymentService.getPayment(table.paymentId).status, 'pending');

const confirmed = await sendIncoming({ phone: adminPhone, id: 'msg-7', text: `/admin confirmar ${table.paymentId}` });
assert.equal(confirmed.type, 'payment_confirmed');
payment = paymentService.getPayment(table.paymentId);
assert.equal(payment.status, 'confirmed');
assert.equal(payment.confirmedBy, adminPhone);
assert.ok(payment.confirmedAt);
assert.ok(payment.linkSentAt);
const playerLinkMessage = sentMessages.findLast((message) => message.phone === playerPhone && message.text.includes('access='));
assert.ok(playerLinkMessage, 'Link deve ser enviado ao jogador confirmado.');
const accessToken = new URL(playerLinkMessage.text.split('\n').at(-1)).searchParams.get('access');
assert.equal(paymentService.validateAccessToken(accessToken)?.paymentId, table.paymentId);

const duplicateConfirmation = await sendIncoming({ phone: adminPhone, id: 'msg-8', text: `/admin confirmar ${table.paymentId}` });
assert.equal(duplicateConfirmation.type, 'admin_command_failed');
assert.equal(duplicateConfirmation.error, 'PAYMENT_NOT_PENDING');
const confirmedAudits = paymentService.getPayment(table.paymentId).auditLog.filter((entry) => entry.action === 'payment_confirmed');
assert.equal(confirmedAudits.length, 1, 'Pagamento só pode ser confirmado uma vez.');

assert.throws(
  () => paymentService.reserveAccess({ paymentId: table.paymentId, socketId: 'socket-1', selectedTable: 10 }),
  /PAYMENT_TABLE_MISMATCH/,
);
paymentService.reserveAccess({ paymentId: table.paymentId, socketId: 'socket-1', selectedTable: 5 });
assert.throws(
  () => paymentService.reserveAccess({ paymentId: table.paymentId, socketId: 'socket-2', selectedTable: 5 }),
  /PAYMENT_ACCESS_RESERVED/,
);
paymentService.consumeAccess({ paymentId: table.paymentId, socketId: 'socket-1', matchId: 'match-test-1' });
assert.throws(
  () => paymentService.reserveAccess({ paymentId: table.paymentId, socketId: 'socket-1', selectedTable: 5 }),
  /PAYMENT_ACCESS_ALREADY_USED/,
);

const retryPhone = '5511555550000';
const retryPending = paymentService.selectTable({ phone: retryPhone, selectedTable: 2, source: 'test' });
paymentService.markReceiptReceived({ phone: retryPhone, messageId: 'retry-receipt', source: 'test' });
const firstDelivery = paymentService.confirmPayment({ paymentId: retryPending.paymentId, adminPhone, source: 'test' });
const firstDeliveryToken = new URL(firstDelivery.accessLink).searchParams.get('access');
paymentService.markLinkDelivery(retryPending.paymentId, { sent: false, error: 'temporary Evolution failure' });
advance();
const retriedDelivery = paymentService.retryAccessLinkDelivery({ paymentId: retryPending.paymentId, adminPhone, source: 'test-retry' });
const retriedToken = new URL(retriedDelivery.accessLink).searchParams.get('access');
assert.notEqual(retriedToken, firstDeliveryToken);
assert.equal(paymentService.validateAccessToken(firstDeliveryToken), null);
assert.equal(paymentService.validateAccessToken(retriedToken)?.paymentId, retryPending.paymentId);
let retryPayment = paymentService.getPayment(retryPending.paymentId);
assert.equal(retryPayment.auditLog.filter((entry) => entry.action === 'payment_confirmed').length, 1);
assert.equal(retryPayment.auditLog.filter((entry) => entry.action === 'access_link_regenerated').length, 1);
paymentService.markLinkDelivery(retryPending.paymentId, { sent: true });
assert.throws(
  () => paymentService.retryAccessLinkDelivery({ paymentId: retryPending.paymentId, adminPhone, source: 'test-retry-again' }),
  /PAYMENT_NOT_PENDING/,
);

const secondPlayer = '5511666660000';
const secondTable = await sendIncoming({ phone: secondPlayer, id: 'msg-9', text: '2' });
await sendIncoming({ phone: secondPlayer, id: 'msg-10', receipt: true });
const rejected = await sendIncoming({ phone: adminPhone, id: 'msg-11', text: `/admin rejeitar ${secondTable.paymentId} comprovante ilegivel` });
assert.equal(rejected.type, 'payment_rejected');
const rejectedPayment = paymentService.getPayment(secondTable.paymentId);
assert.equal(rejectedPayment.status, 'rejected');
assert.equal(rejectedPayment.rejectedBy, adminPhone);
assert.ok(rejectedPayment.rejectedAt);
assert.equal(rejectedPayment.rejectionReason, 'comprovante ilegivel');
assert.ok(rejectedPayment.auditLog.some((entry) => entry.action === 'payment_rejected'));

const messageCount = sentMessages.length;
const duplicateWebhook = await bot.handleWebhook(webhook({ phone: secondPlayer, id: 'msg-10', receipt: true }));
assert.equal(duplicateWebhook.reason, 'duplicate-message');
assert.equal(sentMessages.length, messageCount);

const requestCapture = [];
const contractClient = new EvolutionClient({
  baseUrl: 'https://evolution.example',
  apiKey: 'backend-only-key',
  instanceName: 'pife-duelo',
  fetchImpl: async (url, options) => {
    requestCapture.push({ url, options });
    return { ok: true, json: async () => ({ ok: true }) };
  },
});
await contractClient.sendText(playerPhone, 'teste');
assert.equal(requestCapture[0].url, 'https://evolution.example/message/sendText/pife-duelo');
assert.equal(requestCapture[0].options.headers.apikey, 'backend-only-key');
assert.deepEqual(JSON.parse(requestCapture[0].options.body), {
  number: `${playerPhone}@s.whatsapp.net`,
  text: 'teste',
});
await contractClient.sendText('123456789012@lid', 'teste lid');
assert.deepEqual(JSON.parse(requestCapture[1].options.body), {
  number: '123456789012@lid',
  text: 'teste lid',
});

console.log('WhatsApp/Pix: fluxo manual, auditoria, autorização, idempotência e acesso validados.');
