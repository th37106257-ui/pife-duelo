import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const DEFAULT_PORT = 4173;
const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}/?mode=test&debug=exact-canbeat-discard`;
const targetUrl = process.env.PIFE_E2E_URL ?? DEFAULT_URL;
const spawnedProcesses = new Set();

function terminateProcessTree(child) {
  if (!child?.pid) return null;
  if (process.platform !== 'win32') {
    child.kill();
    return null;
  }
  return spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
}

function killSpawnedProcesses() {
  for (const child of spawnedProcesses) {
    try {
      terminateProcessTree(child);
    } catch {}
  }
  spawnedProcesses.clear();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hardTimeout = setTimeout(() => {
  console.error('TEST_MODE_DISCARD_UNLOCK_E2E_TIMEOUT');
  killSpawnedProcesses();
  process.exit(1);
}, 300000);

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} em ${url}: ${await response.text()}`);
  }
  return response.json();
}

async function waitForHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(300);
  }
  throw new Error(`Preview indisponivel em ${url}. Ultimo erro: ${lastError?.message ?? 'timeout'}`);
}

function getContentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

async function startPreviewIfNeeded() {
  if (!targetUrl.startsWith(`http://127.0.0.1:${DEFAULT_PORT}`)) {
    return null;
  }

  try {
    const existingPreview = await fetch(targetUrl, { method: 'GET' });
    if (existingPreview.ok) {
      console.log('TEST_MODE_E2E_REUSING_EXISTING_PREVIEW');
      return null;
    }
  } catch {}

  const distDir = join(process.cwd(), 'dist');
  if (!existsSync(join(distDir, 'index.html'))) {
    throw new Error('dist/index.html nao encontrado. Rode npm run build antes do E2E.');
  }

  console.log('TEST_MODE_E2E_STATIC_SERVER_STARTING');
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${DEFAULT_PORT}`);
      const safePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const requestedFile = safePath ? join(distDir, safePath) : join(distDir, 'index.html');
      const filePath = requestedFile.startsWith(distDir) ? requestedFile : join(distDir, 'index.html');

      try {
        const content = await readFile(filePath);
        response.writeHead(200, { 'content-type': getContentType(filePath) });
        response.end(content);
      } catch {
        const content = await readFile(join(distDir, 'index.html'));
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(content);
      }
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error.message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(DEFAULT_PORT, '127.0.0.1', resolve);
  });
  console.log('TEST_MODE_E2E_STATIC_SERVER_READY');

  return {
    kill: () => server.close(),
  };
}

function findEdgePath() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error('Edge/Chrome nao encontrado. Defina EDGE_PATH apontando para o navegador.');
  }
  return found;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];

    socket.on('message', (data) => {
      const payload = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      const message = JSON.parse(payload);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`));
        } else {
          resolve(message.result);
        }
        return;
      }
      if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) console.error('TEST_MODE_E2E_CDP_SEND_ERROR', method, error.message);
      });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
    });
  }

}

async function openCdpPage(url) {
  const port = 9222 + Math.floor(Math.random() * 800);
  const profileDir = await mkdtemp(join(tmpdir(), 'pife-test-mode-cdp-'));
  const browserProcess = spawn(findEdgePath(), [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=420,860',
    'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  spawnedProcesses.add(browserProcess);
  browserProcess.on('exit', () => spawnedProcesses.delete(browserProcess));

  const versionUrl = `http://127.0.0.1:${port}/json/version`;
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try {
      await fetchJson(versionUrl);
      break;
    } catch {
      await wait(250);
    }
  }

  const target = await fetchJson(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );

  const socket = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', () => reject(new Error('Falha ao conectar no CDP do navegador.')));
  });

  const cdp = new CdpClient(socket);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 860,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 1,
  });

  return {
    cdp,
    close: async () => {
      try {
        socket.close();
      } catch {}
      const browserExited = new Promise((resolve) => browserProcess.once('exit', resolve));
      const killer = terminateProcessTree(browserProcess);
      if (killer) {
        await Promise.race([
          new Promise((resolve) => killer.once('exit', resolve)),
          wait(5000),
        ]);
      }
      await Promise.race([browserExited, wait(3000)]);
      spawnedProcesses.delete(browserProcess);
      await Promise.race([
        rm(profileDir, { recursive: true, force: true }).catch(() => {}),
        wait(3000),
      ]);
    },
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? 'Erro ao avaliar expressao no navegador.');
  }

  return response.result?.value;
}

