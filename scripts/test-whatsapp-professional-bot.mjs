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
  const menu = mainMenu({ waitingPlayers: 7 });
  assert.match(menu, /PIFE DUELO/);
  assert.match(menu, /7 jogadores procurando agora/i);
  assert.match(menu, /Jogar agora/i);
  assert.match(menu, /2️⃣.*Jogar grátis/);
  assert.match(menu, /3️⃣ Carteira/);
  assert.match(menu, /4️⃣ Regras/);
  assert.match(menu, /5️⃣ Suporte/);
  assert.match(menu, /Regras/);
  assert.match(menu, /Suporte/);
  assert.doesNotMatch(menu, /sandbox|homologa..o|demonstra..o|nenhum dinheiro real/i);
  assert.doesNotMatch(menu, /vencedor recebe/i);

  const tables = tablesMenu({ paymentsEnabled: false });
  assert.match(tables, /R\$2,00/);
  assert.match(tables, /R\$5,00/);
  assert.match(tables, /R\$10,00/);
  assert.match(tables, /R\$20,00/);
  assert.match(tables, /1 .*R\$2,00/);
  assert.doesNotMatch(tables, /Pix/i);

  assert.match(howItWorksMenu({ paymentsEnabled: false }), /Escolha uma mesa/i);
  assert.match(rulesMenu(), /Combina..es v.lidas/i);
  assert.match(rulesMenu(), /1 .*Objetivo[^]*2 .*turno/iu);
  assert.match(ruleTopic('1'), /tr.s combina..es v.lidas/i);
  assert.match(ruleTopic('2'), /compre uma carta/i);
  assert.match(ruleTopic('3'), /Sequ.ncia/i);
  assert.match(ruleTopic('4'), /use \*BATER\*/i);
  assert.match(ruleTopic('5'), /Partida come.ou/i);
  assert.match(allRules(), /Uma carta n.o pode ser reutilizada/i);
  assert.doesNotMatch(supportMenu({ publicReference: 'PD-ABCD1234' }), /PD-ABCD1234/);
  assert.match(supportMenu(), /1 .*Link n.o abre[^]*2 .*Advers.rio/iu);
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

  const walletUnavailable = await bot.handleConnectivityWebhook(webhook('3'));
  assert.equal(walletUnavailable.type, 'financial_unavailable');
  assert.match(sentMessages.at(-1).text, /carteira financeira não está ativada/i);

  const how = await bot.handleConnectivityWebhook(webhook('como funciona'));
  assert.equal(how.type, 'whatsapp_how_it_works_sent');
  assert.match(sentMessages.at(-1).text, /Como funciona/i);

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
  assert.match(sentMessages.at(-1).text, /não está aguardando uma partida/i);
  assert.match(sentMessages.at(-1).text, /\*jogar\* — escolher uma mesa/i);
  assert.doesNotMatch(sentMessages.at(-1).text, /indisponível/i);
  const missingLink = await bot.handleConnectivityWebhook(webhook('link'));
  assert.equal(missingLink.type, 'whatsapp_match_link_unavailable');

  assert.equal(sentMessages.every((message) => !/token|api.?key|secret/i.test(message.text)), true);
  assert.equal(logs.some((item) => item.event === 'BOT_HANDLER_SELECTED'), true);
  assert.equal(logs.some((item) => item.level === 'error'), false);
}

