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

function createWebhook(phone, text, replyJid = `${phone}@s.whatsapp.net`, { senderJid = `${phone}@s.whatsapp.net`, ownerJid = null } = {}) {
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
      ownerJid,
      sender: senderJid,
      message: { conversation: text },
    },
  };
}

function createBot(store = new WhatsAppEntryStore(), { sendText = null } = {}) {
  const entryService = createEntryService(store);
  const logs = [];
  const matchQueue = new MatchQueue({
    entryService,
    clock: () => now,
    logInfo: (event, payload) => logs.push({ level: 'info', event, payload }),
    logWarn: (event, payload) => logs.push({ level: 'warn', event, payload }),
    logError: (event, payload) => logs.push({ level: 'error', event, payload }),
  });
  const sentMessages = [];
  const bot = new WhatsAppPaymentBot({
    entryService,
    matchQueue,
    safeEntryEnabled: true,
    evolutionClient: {
      isConfigured: () => true,
      sendText: sendText ?? (async (phone, text) => sentMessages.push({ phone, text })),
    },
    adminNumbers: ['5511999990000'],
    publicGameUrl: 'https://pife-duelo.example',
    clock: () => now,
    logInfo: (event, payload) => logs.push({ level: 'info', event, payload }),
    logWarn: (event, payload) => logs.push({ level: 'warn', event, payload }),
    logError: (event, payload) => logs.push({ level: 'error', event, payload }),
  });

  return { bot, store, entryService, matchQueue, sentMessages, logs };
}

function extractFirstUrl(text) {
  return String(text || '').match(/https?:\/\/\S+/)?.[0] || '';
}

async function chooseTable(bot, phone, menuOption = '1', tableOption = '1', replyJid = `${phone}@s.whatsapp.net`) {
  await bot.handleConnectivityWebhook(createWebhook(phone, 'oi', replyJid));
  await bot.handleConnectivityWebhook(createWebhook(phone, menuOption, replyJid));
  return bot.handleConnectivityWebhook(createWebhook(phone, tableOption, replyJid));
}

async function chooseTableWithSender(bot, phone, menuOption, tableOption, replyJid, senderJid, ownerJid = null) {
  await bot.handleConnectivityWebhook(createWebhook(phone, 'oi', replyJid, { senderJid, ownerJid }));
  await bot.handleConnectivityWebhook(createWebhook(phone, menuOption, replyJid, { senderJid, ownerJid }));
  return bot.handleConnectivityWebhook(createWebhook(phone, tableOption, replyJid, { senderJid, ownerJid }));
}

{
  const { bot, store, matchQueue, sentMessages, logs } = createBot();
  const testPhone = '551188889900';

  const menuResult = await bot.handleConnectivityWebhook(createWebhook(testPhone, 'menu'));
  assert.equal(menuResult.type, 'whatsapp_menu_sent');
  assert.match(sentMessages.at(-1).text, /Jogar valendo/);
  assert.match(sentMessages.at(-1).text, /Modo teste gr/);

  const testModeResult = await bot.handleConnectivityWebhook(createWebhook(testPhone, '2'));
  assert.equal(testModeResult.type, 'whatsapp_test_mode_link_sent');
  assert.equal(testModeResult.testModeLink, 'https://pife-duelo.example/?mode=test');
  assert.match(sentMessages.at(-1).text, /Modo Teste gr/);
  assert.match(sentMessages.at(-1).text, /Sem Pix/);
  assert.match(sentMessages.at(-1).text, /sem pagar nada/i);
  assert.match(sentMessages.at(-1).text, /https:\/\/pife-duelo\.example\/\?mode=test/);
  assert.equal(store.listEntries().length, 0);
  assert.equal(matchQueue.getQueueStatus(5).waitingPlayers, 0);
  assert.ok(logs.some((log) => log.event === 'WHATSAPP_TEST_MODE_REQUEST'));
  assert.ok(logs.some((log) => log.event === 'WHATSAPP_TEST_MODE_LINK_SENT'));

  const paidTables = await bot.handleConnectivityWebhook(createWebhook(testPhone, '1'));
  assert.equal(paidTables.type, 'whatsapp_tables_sent');
  const paidQueue = await bot.handleConnectivityWebhook(createWebhook(testPhone, '2'));
  assert.equal(paidQueue.type, 'whatsapp_queue_joined');
  assert.equal(paidQueue.selectedTable, 5);
  assert.equal(matchQueue.getQueueStatus(5).waitingPlayers, 1);
  assert.equal(store.listEntries().length, 1);
}

