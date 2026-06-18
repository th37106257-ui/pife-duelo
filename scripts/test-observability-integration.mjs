import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const port = 3197;
const baseUrl = `http://127.0.0.1:${port}`;
const password = 'observability-integration-test';
const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    ADMIN_PASSWORD: password,
    CLIENT_URL: baseUrl,
    ALLOWED_CLIENT_URLS: baseUrl,
  },
  stdio: 'ignore',
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de integracao nao iniciou.');
}

function waitForSocketEvent(socket, eventName) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Evento ${eventName} nao recebido.`)), 3000);
    socket.once(eventName, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

try {
  const health = await waitForHealth();
  assert.equal(health.status, 'ok');
  assert.equal(health.phase, '4.15');
  assert.equal(typeof health.errorCountLastHour, 'number');
  assert.equal(typeof health.memoryUsage.heapUsedMb, 'number');

  const socket = io(baseUrl, { transports: ['polling', 'websocket'] });
  await waitForSocketEvent(socket, 'connect');
  socket.emit('client_error_report', { message: 'erro frontend de integracao', source: 'integration-test' });
  const rejectionPromise = waitForSocketEvent(socket, 'actionRejected');
  socket.emit('playerDrawFromDeck', { matchId: 'match-inexistente' });
  const rejection = await rejectionPromise;
  assert.equal(rejection.reason, 'MATCH_NOT_FOUND');
  await new Promise((resolve) => setTimeout(resolve, 50));

  const response = await fetch(`${baseUrl}/api/admin/dashboard`, {
    headers: { 'x-admin-password': password },
  });
  assert.equal(response.ok, true);
  const admin = await response.json();
  assert.equal(admin.monitoring.clientErrors.some((entry) => entry.message === 'erro frontend de integracao'), true);
  assert.equal(admin.monitoring.serverErrors.some((entry) => entry.event === 'ACTION_REJECTED'), true);
  assert.equal(typeof admin.metrics.onlinePlayers, 'number');
  socket.disconnect();
  console.log('PASS integracao health, socket, frontend error e admin monitoring');
} finally {
  server.kill();
}
