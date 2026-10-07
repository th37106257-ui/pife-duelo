import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applySecurityHeaders,
  buildHtmlContentSecurityPolicy,
  injectScriptNonce,
} from '../server/src/security/httpHeaders.js';

const nonce = 'browser-hardening-test-nonce';
const policy = buildHtmlContentSecurityPolicy(nonce);
assert.match(policy, /default-src 'self'/);
assert.match(policy, /object-src 'none'/);
assert.match(policy, /frame-ancestors 'none'/);
assert.match(policy, /base-uri 'self'/);
assert.match(policy, new RegExp(`nonce-${nonce}`));

const html = [
  '<!doctype html>',
  '<script>window.inline = true;</script>',
  '<script defer src="/assets/app.js"></script>',
].join('\n');
const hardenedHtml = injectScriptNonce(html, nonce);
assert.equal((hardenedHtml.match(new RegExp(`nonce="${nonce}"`, 'g')) || []).length, 2);

const headers = new Map();
const response = {
  set(name, value) {
    headers.set(String(name).toLowerCase(), String(value));
    return this;
  },
};
applySecurityHeaders(response, { production: true, sensitive: true });
assert.equal(headers.get('referrer-policy'), 'no-referrer');
assert.equal(headers.get('x-content-type-options'), 'nosniff');
assert.equal(headers.get('x-frame-options'), 'DENY');
assert.match(headers.get('permissions-policy'), /camera=\(\)/);
assert.equal(headers.get('strict-transport-security'), 'max-age=31536000');
assert.equal(headers.get('cache-control'), 'no-store');

const socketSource = readFileSync(new URL('../src/services/socket.js', import.meta.url), 'utf8');
assert.doesNotMatch(socketSource, /__PIFE_DUELO_SOCKET__/);

const errorReporterSource = readFileSync(new URL('../src/services/errorReporter.js', import.meta.url), 'utf8');
assert.doesNotMatch(errorReporterSource, /__PIFE_DUELO_SOCKET__/);

const adminSource = readFileSync(new URL('../src/components/AdminPanel.jsx', import.meta.url), 'utf8');
assert.doesNotMatch(adminSource, /sessionStorage\.(?:getItem|setItem).*adminPassword/i);
assert.doesNotMatch(adminSource, /pifeDuelo\.adminPassword/);

const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
assert.match(appSource, /import\.meta\.env\.DEV\s*&&\s*params\.get\('socketTest'\)/);

const networkDebugSource = readFileSync(new URL('../src/components/NetworkDebugBadge.jsx', import.meta.url), 'utf8');
assert.match(networkDebugSource, /!import\.meta\.env\.DEV/);

const debugScenarioSource = readFileSync(new URL('../src/game/debugScenarios.js', import.meta.url), 'utf8');
assert.match(debugScenarioSource, /import\.meta\.env\?\.PROD/);

const viteSource = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
assert.match(viteSource, /sourcemap:\s*false/);

const mainSource = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
assert.match(mainSource, /entrySessionKey/);
assert.match(mainSource, /searchParams\.delete\(key\)/);

console.log('Browser hardening: CSP, headers, debug production surface, admin credential storage and URL sanitization validated.');