{
  const { bot, sentMessages } = createBot();
  const adminPhone = '5511999990000';
  const playerPhone = '551188889901';

  const adminIdentity = await bot.handleConnectivityWebhook(createWebhook(adminPhone, 'meu numero'));
  assert.equal(adminIdentity.type, 'whatsapp_identity_sent');
  assert.ok(sentMessages.at(-1).text.includes(`Seu número: ${adminPhone}`));
  assert.ok(sentMessages.at(-1).text.includes('Admin autorizado: sim'));

  const playerIdentity = await bot.handleConnectivityWebhook(createWebhook(playerPhone, 'meu número'));
  assert.equal(playerIdentity.type, 'whatsapp_identity_sent');
  assert.ok(sentMessages.at(-1).text.includes(`Seu número: ${playerPhone}`));
  assert.ok(sentMessages.at(-1).text.includes('Admin autorizado: não'));
}

{
  const { bot, sentMessages, logs } = createBot();
  const adminPhone = '5511999990000';
  const unauthorizedPhone = '551177770000';

  const ping = await bot.handleConnectivityWebhook(createWebhook(adminPhone, 'admin ping'));
  assert.equal(ping.type, 'entry_admin_ping');
  assert.equal(sentMessages.at(-1).text, '✅ Admin ativo.');

  const status = await bot.handleConnectivityWebhook(createWebhook(adminPhone, 'admin status'));
  assert.equal(status.type, 'entry_admin_status');
  assert.ok(sentMessages.at(-1).text.includes('Admin reconhecido'));
  assert.ok(sentMessages.at(-1).text.includes(adminPhone));

  const denied = await bot.handleConnectivityWebhook(createWebhook(unauthorizedPhone, 'admin ping'));
  assert.equal(denied.type, 'entry_admin_unauthorized');
  assert.equal(sentMessages.at(-1).text, '❌ Comando admin não autorizado para este número.');

  const invalid = await bot.handleConnectivityWebhook(createWebhook(adminPhone, 'admin recolocar'));
  assert.equal(invalid.type, 'entry_admin_invalid_format');
  assert.ok(sentMessages.at(-1).text.includes('Formato inválido'));

  const notFound = await bot.handleConnectivityWebhook(createWebhook(adminPhone, 'admin recolocar +55 21 99999-9999'));
  assert.equal(notFound.type, 'entry_admin_paid_decision_failed');
  assert.equal(notFound.targetPhone, '*********9999');
  assert.ok(sentMessages.at(-1).text.includes('Jogador'));
  assert.ok(logs.some((log) => log.event === 'ADMIN_COMMAND_RECEIVED'));
  assert.ok(logs.some((log) => log.event === 'ADMIN_COMMAND_AUTH_CHECK' && log.payload.isAdmin === true));
  assert.ok(logs.some((log) => log.event === 'ADMIN_COMMAND_DENIED'));
  assert.ok(logs.some((log) => log.event === 'ADMIN_COMMAND_INVALID_FORMAT'));
  assert.ok(logs.some((log) => log.event === 'ADMIN_COMMAND_EXECUTED'));
}

