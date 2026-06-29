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

function createBot(store = new WhatsAppEntryStore()) {
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
  assert.match(sentMessages.at(-1).text, /Você entrou na fila da Mesa R\$2/);
  assert.match(sentMessages.at(-1).text, /Para cancelar, digite sair ou menu/);
  assert.doesNotMatch(sentMessages.at(-1).text, /Pix|chave|https?:\/\//i);
  assert.equal(matchQueue.getQueueStatus(2).waitingPlayers, 1);

  const duplicateResult = await bot.handleConnectivityWebhook(createWebhook(firstPhone, '1', firstReplyJid));
  assert.equal(duplicateResult.type, 'whatsapp_queue_duplicate');
  assert.equal(sentMessages.at(-1).text, '⏳ Você já está aguardando um adversário nesta mesa.');

  const otherTableBlocked = await bot.handleConnectivityWebhook(createWebhook(firstPhone, '2', firstReplyJid));
  assert.equal(otherTableBlocked.type, 'whatsapp_queue_other_table_blocked');
  assert.match(sentMessages.at(-1).text, /outra mesa/);

  const secondResult = await chooseTable(bot, secondPhone, '1', '1', secondReplyJid);
  assert.equal(secondResult.type, 'whatsapp_match_created');
  assert.ok(secondResult.matchId);
  assert.equal(matchQueue.getQueueStatus(2).waitingPlayers, 0);

  const matchMessages = sentMessages.filter((message) => message.text.includes('🎮 Partida encontrada!'));
  assert.equal(matchMessages.length, 2);
  assert.ok(matchMessages.some((message) => message.phone === firstPhone));
  assert.ok(matchMessages.some((message) => message.phone === secondPhone));
  assert.ok(matchMessages.every((message) => message.text.includes('Mesa: R$2')));
  assert.ok(matchMessages.every((message) => message.text.includes('Entre na sala pelo link abaixo:')));
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
  const reservedLinkResult = await bot.handleConnectivityWebhook(createWebhook(firstPhone, '1', firstReplyJid));
  assert.equal(reservedLinkResult.type, 'whatsapp_queue_joined');
  assert.notEqual(reservedLinkResult.type, 'whatsapp_queue_active_match_blocked');
}

{
  const sharedStore = new WhatsAppEntryStore();
  const firstRuntime = createBot(sharedStore);
  const firstPhone = '551188880040';
  const secondPhone = '551188880041';
  const firstReplyJid = `${firstPhone}000@lid`;
  const secondReplyJid = `${secondPhone}000@lid`;

  const firstWaiting = await chooseTable(firstRuntime.bot, firstPhone, '1', '3', firstReplyJid);
  assert.equal(firstWaiting.type, 'whatsapp_queue_joined');
  assert.equal(firstWaiting.selectedTable, 10);
  assert.equal(firstRuntime.matchQueue.getQueueStatus(10).waitingPlayers, 1);
  assert.ok(sharedStore.listEntries().some((entry) => (
    entry.phone === firstPhone
    && entry.selectedTable === 10
    && entry.status === 'approved_for_queue'
    && entry.queuedAt
    && entry.whatsappReplyTo === firstReplyJid
  )));

  const secondRuntimeAfterMemoryLoss = createBot(sharedStore);
  assert.equal(secondRuntimeAfterMemoryLoss.matchQueue.getQueueStatus(10).waitingPlayers, 0);
  const secondMatch = await chooseTable(secondRuntimeAfterMemoryLoss.bot, secondPhone, '1', '3', secondReplyJid);
  assert.equal(secondMatch.type, 'whatsapp_match_created');
  assert.ok(secondMatch.matchId);
  assert.equal(secondRuntimeAfterMemoryLoss.matchQueue.getQueueStatus(10).waitingPlayers, 0);

  const matchMessages = secondRuntimeAfterMemoryLoss.sentMessages
    .filter((message) => message.text.includes('🎮 Partida encontrada!'));
  assert.equal(matchMessages.length, 2);
  assert.ok(matchMessages.some((message) => message.phone === firstPhone));
  assert.ok(matchMessages.some((message) => message.phone === secondPhone));
  assert.ok(matchMessages.every((message) => message.text.includes('Mesa: R$10')));
  assert.ok(matchMessages.every((message) => message.text.includes('?online=1&entry=')));
  assert.ok(sharedStore.listEntries()
    .filter((entry) => [firstPhone, secondPhone].includes(entry.phone))
    .every((entry) => entry.linkSentAt));
}

{
  const { bot, store, matchQueue, sentMessages } = createBot();
  const cancelPhone = '551188880010';
  await chooseTable(bot, cancelPhone, '1', '3');
  assert.equal(matchQueue.getQueueStatus(10).waitingPlayers, 1);

  const cancelResult = await bot.handleConnectivityWebhook(createWebhook(cancelPhone, 'sair'));
  assert.equal(cancelResult.type, 'whatsapp_queue_cancelled');
  assert.equal(matchQueue.getQueueStatus(10).waitingPlayers, 0);
  assert.match(sentMessages.at(-1).text, /Você saiu da fila/);
  assert.match(sentMessages.at(-1).text, /Bem-vindo ao Pife Duelo/);
  assert.equal(store.listEntries().at(-1).status, 'expired');
  assert.ok(store.listEntries().at(-1).auditLog.some((item) => item.action === 'entry_queue_cancelled'));

  await bot.handleConnectivityWebhook(createWebhook(cancelPhone, '1'));
  const rejoinResult = await bot.handleConnectivityWebhook(createWebhook(cancelPhone, '4'));
  assert.equal(rejoinResult.type, 'whatsapp_queue_joined');
  assert.equal(rejoinResult.selectedTable, 20);
  assert.equal(matchQueue.getQueueStatus(20).waitingPlayers, 1);

  const menuCancel = await bot.handleConnectivityWebhook(createWebhook(cancelPhone, 'menu'));
  assert.equal(menuCancel.type, 'whatsapp_queue_cancelled');
  assert.equal(matchQueue.getQueueStatus(20).waitingPlayers, 0);

  const emptyCancel = await bot.handleConnectivityWebhook(createWebhook('551188880011', 'cancelar'));
  assert.equal(emptyCancel.type, 'whatsapp_queue_cancel_empty');
  assert.match(sentMessages.at(-1).text, /não está aguardando/);
}

{
  const { bot, store, entryService, matchQueue, sentMessages } = createBot();
  const stalePhone = '551188880020';
  const staleEntry = entryService.createEntry({ phone: stalePhone, selectedTable: 10, source: 'stale-test' });
  const staleApproval = entryService.approveEntry({
    entryId: staleEntry.entryId,
    actor: 'test',
    source: 'stale-approved-entry-test',
  });
  entryService.markLinkDelivery(staleEntry.entryId, { sent: true });
  assert.equal(staleApproval.entry.status, 'approved_for_queue');
  assert.equal(staleApproval.entry.linkSentAt, null);
  assert.equal(staleApproval.entry.linkedMatchId, null);
  assert.equal(matchQueue.findActiveMatch(stalePhone), null);

  await bot.handleConnectivityWebhook(createWebhook(stalePhone, 'oi'));
  await bot.handleConnectivityWebhook(createWebhook(stalePhone, '1'));
  const staleJoin = await bot.handleConnectivityWebhook(createWebhook(stalePhone, '3'));
  assert.equal(staleJoin.type, 'whatsapp_queue_joined');
  assert.equal(staleJoin.selectedTable, 10);
  assert.match(sentMessages.at(-1).text, /Você entrou na fila da Mesa R\$10/);
  assert.notEqual(staleJoin.type, 'whatsapp_queue_active_match_blocked');
  assert.equal(store.getEntry(staleEntry.entryId).status, 'expired');
  assert.ok(store.getEntry(staleEntry.entryId).auditLog.some((item) => item.action === 'entry_queue_cancelled'));
  assert.equal(matchQueue.getQueueStatus(10).waitingPlayers, 1);
}

{
  const { bot, entryService, sentMessages } = createBot();
  const activePhone = '551188880030';
  const activeEntry = entryService.createEntry({ phone: activePhone, selectedTable: 5, source: 'active-test' });
  entryService.approveEntry({
    entryId: activeEntry.entryId,
    actor: 'test',
    source: 'active-entry-test',
  });
  entryService.reserveQueueAccess({
    entryId: activeEntry.entryId,
    socketId: 'socket-active-test',
    selectedTable: 5,
  });

  await bot.handleConnectivityWebhook(createWebhook(activePhone, 'oi'));
  await bot.handleConnectivityWebhook(createWebhook(activePhone, '1'));
  const activeBlocked = await bot.handleConnectivityWebhook(createWebhook(activePhone, '2'));
  assert.equal(activeBlocked.type, 'whatsapp_queue_active_match_blocked');
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