{
  const sentMessages = [];
  let firstBalanceRead = true;
  const demoCreditsService = {
    startingBalance: 100,
    isEnabled: () => true,
    getBalance: () => {
      const initialGrantApplied = firstBalanceRead;
      firstBalanceRead = false;
      return {
        availableBalance: 100,
        reservedBalance: 0,
        initialGrantApplied,
      };
    },
  };
  const bot = new WhatsAppPaymentBot({
    paymentsEnabled: false,
    demoCreditsService,
    cleanConversationEnabled: false,
    evolutionClient: {
      isConfigured: () => true,
      sendWhatsAppMessage: async (target, text) => {
        sentMessages.push({ target, text });
        return { ok: true, sent: true };
      },
    },
  });

  const welcome = await bot.handleConnectivityWebhook(webhook('oi'));
  assert.equal(welcome.type, 'whatsapp_new_player_welcome');
  assert.equal(welcome.state, 'new_player_onboarding');
  assert.match(sentMessages.at(-1).text, /BEM-VINDO AO PIFE DUELO/i);
  assert.match(sentMessages.at(-1).text, /100 Créditos de Teste/i);
  assert.match(sentMessages.at(-1).text, /Jogar minha primeira partida/i);
  assert.match(sentMessages.at(-1).text, /Ver como funciona/i);

  const explanation = await bot.handleConnectivityWebhook(webhook('2'));
  assert.equal(explanation.type, 'whatsapp_new_player_how_it_works');
  assert.match(sentMessages.at(-1).text, /PIFE EM 20 SEGUNDOS/i);
  assert.match(sentMessages.at(-1).text, /Escolher minha primeira mesa/i);

  const firstTables = await bot.handleConnectivityWebhook(webhook('1'));
  assert.equal(firstTables.type, 'whatsapp_first_match_tables_sent');
  assert.equal(firstTables.state, 'choosing_table');
  assert.match(sentMessages.at(-1).text, /ESCOLHA SUA PRIMEIRA MESA/i);
  assert.match(sentMessages.at(-1).text, /Recomendada para começar/i);
  assert.match(sentMessages.at(-1).text, /Mesa 1 — 2 Créditos de Teste/i);

  const normalMenu = await bot.handleConnectivityWebhook(webhook('menu'));
  assert.equal(normalMenu.type, 'whatsapp_menu_sent');
  assert.match(sentMessages.at(-1).text, /Jogar agora/i);
  assert.doesNotMatch(sentMessages.at(-1).text, /BEM-VINDO AO PIFE DUELO/i);
}

{
  const sentMessages = [];
  const demoCreditsService = {
    isEnabled: () => true,
    getBalance: () => ({
      availableBalance: 100,
      reservedBalance: 0,
      initialGrantApplied: false,
    }),
  };
  const bot = new WhatsAppPaymentBot({
    paymentsEnabled: false,
    demoCreditsService,
    cleanConversationEnabled: false,
    evolutionClient: {
      isConfigured: () => true,
      sendWhatsAppMessage: async (target, text) => {
        sentMessages.push({ target, text });
        return { ok: true, sent: true };
      },
    },
  });

  const walletResult = await bot.handleConnectivityWebhook(webhook('3'));
  assert.equal(walletResult.type, 'demo_credits_balance_sent');
  assert.match(sentMessages.at(-1).text, /Créditos de Teste/i);
  assert.match(sentMessages.at(-1).text, /Disponível:\s*\*100\*/i);
  assert.doesNotMatch(sentMessages.at(-1).text, /carteira est. indispon.vel/i);

  const balanceResult = await bot.handleConnectivityWebhook(webhook('saldo'));
  assert.equal(balanceResult.type, 'demo_credits_balance_sent');
  assert.match(sentMessages.at(-1).text, /Disponível:\s*\*100\*/i);
}

// Main menu practice is independent of demo balance and never enters a queue.
for (const balance of [0, 100]) {
  const sent = [];
  let balanceReads = 0;
  const bot = new WhatsAppPaymentBot({
    paymentsEnabled: false,
    cleanConversationEnabled: false,
    publicGameUrl: 'https://pife-duelo.example',
    demoCreditsService: {
      isEnabled: () => true,
      getBalance: () => { balanceReads += 1; return { availableBalance: balance, initialGrantApplied: false }; },
    },
    matchQueue: {
      joinQueue: () => { throw new Error('Practice must not enter matchmaking'); },
      joinFinancialQueue: () => { throw new Error('Practice must not reserve money'); },
    },
    evolutionClient: {
      isConfigured: () => true,
      sendWhatsAppMessage: async (target, text) => { sent.push(text); return { ok: true }; },
    },
  });
  for (const command of ['2', 'jogar grátis', 'teste']) {
    const result = await bot.handleConnectivityWebhook(webhook(command));
    assert.equal(result.type, 'whatsapp_test_mode_link_sent');
    assert.equal(result.testModeLink, 'https://pife-duelo.example/?mode=test');
    assert.match(sent.at(-1), /contra o bot sem entrar na fila/i);
  }
  assert.equal(balanceReads, 0);
  assert.equal((await bot.handleConnectivityWebhook(webhook('4'))).type, 'whatsapp_rules_sent');
  assert.equal((await bot.handleConnectivityWebhook(webhook('2'))).type, 'whatsapp_rules_topic_sent');
  await bot.handleConnectivityWebhook(webhook('menu'));
  assert.equal((await bot.handleConnectivityWebhook(webhook('5'))).type, 'whatsapp_support_menu_sent');
  assert.equal((await bot.handleConnectivityWebhook(webhook('2'))).type, 'whatsapp_support_topic_sent');
}

console.log('WhatsApp professional bot: conteudo centralizado, submenus e navegacao segura validados.');
