import assert from 'node:assert/strict';
import { MatchQueue } from '../server/src/services/matchQueue.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createQueue(entryService, log = []) {
  return new MatchQueue({
    entryService,
    logInfo: (event) => log.push(event),
    logWarn: (event) => log.push(event),
    logError: (event) => log.push(event),
  });
}

function queueEntry(entryId = 'safe-entry-async-1') {
  return {
    playerPhone: '5511999990201',
    phoneMasked: '***0201',
    replyTo: '***0201',
    tableId: 'mesa_5',
    tableValue: 5,
    tableAmount: 5,
    prizeAmount: 9,
    entryId,
    accessLink: null,
    queuedAt: new Date().toISOString(),
  };
}

// removeFromQueue must wait for the persistent revocation before claiming success.
{
  const revoke = deferred();
  const logs = [];
  const service = {
    listWhatsAppQueueEntries: () => [],
    cancelQueueEntry: () => revoke.promise,
  };
  const queue = createQueue(service, logs);
  const entry = queueEntry();
  queue.queues.get('mesa_5').push(entry);
  let settled = false;
  const removal = queue.removeFromQueue(entry.playerPhone).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false, 'Queue removal must remain pending until PostgreSQL revocation finishes.');
  revoke.resolve(true);
  assert.equal((await removal).removed, true);
  assert.equal(settled, true);
}

// A failed revocation is surfaced and the local queue item is restored, not reported as removed.
{
  const revoke = deferred();
  const logs = [];
  const service = {
    listWhatsAppQueueEntries: () => [],
    cancelQueueEntry: () => revoke.promise,
  };
  const queue = createQueue(service, logs);
  const entry = queueEntry('safe-entry-async-2');
  queue.queues.get('mesa_5').push(entry);
  const removal = queue.removeFromQueue(entry.playerPhone);
  await Promise.resolve();
  revoke.reject(new Error('SAFE_ENTRY_STORE_UNAVAILABLE'));
  await assert.rejects(removal, { message: 'SAFE_ENTRY_STORE_UNAVAILABLE' });
  assert.equal(queue.queues.get('mesa_5')[0], entry, 'Failed revocation must restore the queue item.');
  assert.equal(logs.includes('WHATSAPP_QUEUE_LEFT'), false, 'Failed revocation must not log a successful queue leave.');
  assert.equal(logs.includes('WHATSAPP_QUEUE_ENTRY_CANCEL_FAILED'), true);
}

// clearPlayerState must await entry revocation and propagate a persistence failure.
{
  const clear = deferred();
  const service = {
    listWhatsAppQueueEntries: () => [],
    getClearableStateForPhone: () => ({ activeEntries: [], pendingEntries: [] }),
    getPreStartMatchForPhone: () => null,
    clearPlayerEntries: () => clear.promise,
  };
  const queue = createQueue(service);
  let settled = false;
  const clearing = queue.clearPlayerState('5511999990202').then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false, 'Clear operation must wait for persisted revocations.');
  clear.reject(new Error('SAFE_ENTRY_STORE_UNAVAILABLE'));
  await assert.rejects(clearing, { message: 'SAFE_ENTRY_STORE_UNAVAILABLE' });
  assert.equal(settled, false, 'A failed persistence operation must not produce a success result.');
}

// Match creation must wait until both refreshed access links are persisted.
{
  const first = deferred();
  const second = deferred();
  let refreshCount = 0;
  const service = {
    refreshQueueAccessLink: () => [first.promise, second.promise][refreshCount++],
  };
  const queue = createQueue(service);
  const players = [queueEntry('safe-entry-match-a'), { ...queueEntry('safe-entry-match-b'), playerPhone: '5511999990203' }];
  queue.queues.get('mesa_5').push(...players);
  const matching = queue.tryCreateMatch(5);
  await Promise.resolve();
  assert.equal(refreshCount, 1, 'First shared access persistence must be awaited before advancing.');
  assert.equal(queue.activeMatchesByPhone.size, 0, 'No match may be published before both links persist.');
  first.resolve({ accessLink: 'https://pife-duelo.example/join/match?entry=opaque-a' });
  for (let index = 0; index < 5 && refreshCount < 2; index += 1) await Promise.resolve();
  assert.equal(refreshCount, 2, 'Second shared access persistence must be attempted after the first succeeds.');
  assert.equal(queue.activeMatchesByPhone.size, 0, 'Match remains unpublished while the second link is pending.');
  second.resolve({ accessLink: 'https://pife-duelo.example/join/match?entry=opaque-b' });
  const match = await matching;
  assert.ok(match?.matchId);
  assert.equal(queue.activeMatchesByPhone.size, 2);
}

// If access persistence fails, the pair is restored to the queue and no match is exposed.
{
  const first = deferred();
  const service = { refreshQueueAccessLink: () => first.promise };
  const queue = createQueue(service);
  const players = [queueEntry('safe-entry-match-fail-a'), { ...queueEntry('safe-entry-match-fail-b'), playerPhone: '5511999990204' }];
  queue.queues.get('mesa_5').push(...players);
  const matching = queue.tryCreateMatch(5);
  await Promise.resolve();
  first.reject(new Error('SAFE_ENTRY_STORE_UNAVAILABLE'));
  await assert.rejects(matching, { message: 'SAFE_ENTRY_STORE_UNAVAILABLE' });
  assert.deepEqual(queue.queues.get('mesa_5'), players, 'Failed link persistence must restore both queue entries.');
  assert.equal(queue.activeMatchesByPhone.size, 0, 'Failed persistence must not leave an active match.');
}

console.log('PASS Safe Entry async propagation; queue revocations fail closed; match waits for both persisted links');
