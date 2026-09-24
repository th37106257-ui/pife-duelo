import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';
import { PostgresWhatsAppEntryAccessRepository } from '../server/src/entries/PostgresWhatsAppEntryAccessRepository.js';

const requireServerDependency = createRequire(new URL('../server/package.json', import.meta.url));
const { Pool } = requireServerDependency('pg');
const connectionString = process.env.PIFE_SAFE_ENTRY_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('PIFE_SAFE_ENTRY_TEST_DATABASE_URL_REQUIRED');
const database = new URL(connectionString);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '55432'
  || database.pathname !== '/pife_safe_entry_test' || database.username !== 'pife_test') {
  throw new Error('SAFE_ENTRY_TEST_REQUIRES_ISOLATED_LOCAL_POSTGRES');
}

const accessSecret = 'safe-entry-postgres-integration-secret';
const repoA = new PostgresWhatsAppEntryAccessRepository({ connectionString });
const repoB = new PostgresWhatsAppEntryAccessRepository({ connectionString });
const repoRestarted = new PostgresWhatsAppEntryAccessRepository({ connectionString });
const storeA = new WhatsAppEntryStore({});
const storeB = new WhatsAppEntryStore({});
const storeRestarted = new WhatsAppEntryStore({});
const tokenFactory = () => randomBytes(32).toString('base64url');
const serviceA = new WhatsAppEntryService({
  store: storeA, accessSecret, publicGameUrl: 'http://localhost:3000', tokenFactory,
  sharedAccessRepository: repoA, requireSharedAccessRepository: true,
});
const serviceB = new WhatsAppEntryService({
  store: storeB, accessSecret, publicGameUrl: 'http://localhost:3000', tokenFactory,
  sharedAccessRepository: repoB, requireSharedAccessRepository: true,
});
const serviceRestarted = new WhatsAppEntryService({
  store: storeRestarted, accessSecret, publicGameUrl: 'http://localhost:3000', tokenFactory,
  sharedAccessRepository: repoRestarted, requireSharedAccessRepository: true,
});

async function createTicket(service, phone, matchId) {
  const pending = service.createEntry({ phone, selectedTable: 5, source: 'safe-entry-postgres-test' });
  const approved = await service.approveEntry({ entryId: pending.entryId, actor: 'safe-entry-postgres-test' });
  const refreshed = await service.refreshQueueAccessLink(approved.entry.entryId, { matchId });
  return {
    entryId: approved.entry.entryId,
    token: new URL(refreshed.accessLink).searchParams.get('entry'),
    matchId,
    phone,
  };
}

async function denied(promise, label) {
  await assert.rejects(promise, (error) => ['ENTRY_ACCESS_DENIED', 'ENTRY_DUPLICATE_SESSION'].includes(error.message), label);
}

async function issueRejected(promise, code, label) {
  await assert.rejects(promise, { message: code }, label);
}