async function waitForEval(cdp, description, expression, timeoutMs = 12000) {
  const start = Date.now();
  let lastValue;
  while (Date.now() - start < timeoutMs) {
    lastValue = await evaluate(cdp, expression);
    if (lastValue) return lastValue;
    await wait(250);
  }
  const snapshot = await evaluate(cdp, 'JSON.stringify(window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__ ?? null)');
  throw new Error(`${description} nao aconteceu. Ultimo valor: ${JSON.stringify(lastValue)}. Snapshot: ${snapshot}`);
}

async function waitForEvalBoolean(cdp, expression, timeoutMs = 1200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(cdp, expression)) return true;
    await wait(120);
  }
  return false;
}

async function getRect(cdp, expression) {
  const rect = await evaluate(cdp, `(() => {
    const element = ${expression};
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
  })()`);
  if (!rect) throw new Error(`Elemento nao encontrado para: ${expression}`);
  return rect;
}

async function clickRect(cdp, rect) {
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}

async function dragPointToRect(cdp, start, toRect) {
  const end = { x: toRect.left + toRect.width / 2, y: toRect.top + toRect.height / 2 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });

  for (let step = 1; step <= 12; step += 1) {
    const t = step / 12;
    const x = start.x + (end.x - start.x) * t;
    const y = start.y + (end.y - start.y) * t;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await wait(35);
  }

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}

async function dragRectToRect(cdp, fromRect, toRect) {
  const start = { x: fromRect.left + fromRect.width / 2, y: fromRect.top + fromRect.height / 2 };
  await dragPointToRect(cdp, start, toRect);
}

async function touchDragPointToRect(cdp, start, toRect) {
  const end = { x: toRect.left + toRect.width / 2, y: toRect.top + toRect.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: start.x, y: start.y, radiusX: 3, radiusY: 3, force: 1, id: 1 }],
  });
  for (let step = 1; step <= 16; step += 1) {
    const t = step / 16;
    const x = start.x + (end.x - start.x) * t;
    const y = start.y + (end.y - start.y) * t;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y, radiusX: 3, radiusY: 3, force: 1, id: 1 }],
    });
    await wait(35);
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

async function touchDragRectToRect(cdp, fromRect, toRect) {
  const start = { x: fromRect.left + fromRect.width / 2, y: fromRect.top + fromRect.height / 2 };
  await touchDragPointToRect(cdp, start, toRect);
}

async function getVisibleCardPoint(cdp, cardId) {
  const point = await evaluate(cdp, `(() => {
    const cardId = ${JSON.stringify(cardId)};
    const element = document.querySelector('[data-card-id="' + CSS.escape(cardId) + '"]');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const xs = [8, 14, 22, rect.width * 0.35, rect.width * 0.55, rect.width * 0.75].map((x) => rect.left + Math.min(Math.max(x, 2), rect.width - 2));
    const ys = [12, 24, rect.height * 0.35, rect.height * 0.55, rect.height * 0.78].map((y) => rect.top + Math.min(Math.max(y, 2), rect.height - 2));
    for (const y of ys) {
      for (const x of xs) {
        const hit = document.elementFromPoint(x, y)?.closest?.('[data-card-id]');
        if (hit?.getAttribute('data-card-id') === cardId) {
          return { x, y };
        }
      }
    }
    return { x: rect.left + Math.min(12, rect.width / 2), y: rect.top + Math.min(24, rect.height / 2) };
  })()`);
  if (!point) throw new Error(`Ponto visivel nao encontrado para carta ${cardId}`);
  return point;
}