{
  const { bot, store, matchQueue, sentMessages, logs } = createBot();
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
  assert.ok(logs.some((log) => log.event === 'PLAYER_BLOCKED_ACTIVE_QUEUE'
    && log.payload.currentTable === 2
    && log.payload.attemptedTable === 5));

  const secondResult = await chooseTable(bot, secondPhone, '1', '1', secondReplyJid);
  assert.equal(secondResult.type, 'whatsapp_match_created');
  assert.ok(secondResult.matchId);
  assert.equal(matchQueue.getQueueStatus(2).waitingPlayers, 0);

  const matchMessages = sentMessages.filter((message) => message.text.includes('🎮 Partida encontrada!'));
  assert.equal(matchMessages.length, 2);
  assert.ok(matchMessages.some((message) => message.phone === firstReplyJid));
  assert.ok(matchMessages.some((message) => message.phone === secondReplyJid));
  assert.ok(matchMessages.every((message) => message.text.includes('Mesa: R$2')));
  assert.ok(matchMessages.every((message) => message.text.includes('Entre na sala pelo link abaixo:')));
  assert.ok(matchMessages.every((message) => message.text.includes('?online=1&entry=')));
  const matchUrls = matchMessages.map((message) => new URL(extractFirstUrl(message.text)));
  assert.ok(matchUrls.every((url) => url.pathname.startsWith('/join/whatsapp_match-')));
  assert.equal(matchUrls[0].pathname, matchUrls[1].pathname, 'Os dois jogadores devem receber o mesmo matchId no caminho do link.');
  assert.notEqual(matchUrls[0].searchParams.get('entry'), matchUrls[1].searchParams.get('entry'), 'Cada jogador mantem token individual seguro.');
  assert.ok(matchMessages.every((message) => !/Pix|chave/i.test(message.text)));

  const entries = store.listEntries();
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.status === 'approved_for_queue'));
  assert.ok(entries.every((entry) => entry.linkSentAt));
  assert.ok(entries.every((entry) => entry.auditLog.some((item) => item.action === 'entry_approved_for_queue')));
  assert.ok(entries.every((entry) => entry.auditLog.some((item) => item.action === 'entry_link_sent')));

  const paidCancelBlocked = await bot.handleConnectivityWebhook(createWebhook(firstPhone, 'menu', firstReplyJid));
  assert.equal(paidCancelBlocked.type, 'whatsapp_paid_entry_preserved');
  assert.equal(store.listEntries().find((entry) => entry.phone === firstPhone).status, 'approved_for_queue');
  assert.ok(logs.some((log) => log.event === 'PLAYER_CANCEL_BLOCKED_AFTER_PAYMENT'));
}

{
  const { bot, matchQueue, sentMessages, logs } = createBot();
  const botJid = '5521999974561@s.whatsapp.net';
  const firstPhone = '551188880080';
  const secondPhone = '551188880081';
  const firstReplyJid = `${firstPhone}999@lid`;
  const secondReplyJid = `${secondPhone}999@lid`;

  const firstResult = await chooseTableWithSender(bot, firstPhone, '1', '2', firstReplyJid, botJid, botJid);
  assert.equal(firstResult.type, 'whatsapp_queue_joined');
  assert.equal(firstResult.selectedTable, 5);
  assert.equal(matchQueue.getQueueStatus(5).waitingPlayers, 1);

  const secondResult = await chooseTableWithSender(bot, secondPhone, '1', '2', secondReplyJid, botJid, botJid);
  assert.equal(secondResult.type, 'whatsapp_match_created');
  assert.equal(secondResult.selectedTable, 5);
  assert.equal(matchQueue.getQueueStatus(5).waitingPlayers, 0);

  const matchMessages = sentMessages.filter((message) => message.text.includes('Partida encontrada!'));
  assert.equal(matchMessages.length, 2);
  assert.ok(matchMessages.some((message) => message.phone === firstReplyJid));
  assert.ok(matchMessages.some((message) => message.phone === secondReplyJid));
  assert.ok(matchMessages.every((message) => message.text.includes('Mesa: R$5')));
  const matchUrls = matchMessages.map((message) => new URL(extractFirstUrl(message.text)));
  assert.ok(matchUrls.every((url) => url.pathname.startsWith('/join/whatsapp_match-')));
  assert.equal(matchUrls[0].pathname, matchUrls[1].pathname);
  assert.ok(logs.some((log) => log.event === 'WHATSAPP_QUEUE_JOIN'));
  assert.ok(logs.some((log) => log.event === 'WHATSAPP_QUEUE_STATE'));
  assert.ok(logs.some((log) => log.event === 'MATCH_CREATED'
    && log.payload.matchId === secondResult.matchId
    && log.payload.table === 5
    && log.payload.players.length === 2));
  assert.equal(logs.filter((log) => log.event === 'WHATSAPP_MATCH_LINK_SENT'
    && log.payload.matchId === secondResult.matchId).length, 2);
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
  assert.ok(matchMessages.some((message) => message.phone === firstReplyJid));
  assert.ok(matchMessages.some((message) => message.phone === secondReplyJid));
  assert.ok(matchMessages.every((message) => message.text.includes('Mesa: R$10')));
  assert.ok(matchMessages.every((message) => message.text.includes('?online=1&entry=')));
  assert.ok(sharedStore.listEntries()
    .filter((entry) => [firstPhone, secondPhone].includes(entry.phone))
    .every((entry) => entry.linkSentAt));
}

