import assert from 'node:assert/strict';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';
import { WhatsAppPaymentBot } from '../server/src/payments/WhatsAppPaymentBot.js';

let now = Date.parse('2026-06-22T12:00:00.000Z');
let tokenSequence = 0;
const store = new WhatsAppEntryStore();
const service = new WhatsAppEntryService({
  store,
  adminNumbers: ['5511999990000'],
  accessSecret: 'safe-entry-test-secret',
  publicGameUrl: 'https://pife-duelo.example',
  entryExpiryMinutes: 60,
  accessTtlMinutes: 180,
  clock: () => now,
  tokenFactory: () => `entry-token-${++tokenSequence}`,
});

const tableExpectations = new Map([
  [2, 3.6],
  [5, 9],
  [10, 17],
  [20, 32.8],
]);

for (const [table, prize] of tableExpectations) {
  const phone = `55118888${String(table).padStart(4, '0')}`;
  const entry = service.createEntry({ phone, selectedTable: table });
  assert.equal(entry.status, 'pending_admin_validation');
  assert.equal(entry.selectedTable, table);
  assert.equal(entry.tableAmount, table);
  assert.equal(entry.prizeAmount, prize);
  assert.equal(entry.mode, 'safe_test_without_pix');
  assert.equal(entry.phone, undefined);
  assert.match(entry.phoneMasked, /\*+\d{4}/);
}

const playerPhone = '5511777770000';
const pending = service.createEntry({ phone: playerPhone, selectedTable: 5 });
const samePending = service.createEntry({ phone: playerPhone, selectedTable: 5 });
assert.equal(samePending.entryId, pending.entryId, 'Webhook repetido não duplica entrada ativa.');
assert.throws(() => service.createEntry({ phone: playerPhone, selectedTable: 10 }), /ENTRY_TABLE_LOCKED/);
assert.equal(service.validateAccessToken('missing'), null);

const approved = service.approveEntry({ entryId: pending.entryId, actor: 'admin-panel' });
assert.equal(approved.entry.status, 'approved_for_queue');
const approvedToken = new URL(approved.accessLink).searchParams.get('entry');
assert.ok(approvedToken);
assert.equal(service.validateAccessToken(approvedToken)?.entryId, pending.entryId);
assert.throws(() => service.approveEntry({ entryId: pending.entryId, actor: 'admin-panel' }), /ENTRY_NOT_PENDING/);

const deliveryFailure = service.createEntry({ phone: '5511333330000', selectedTable: 20 });
service.approveEntry({ entryId: deliveryFailure.entryId, actor: 'admin-panel' });
service.markLinkDelivery(deliveryFailure.entryId, { sent: false, error: 'temporary delivery failure' });
const rolledBack = service.rollbackApprovalAfterDeliveryFailure(deliveryFailure.entryId, { error: 'temporary delivery failure' });
assert.equal(rolledBack.status, 'pending_admin_validation');
assert.equal(rolledBack.accessExpiresAt, null);
assert.equal(store.getEntry(deliveryFailure.entryId).accessTokenHash, null);

assert.throws(
  () => service.reserveQueueAccess({ entryId: pending.entryId, socketId: 'socket-1', selectedTable: 10 }),
  /ENTRY_TABLE_MISMATCH/,
);
const queued = service.reserveQueueAccess({ entryId: pending.entryId, socketId: 'socket-1', selectedTable: 5 });
assert.equal(queued.status, 'queued');
assert.throws(
  () => service.reserveQueueAccess({ entryId: pending.entryId, socketId: 'socket-2', selectedTable: 5 }),
  /ENTRY_ACCESS_RESERVED/,
);
const playing = service.linkToMatch({ entryId: pending.entryId, socketId: 'socket-1', matchId: 'match-safe-1' });
assert.equal(playing.status, 'playing');
assert.equal(playing.linkedMatchId, 'match-safe-1');
assert.throws(
  () => service.reserveQueueAccess({ entryId: pending.entryId, socketId: 'socket-1', selectedTable: 5 }),
  /ENTRY_NOT_APPROVED/,
);
const finishedEntries = service.finishEntriesForMatch({
  matchId: 'match-safe-1',
  winnerId: 'player-a',
  loserId: 'player-b',
  reason: 'knock',
});
assert.equal(finishedEntries.length, 1);
assert.equal(finishedEntries[0].status, 'finished');
assert.equal(finishedEntries[0].finishedAt !== null, true);
assert.equal(service.getActiveEntryForPhone('5511888880000'), null);
assert.ok(store.getEntry(pending.entryId).auditLog.some((item) => item.action === 'entry_finished'));

const rejectedPending = service.createEntry({ phone: '5511666660000', selectedTable: 2 });
const rejected = service.rejectEntry({ entryId: rejectedPending.entryId, actor: 'admin-panel', reason: 'teste rejeitado' });
assert.equal(rejected.status, 'rejected');
assert.equal(service.validateAccessToken('anything'), null);
assert.throws(() => service.approveEntry({ entryId: rejected.entryId, actor: 'admin-panel' }), /ENTRY_NOT_PENDING/);

const expiring = service.createEntry({ phone: '5511555550000', selectedTable: 20 });
now += 61 * 60 * 1000;
assert.equal(service.getEntry(expiring.entryId).status, 'expired');
assert.throws(() => service.approveEntry({ entryId: expiring.entryId, actor: 'admin-panel' }), /ENTRY_NOT_PENDING/);