async function syntheticPointerDragCardToDiscard(cdp, cardId, start, toRect) {
  const end = { x: toRect.left + toRect.width / 2, y: toRect.top + toRect.height / 2 };
  await evaluate(cdp, `(() => {
    const cardId = ${JSON.stringify(cardId)};
    const start = ${JSON.stringify(start)};
    const end = ${JSON.stringify(end)};
    const element = document.querySelector('[data-card-id="' + CSS.escape(cardId) + '"]');
    if (!element) throw new Error('Carta nao encontrada: ' + cardId);
    const makeEvent = (type, point) => new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 11,
      pointerType: 'touch',
      isPrimary: true,
      clientX: point.x,
      clientY: point.y,
      buttons: type === 'pointerup' ? 0 : 1,
      button: 0,
    });
    element.dispatchEvent(makeEvent('pointerdown', start));
    for (let step = 1; step <= 12; step += 1) {
      const t = step / 12;
      const point = {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      };
      window.dispatchEvent(makeEvent('pointermove', point));
    }
    window.dispatchEvent(makeEvent('pointerup', end));
    return true;
  })()`);
}

async function assertPlayerUnlocked(cdp, label) {
  await waitForEval(
    cdp,
    `${label}: turno voltou ao jogador desbloqueado`,
    'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.currentTurn === "player" && window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.turnPhase === "PLAYER_MUST_DRAW"',
    16000,
  );

  const snapshot = await evaluate(cdp, 'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__');
  if (snapshot.blockReason !== 'NONE' || !snapshot.canPlayerAct || !snapshot.canDraw || !snapshot.canReorderHand) {
    throw new Error(`${label}: interacao bloqueada: ${JSON.stringify(snapshot)}`);
  }
  return snapshot;
}

async function drawUntilCanBeat(cdp, label, expectedMarkerCount) {
  console.log(`${label}_DRAW`);
  const drawRect = await getRect(cdp, 'document.querySelector(\'button[aria-label="Comprar carta"]\')');
  await clickRect(cdp, drawRect);

  await waitForEval(
    cdp,
    `${label}: compra com canBeat ativo`,
    'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.handSize === 10 && window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.canBeat === true',
    10000,
  );

  const snapshot = await evaluate(cdp, 'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__');
  const markerCount = await evaluate(cdp, 'document.querySelectorAll(".playing-card-combo .combo-marker").length');
  if (snapshot.validGroupCount !== 3 || snapshot.groupedCardCount !== 9 || snapshot.remainingCardCount !== 1) {
    throw new Error(`${label}: solucao invalida: ${JSON.stringify(snapshot)}`);
  }
  const acceptedMarkerCounts = Array.isArray(expectedMarkerCount)
    ? expectedMarkerCount
    : [expectedMarkerCount];
  if (snapshot.comboHighlightEnabled && !acceptedMarkerCounts.includes(markerCount)) {
    throw new Error(`${label}: circulos esperados=${acceptedMarkerCounts.join(' ou ')}, encontrados=${markerCount}`);
  }
  if (!snapshot.comboHighlightEnabled && markerCount !== 0) {
    throw new Error(`${label}: circulos deveriam estar desativados, encontrados=${markerCount}`);
  }

  return snapshot;
}

async function dragCardToDiscard(cdp, label, cardId, inputMethod = 'touch') {
  console.log(`${label}_DRAG_DISCARD_${cardId}`);
  const cardPoint = await getVisibleCardPoint(cdp, cardId);
  const discardRect = await getRect(cdp, 'document.querySelector(\'.discard-button\')');
  if (inputMethod === 'mouse') {
    await dragPointToRect(cdp, cardPoint, discardRect);
  } else {
    await touchDragPointToRect(cdp, cardPoint, discardRect);
  }
  if (
    inputMethod === 'touch'
    && !await waitForEvalBoolean(cdp, 'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.currentTurn === "bot"', 1500)
  ) {
    console.log(`${label}_DRAG_DISCARD_SYNTHETIC_POINTER_FALLBACK`);
    await syntheticPointerDragCardToDiscard(cdp, cardId, cardPoint, discardRect);
  }
  if (!await waitForEvalBoolean(cdp, 'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.currentTurn === "bot"', 1500)) {
    throw new Error(`${label}: o drag real do componente nao descartou a carta`);
  }

  await waitForEval(
    cdp,
    `${label}: descarte manual passou a vez ao bot`,
    'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.currentTurn === "bot"',
    10000,
  );

  const dragAttempt = await evaluate(cdp, `(() => {
    const attempts = window.__PIFE_DUELO_TEST_MODE_ACTION_ATTEMPTS__ ?? [];
    return [...attempts].reverse().find((attempt) => attempt.action === 'DRAG_TO_DISCARD') ?? null;
  })()`);
  if (!dragAttempt?.allowed || !dragAttempt.handDragging || !dragAttempt.canDropDiscard) {
    throw new Error(`${label}: destino de descarte perdeu autorizacao durante o drag: ${JSON.stringify(dragAttempt)}`);
  }
}

