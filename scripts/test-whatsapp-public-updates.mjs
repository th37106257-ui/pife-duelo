import assert from 'node:assert/strict';
import { WhatsAppPaymentBot } from '../server/src/payments/WhatsAppPaymentBot.js';
import { mainMenu } from '../server/src/services/whatsappMessages.js';
import {
  PUBLIC_ROADMAP,
  PUBLIC_ROADMAP_STATUS,
  availableUpdates,
  getPublicRoadmap,
  publicProjectStatus,
  publicUpdatesMenu,
  upcomingUpdates,
} from '../server/src/services/publicRoadmap.js';

let messageSequence = 0;

function webhook(phone, text) {
  messageSequence += 1;
  return {
    event: 'messages.upsert',
    instance: 'pife-duelo-bot-prod',
    data: {
      key: {
        remoteJid: `${phone}@s.whatsapp.net`,
        fromMe: false,
        id: `updates-${messageSequence}`,
      },
      sender: `${phone}@s.whatsapp.net`,
      message: { conversation: text },
    },
  };
}

function createRuntime({ cleanConversationEnabled = false, matchQueue = null, entryService = null } = {}) {
  const sent = [];
  const edited = [];
  const logs = [];
  let sentSequence = 0;
  const evolutionClient = {
    isConfigured: () => true,
    sendWhatsAppMessage: async (target, text) => {
      sentSequence += 1;
      sent.push({ target, text });
      return {
        ok: true,
        sent: true,
        messageKey: {
          id: `bot-panel-${sentSequence}`,
          remoteJid: String(target).includes('@') ? target : `${target}@s.whatsapp.net`,
          fromMe: true,
        },
      };
    },
    editTrackedMessage: async ({ phone, text, messageKey }) => {
      edited.push({ phone, text, messageKey });
      return { ok: true, edited: true };
    },
  };
  const bot = new WhatsAppPaymentBot({
    paymentsEnabled: false,
    cleanConversationEnabled,
    matchQueue,
    entryService,
    evolutionClient,
    logInfo: (event, payload) => logs.push({ level: 'info', event, payload }),
    logWarn: (event, payload) => logs.push({ level: 'warn', event, payload }),
    logError: (event, payload) => logs.push({ level: 'error', event, payload }),
  });
  return { bot, sent, edited, logs };
}

const flagsOff = {
  featureFlags: {
    paymentsEnabled: false,
    whatsappPaymentsEnabled: false,
    gateEnabled: false,
  },
};

{
  const menu = mainMenu({ paymentsEnabled: false });
  const updates = publicUpdatesMenu(flagsOff);
  const available = availableUpdates(flagsOff);
  const upcoming = upcomingUpdates(flagsOff);
  const status = publicProjectStatus(flagsOff);
  const fourPlayer = PUBLIC_ROADMAP.find((item) => item.id === 'four-player-mode');

  assert.match(menu, /5 .*Atualiza..es/i);
  assert.match(updates, /ATUALIZA..ES DO PIFE DUELO/i);
  assert.match(updates, /✅[^\n]*Novidades dispon.ve[íi]s[^\n]*\n\n🔎[^\n]*Pr.ximos recursos/iu);
  assert.doesNotMatch(updates, /Partidas online 1 contra 1/i);
  assert.match(available, /Partidas online 1 contra 1/i);
  assert.equal(fourPlayer?.status, PUBLIC_ROADMAP_STATUS.STUDY);
  assert.match(upcoming, /Em estudo.*Modalidade para 4 jogadores/is);
  assert.match(upcoming, /O modo 1 contra 1 continuar. dispon.vel/i);
  assert.doesNotMatch(upcoming, /em breve|chegando em breve|em desenvolvimento/i);
  assert.match(status, /beta fechado gratuito/i);
  assert.match(status, /Pagamentos, Pix e pr.mios reais n.o est.o dispon.veis/i);
  assert.doesNotMatch(`${updates}\n${available}\n${upcoming}`, /mesas pagas ativas|pagamentos liberados|reembolsos autom.ticos|torneios pagos/i);

  const protectedFinancialItem = {
    id: 'financial-test',
    title: 'Pagamento real',
    status: PUBLIC_ROADMAP_STATUS.AVAILABLE,
    publicVisible: true,
    requiredFlags: ['paymentsEnabled', 'whatsappPaymentsEnabled', 'gateEnabled'],
    order: 1,
  };
  assert.equal(getPublicRoadmap({ ...flagsOff, items: [protectedFinancialItem] }).length, 0);
  assert.equal(getPublicRoadmap({
    featureFlags: { paymentsEnabled: true, whatsappPaymentsEnabled: true, gateEnabled: true },
    items: [protectedFinancialItem],
  }).length, 1);
  assert.equal(getPublicRoadmap({
    items: [{ ...protectedFinancialItem, publicVisible: false, requiredFlags: [] }],
  }).length, 0);
}

