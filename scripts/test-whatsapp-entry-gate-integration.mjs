import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { WhatsAppEntryStore } from '../server/src/entries/WhatsAppEntryStore.js';
import { WhatsAppEntryService } from '../server/src/entries/WhatsAppEntryService.js';

const port = 3201;
const baseUrl = `http://127.0.0.1:${port}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pife-whatsapp-entry-gate-'));
const entryStorePath = join(temporaryDirectory, 'entries.json');
const accessSecret = 'integration-whatsapp-entry-secret';
const seedStore = new WhatsAppEntryStore({ filePath: entryStorePath });
const seedService = new WhatsAppEntryService({
  store: seedStore,
  accessSecret,
  publicGameUrl: baseUrl,
});

function createApprovedEntry(phone) {
  const entry = seedService.createEntry({ phone, selectedTable: 5, source: 'integration-test' });
  return seedService.approveEntry({ entryId: entry.entryId, actor: 'integration-admin', source: 'integration-test' });
}

const firstApproval = createApprovedEntry('5511888880000');
const secondApproval = createApprovedEntry('5511777770000');
const firstToken = new URL(firstApproval.accessLink).searchParams.get('entry');
const secondToken = new URL(secondApproval.accessLink).searchParams.get('entry');

const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'entry-gate-test',
    CLIENT_URL: baseUrl,
    FRONTEND_URL: baseUrl,
    ALLOWED_CLIENT_URLS: baseUrl,
    PAYMENT_GATE_ENABLED: 'false',
    WHATSAPP_PAYMENTS_ENABLED: 'false',
    WHATSAPP_SAFE_ENTRY_ENABLED: 'true',
    WHATSAPP_ENTRY_STORE_PATH: entryStorePath,
    WHATSAPP_ENTRY_ACCESS_SECRET: accessSecret,
    PUBLIC_GAME_URL: baseUrl,
    ADMIN_WHATSAPP_NUMBERS: '5511999990000',
    EVOLUTION_API_URL: 'https://evolution.example',
    EVOLUTION_API_KEY: 'integration-placeholder',
    EVOLUTION_INSTANCE_NAME: 'pife-duelo-test',
    EVOLUTION_WEBHOOK_SECRET: 'integration-webhook-secret',
  },
  stdio: 'ignore',
});

function once(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Evento ${eventName} nao recebido.`)), timeoutMs);
    socket.once(eventName, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.payments.enabled, false);
        assert.equal(health.payments.gateEnabled, false);
        assert.equal(health.whatsapp.safeEntryEnabled, true);
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de teste nao iniciou.');
}

async function connectClient(entryToken = '') {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: false,
    auth: entryToken ? { entryToken } : {},
  });
  const connected = once(socket, 'connect');
  const identity = once(socket, 'connection:success');
  socket.connect();
  await connected;
  return { socket, connection: await identity };
}

async function expectConnectionDenied(entryToken) {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    auth: { entryToken },
  });
  const errorPromise = once(socket, 'connect_error');
  socket.connect();
  const error = await errorPromise;
  assert.equal(error.message, 'ENTRY_ACCESS_DENIED');
  assert.equal(error.data?.code, 'ENTRY_ACCESS_DENIED');
  socket.close();
}

function joinQueue(socket, tableValue, playerName) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit('joinQueue', { tableValue, playerName }, (error, acknowledgement) => {
      if (error) reject(error);
      else resolve(acknowledgement);
    });
  });
}

try {
  await waitForHealth();

  const fallback = await connectClient();
  assert.equal(fallback.connection.entryAccess, null);
  fallback.socket.close();
  await expectConnectionDenied('invalid-entry-token');

  const first = await connectClient(firstToken);
  assert.equal(first.connection.entryAccess.entryId, firstApproval.entry.entryId);
  assert.equal(first.connection.entryAccess.selectedTable, 5);

  const wrongTable = await joinQueue(first.socket, 10, 'Entrada A');
  assert.equal(wrongTable.ok, false);
  assert.equal(wrongTable.reason, 'ENTRY_TABLE_MISMATCH');

  const firstQueued = await joinQueue(first.socket, 5, 'Entrada A');
  assert.equal(firstQueued.ok, true);

  const duplicate = await connectClient(firstToken);
  const duplicateQueue = await joinQueue(duplicate.socket, 5, 'Duplicado');
  assert.equal(duplicateQueue.ok, false);
  assert.equal(duplicateQueue.reason, 'ENTRY_ACCESS_RESERVED');
  duplicate.socket.close();

  const second = await connectClient(secondToken);
  const firstStarted = once(first.socket, 'matchStarted');
  const secondStarted = once(second.socket, 'matchStarted');
  const secondQueued = await joinQueue(second.socket, 5, 'Entrada B');
  assert.equal(secondQueued.ok, true);
  const [firstMatch, secondMatch] = await Promise.all([firstStarted, secondStarted]);
  assert.equal(firstMatch.matchId, secondMatch.matchId);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const persistedStore = new WhatsAppEntryStore({ filePath: entryStorePath });
  [firstApproval.entry.entryId, secondApproval.entry.entryId].forEach((entryId) => {
    const entry = persistedStore.getEntry(entryId);
    assert.equal(entry.status, 'playing');
    assert.equal(entry.linkedMatchId, firstMatch.matchId);
  });

  first.socket.close();
  second.socket.close();
  console.log('Entrada WhatsApp: fallback preservado, token invalido bloqueado e dois links aprovados iniciaram partida.');
} finally {
  server.kill();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