async function dragRemainingCardToDiscard(cdp, label, inputMethod = 'touch') {
  const snapshot = await evaluate(cdp, 'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__');
  const remainingCardId = snapshot.remainingCardIds?.[0];
  if (!remainingCardId) {
    throw new Error(`${label}: carta restante ausente no snapshot ${JSON.stringify(snapshot)}`);
  }
  await dragCardToDiscard(cdp, label, remainingCardId, inputMethod);
}

function buildScenarioUrl(scenarioKey) {
  const url = new URL(targetUrl);
  url.searchParams.set('mode', 'test');
  url.searchParams.set('debug', scenarioKey);
  url.searchParams.set('e2e', String(Date.now()));
  return url.toString();
}

async function openReadyScenario(scenarioKey) {
  const session = await openCdpPage(buildScenarioUrl(scenarioKey));
  await waitForEval(session.cdp, `${scenarioKey}: modo teste pronto`, 'Boolean(window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__)', 15000);
  await waitForEval(session.cdp, `${scenarioKey}: turno inicial`, 'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.currentTurn === "player"');
  return session;
}

async function reorderFirstCard(cdp, label) {
  console.log(`${label}_REORDER_CHECK`);
  const rects = await evaluate(cdp, `(() => Array.from(document.querySelectorAll('.card-fan-player [data-card-id]')).map((element) => {
    const rect = element.getBoundingClientRect();
    return { id: element.getAttribute('data-card-id'), left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
  }))()`);
  if (!Array.isArray(rects) || rects.length < 2) {
    throw new Error(`${label}: cartas insuficientes para reorganizar`);
  }
  const beforeOrder = rects.map((card) => card.id);
  await touchDragRectToRect(cdp, rects[0], rects[rects.length - 1]);
  await wait(700);
  let afterOrder = await evaluate(cdp, `Array.from(document.querySelectorAll('.card-fan-player [data-card-id]')).map((element) => element.getAttribute('data-card-id'))`);
  if (JSON.stringify(afterOrder) === JSON.stringify(beforeOrder)) {
    console.log(`${label}_REORDER_SYNTHETIC_POINTER_FALLBACK`);
    const start = await getVisibleCardPoint(cdp, rects[0].id);
    await syntheticPointerDragCardToDiscard(cdp, rects[0].id, start, rects[rects.length - 1]);
    await wait(700);
    afterOrder = await evaluate(cdp, `Array.from(document.querySelectorAll('.card-fan-player [data-card-id]')).map((element) => element.getAttribute('data-card-id'))`);
  }
  if (JSON.stringify(afterOrder) === JSON.stringify(beforeOrder)) {
    throw new Error(`${label}: o gesto real nao reorganizou a mao`);
  }
  const snapshot = await evaluate(cdp, 'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__');
  if (snapshot.blockReason !== 'NONE' || !snapshot.canReorderHand) {
    throw new Error(`${label}: reorganizacao bloqueou a mao: ${JSON.stringify(snapshot)}`);
  }
}