{
  const sentMessages = [];
  const runtime = createBot(new WhatsAppEntryStore(), {
    sendText: async (phone, text) => {
      if (String(phone).endsWith('@lid') && text.includes('🎮 Partida encontrada!')) {
        throw new Error('SEND_LID_FAILED');
      }
      sentMessages.push({ phone, text });
    },
  });
  const firstPhone = '551188880050';
  const secondPhone = '551188880051';
  const firstReplyJid = `${firstPhone}000@lid`;
  const secondReplyJid = `${secondPhone}000@lid`;

  await chooseTable(runtime.bot, firstPhone, '1', '2', firstReplyJid);
  const fallbackMatch = await chooseTable(runtime.bot, secondPhone, '1', '2', secondReplyJid);
  assert.equal(fallbackMatch.type, 'whatsapp_match_created');

  const matchMessages = sentMessages.filter((message) => message.text.includes('🎮 Partida encontrada!'));
  assert.equal(matchMessages.length, 2);
  assert.ok(matchMessages.some((message) => message.phone === firstPhone));
  assert.ok(matchMessages.some((message) => message.phone === secondPhone));
  assert.ok(matchMessages.every((message) => message.text.includes('Mesa: R$5')));
}

{
  const sharedStore = new WhatsAppEntryStore();
  const firstRuntime = createBot(sharedStore);
  const firstPhone = '551188880060';
  const secondPhone = '551188880061';
  const firstReplyJid = `${firstPhone}000@lid`;
  const secondReplyJid = `${secondPhone}000@lid`;

  const firstWaiting = await chooseTable(firstRuntime.bot, firstPhone, '1', '3', firstReplyJid);
  assert.equal(firstWaiting.type, 'whatsapp_queue_joined');
  const secondWaitingEntry = firstRuntime.entryService.createEntry({
    phone: secondPhone,
    selectedTable: 10,
    source: 'stuck-queue-test',
  });
  const secondApproval = firstRuntime.entryService.approveEntry({
    entryId: secondWaitingEntry.entryId,
    actor: 'test',
    source: 'stuck-queue-test',
  });
  firstRuntime.entryService.markWhatsAppQueueWaiting(secondApproval.entry.entryId, {
    actor: secondPhone,
    replyTo: secondReplyJid,
    source: 'stuck-queue-test',
  });

  const retryRuntime = createBot(sharedStore);
  await retryRuntime.bot.handleConnectivityWebhook(createWebhook(firstPhone, 'oi', firstReplyJid));
  await retryRuntime.bot.handleConnectivityWebhook(createWebhook(firstPhone, '1', firstReplyJid));
  const recoveredMatch = await retryRuntime.bot.handleConnectivityWebhook(createWebhook(firstPhone, '3', firstReplyJid));
  assert.equal(recoveredMatch.type, 'whatsapp_match_created');
  assert.equal(recoveredMatch.matchId.startsWith('whatsapp_match-'), true);
  assert.equal(retryRuntime.matchQueue.getQueueStatus(10).waitingPlayers, 0);

  const matchMessages = retryRuntime.sentMessages
    .filter((message) => message.text.includes('🎮 Partida encontrada!'));
  assert.equal(matchMessages.length, 2);
  assert.ok(matchMessages.some((message) => message.phone === firstReplyJid));
  assert.ok(matchMessages.some((message) => message.phone === secondReplyJid));
  assert.ok(matchMessages.every((message) => message.text.includes('Mesa: R$10')));
}

