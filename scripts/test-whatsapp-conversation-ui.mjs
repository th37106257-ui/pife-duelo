import assert from 'node:assert/strict';
import { EvolutionClient } from '../server/src/payments/EvolutionClient.js';
import { WhatsAppConversationUiService } from '../server/src/services/WhatsAppConversationUiService.js';

const phone = '5511999991234';
const jid = `${phone}@s.whatsapp.net`;

{
  let sends = 0;
  const ui = new WhatsAppConversationUiService({ enabled: false });
  const result = await ui.updateConversationPanel({
    phone,
    state: 'MAIN_MENU',
    content: 'menu tradicional',
    sendNew: async (content) => {
      sends += 1;
      return { ok: true, sent: true, content };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(sends, 1);
  assert.equal(ui.getPanel(phone), null);
}

{
  const logs = [];
  const edits = [];
  const deletes = [];
  let sendSequence = 0;
  let editShouldFail = false;
  const client = {
    editTrackedMessage: async (payload) => {
      edits.push(payload);
      return editShouldFail ? { ok: false, reason: 'simulated_edit_failure' } : { ok: true };
    },
    deleteTrackedMessage: async (payload) => {
      deletes.push(payload);
      return { ok: false, reason: 'simulated_delete_failure' };
    },
  };
  const ui = new WhatsAppConversationUiService({
    client,
    enabled: true,
    logInfo: (event, payload) => logs.push({ level: 'info', event, payload }),
    logWarn: (event, payload) => logs.push({ level: 'warn', event, payload }),
  });
  const sendNew = async () => {
    sendSequence += 1;
    return {
      ok: true,
      sent: true,
      messageKey: { id: `bot-${sendSequence}`, remoteJid: jid, fromMe: true },
    };
  };

  const created = await ui.updateConversationPanel({ phone, state: 'MAIN_MENU', content: 'menu', sendNew });
  assert.equal(created.panelCreated, true);
  assert.equal(ui.getPanel(phone).currentPanelMessageId, 'bot-1');
  assert.equal(logs.some((item) => item.event === 'WHATSAPP_PANEL_CREATED'), true);

  const edited = await ui.updateConversationPanel({ phone, state: 'RULES', content: 'regras', sendNew });
  assert.equal(edited.panelUpdated, true);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageKey.id, 'bot-1');
  assert.equal(ui.getPanel(phone).currentPanelState, 'RULES');
  assert.equal(logs.some((item) => item.event === 'WHATSAPP_PANEL_EDIT_SUCCESS'), true);

  editShouldFail = true;
  const fallback = await ui.updateConversationPanel({ phone, state: 'SUPPORT', content: 'suporte', sendNew });
  assert.equal(fallback.panelCreated, true);
  assert.equal(ui.getPanel(phone).currentPanelMessageId, 'bot-2');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].messageKey.id, 'bot-1');
  assert.equal(logs.some((item) => item.event === 'WHATSAPP_PANEL_EDIT_FAILED'), true);
  assert.equal(logs.some((item) => item.event === 'WHATSAPP_PANEL_FALLBACK_NEW_MESSAGE'), true);
  assert.equal(logs.some((item) => item.event === 'WHATSAPP_PANEL_DELETE_FAILED'), true);

  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes(phone), false);
  assert.equal(serializedLogs.includes('secret'), false);
}

{
  const logs = [];
  const sentContents = [];
  const ui = new WhatsAppConversationUiService({
    enabled: true,
    logWarn: (event, payload) => logs.push({ event, payload }),
  });
  const sendNew = async (content) => {
    sentContents.push(content);
    return { ok: true, messageKey: { id: content, remoteJid: jid, fromMe: true } };
  };
  const first = ui.updateConversationPanel({ phone, state: 'OLD', content: 'antigo', sendNew });
  const second = ui.updateConversationPanel({ phone, state: 'NEW', content: 'novo', sendNew });
  const [oldResult, newResult] = await Promise.all([first, second]);
  assert.equal(oldResult.ignored, true);
  assert.equal(newResult.panelCreated, true);
  assert.deepEqual(sentContents, ['novo']);
  assert.equal(logs.some((item) => item.event === 'WHATSAPP_PANEL_STALE_UPDATE_IGNORED'), true);
}

{
  const ui = new WhatsAppConversationUiService({ enabled: true });
  const unsafe = await ui.updateConversationPanel({
    phone,
    state: 'UNSAFE',
    content: 'nao rastrear',
    sendNew: async () => ({
      ok: true,
      messageKey: { id: 'player-message', remoteJid: jid, fromMe: false },
    }),
  });
  assert.equal(unsafe.panelCreated, false);
  assert.equal(ui.getPanel(phone), null);
}

{
  const ui = new WhatsAppConversationUiService({ enabled: true });
  const disconnected = await ui.updateConversationPanel({
    phone,
    state: 'OFFLINE',
    content: 'estado preservado',
    sendNew: async () => ({ ok: false, sent: false, reason: 'WHATSAPP_INSTANCE_NOT_OPEN' }),
  });
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.reason, 'WHATSAPP_INSTANCE_NOT_OPEN');
  assert.equal(ui.getPanel(phone), null);
}

{
  let now = Date.parse('2026-07-14T12:00:00.000Z');
  const ui = new WhatsAppConversationUiService({ enabled: true, clock: () => now, ttlMs: 1000 });
  await ui.updateConversationPanel({
    phone,
    state: 'TTL',
    content: 'temporario',
    sendNew: async () => ({ ok: true, messageKey: { id: 'ttl-message', remoteJid: jid, fromMe: true } }),
  });
  assert.equal(ui.getPanel(phone)?.currentPanelMessageId, 'ttl-message');
  now += 1001;
  assert.equal(ui.getPanel(phone), null);
}

{
  const requests = [];
  const responseBodies = [
    { key: { id: 'evo-message-1', remoteJid: jid, fromMe: true } },
    { ok: true },
    { ok: true },
  ];
  const client = new EvolutionClient({
    baseUrl: 'https://evolution.example',
    apiKey: 'server-secret',
    instanceName: 'pife-duelo-bot',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const body = responseBodies.shift() ?? { ok: true };
      return { ok: true, status: 200, json: async () => body };
    },
  });
  const sent = await client.sendWhatsAppMessage(phone, 'menu', { checkStatus: false, attempts: 1 });
  assert.deepEqual(sent.messageKey, { id: 'evo-message-1', remoteJid: jid, fromMe: true });

  await client.editTrackedMessage({ phone, text: 'regras', messageKey: sent.messageKey });
  await client.deleteTrackedMessage({ messageKey: sent.messageKey });

  assert.equal(requests[0].url, 'https://evolution.example/message/sendText/pife-duelo-bot');
  assert.deepEqual(JSON.parse(requests[0].options.body), { number: phone, text: 'menu' });
  assert.equal(requests[1].url, 'https://evolution.example/chat/updateMessage/pife-duelo-bot');
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    number: phone,
    text: 'regras',
    key: { id: 'evo-message-1', remoteJid: jid, fromMe: true },
  });
  assert.equal(requests[2].url, 'https://evolution.example/chat/deleteMessageForEveryone/pife-duelo-bot');
  assert.equal(requests[2].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    id: 'evo-message-1',
    remoteJid: jid,
    fromMe: true,
  });
}

console.log('WhatsApp conversation UI: flag segura, painel rastreado, fallback e contrato Evolution validados.');