async function arrangeScatteredWinningHand(cdp) {
  const desiredSuffixes = [
    '-2-clubs',
    '-7-diamonds',
    '-3-clubs',
    '-2-hearts',
    '-9-clubs',
    '-7-clubs',
    '-4-clubs',
    '-2-spades',
    '-7-hearts',
  ];

  for (let index = 0; index < desiredSuffixes.length; index += 1) {
    const suffix = desiredSuffixes[index];
    const cardId = await evaluate(cdp, `Array.from(document.querySelectorAll('.card-fan-player [data-card-id]')).map((element) => element.getAttribute('data-card-id')).find((id) => id.endsWith(${JSON.stringify(suffix)}))`);
    if (!cardId) throw new Error(`Carta ausente ao espalhar a mao: ${suffix}`);
    await evaluate(cdp, `window.__PIFE_DUELO_TEST_MODE_ACTIONS__?.reorderCardByDrop(${JSON.stringify(cardId)}, ${index})`);
    await wait(80);
  }

  await wait(700);
  const actualSuffixes = await evaluate(cdp, `Array.from(document.querySelectorAll('.card-fan-player [data-card-id]')).map((element) => {
    const id = element.getAttribute('data-card-id');
    return ${JSON.stringify(desiredSuffixes)}.find((suffix) => id.endsWith(suffix));
  })`);
  if (JSON.stringify(actualSuffixes) !== JSON.stringify(desiredSuffixes)) {
    throw new Error(`Ordem espalhada nao aplicada: ${JSON.stringify(actualSuffixes)}`);
  }
}

async function assertScatteredWinningHandBeat(cdp) {
  await arrangeScatteredWinningHand(cdp);
  await drawUntilCanBeat(cdp, 'TEST_MODE_E2E_SCATTERED_BEAT', 0);
  const beatRect = await getRect(cdp, 'document.querySelector(\'.beat-button:not(:disabled)\')');
  await clickRect(cdp, beatRect);
  await waitForEval(cdp, 'resultado final apos bater', 'Boolean(document.querySelector(".endgame-panel"))', 10000);
  const revealSummary = await evaluate(cdp, `({
    groups: document.querySelectorAll('.endgame-groups .winning-group').length,
    cards: document.querySelectorAll('.endgame-groups .endgame-card').length,
    whatsappButton: Array.from(document.querySelectorAll('.endgame-panel button')).some((button) => button.textContent.includes('WhatsApp')),
  })`);
  if (revealSummary.groups !== 3 || revealSummary.cards !== 9 || !revealSummary.whatsappButton) {
    throw new Error(`Tela final incompleta: ${JSON.stringify(revealSummary)}`);
  }
  return revealSummary;
}