{
  const sharedStore = new WhatsAppEntryStore();
  const firstRuntime = createBot(sharedStore);
  const firstPhone = '551188880070';
  const secondPhone = '551188880071';
  const firstReplyJid = `${firstPhone}000@lid`;
  const secondReplyJid = `${secondPhone}000@lid`;

  const firstWaiting = await chooseTable(firstRuntime.bot, firstPhone, '1', '4', firstReplyJid);
  assert.equal(firstWaiting.type, 'whatsapp_queue_joined');
  const secondWaitingEntry = firstRuntime.entryService.createEntry({
    phone: secondPhone,
    selectedTable: 20,
    source: 'stuck-other-table-test',
  });
  const secondApproval = firstRuntime.entryService.approveEntry({
    entryId: secondWaitingEntry.entryId,
    actor: 'test',
    source: 'stuck-other-table-test',
  });
  firstRuntime.entryService.markWhatsAppQueueWaiting(secondApproval.entry.entryId, {
    actor: secondPhone,
    replyTo: secondReplyJid,
    source: 'stuck-other-table-test',
  });

  const retryRuntime = createBot(sharedStore);
  retryRuntime.bot.setConversationState(firstPhone, 'choosing_table', 20);
  const recoveredMatch = await retryRuntime.bot.handleConnectivityWebhook(createWebhook(firstPhone, '3', firstReplyJid));
  assert.equal(recoveredMatch.type, 'whatsapp_match_created');
  assert.equal(recoveredMatch.selectedTable, 20);
  assert.equal(retryRuntime.matchQueue.getQueueStatus(20).waitingPlayers, 0);

  const matchMessages = retryRuntime.sentMessages
    .filter((message) => message.text.includes('🎮 Partida encontrada!'));
  assert.equal(matchMessages.length, 2);
  assert.ok(matchMessages.some((message) => message.phone === firstReplyJid));
  assert.ok(matchMessages.some((message) => message.phone === secondReplyJid));
  assert.ok(matchMessages.every((message) => message.text.includes('Mesa: R$20')));
}

{
  const { bot, store, matchQueue, sentMessages } = createBot();
  const cancelPhone = '551188880010';
  await chooseTable(bot, cancelPhone, '1', '3');
  assert.equal(matchQueue.getQueueStatus(10).waitingPlayers, 1);

  const cancelResult = await bot.handleConnectivityWebhook(createWebhook(cancelPhone, 'sair'));
  assert.equal(cancelResult.type, 'whatsapp_queue_cancelled');
  assert.equal(matchQueue.getQueueStatus(10).waitingPlayers, 0);
  assert.match(sentMessages.at(-1).text, /entrada foi cancelada/);
  assert.match(sentMessages.at(-1).text, /Bem-vindo ao Pife Duelo/);
  assert.equal(store.listEntries().at(-1).status, 'expired');
  assert.ok(store.listEntries().at(-1).auditLog.some((item) => item.action === 'entry_player_state_cleared'));

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
  const lockedPhone = '551188880090';
  entryService.createEntry({ phone: lockedPhone, selectedTable: 5, source: 'locked-entry-test' });

  const menuClear = await bot.handleConnectivityWebhook(createWebhook(lockedPhone, 'menu'));
  assert.equal(menuClear.type, 'whatsapp_queue_cancelled');
  assert.equal(store.listEntries().at(-1).status, 'expired');
  assert.ok(store.listEntries().at(-1).auditLog.some((item) => item.action === 'entry_player_state_cleared'));
  assert.match(sentMessages.at(-1).text, /entrada foi cancelada/);

  await bot.handleConnectivityWebhook(createWebhook(lockedPhone, '1'));
  const newTable = await bot.handleConnectivityWebhook(createWebhook(lockedPhone, '3'));
  assert.equal(newTable.type, 'whatsapp_queue_joined');
  assert.equal(newTable.selectedTable, 10);
  assert.equal(matchQueue.getQueueStatus(10).waitingPlayers, 1);
}

