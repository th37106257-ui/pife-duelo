import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { PaymentStore } from '../server/src/payments/PaymentStore.js';
import { PaymentService } from '../server/src/payments/PaymentService.js';

const port = 3199;
const baseUrl = `http://127.0.0.1:${port}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'pife-payment-gate-'));
const paymentStorePath = join(temporaryDirectory, 'payments.json');
const accessSecret = 'integration-payment-access-secret';
const adminPhone = '5511999990000';
const seedStore = new PaymentStore({ filePath: paymentStorePath });
const seedService = new PaymentService({
  store: seedStore,
  adminNumbers: [adminPhone],
  accessSecret,
  publicGameUrl: baseUrl,
});

function createConfirmedPayment(phone, messageId) {
  const payment = seedService.selectTable({ phone, selectedTable: 5, source: 'test' });
  seedService.markReceiptReceived({ phone, messageId, source: 'test' });
  return seedService.confirmPayment({ paymentId: payment.paymentId, adminPhone, source: 'test' });
}

const firstPayment = createConfirmedPayment('5511888880000', 'receipt-a');
const secondPayment = createConfirmedPayment('5511777770000', 'receipt-b');
const firstToken = new URL(firstPayment.accessLink).searchParams.get('access');
const secondToken = new URL(secondPayment.accessLink).searchParams.get('access');

const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'payment-gate-test',
    CLIENT_URL: baseUrl,
    FRONTEND_URL: baseUrl,
    ALLOWED_CLIENT_URLS: baseUrl,
    PAYMENT_GATE_ENABLED: 'true',
    WHATSAPP_PAYMENTS_ENABLED: 'true',
    PAYMENT_STORE_PATH: paymentStorePath,
    PAYMENT_ACCESS_SECRET: accessSecret,
    PUBLIC_GAME_URL: baseUrl,
    ADMIN_WHATSAPP_NUMBERS: adminPhone,
    EVOLUTION_API_URL: 'https://evolution.example',
    EVOLUTION_API_KEY: 'test-key',
    EVOLUTION_INSTANCE_NAME: 'pife-duelo-test',
    EVOLUTION_WEBHOOK_SECRET: 'test-webhook-secret',
    PIX_KEY: 'test-pix-key',
    PIX_RECEIVER: 'Pife Duelo Teste',
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
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de teste nao iniciou.');
}

async function expectConnectionDenied(token = '') {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    auth: token ? { paymentToken: token } : {},
  });
  const errorPromise = once(socket, 'connect_error');
  socket.connect();
  const error = await errorPromise;
  assert.equal(error.message, 'PAYMENT_REQUIRED');
  assert.equal(error.data?.code, 'PAYMENT_REQUIRED');
  socket.close();
}

async function connectPaidClient(token) {
  const socket = io(baseUrl, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: false,
    auth: { paymentToken: token },
  });
  const connected = once(socket, 'connect');
  const identity = once(socket, 'connection:success');
  socket.connect();
  await connected;
  const connection = await identity;
  assert.equal(connection.paymentAccess.selectedTable, 5);
  return socket;
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
  await expectConnectionDenied();
  await expectConnectionDenied('invalid-token');

  const first = await connectPaidClient(firstToken);
  const wrongTable = await joinQueue(first, 10, 'Pago A');
  assert.equal(wrongTable.ok, false);
  assert.equal(wrongTable.reason, 'PAYMENT_TABLE_MISMATCH');

  const firstQueued = await joinQueue(first, 5, 'Pago A');
  assert.equal(firstQueued.ok, true);

  const duplicate = await connectPaidClient(firstToken);
  const duplicateQueue = await joinQueue(duplicate, 5, 'Duplicado');
  assert.equal(duplicateQueue.ok, false);
  assert.equal(duplicateQueue.reason, 'PAYMENT_ACCESS_RESERVED');
  duplicate.close();

  const second = await connectPaidClient(secondToken);
  const firstStarted = once(first, 'matchStarted');
  const secondStarted = once(second, 'matchStarted');
  const secondQueued = await joinQueue(second, 5, 'Pago B');
  assert.equal(secondQueued.ok, true);
  const [firstMatch, secondMatch] = await Promise.all([firstStarted, secondStarted]);
  assert.equal(firstMatch.matchId, secondMatch.matchId);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const persistedStore = new PaymentStore({ filePath: paymentStorePath });
  [firstPayment.payment.paymentId, secondPayment.payment.paymentId].forEach((paymentId) => {
    const payment = persistedStore.getPayment(paymentId);
    assert.ok(payment.accessUsedAt);
    assert.equal(payment.linkedMatchId, firstMatch.matchId);
  });

  const usedAccess = await joinQueue(first, 5, 'Pago A');
  assert.equal(usedAccess.ok, false);
  assert.equal(usedAccess.reason, 'PAYMENT_ACCESS_ALREADY_USED');
  first.close();
  second.close();
  console.log('Gate de pagamento: link ausente/invalido bloqueado e dois links confirmados iniciaram uma partida.');
} finally {
  server.kill();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