const manualExpire = service.createEntry({ phone: '5511444440000', selectedTable: 10 });
const expired = service.expireEntry({ entryId: manualExpire.entryId, actor: 'admin-panel' });
assert.equal(expired.status, 'expired');

assert.equal(service.isAdmin('5511999990000'), true);
assert.equal(service.isAdmin('5511000000000'), false);
assert.ok(store.getEntry(pending.entryId).auditLog.some((item) => item.action === 'entry_approved_for_queue'));
assert.ok(store.getEntry(pending.entryId).auditLog.some((item) => item.action === 'entry_queued'));
assert.ok(store.getEntry(pending.entryId).auditLog.some((item) => item.action === 'entry_playing'));

const botStore = new WhatsAppEntryStore();
const botService = new WhatsAppEntryService({
  store: botStore,
  adminNumbers: ['5511999990000'],
  accessSecret: 'safe-entry-bot-secret',
  publicGameUrl: 'https://pife-duelo.example',
  clock: () => now,
  tokenFactory: () => `bot-entry-token-${++tokenSequence}`,
});
const botMessages = [];
const bot = new WhatsAppPaymentBot({
  entryService: botService,
  safeEntryEnabled: true,
  evolutionClient: {
    isConfigured: () => true,
    sendText: async (phone, text) => botMessages.push({ phone, text }),
  },
  adminNumbers: ['5511999990000'],
  clock: () => now,
});

let botMessageSequence = 0;
function entryWebhook(phone, text) {
  botMessageSequence += 1;
  return {
    event: 'messages.upsert',
    instance: 'pife-duelo',
    data: {
      key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: `entry-msg-${botMessageSequence}` },
      message: { conversation: text },
    },
  };
}

const botPlayer = '5511333330000';
await bot.handleConnectivityWebhook(entryWebhook(botPlayer, 'oi'));
await bot.handleConnectivityWebhook(entryWebhook(botPlayer, '1'));
const botPendingResult = await bot.handleConnectivityWebhook(entryWebhook(botPlayer, '1'));
assert.equal(botPendingResult.type, 'whatsapp_entry_pending_admin');
assert.equal(botPendingResult.entryId, 'E2000');
assert.equal(botStore.listEntries().length, 1);
assert.equal(botStore.getEntry('E2000').status, 'pending_admin_validation');
assert.match(botMessages.at(-1).text, /Aguarde a liberação do admin/);
assert.doesNotMatch(botMessages.at(-1).text, /chave pix|https?:\/\//i);

await bot.handleConnectivityWebhook(entryWebhook(botPlayer, 'menu'));
await bot.handleConnectivityWebhook(entryWebhook(botPlayer, '1'));
const lockedResult = await bot.handleConnectivityWebhook(entryWebhook(botPlayer, '2'));
assert.equal(lockedResult.reason, 'ENTRY_TABLE_LOCKED');
assert.equal(botStore.getEntry('E2000').selectedTable, 2);

const unauthorizedAdmin = await bot.handleConnectivityWebhook(entryWebhook('5511222220000', '/admin entradas'));
assert.equal(unauthorizedAdmin.type, 'entry_admin_unauthorized');
assert.equal(botMessages.at(-1).text, 'Comando não autorizado.');

const adminList = await bot.handleConnectivityWebhook(entryWebhook('5511999990000', '/admin entradas'));
assert.equal(adminList.type, 'entry_admin_pending_list');
assert.match(botMessages.at(-1).text, /#E2000/);
assert.doesNotMatch(botMessages.at(-1).text, new RegExp(botPlayer));

const adminApprove = await bot.handleConnectivityWebhook(entryWebhook('5511999990000', '/admin liberar E2000'));
assert.equal(adminApprove.type, 'entry_approved');
assert.equal(botStore.getEntry('E2000').status, 'approved_for_queue');
assert.ok(botMessages.some((message) => message.phone === botPlayer && message.text.includes('?online=1&entry=')));
const duplicateApprove = await bot.handleConnectivityWebhook(entryWebhook('5511999990000', '/admin liberar E2000'));
assert.equal(duplicateApprove.type, 'entry_admin_command_failed');
assert.equal(botStore.getEntry('E2000').auditLog.filter((item) => item.action === 'entry_approved_for_queue').length, 1);

const rejectedBotPlayer = '5511222211111';
await bot.handleConnectivityWebhook(entryWebhook(rejectedBotPlayer, 'menu'));
await bot.handleConnectivityWebhook(entryWebhook(rejectedBotPlayer, '1'));
const rejectedPendingResult = await bot.handleConnectivityWebhook(entryWebhook(rejectedBotPlayer, '2'));
const adminReject = await bot.handleConnectivityWebhook(entryWebhook(
  '5511999990000',
  `/admin rejeitar ${rejectedPendingResult.entryId} validação recusada`,
));
assert.equal(adminReject.type, 'entry_rejected');
assert.equal(botStore.getEntry(rejectedPendingResult.entryId).status, 'rejected');
assert.ok(botMessages.some((message) => message.phone === rejectedBotPlayer && message.text.includes('Digite menu')));

console.log('WhatsApp entries: criação, aprovação manual, token, fila, auditoria e bloqueios validados.');
