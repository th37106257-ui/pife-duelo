import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
const out = openSync(resolve(root, 'vite-dev.out.log'), 'a');
const err = openSync(resolve(root, 'vite-dev.err.log'), 'a');

const child = spawn(
  process.execPath,
  [viteBin, '--host', '0.0.0.0', '--configLoader', 'runner', '--port', '5173'],
  {
    cwd: root,
    stdio: ['pipe', out, err],
    windowsHide: true,
  },
);

console.log(`Pife Duelo dev server started with pid ${child.pid}`);
child.stdin.write('\n');

child.on('exit', (code, signal) => {
  console.log(`Pife Duelo dev server stopped: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  process.exit(code ?? 1);
});

setInterval(() => {}, 60 * 60 * 1000);