async function main() {
  const preview = await startPreviewIfNeeded();
  let browserSession = null;

  try {
    if (preview) {
      console.log('TEST_MODE_E2E_WAITING_PREVIEW');
      await waitForHttp(DEFAULT_URL);
      console.log('TEST_MODE_E2E_PREVIEW_READY');
    }

    console.log('TEST_MODE_E2E_OPEN_BROWSER');
    browserSession = await openReadyScenario('exact-canbeat-discard');
    const { cdp } = browserSession;

    if (process.env.PIFE_E2E_ONLY_BEAT === '1') {
      const revealSummary = await assertScatteredWinningHandBeat(cdp);
      console.log('TEST_MODE_BEAT_E2E_SUCCESS');
      console.log(JSON.stringify({ revealSummary }, null, 2));
      return;
    }

    const cycleResults = [];
    const expectedMarkersByCycle = [6, [3, 6], [3, 6]];
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const label = `TEST_MODE_E2E_CYCLE_${cycle}`;
      const afterDraw = await drawUntilCanBeat(cdp, label, expectedMarkersByCycle[cycle - 1]);
      await dragRemainingCardToDiscard(cdp, label, cycle === 1 ? 'mouse' : 'touch');
      const unlocked = await assertPlayerUnlocked(cdp, label);
      console.log(`${label}_UNLOCKED`);
      cycleResults.push({ cycle, afterDraw, unlocked });
      if (cycle < 3) {
        await reorderFirstCard(cdp, label);
      }
    }

    await browserSession.close();
    browserSession = await openReadyScenario('exact-canbeat-discard');
    const groupedDiscardCdp = browserSession.cdp;
    await drawUntilCanBeat(groupedDiscardCdp, 'TEST_MODE_E2E_GROUP_CARD_DISCARD', 6);
    const groupedCardId = await evaluate(groupedDiscardCdp, `Array.from(document.querySelectorAll('.card-fan-player [data-card-id]')).map((element) => element.getAttribute('data-card-id')).find((id) => id.endsWith('-3-clubs'))`);
    if (!groupedCardId) throw new Error('Carta 3 de paus nao encontrada para descarte do grupo');
    await dragCardToDiscard(groupedDiscardCdp, 'TEST_MODE_E2E_GROUP_CARD_DISCARD', groupedCardId);
    const markersAfterGroupedDiscard = await evaluate(groupedDiscardCdp, 'document.querySelectorAll(".playing-card-combo .combo-marker").length');
    if (markersAfterGroupedDiscard >= 9) {
      throw new Error(`Circulos do grupo quebrado permaneceram ativos: ${markersAfterGroupedDiscard}`);
    }
    await assertPlayerUnlocked(groupedDiscardCdp, 'TEST_MODE_E2E_GROUP_CARD_DISCARD');
    const nextDrawRect = await getRect(groupedDiscardCdp, 'document.querySelector(\'button[aria-label="Comprar carta"]\')');
    await clickRect(groupedDiscardCdp, nextDrawRect);
    await waitForEval(
      groupedDiscardCdp,
      'nova compra apos descarte de carta do grupo',
      'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.handSize === 10 && window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.canDropDiscard === true',
      10000,
    );
    const clickDiscardCardRect = await getRect(groupedDiscardCdp, 'document.querySelector(\'.card-fan-player [data-card-id]\')');
    await clickRect(groupedDiscardCdp, clickDiscardCardRect);
    const clickDiscardPileRect = await getRect(groupedDiscardCdp, 'document.querySelector(\'.discard-button\')');
    await clickRect(groupedDiscardCdp, clickDiscardPileRect);
    await waitForEval(
      groupedDiscardCdp,
      'clique mais clique descartou normalmente',
      'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.currentTurn === "bot"',
      10000,
    );
    await assertPlayerUnlocked(groupedDiscardCdp, 'TEST_MODE_E2E_CLICK_DISCARD');
    const menuRect = await getRect(groupedDiscardCdp, 'document.querySelector(\'.menu-button\')');
    await clickRect(groupedDiscardCdp, menuRect);
    await waitForEval(groupedDiscardCdp, 'menu do modo teste aberto', 'Boolean(document.querySelector(".test-mode-menu-panel"))');
    const restartRect = await getRect(
      groupedDiscardCdp,
      `Array.from(document.querySelectorAll('.test-mode-menu-panel button')).find((button) => button.textContent.includes('Reiniciar teste'))`,
    );
    await clickRect(groupedDiscardCdp, restartRect);
    await waitForEval(
      groupedDiscardCdp,
      'modo teste reiniciado',
      'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.currentTurn === "player" && window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.turnPhase === "PLAYER_MUST_DRAW" && window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__?.handSize === 9',
      10000,
    );
    const scatteredCdp = groupedDiscardCdp;
    await assertScatteredWinningHandBeat(scatteredCdp);

    const finalSnapshot = await evaluate(scatteredCdp, 'window.__PIFE_DUELO_TEST_MODE_INTERACTION_SNAPSHOT__');
    console.log('TEST_MODE_DISCARD_UNLOCK_E2E_SUCCESS');
    console.log(JSON.stringify({
      cycleResults,
      finalSnapshot,
    }, null, 2));
  } finally {
    if (browserSession) {
      await browserSession.close();
    }
    if (preview) {
      preview.kill();
      spawnedProcesses.delete(preview);
    }
  }
}

main().catch((error) => {
  console.error('TEST_MODE_DISCARD_UNLOCK_E2E_FAILED');
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  killSpawnedProcesses();
  clearTimeout(hardTimeout);
});