{
  const { bot, store, entryService, sentMessages } = createBot();
  const adminPhone = '5511999990000';
  const resetPhone = '551188880091';
  entryService.createEntry({ phone: resetPhone, selectedTable: 20, source: 'admin-reset-test' });

  const unauthorized = await bot.handleConnectivityWebhook(createWebhook('551177770000', `resetar ${resetPhone}`));
  assert.equal(unauthorized.type, 'entry_admin_unauthorized');
  assert.match(sentMessages.at(-1).text, /Comando/);
  assert.equal(store.listEntries().at(-1).status, 'pending_admin_validation');

  const resetResult = await bot.handleConnectivityWebhook(createWebhook(adminPhone, `resetar ${resetPhone}`));
  assert.equal(resetResult.type, 'entry_admin_player_reset');
  assert.equal(store.listEntries().at(-1).status, 'expired');
  assert.ok(store.listEntries().at(-1).auditLog.some((item) => item.action === 'entry_player_state_cleared'));
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
  assert.ok(store.getEntry(staleEntry.entryId).auditLog.some((item) => (
    item.action === 'entry_queue_cancelled' || item.action === 'entry_player_state_cleared'
  )));
  assert.equal(matchQueue.getQueueStatus(10).waitingPlayers, 1);
}

{
  const { bot, entryService, sentMessages, logs } = createBot();
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
  assert.ok(logs.some((log) => log.event === 'PLAYER_BLOCKED_ACTIVE_MATCH'
    && log.payload.attemptedTable === 5));
}

{
  const { bot, store, entryService, matchQueue, sentMessages, logs } = createBot();
  const firstPhone = '551188881001';
  const secondPhone = '551188881002';
  const firstReplyJid = `${firstPhone}@s.whatsapp.net`;
  const secondReplyJid = `${secondPhone}@s.whatsapp.net`;

  await chooseTable(bot, firstPhone, '1', '2', firstReplyJid);
  const firstPair = await chooseTable(bot, secondPhone, '1', '2', secondReplyJid);
  assert.equal(firstPair.type, 'whatsapp_match_created');
  assert.equal(matchQueue.getQueueStatus(5).waitingPlayers, 0);

  const firstMatchMessages = sentMessages.filter((message) => message.text.includes('Partida encontrada!'));
  const secondOldLink = extractFirstUrl(firstMatchMessages.find((message) => message.phone === secondReplyJid)?.text);
  assert.ok(secondOldLink);
  const secondOldToken = new URL(secondOldLink).searchParams.get('entry');

  const cancelResult = await bot.handleConnectivityWebhook(createWebhook(firstPhone, 'sair', firstReplyJid));
  assert.equal(cancelResult.type, 'whatsapp_paid_entry_preserved');
  assert.equal(matchQueue.getQueueStatus(5).waitingPlayers, 0);

  const firstEntry = store.listEntries().find((entry) => entry.phone === firstPhone);
  const secondEntry = store.listEntries().find((entry) => entry.phone === secondPhone);
  assert.equal(firstEntry.status, 'approved_for_queue');
  assert.equal(secondEntry.status, 'approved_for_queue');
  assert.ok(firstEntry.auditLog.some((item) => item.action === 'player_cancel_blocked_after_payment'));
  assert.equal(entryService.validateAccessToken(secondOldToken)?.status, 'approved_for_queue');
  assert.ok(logs.some((log) => log.event === 'PLAYER_CANCEL_BLOCKED_AFTER_PAYMENT'));
  assert.ok(sentMessages.some((message) => (
    message.phone === firstPhone
    || message.phone === firstReplyJid
  ) && message.text.includes('entrada paga ativa')));

  const paidMenuResult = await bot.handleConnectivityWebhook(createWebhook(secondPhone, 'menu', secondReplyJid));
  assert.equal(paidMenuResult.type, 'whatsapp_paid_entry_preserved');
  assert.equal(store.listEntries().find((entry) => entry.phone === secondPhone).status, 'approved_for_queue');
  assert.equal(matchQueue.getQueueStatus(5).waitingPlayers, 0);
}

