import { createServer } from 'node:http';
import { appendFileSync, createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = resolve(root, 'dist');
const port = Number(process.env.PORT || 5173);
const logFile = resolve(root, 'static-server.log');

function log(message) {
  appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function resolveRequestPath(url) {
  const pathname = decodeURIComponent(new URL(url, `http://127.0.0.1:${port}`).pathname);
  const requested = normalize(join(dist, pathname));
  if (!requested.startsWith(dist)) return null;
  if (existsSync(requested) && !pathname.endsWith('/')) return requested;
  return join(dist, 'index.html');
}

const server = createServer((request, response) => {
  const file = resolveRequestPath(request.url ?? '/');
  if (!file || !existsSync(file)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': types[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(response);
});

server.listen(port, '0.0.0.0', () => {
  const message = `Pife Duelo static server listening on port ${port}`;
  log(message);
  console.log(message);
});

server.on('error', (error) => {
  log(`server error: ${error.stack ?? error.message}`);
});

process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error.stack ?? error.message}`);
  process.exit(1);
});

process.on('exit', (code) => {
  log(`process exit: ${code}`);
});
