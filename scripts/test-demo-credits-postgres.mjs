import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PostgresDemoCreditsRepository, PostgresDemoCreditsService } from '../server/src/demoCredits/PostgresDemoCreditsService.js';

const requireServer = createRequire(new URL('../server/package.json', import.meta.url));
const { Pool } = requireServer('pg');
const connectionString = process.env.PIFE_DEMO_CREDITS_TEST_DATABASE_URL;
if (!connectionString) throw new Error('PIFE_DEMO_CREDITS_TEST_DATABASE_URL_REQUIRED');
const database = new URL(connectionString);
if (!['postgres:', 'postgresql:'].includes(database.protocol)
  || !['localhost', '127.0.0.1'].includes(database.hostname)
  || database.pathname !== '/pife_demo_credits_test'
  || database.username !== 'pife_test') {
  throw new Error('DEMO_CREDITS_TEST_REQUIRES_ISOLATED_LOCAL_POSTGRES');
}

const poolA = new Pool({ connectionString });
const poolB = new Pool({ connectionString });
const repositoryA = new PostgresDemoCreditsRepository({ pool: poolA });
const repositoryB = new PostgresDemoCreditsRepository({ pool: poolB });
const serviceA = new PostgresDemoCreditsService({ repository: repositoryA, enabled: true, startingBalance: 5 });
const serviceB = new PostgresDemoCreditsService({ repository: repositoryB, enabled: true, startingBalance: 5 });
const playerA = '5511990001001';
const playerB = '5511990001002';
const playerC = '5511990001003';

try {
  await Promise.all([repositoryA.initialize(), repositoryB.initialize()]);
  await poolA.query('TRUNCATE demo_credit_ledger, demo_credit_reservations, demo_credit_accounts RESTART IDENTITY CASCADE');

  const references = [
    { publicReference: 'DEMO-ATOMIC-A1', entryId: 'ATOMIC-A1', tableId: 5 },
    { publicReference: 'DEMO-ATOMIC-A2', entryId: 'ATOMIC-A2', tableId: 5 },
  ];
  const attempts = await Promise.allSettled([
    serviceA.reserveCredits(playerA, 5, references[0]),
    serviceB.reserveCredits(playerA, 5, references[1]),
  ]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(attempts.find((item) => item.status === 'rejected').reason.message, 'DEMO_ACTIVE_RESERVATION_EXISTS');
  const winningReference = references[attempts.findIndex((item) => item.status === 'fulfilled')];
  assert.equal((await serviceB.reserveCredits(playerA, 5, winningReference)).duplicate, true);
  assert.deepEqual((await serviceA.getBalance(playerA)).availableBalance, 0);
  assert.deepEqual((await serviceB.getBalance(playerA)).reservedBalance, 5);
  const count = await poolA.query('SELECT count(*)::integer AS total FROM demo_credit_reservations');
  assert.equal(count.rows[0].total, 1);

  await serviceB.reserveCredits(playerB, 5, { publicReference: 'DEMO-ATOMIC-B1', entryId: 'ATOMIC-B1', tableId: 5 });
  const participants = [
    { playerId: playerA, entryId: winningReference.entryId, matchPlayerId: 'P-A' },
    { playerId: playerB, entryId: 'ATOMIC-B1', matchPlayerId: 'P-B' },
  ];
  await assert.rejects(serviceA.consumeMatchReservations([
    participants[0], { playerId: playerB, entryId: 'FORGED', matchPlayerId: 'P-B' },
  ], { matchId: 'MATCH-ATOMIC', tableId: 5 }), { message: 'DEMO_MATCH_RESERVATION_INVALID' });
  assert.equal((await serviceB.getBalance(playerA)).reservedBalance, 5);
  assert.equal((await serviceA.consumeMatchReservations(participants, { matchId: 'MATCH-ATOMIC', tableId: 5 })).operations.length, 2);
  assert.equal((await serviceB.consumeMatchReservations(participants, { matchId: 'MATCH-ATOMIC', tableId: 5 })).duplicate, true);
  assert.equal((await serviceA.getBalance(playerA)).reservedBalance, 0);

  const settled = await serviceB.settleMatchResult({
    matchId: 'MATCH-ATOMIC', tableId: 5, winnerMatchPlayerId: 'P-A', participants,
  });
  assert.equal(settled.rewarded.duplicate, false);
  assert.equal((await serviceA.settleMatchResult({
    matchId: 'MATCH-ATOMIC', tableId: 5, winnerMatchPlayerId: 'P-A', participants,
  })).rewarded.duplicate, true);
  assert.equal((await serviceA.getBalance(playerA)).availableBalance, 9);
  assert.equal((await serviceB.getBalance(playerB)).availableBalance, 0);
  const rewardCount = await poolA.query("SELECT count(*)::integer AS total FROM demo_credit_ledger WHERE event_type = 'DEMO_MATCH_REWARD'");
  assert.equal(rewardCount.rows[0].total, 1);

  const restartRepository = new PostgresDemoCreditsRepository({ connectionString });
  try {
    await restartRepository.initialize();
    const restarted = new PostgresDemoCreditsService({ repository: restartRepository, enabled: true, startingBalance: 5 });
    assert.equal((await restarted.getBalance(playerA)).availableBalance, 9);
    assert.equal((await restarted.getStatus()).persistenceConfigured, true);
    const reference = { publicReference: 'DEMO-ATOMIC-C1', entryId: 'ATOMIC-C1', tableId: 5 };
    await restarted.reserveCredits(playerC, 5, reference);
    assert.equal((await serviceA.releaseReservation(playerC, reference)).released, true);
    assert.equal((await restarted.releaseReservation(playerC, reference)).duplicate, true);
    assert.equal((await serviceB.getBalance(playerC)).availableBalance, 5);
  } finally {
    await restartRepository.close();
  }

  const unavailableRepository = new PostgresDemoCreditsRepository({
    pool: { connect: async () => { throw new Error('database unavailable'); } },
  });
  unavailableRepository.initialized = true;
  const unavailableService = new PostgresDemoCreditsService({ repository: unavailableRepository, enabled: true });
  await assert.rejects(unavailableService.reserveCredits(playerA, 5, winningReference), /database unavailable/);
  assert.equal((await serviceA.getBalance(playerA)).availableBalance, 9);
  console.log('PASS demo PostgreSQL: independent pools, concurrent reserve, retry, atomic match start, settlement, restart, release and fail-closed');
} finally {
  await Promise.all([poolA.end(), poolB.end()]);
}
