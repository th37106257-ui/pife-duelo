import assert from 'node:assert/strict';
import { WhatsAppPaymentBot } from '../server/src/payments/WhatsAppPaymentBot.js';
import {
  allRules,
  howItWorksMenu,
  mainMenu,
  ruleTopic,
  rulesMenu,
  supportMenu,
  supportTopic,
  tablesMenu,
} from '../server/src/services/whatsappMessages.js';

let messageSequence = 0;
const phone = '5511888877777';

function webhook(text) {
  messageSequence += 1;
  return {
    event: 'messages.upsert',
    instance: 'pife-duelo-bot',
    data: {
      key: {
        remoteJid: `${phone}@s.whatsapp.net`,
        fromMe: false,
        id: `professional-${messageSequence}`,
      },
      sender: `${phone}@s.whatsapp.net`,
      message: { conversation: text },
    },
  };
}

{
  const menu = mainMenu({ paymentsEnabled: false });
  assert.match(menu, /PIFE DUELO/);
  assert.match(menu, /1 .*Jogar/);
  assert.match(menu, /2 .*Como funciona/);
  assert.match(menu, /3 .*Regras do Pife/);
  assert.match(menu, /4 .*Suporte/);
  assert.match(menu, /sem cobran.a/i);
  assert.match(menu, /sem pr.mio real/i);
  assert.doesNotMatch(menu, /vencedor recebe/i);

  const tables = tablesMenu({ paymentsEnabled: false });
  assert.match(tables, /R\$2,00/);
  assert.match(tables, /R\$5,00/);
  assert.match(tables, /R\$10,00/);
  assert.match(tables, /R\$20,00/);
  assert.match(tables, /Nenhum valor ser. cobrado/i);
  assert.doesNotMatch(tables, /Pix/i);

  assert.match(howItWorksMenu({ paymentsEnabled: false }), /testes s.o gratuitos/i);
  assert.match(rulesMenu(), /Combina..es v.lidas/i);
  assert.match(ruleTopic('1'), /tr.s combina..es v.lidas/i);
  assert.match(ruleTopic('2'), /compre uma carta/i);
  assert.match(ruleTopic('3'), /Sequ.ncia/i);
  assert.match(ruleTopic('4'), /use \*BATER\*/i);
  assert.match(ruleTopic('5'), /Partida come.ou/i);
  assert.match(allRules(), /Uma carta n.o pode ser reutilizada/i);
  assert.match(supportMenu({ publicReference: 'PD-ABCD1234' }), /PD-ABCD1234/);
  assert.match(supportTopic('3'), /Atualize a p.gina/i);
}

{
  const sentMessages = [];
  const logs = [];
  const bot = new WhatsAppPaymentBot({
    paymentsEnabled: false,
    cleanConversationEnabled: false,
    publicGameUrl: 'https://pife-duelo.example',
    supportNumber: '5511999992222',
    evolutionClient: {
      isConfigured: () => true,
      sendWhatsAppMessage: async (target, text) => {
        sentMessages.push({ target, text });
        return { ok: true, sent: true };
      },
    },
    logInfo: (event, payload) => logs.push({ level: 'info', event, payload }),
    logWarn: (event, payload) => logs.push({ level: 'warn', event, payload }),
    logError: (event, payload) => logs.push({ level: 'error', event, payload }),
  });

  const hello = await bot.handleConnectivityWebhook(webhook('oi'));
  assert.equal(hello.type, 'whatsapp_menu_sent');
  assert.match(sentMessages.at(-1).text, /PIFE DUELO/);

  const how = await bot.handleConnectivityWebhook(webhook('2'));
  assert.equal(how.type, 'whatsapp_how_it_works_sent');
  assert.match(sentMessages.at(-1).text, /COMO FUNCIONA/);

  const rules = await bot.handleConnectivityWebhook(webhook('regras'));
  assert.equal(rules.type, 'whatsapp_rules_sent');
  assert.match(sentMessages.at(-1).text, /REGRAS DO PIFE/);
  const combinations = await bot.handleConnectivityWebhook(webhook('3'));
  assert.equal(combinations.type, 'whatsapp_rules_topic_sent');
  assert.match(sentMessages.at(-1).text, /COMBINA..ES V.LIDAS/i);

  const support = await bot.handleConnectivityWebhook(webhook('suporte'));
  assert.equal(support.type, 'whatsapp_support_menu_sent');
  assert.match(sentMessages.at(-1).text, /SUPORTE PIFE DUELO/);
  const supportTopicResult = await bot.handleConnectivityWebhook(webhook('1'));
  assert.equal(supportTopicResult.type, 'whatsapp_support_topic_sent');
  assert.match(sentMessages.at(-1).text, /navegador padr.o/i);

  const menuAgain = await bot.handleConnectivityWebhook(webhook('menu'));
  assert.equal(menuAgain.type, 'whatsapp_menu_sent');
  const idleCancel = await bot.handleConnectivityWebhook(webhook('cancelar'));
  assert.equal(idleCancel.type, 'whatsapp_cancel_empty');
  const missingLink = await bot.handleConnectivityWebhook(webhook('link'));
  assert.equal(missingLink.type, 'whatsapp_match_link_unavailable');

  assert.equal(sentMessages.every((message) => !/token|api.?key|secret/i.test(message.text)), true);
  assert.equal(logs.some((item) => item.event === 'BOT_HANDLER_SELECTED'), true);
  assert.equal(logs.some((item) => item.level === 'error'), false);
}

console.log('WhatsApp professional bot: conteudo centralizado, submenus e navegacao segura validados.');
