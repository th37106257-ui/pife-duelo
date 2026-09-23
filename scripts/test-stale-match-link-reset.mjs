import assert from 'node:assert/strict';
import {
  clearEntrySessionKey,
  clearStaleMatchAccessFromUrl,
  finalizeWhatsAppEntryBootstrap,
  hasStoredEntrySession,
} from '../src/services/socket.js';
import { getSanitizedClientUrl } from '../src/services/errorReporter.js';

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
assert.equal(
  getSanitizedClientUrl('https://pife-duelo.example/join/match?online=1&entry=secret-entry&access=secret-payment&entrySessionKey=secret-session&source=whatsapp#table'),
  'https://pife-duelo.example/join/match?online=1&source=whatsapp#table',
  'Error reporter não deve enviar tickets ou credenciais de sessão na URL.',
);

const storageValues = new Map();
const bootstrapUrl = new URL('https://pife-duelo.example/join/match-bootstrap?online=1&entry=bootstrap-ticket&source=whatsapp#table');
let historySawPersistedKey = false;
globalThis.window = {
  location: bootstrapUrl,
  localStorage: {
    getItem(key) { return storageValues.get(key) ?? null; },
    setItem(key, value) { storageValues.set(key, value); },
    removeItem(key) { storageValues.delete(key); },
  },
  history: {
    state: { navigation: 'existing' },
    replaceState(state, _title, nextUrl) {
      historySawPersistedKey = storageValues.get('pifeDuelo.entrySession.match-bootstrap') === 'fresh-session-key';
      assert.deepEqual(state, { navigation: 'existing' });
      globalThis.window.location = new URL(nextUrl, bootstrapUrl.origin);
    },
  },
};
const bootstrapSocket = { auth: { entryToken: 'bootstrap-ticket', joinMatchId: 'match-bootstrap', paymentToken: 'unmodified-payment-token' } };
assert.equal(finalizeWhatsAppEntryBootstrap(bootstrapSocket, 'fresh-session-key'), true);
assert.equal(historySawPersistedKey, true, 'A sessionKey deve ser persistida antes da remoção do ticket da URL.');
assert.equal(window.location.pathname, '/join/match-bootstrap');
assert.equal(window.location.searchParams.get('entry'), null);
assert.equal(window.location.searchParams.get('online'), '1');
assert.equal(window.location.searchParams.get('source'), 'whatsapp');
assert.equal(window.location.hash, '#table');
assert.equal(bootstrapSocket.auth.entryToken, undefined);
assert.equal(bootstrapSocket.auth.joinMatchId, 'match-bootstrap');
assert.equal(bootstrapSocket.auth.entrySessionKey, 'fresh-session-key');
assert.equal(bootstrapSocket.auth.paymentToken, 'unmodified-payment-token');
assert.equal(hasStoredEntrySession('match-bootstrap'), true);

const recoveredUrl = new URL('https://pife-duelo.example/join/match-recovered?online=1&entry=stale-ticket#resume');
window.location = recoveredUrl;
window.localStorage.setItem('pifeDuelo.entrySession.match-recovered', 'stored-session-key');
const recoveredSocket = { auth: { entryToken: 'stale-ticket', joinMatchId: 'match-recovered', entrySessionKey: 'stored-session-key' } };
assert.equal(finalizeWhatsAppEntryBootstrap(recoveredSocket), true);
assert.equal(window.location.searchParams.get('entry'), null, 'Reconexão aceita também limpa ticket antigo da URL.');
assert.equal(recoveredSocket.auth.entryToken, undefined);
assert.equal(recoveredSocket.auth.entrySessionKey, 'stored-session-key');
clearEntrySessionKey('match-recovered');
assert.equal(hasStoredEntrySession('match-recovered'), false, 'Sessão terminal deve poder ser removida do armazenamento.');

delete globalThis.window;
console.log('Link antigo e bootstrap/reconexão WhatsApp: URL sanitizada, sessionKey persistida antes do ticket ser removido e sessão terminal limpável.');
