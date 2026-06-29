import assert from 'node:assert/strict';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';
import { WhatsAppPaymentBot } from '../server/src/payments/WhatsAppPaymentBot.js';
import { MatchQueue } from '../server/src/services/matchQueue.js';

let now = Date.parse('2026-06-29T10:00:00.000Z');
let tokenSequence = 0;
let messageSequence = 0;

function createEntryService(store = new WhatsAppEntryStore()) {
  return new WhatsAppEntryService({
    store,
    adminNumbers: ['5511999990000'],
    accessSecret: 'whatsapp-match-queue-secret',
    publicGameUrl: 'https://pife-duelo.example',
    clock: () => now,
    tokenFactory: () => `queue-entry-token-${++tokenSequence}`,
  });
}

function createWebhook(phone, text, replyJid = `${phone}@s.whatsapp.net`) {
  messageSequence += 1;
  return {
    event: 'messages.upsert',
    instance: 'pife-duelo',
    data: {
      key: {
        remoteJid: replyJid,
        fromMe: false,
        id: `queue-msg-${messageSequence}`,
      },
      sender: `${phone}@s.whatsapp.net`,
      message: { conversation: text },
    },
  };
}

function createBot() {
  const store = new WhatsAppEntryStore();
  const entryService = createEntryService(store);
  const matchQueue = new MatchQueue({
    entryService,
    clock: () => now,
  });
  const sentMessages = [];
  const bot = new WhatsAppPaymentBot({
    entryService,
    matchQueue,
    safeEntryEnabled: true,
    evolutionClient: {
      isConfigured: () => true,
      sendText: async (phone, text) => sentMessages.push({ phone, text }),
    },
    adminNumbers: ['5511999990000'],
    clock: () => now,
  });

  return { bot, store, entryService, matchQueue, sentMessages };
}

async function chooseTable(bot, phone, menuOption = '1', tableOption = '1', replyJid = `${phone}@s.whatsapp.net`) {
  await bot.handleConnectivityWebhook(createWebhook(phone, 'oi', replyJid));
  await bot.handleConnectivityWebhook(createWebhook(phone, menuOption, replyJid));
  return bot.handleConnectivityWebhook(createWebhook(phone, tableOption, replyJid));
}

{
  const { bot, store, matchQueue, sentMessages } = createBot();
  const firstPhone = '551188880001';
  const secondPhone = '551188880002';
  const firstReplyJid = `${firstPhone}000@lid`;
  const secondReplyJid = `${secondPhone}000@lid`;

  const firstResult = await chooseTable(bot, firstPhone, '1', '1', firstReplyJid);
  assert.equal(firstResult.type, 'whatsapp_queue_joined');
  assert.equal(firstResult.selectedTable, 2);
  assert.match(sentMessages.at(-1).text, /Você entrou na fila da mesa R\$2,00/);
  assert.doesNotMatch(sentMessages.at(-1).text, /Pix|chave|https?:\/\//i);
  assert.equal(matchQueue.getQueueStatus(2).waitingPlayers, 1);

  const duplicateResult = await bot.handleConnectivityWebhook(createWebhook(firstPhone, '1', firstReplyJid));
  assert.equal(duplicateResult.type, 'whatsapp_queue_duplicate');
  assert.equal(sentMessages.at(-1).text, '⏳ Você já está aguardando um adversário nesta mesa.');

  const secondResult = await chooseTable(bot, secondPhone, '1', '1', secondReplyJid);
  assert.equal(secondResult.type, 'whatsapp_match_created');
  assert.ok(secondResult.matchId);
  assert.equal(matchQueue.getQueueStatus(2).waitingPlayers, 0);

  const matchMessages = sentMessages.filter((message) => message.text.includes('🎮 Partida encontrada!'));
  assert.equal(matchMessages.length, 2);
  assert.ok(matchMessages.some((message) => message.phone === firstReplyJid));
  assert.ok(matchMessages.some((message) => message.phone === secondReplyJid));
  assert.ok(matchMessages.every((message) => message.text.includes('?online=1&entry=')));
  assert.ok(matchMessages.every((message) => !/Pix|chave/i.test(message.text)));

  const entries = store.listEntries();
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.status === 'approved_for_queue'));
  assert.ok(entries.every((entry) => entry.linkSentAt));
  assert.ok(entries.every((entry) => entry.auditLog.some((item) => item.action === 'entry_approved_for_queue')));
  assert.ok(entries.every((entry) => entry.auditLog.some((item) => item.action === 'entry_link_sent')));

  await bot.handleConnectivityWebhook(createWebhook(firstPhone, 'menu', firstReplyJid));
  await bot.handleConnectivityWebhook(createWebhook(firstPhone, '1', firstReplyJid));
  const activeResult = await bot.handleConnectivityWebhook(createWebhook(firstPhone, '1', firstReplyJid));
  assert.equal(activeResult.type, 'whatsapp_queue_active_match_blocked');
  assert.equal(sentMessages.at(-1).text, '⚠️ Você já está em uma partida ativa.');
}

{
  const { matchQueue } = createBot();
  for (const [tableValue, queueId] of [[2, 'mesa_2'], [5, 'mesa_5'], [10, 'mesa_10'], [20, 'mesa_20']]) {
    const first = matchQueue.joinQueue(`55117777${String(tableValue).padStart(4, '0')}`, tableValue);
    assert.equal(first.blocked, false);
    assert.equal(first.entry.tableId, queueId);
    assert.equal(matchQueue.getQueueStatus(tableValue).waitingPlayers, 1);
    const removed = matchQueue.removeFromQueue(first.entry.playerPhone);
    assert.equal(removed.removed, true);
    assert.equal(matchQueue.getQueueStatus(tableValue).waitingPlayers, 0);
  }
}

console.log('WhatsApp match queue: filas por mesa, duplicidade, pareamento e links seguros validados.');
