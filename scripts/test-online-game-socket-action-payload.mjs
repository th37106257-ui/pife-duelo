import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createViteServer } from 'vite';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { Server: SocketServer } = require('socket.io');
const httpServer = createHttpServer();
const socketServer = new SocketServer(httpServer, { transports: ['websocket'] });
const received = [];
let vite;
let clientWindow;

async function waitForReceivedEvent(eventName, startIndex) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const emitted = received.slice(startIndex).find((entry) => entry.eventName === eventName);
    if (emitted) return emitted;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Evento ${eventName} não chegou ao socket de teste.`);
}

socketServer.on('connection', (socket) => {
  socket.emit('connection:success', { connected: true });
  socket.on('ping_game', (_payload, acknowledge) => acknowledge({ transport: 'websocket' }));
  socket.onAny((eventName, payload, acknowledge) => {
    received.push({ eventName, payload });
    if (typeof acknowledge === 'function') acknowledge({ ok: true });
  });
});

await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const { port } = httpServer.address();
clientWindow = {
  location: {
    origin: `http://127.0.0.1:${port}`,
    pathname: '/',
    search: '',
    href: `http://127.0.0.1:${port}/`,
  },
  history: { replaceState() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
globalThis.window = clientWindow;

try {
  vite = await createViteServer({
    appType: 'custom',
    configFile: false,
    logLevel: 'silent',
    optimizeDeps: { include: [], noDiscovery: true },
    server: { middlewareMode: true },
  });
  const socketModule = await vite.ssrLoadModule('/src/services/socket.js');
  const actionsModule = await vite.ssrLoadModule('/src/services/onlineGameSocket.js');
  await socketModule.connectSocket();

  const cases = [
    ['drawFromDeckOnline', 'playerDrawFromDeck'],
    ['drawFromDiscardOnline', 'playerDrawFromDiscard'],
    ['discardCardOnline', 'playerDiscardCard'],
    ['knockOnline', 'player:knock'],
    ['reorderHandOnline', 'player:reorderHand'],
    ['surrenderOnlineMatch', 'playerSurrender'],
  ];

  for (const [functionName, expectedEvent] of cases) {
    const startIndex = received.length;
    await actionsModule[functionName]({
      roomId: 'room-action-payload-test',
      matchId: `match-${functionName}`,
      playerId: 'player-action-payload-test',
      turnNumber: 42,
      cardId: 'card-test',
      clientHandOrder: ['card-test'],
      handOrder: ['card-test'],
    });
    const emitted = received.slice(startIndex).find(({ eventName }) => eventName === expectedEvent);
    assert.equal(emitted?.eventName, expectedEvent, `${functionName} deve emitir o evento esperado`);
    assert.equal(emitted.payload.matchId, `match-${functionName}`);
    assert.equal(emitted.payload.turnNumber, 42);
    assert.equal(typeof emitted.payload.actionId, 'string');
    assert.ok(emitted.payload.actionId.startsWith(`${expectedEvent}-`));
  }

  for (const functionName of ['requestGameState', 'resumeOnlineMatch']) {
    const startIndex = received.length;
    actionsModule[functionName]({
      roomId: 'room-action-payload-test',
      matchId: `match-${functionName}`,
      playerId: 'player-action-payload-test',
      turnNumber: 42,
    });
    const emitted = await waitForReceivedEvent(functionName, startIndex);
    assert.equal(emitted.payload.matchId, `match-${functionName}`);
    assert.equal('turnNumber' in emitted.payload, false, `${functionName} não deve receber turnNumber`);
  }

  console.log('OK: seis ações encaminham matchId, turnNumber e actionId pelo socket real; operações de sessão não recebem turnNumber.');
} finally {
  try {
    const socketModule = vite && await vite.ssrLoadModule('/src/services/socket.js');
    socketModule?.disconnectSocket();
  } finally {
    await vite?.close();
    await new Promise((resolve) => socketServer.close(() => httpServer.close(resolve)));
    delete globalThis.window;
  }
}
