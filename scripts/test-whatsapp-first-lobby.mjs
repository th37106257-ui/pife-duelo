import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';
import { MatchQueue } from '../server/src/services/matchQueue.js';

let now = Date.parse('2026-07-14T12:00:00.000Z');
let tokenSequence = 0;
const store = new WhatsAppEntryStore();
const entries = new WhatsAppEntryService({
  store,
  accessSecret: 'whatsapp-first-test-secret',
  publicGameUrl: 'https://pife-duelo.example',
  clock: () => now,
  tokenFactory: () => `secure-token-${++tokenSequence}`,
});
const queue = new MatchQueue({
  entryService: entries,
  paymentsEnabled: false,
  preMatchTimeoutSeconds: 60,
  clock: () => now,
});

const firstPhone = '5511999991111';
const secondPhone = '5511999992222';
const first = queue.joinQueue(firstPhone, 5, { replyTo: firstPhone });
const second = queue.joinQueue(secondPhone, 5, { replyTo: secondPhone });
assert.equal(first.blocked, false);
assert.equal(second.blocked, false);
assert.ok(second.match);
assert.equal(second.match.players.length, 2);
assert.equal(second.match.players[0].accessLink.includes(second.match.matchId), true);
assert.equal(second.match.players[1].accessLink.includes(second.match.matchId), true);
assert.notEqual(second.match.players[0].accessLink, second.match.players[1].accessLink);
assert.equal(Date.parse(second.match.preMatchDeadline) - now, 60_000);
assert.match(second.match.publicReference, /^PD-[A-F0-9]{6}$/);

const firstToken = new URL(second.match.players[0].accessLink).searchParams.get('entry');
const firstAuthorized = entries.validateAccessToken(firstToken);
assert.ok(firstAuthorized);
const claimed = entries.claimAccessSession({ entryId: firstAuthorized.entryId });
assert.ok(claimed.sessionKey);
assert.equal(claimed.recovered, false);
assert.throws(
  () => entries.claimAccessSession({ entryId: firstAuthorized.entryId }),
  /ENTRY_DUPLICATE_SESSION/,
);
const recovered = entries.claimAccessSession({
  entryId: firstAuthorized.entryId,
  sessionKey: claimed.sessionKey,
});
assert.equal(recovered.recovered, true);

const abort = queue.abortMatchAndReleaseParticipants({
  matchId: second.match.matchId,
  reason: 'player_left_before_start',
  cancelledBy: firstPhone,
});
assert.equal(abort.aborted, true);
assert.equal(abort.participants.length, 2);
assert.equal(entries.validateAccessToken(firstToken), null);
assert.equal(entries.getActiveEntryForPhone(firstPhone), null);
assert.equal(entries.getActiveEntryForPhone(secondPhone), null);
assert.equal(queue.abortMatchAndReleaseParticipants({ matchId: second.match.matchId }).alreadyProcessed, true);

const paidStore = new WhatsAppEntryStore();
const paidEntries = new WhatsAppEntryService({
  store: paidStore,
  accessSecret: 'paid-entry-preservation-secret',
  publicGameUrl: 'https://pife-duelo.example',
  clock: () => now,
  tokenFactory: () => `paid-token-${++tokenSequence}`,
});
const paidA = paidEntries.createEntry({ phone: '5511888881111', selectedTable: 10 });
const paidB = paidEntries.createEntry({ phone: '5511888882222', selectedTable: 10 });
paidEntries.approveEntry({ entryId: paidA.entryId, actor: 'admin-real' });
paidEntries.approveEntry({ entryId: paidB.entryId, actor: 'admin-real' });
const paidMatchId = 'whatsapp_match_paid_abort';
const deadline = new Date(now + 60_000).toISOString();
paidEntries.refreshQueueAccessLink(paidA.entryId, { matchId: paidMatchId, preMatchDeadline: deadline });
paidEntries.refreshQueueAccessLink(paidB.entryId, { matchId: paidMatchId, preMatchDeadline: deadline });
const paidAbort = paidEntries.abortPreStartMatchAndReleaseParticipants({
  matchId: paidMatchId,
  reason: 'queue_timeout_before_start',
  forceFreeMode: false,
});
assert.equal(paidAbort.aborted, true);
assert.ok(paidAbort.participants.every((entry) => entry.status === 'refund_pending'));
assert.ok(paidAbort.participants.every((entry) => entry.paidConfirmed === true));

const matchmakingSource = readFileSync(new URL('../src/components/MatchmakingScreen.jsx', import.meta.url), 'utf8');
const fallbackSource = readFileSync(new URL('../src/components/WhatsAppLobbyFallback.jsx', import.meta.url), 'utf8');
const socketSource = readFileSync(new URL('../server/src/socket/index.js', import.meta.url), 'utf8');
assert.match(matchmakingSource, /WhatsAppLobbyFallback/);
assert.match(matchmakingSource, /Cancelar espera/);
assert.match(matchmakingSource, /Minha partida nao iniciou e quero verificar minha entrada\. Codigo:/);
assert.match(fallbackSource, /buildOfficialWhatsAppLink\(\{ message: whatsappMessage \}\)/);
assert.match(socketSource, /WHATSAPP_FIRST_DIRECT_QUEUE_BLOCKED/);
assert.match(socketSource, /ENTRY_DUPLICATE_SESSION/);

console.log('WhatsApp-first: links individuais, sessão única, timeout de 60s, aborto idempotente e preservação paga validados.');