{
  const phone = '5511888877777';
  const runtime = createRuntime({ cleanConversationEnabled: false });
  assert.equal((await runtime.bot.handleConnectivityWebhook(webhook(phone, 'oi'))).type, 'whatsapp_menu_sent');
  assert.equal((await runtime.bot.handleConnectivityWebhook(webhook(phone, '5'))).type, 'whatsapp_public_updates_sent');
  assert.match(runtime.sent.at(-1).text, /ATUALIZA..ES DO PIFE DUELO/i);

  const available = await runtime.bot.handleConnectivityWebhook(webhook(phone, '1'));
  assert.equal(available.type, 'whatsapp_public_updates_section_sent');
  assert.equal(available.section, 'available');

  assert.equal((await runtime.bot.handleConnectivityWebhook(webhook(phone, 'atualizações'))).type, 'whatsapp_public_updates_sent');
  const upcoming = await runtime.bot.handleConnectivityWebhook(webhook(phone, '2'));
  assert.equal(upcoming.section, 'upcoming');
  assert.match(runtime.sent.at(-1).text, /Em estudo.*Modalidade para 4 jogadores/is);

  const status = await runtime.bot.handleConnectivityWebhook(webhook(phone, '3'));
  assert.equal(status.section, 'status');
  assert.match(runtime.sent.at(-1).text, /beta fechado gratuito/i);

  const invalid = await runtime.bot.handleConnectivityWebhook(webhook(phone, '9'));
  assert.equal(invalid.type, 'whatsapp_invalid_updates_option');
  assert.match(runtime.sent.at(-1).text, /ATUALIZA..ES DO PIFE DUELO/i);

  const menu = await runtime.bot.handleConnectivityWebhook(webhook(phone, 'menu'));
  assert.equal(menu.type, 'whatsapp_menu_sent');
  assert.equal(runtime.logs.some((item) => item.event === 'WHATSAPP_PUBLIC_UPDATES_REQUEST'), true);
  assert.equal(runtime.logs.some((item) => item.event === 'WHATSAPP_PUBLIC_UPDATES_SECTION_SENT'), true);
}

{
  const phone = '5511777766666';
  let joinCalls = 0;
  let clearCalls = 0;
  const queue = { tableValue: 5 };
  const runtime = createRuntime({
    matchQueue: {
      findPlayerQueue: (target) => target === phone ? queue : null,
      joinQueue: () => { joinCalls += 1; },
      clearPlayerState: () => { clearCalls += 1; },
    },
  });
  const result = await runtime.bot.handleConnectivityWebhook(webhook(phone, '5'));
  assert.equal(result.type, 'whatsapp_public_updates_sent');
  assert.equal(runtime.bot.getPlayerContext(phone).state, 'WAITING_FOR_OPPONENT');
  assert.equal(joinCalls, 0);
  assert.equal(clearCalls, 0);
  assert.strictEqual(runtime.bot.getPlayerContext(phone).queue, queue);
}

{
  const phone = '5511666655555';
  const activeEntry = { entryId: 'entry-active', phone, status: 'playing', selectedTable: 10, linkedMatchId: 'match-active' };
  let mutations = 0;
  const runtime = createRuntime({
    entryService: {
      getActiveEntryForPhone: (target) => target === phone ? activeEntry : null,
      listEntriesForPhone: (target) => target === phone ? [activeEntry] : [],
      createEntry: () => { mutations += 1; },
      clearPlayerState: () => { mutations += 1; },
    },
  });
  const result = await runtime.bot.handleConnectivityWebhook(webhook(phone, 'atualizações'));
  assert.equal(result.type, 'whatsapp_public_updates_sent');
  assert.equal(runtime.bot.getPlayerContext(phone).state, 'MATCH_STARTED');
  assert.equal(mutations, 0);
}

{
  const phone = '5511555544444';
  const runtime = createRuntime({ cleanConversationEnabled: true });
  await runtime.bot.handleConnectivityWebhook(webhook(phone, 'oi'));
  await runtime.bot.handleConnectivityWebhook(webhook(phone, '5'));
  await runtime.bot.handleConnectivityWebhook(webhook(phone, '2'));
  assert.equal(runtime.sent.length, 3);
  assert.equal(runtime.edited.length, 0);
  assert.match(runtime.sent.at(-1).text, /PR.XIMOS RECURSOS/i);
}

console.log('WhatsApp public updates: roadmap central, painel vivo, flags e estados preservados.');
