import assert from 'node:assert/strict';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';
import { MatchQueue } from '../server/src/services/matchQueue.js';
import { createPostMatchFlow } from '../server/src/services/postMatchFlow.js';

let now = Date.parse('2026-07-01T12:00:00.000Z');
let tokenSequence = 0;

const logs = [];
const sentMessages = [];

const store = new WhatsAppEntryStore();
const entryService = new WhatsAppEntryService({
  store,
  adminNumbers: ['5511999990000'],
  accessSecret: 'post-match-secret',
  publicGameUrl: 'https://pife-duelo.example',
  clock: () => now,
  tokenFactory: () => `post-match-token-${++tokenSequence}`,
});
const matchQueue = new MatchQueue({
  entryService,
  clock: () => now,
  logInfo: (event, payload) => logs.push({ level: 'info', event, payload }),
  logWarn: (event, payload) => logs.push({ level: 'warn', event, payload }),
  logError: (event, payload) => logs.push({ level: 'error', event, payload }),
});
const whatsappBot = {
  adminNumbers: ['5511999990000'],
  send: async (phone, text) => {
    sentMessages.push({ phone, text });
  },
};
const flow = createPostMatchFlow({
  entryService,
  whatsappBot,
  whatsappMatchQueue: matchQueue,
  adminSummaryEnabled: true,
  logInfo: (event, payload) => logs.push({ level: 'info', event, payload }),
  logWarn: (event, payload) => logs.push({ level: 'warn', event, payload }),
  logError: (event, payload) => logs.push({ level: 'error', event, payload }),
});

function prepareLinkedEntry(phone, entryIdSuffix, playerId) {
  const created = entryService.createEntry({ phone, selectedTable: 5, source: 'whatsapp-queue' });
  const approval = entryService.approveEntry({
    entryId: created.entryId,
    actor: 'whatsapp-queue',
    source: 'test',
  });
  entryService.markWhatsAppQueueWaiting(created.entryId, {
    actor: phone,
    replyTo: `${phone}@s.whatsapp.net`,
    source: 'test',
  });
  entryService.reserveQueueAccess({
    entryId: created.entryId,
    socketId: `socket-${entryIdSuffix}`,
    selectedTable: 5,
  });
  entryService.linkToMatch({
    entryId: created.entryId,
    socketId: `socket-${entryIdSuffix}`,
    matchId: 'match-post-1',
    playerId,
  });
  return approval.entry;
}

prepareLinkedEntry('5511999991111', 'a', 'player-a');
prepareLinkedEntry('5511999992222', 'b', 'player-b');
matchQueue.activeMatchesByPhone.set('5511999991111', { matchId: 'match-post-1', tableValue: 5, entryId: 'E1', status: 'playing' });
matchQueue.activeMatchesByPhone.set('5511999992222', { matchId: 'match-post-1', tableValue: 5, entryId: 'E2', status: 'playing' });

const gameState = {
  matchId: 'match-post-1',
  roomId: 'room-post-1',
  tableValue: 5,
  status: 'finished',
  startedAt: '2026-07-01T11:51:18.000Z',
  finishedAt: '2026-07-01T12:00:00.000Z',
  result: {
    winnerId: 'player-a',
    loserId: 'player-b',
    reason: 'knock',
    finishedAt: '2026-07-01T12:00:00.000Z',
  },
  players: [
    { id: 'player-a', name: 'Jogador A' },
    { id: 'player-b', name: 'Jogador B' },
  ],
};

let emitted = 0;
const first = await flow.finishMatchAndNotify(gameState, 'knock', {
  emitResult: () => {
    emitted += 1;
  },
});
const second = await flow.finishMatchAndNotify(gameState, 'knock', {
  emitResult: () => {
    emitted += 1;
  },
});

assert.equal(first.ok, true);
assert.equal(first.alreadyProcessed, false);
assert.equal(second.alreadyProcessed, true);
assert.equal(emitted, 2);
assert.equal(sentMessages.length, 3);
assert.match(sentMessages[0].text, /Você venceu no Pife Duelo/i);
assert.match(sentMessages[1].text, /Resultado: Derrota/);
assert.match(sentMessages[2].text, /PARTIDA FINALIZADA/);
assert.equal(matchQueue.findActiveMatch('5511999991111'), null);
assert.equal(matchQueue.findActiveMatch('5511999992222'), null);
assert.equal(entryService.getActiveEntryForPhone('5511999991111'), null);
assert.equal(entryService.getActiveEntryForPhone('5511999992222'), null);
assert.ok(logs.some((log) => log.event === 'MATCH_FINISH_STARTED'));
assert.ok(logs.some((log) => log.event === 'MATCH_FINISH_COMPLETED'));
assert.ok(logs.some((log) => log.event === 'MATCH_FINISH_ALREADY_PROCESSED'));
assert.ok(logs.some((log) => log.event === 'PLAYER_ENTRY_RELEASED_AFTER_MATCH'));
assert.ok(logs.some((log) => log.event === 'PLAYER_QUEUE_REMOVED_AFTER_MATCH'));
assert.ok(logs.some((log) => log.event === 'WHATSAPP_RESULT_SENT_TO_WINNER'));
assert.ok(logs.some((log) => log.event === 'WHATSAPP_RESULT_SENT_TO_LOSER'));
assert.ok(logs.some((log) => log.event === 'ADMIN_MATCH_REPORT_SENT'));

const pendingSummary = await flow.notifyPendingMatchTerminal({
  matchId: 'whatsapp_match_pending-timeout',
  reason: 'queue_timeout_before_start',
  table: 5,
  participants: [
    { phoneMasked: '*********1111', status: 'refund_pending' },
    { phoneMasked: '*********2222', status: 'refund_pending' },
  ],
});
assert.equal(pendingSummary.sent, true);
assert.match(sentMessages.at(-1).text, /Estado da partida: aborted/i);
assert.match(sentMessages.at(-1).text, /Status das entradas: refund_pending \/ refund_pending/);

let retryAttempts = 0;
const retryFlow = createPostMatchFlow({
  whatsappEnabled: false,
  adminSummaryEnabled: true,
  whatsappBot: {
    adminNumbers: ['5511999990000'],
    send: async () => {
      retryAttempts += 1;
      if (retryAttempts === 1) throw new Error('temporary-evolution-failure');
    },
  },
});
const retryState = { ...gameState, matchId: 'match-admin-summary-retry' };
const failedSummary = await retryFlow.finishMatchAndNotify(retryState, 'knock');
const retriedSummary = await retryFlow.finishMatchAndNotify(retryState, 'knock');
assert.equal(failedSummary.adminSent, false);
assert.equal(retriedSummary.alreadyProcessed, true);
assert.equal(retriedSummary.adminSent, true);
assert.equal(retryAttempts, 2);

console.log('post-match-flow ok');
