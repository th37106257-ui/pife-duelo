import assert from 'node:assert/strict';
import {
  MAX_LOGS,
  clearObservabilityForTests,
  getDailyObservabilityMetrics,
  getErrorCountSince,
  listObservabilityLogs,
  recordClientError,
  recordServerLog,
} from '../server/src/observabilityStore.js';

const results = [];

function test(name, run) {
  try {
    run();
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

test('registra e sanitiza erro do servidor', () => {
  clearObservabilityForTests();
  recordServerLog({
    level: 'error',
    event: 'SOCKET_ERROR',
    message: 'falha controlada',
    playerId: 'player-1',
    password: 'nao-pode-vazar',
    context: { token: 'segredo', safe: 'ok' },
  });
  const [entry] = listObservabilityLogs().server;
  assert.equal(entry.message, 'falha controlada');
  assert.equal(entry.playerId, 'player-1');
  assert.equal(entry.context.password, undefined);
  assert.equal(entry.context.context.token, undefined);
  assert.equal(entry.context.context.safe, 'ok');
});

test('recebe erro do frontend', () => {
  clearObservabilityForTests();
  recordClientError({ message: 'render falhou', source: 'react-render', matchId: 'match-1' });
  const [entry] = listObservabilityLogs().client;
  assert.equal(entry.source, 'frontend');
  assert.equal(entry.matchId, 'match-1');
});

test('limita cada colecao a 500 registros', () => {
  clearObservabilityForTests();
  for (let index = 0; index < MAX_LOGS + 25; index += 1) {
    recordServerLog({ level: 'warn', event: 'ACTION_REJECTED', message: `rejeitada-${index}` });
  }
  const logs = listObservabilityLogs({ limit: 1000 });
  assert.equal(logs.server.length, MAX_LOGS);
  assert.equal(logs.events.length, MAX_LOGS);
  assert.equal(logs.server[0].message, `rejeitada-${MAX_LOGS + 24}`);
});

test('calcula metricas de producao', () => {
  clearObservabilityForTests();
  recordServerLog({ level: 'info', event: 'ONLINE_MATCH_CREATED', matchId: 'match-1' });
  recordServerLog({ level: 'info', event: 'PLAYER_RECONNECTED', playerId: 'player-1' });
  recordServerLog({ level: 'info', event: 'PLAYER_DISCONNECTED', playerId: 'player-1' });
  recordServerLog({ level: 'info', event: 'AUTO_TURN_TIMEOUT', matchId: 'match-1' });
  recordServerLog({ level: 'error', event: 'MATCH_INTEGRITY_ERROR', matchId: 'match-1' });
  const metrics = getDailyObservabilityMetrics();
  assert.equal(metrics.startedMatchesToday, 1);
  assert.equal(metrics.reconnectCountToday, 1);
  assert.equal(metrics.disconnectCountToday, 1);
  assert.equal(metrics.autoTimeoutTurnsToday, 1);
  assert.equal(metrics.integrityErrorsToday, 1);
  assert.equal(getErrorCountSince(Date.now() - 1000), 1);
});

const failed = results.filter((result) => !result.passed);
console.log(`\nObservabilidade: ${results.length - failed.length}/${results.length} testes passaram.`);
if (failed.length) process.exitCode = 1;
