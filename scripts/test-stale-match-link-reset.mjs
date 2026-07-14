import assert from 'node:assert/strict';
import { clearStaleMatchAccessFromUrl } from '../src/services/socket.js';

const initialUrl = new URL('https://pife-duelo.example/join/whatsapp_match-old?online=1&entry=expired-token&matchId=whatsapp_match-old&source=test');
globalThis.window = {
  location: initialUrl,
  history: {
    replaceState(_state, _title, nextUrl) {
      globalThis.window.location = new URL(nextUrl, initialUrl.origin);
    },
  },
};

assert.equal(clearStaleMatchAccessFromUrl(), true);
assert.equal(window.location.pathname, '/');
assert.equal(window.location.searchParams.get('entry'), null);
assert.equal(window.location.searchParams.get('matchId'), null);
assert.equal(window.location.searchParams.get('online'), '1');
assert.equal(window.location.searchParams.get('source'), 'test');
assert.equal(clearStaleMatchAccessFromUrl(), false);

delete globalThis.window;
console.log('Link antigo: parametros de partida removidos e lobby online preservado.');