try {
  await repoA.initialize();
  await repoB.initialize();
  await repoRestarted.initialize();
  await repoA.pool.query('TRUNCATE TABLE whatsapp_safe_entries');

  const ticket = await createTicket(serviceA, '5511999990101', 'safe-entry-match-main');
  const unclaimedEntry = storeA.getEntry(ticket.entryId);
  const unclaimedBefore = await repoA.getEntry(ticket.entryId);
  assert.equal(await repoA.issueAccess(unclaimedEntry, serviceA.hashPlayerBinding(unclaimedEntry.phone)), true,
    'Reissuing identical access for an unclaimed ticket must remain idempotent.');
  const unclaimedAfter = await repoA.getEntry(ticket.entryId);
  assert.equal(await repoA.countEntry(ticket.entryId), 1, 'Idempotent issue must keep exactly one row.');
  assert.equal(unclaimedAfter.accessTokenHash, unclaimedBefore.accessTokenHash, 'Idempotent issue must preserve the ticket token.');
  await issueRejected(repoB.issueAccess(unclaimedEntry, 'different-player-binding'), 'SAFE_ENTRY_BINDING_MISMATCH',
    'A different player binding must not replace a pre-claim ticket.');
  assert.equal((await repoA.getEntry(ticket.entryId)).accessTokenHash, unclaimedBefore.accessTokenHash,
    'Binding mismatch must leave the existing ticket unchanged.');

  await denied(serviceA.claimAccessSessionAuthoritative({
    entryId: ticket.entryId, accessToken: ticket.token, matchId: 'wrong-match-id',
  }), 'Wrong match id must not claim a valid ticket.');
  let row = await repoA.getEntry(ticket.entryId);
  assert.equal(row.accessSessionClaimedAt, null, 'A wrong match must not consume a ticket.');
  assert.equal(row.accessSessionTokenHash, null, 'A wrong match must not persist a session hash.');
  await denied(serviceA.claimAccessSessionAuthoritative({
    entryId: ticket.entryId, accessToken: ticket.token, sessionKey: 'client-forged-session-key', matchId: ticket.matchId,
  }), 'A client-provided session key must not claim an unclaimed ticket.');
  row = await repoA.getEntry(ticket.entryId);
  assert.equal(row.accessSessionClaimedAt, null, 'A forged session key must not consume a ticket.');
  assert.equal(row.accessSessionTokenHash, null, 'A forged session key must not persist a session hash.');

  const race = await Promise.allSettled([
    serviceA.claimAccessSessionAuthoritative({ entryId: ticket.entryId, accessToken: ticket.token, matchId: ticket.matchId }),
    serviceB.claimAccessSessionAuthoritative({ entryId: ticket.entryId, accessToken: ticket.token, matchId: ticket.matchId }),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1, 'Exactly one independent pool must claim the ticket.');
  assert.equal(race.filter((result) => result.status === 'rejected').length, 1, 'The competing claim must be rejected.');
  const winner = race.find((result) => result.status === 'fulfilled').value;
  assert.ok(winner.sessionKey, 'Only the winning claim returns a new session key.');
  await assert.rejects(repoB.claimOrRecover({
    entryId: ticket.entryId,
    expectedMatchId: ticket.matchId,
    tokenHash: serviceB.hashToken(ticket.token),
    sessionKeyHash: null,
    nextSessionKeyHash: serviceB.hashToken(tokenFactory()),
  }), { message: 'ENTRY_DUPLICATE_SESSION' });
  row = await repoA.getEntry(ticket.entryId);
  assert.equal(await repoB.countEntry(ticket.entryId), 1, 'There must be exactly one persisted entry.');
  assert.equal(row.accessSessionTokenHash, serviceA.hashToken(winner.sessionKey), 'The only persisted claim must belong to the winner.');
  const claimedSnapshot = {
    claimedAt: row.accessSessionClaimedAt,
    sessionHash: row.accessSessionTokenHash,
    tokenHash: row.accessTokenHash,
    status: row.status,
    revokedAt: row.revokedAt,
  };
  await issueRejected(repoA.issueAccess(unclaimedEntry, serviceA.hashPlayerBinding(unclaimedEntry.phone)), 'SAFE_ENTRY_ISSUE_REJECTED',
    'A stale access issue must not reopen a claimed ticket.');
  await issueRejected(serviceA.persistSharedAccess(unclaimedEntry), 'SAFE_ENTRY_ISSUE_REJECTED',
    'The service persistence wrapper must preserve rejection for a claimed ticket.');
  row = await repoB.getEntry(ticket.entryId);
  assert.deepEqual({
    claimedAt: row.accessSessionClaimedAt,
    sessionHash: row.accessSessionTokenHash,
    tokenHash: row.accessTokenHash,
    status: row.status,
    revokedAt: row.revokedAt,
  }, claimedSnapshot, 'Rejected reissue must preserve the claimed ticket state.');

  await denied(serviceB.claimAccessSessionAuthoritative({ entryId: ticket.entryId, accessToken: ticket.token, matchId: ticket.matchId }),
    'A consumed ticket replay without its session key must be rejected.');
  await denied(serviceB.claimAccessSessionAuthoritative({
    entryId: ticket.entryId, accessToken: ticket.token, sessionKey: 'wrong-session-key', matchId: ticket.matchId,
  }), 'A wrong session key must be rejected.');

  const otherTicket = await createTicket(serviceA, '5511999990102', 'safe-entry-match-other');
  const otherClaim = await serviceA.claimAccessSessionAuthoritative({
    entryId: otherTicket.entryId, accessToken: otherTicket.token, matchId: otherTicket.matchId,
  });
  await denied(serviceB.claimAccessSessionAuthoritative({
    entryId: ticket.entryId, accessToken: ticket.token, sessionKey: otherClaim.sessionKey, matchId: ticket.matchId,
  }), 'A different player session must not claim this entry.');

  const recovered = await serviceB.recoverAccessSessionAuthoritative({ matchId: ticket.matchId, sessionKey: winner.sessionKey });
  assert.equal(recovered.entry.entryId, ticket.entryId, 'A second independent repository must recover the same entry.');
  assert.equal(recovered.recovered, true);
  const afterRestart = await serviceRestarted.recoverAccessSessionAuthoritative({ matchId: ticket.matchId, sessionKey: winner.sessionKey });
  assert.equal(afterRestart.entry.entryId, ticket.entryId, 'Restarted service/pool must recover from persistent state.');
  await denied(serviceRestarted.recoverAccessSessionAuthoritative({ matchId: 'wrong-match-id', sessionKey: winner.sessionKey }),
    'A session key cannot recover another match.');

  const expiredTicket = await createTicket(serviceA, '5511999990103', 'safe-entry-match-expired');
  await repoA.pool.query("UPDATE whatsapp_safe_entries SET expires_at = '2000-01-01T00:00:00Z' WHERE entry_id = $1", [expiredTicket.entryId]);
  assert.equal(await serviceB.validateAccessTokenAuthoritative(expiredTicket.token), null, 'Expired ticket must not validate.');
  await denied(serviceB.claimAccessSessionAuthoritative({
    entryId: expiredTicket.entryId, accessToken: expiredTicket.token, matchId: expiredTicket.matchId,
  }), 'Expired ticket must not be claimed.');

  const revokedTicket = await createTicket(serviceA, '5511999990104', 'safe-entry-match-revoked');
  const revokedEntry = storeA.getEntry(revokedTicket.entryId);
  assert.equal(await serviceA.revokeSharedAccess(revokedEntry), true, 'Revocation must persist in PostgreSQL.');
  const revokedSnapshot = await repoB.getEntry(revokedTicket.entryId);
  await issueRejected(repoA.issueAccess(revokedEntry, serviceA.hashPlayerBinding(revokedEntry.phone)), 'SAFE_ENTRY_ISSUE_REJECTED',
    'A revoked ticket must never be reopened by stale issuance.');
  await issueRejected(serviceA.persistSharedAccess(revokedEntry), 'SAFE_ENTRY_ISSUE_REJECTED',
    'The service persistence wrapper must preserve rejection for a revoked ticket.');
  assert.deepEqual(await repoB.getEntry(revokedTicket.entryId), revokedSnapshot,
    'Rejected reissue must preserve revocation and all persisted state.');
  assert.equal(await serviceB.validateAccessTokenAuthoritative(revokedTicket.token), null, 'Revoked ticket must not validate in another instance.');
  await denied(serviceB.claimAccessSessionAuthoritative({
    entryId: revokedTicket.entryId, accessToken: revokedTicket.token, matchId: revokedTicket.matchId,
  }), 'Revoked ticket must not be claimed.');

  const unavailablePool = new Pool({
    connectionString: connectionString.replace(':55432/', ':55433/'),
    connectionTimeoutMillis: 300,
    max: 1,
  });
  const unavailableRepo = new PostgresWhatsAppEntryAccessRepository({ pool: unavailablePool });
  const unavailableService = new WhatsAppEntryService({
    store: new WhatsAppEntryStore({}), accessSecret, publicGameUrl: 'http://localhost:3000',
    sharedAccessRepository: unavailableRepo, requireSharedAccessRepository: true,
  });
  await assert.rejects(unavailableService.validateAccessTokenAuthoritative(ticket.token), { message: 'SAFE_ENTRY_STORE_UNAVAILABLE' },
    'A database outage must fail closed with a controlled error.');
  await unavailablePool.end();

  console.log('PASS real PostgreSQL; independent pools; atomic claim=1 success/1 rejection; persisted row=1; replay/reconnect/restart/wrong match/session/player/expiry/revocation/fail-closed');
} finally {
  await repoA.pool.query('TRUNCATE TABLE whatsapp_safe_entries').catch(() => {});
  await Promise.all([repoA.close(), repoB.close(), repoRestarted.close()]);
}