{
  const { bot, store, entryService, sentMessages, logs } = createBot();
  const adminPhone = '5511999990000';
  const paidPhone = '551188881010';
  const paidEntry = entryService.createEntry({ phone: paidPhone, selectedTable: 10, source: 'paid-reset-test' });
  entryService.approveEntry({ entryId: paidEntry.entryId, actor: 'admin-test', source: 'paid-reset-test' });
  entryService.markLinkDelivery(paidEntry.entryId, { sent: true });

  const resetPaid = await bot.handleConnectivityWebhook(createWebhook(adminPhone, `resetar ${paidPhone}`));
  assert.equal(resetPaid.type, 'entry_admin_player_reset');
  assert.equal(store.getEntry(paidEntry.entryId).status, 'approved_for_queue');
  assert.ok(store.getEntry(paidEntry.entryId).auditLog.some((item) => item.action === 'paid_entry_preserved_on_clear_attempt'));
  assert.ok(logs.some((log) => log.event === 'RESET_PAID_ENTRY_WARNING'));
  assert.ok(sentMessages.some((message) => message.text.includes('RESET_PAID_ENTRY_WARNING')));

  const paidCancelPhone = '551188881011';
  const paidCancelEntry = entryService.createEntry({ phone: paidCancelPhone, selectedTable: 5, source: 'paid-cancel-test' });
  entryService.approveEntry({ entryId: paidCancelEntry.entryId, actor: 'admin-test', source: 'paid-cancel-test' });
  entryService.markLinkDelivery(paidCancelEntry.entryId, { sent: true });
  const adminCancel = await bot.handleConnectivityWebhook(createWebhook(adminPhone, `admin cancelar ${paidCancelPhone}`));
  assert.equal(adminCancel.type, 'entry_admin_paid_decision');
  assert.equal(store.getEntry(paidCancelEntry.entryId).status, 'cancelled_by_admin');
  assert.ok(store.getEntry(paidCancelEntry.entryId).auditLog.some((item) => item.action === 'admin_cancel_paid_entry'));

  const paidRefundPhone = '551188881012';
  const paidRefundEntry = entryService.createEntry({ phone: paidRefundPhone, selectedTable: 20, source: 'paid-refund-test' });
  entryService.approveEntry({ entryId: paidRefundEntry.entryId, actor: 'admin-test', source: 'paid-refund-test' });
  entryService.markLinkDelivery(paidRefundEntry.entryId, { sent: true });
  const adminRefund = await bot.handleConnectivityWebhook(createWebhook(adminPhone, `admin reembolsar ${paidRefundPhone}`));
  assert.equal(adminRefund.type, 'entry_admin_paid_decision');
  assert.equal(store.getEntry(paidRefundEntry.entryId).status, 'refund_pending');
  assert.ok(store.getEntry(paidRefundEntry.entryId).auditLog.some((item) => item.action === 'admin_refund_paid_entry'));

  const adminRequeue = await bot.handleConnectivityWebhook(createWebhook(adminPhone, `admin recolocar ${paidPhone}`));
  assert.equal(adminRequeue.type, 'entry_admin_paid_decision');
  assert.equal(store.getEntry(paidEntry.entryId).status, 'requeued_after_opponent_cancel');
  assert.ok(store.getEntry(paidEntry.entryId).auditLog.some((item) => item.action === 'admin_requeue_paid_entry'));
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
