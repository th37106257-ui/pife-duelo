import assert from 'node:assert/strict';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';

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

console.log('WhatsApp entries: criação, aprovação manual, token, fila, auditoria e bloqueios validados.');
