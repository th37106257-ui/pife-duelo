import assert from 'node:assert/strict';
import { buildWhatsAppChatUrl } from '../src/services/whatsAppLink.js';

assert.equal(
  buildWhatsAppChatUrl({ phone: '+55 (21) 97873-6523', message: 'jogar' }),
  'https://wa.me/5521978736523?text=jogar',
);

assert.equal(
  buildWhatsAppChatUrl({ phone: '5521978736523@s.whatsapp.net', message: 'Quero jogar Pife Duelo' }),
  'https://wa.me/5521978736523?text=Quero%20jogar%20Pife%20Duelo',
);

assert.equal(buildWhatsAppChatUrl({ phone: '', message: 'jogar' }), null);
assert.equal(buildWhatsAppChatUrl({ phone: '---', message: 'jogar' }), null);

console.log('WhatsApp link: numero normalizado, conversa direta e fallback seguro validados.');
