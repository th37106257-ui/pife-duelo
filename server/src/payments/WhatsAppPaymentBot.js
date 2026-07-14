import { maskPhone, normalizePhone } from './PaymentService.js';

function sanitizeText(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function getMessageText(message = {}) {
  if (typeof message === 'string') return sanitizeText(message);
  const wrappedMessage = message.ephemeralMessage?.message
    || message.viewOnceMessage?.message
    || message.viewOnceMessageV2?.message
    || message.viewOnceMessageV2Extension?.message
    || message.documentWithCaptionMessage?.message
    || message.editedMessage?.message
    || message.protocolMessage?.editedMessage
    || null;
  if (wrappedMessage) {
    const nestedText = getMessageText(wrappedMessage);
    if (nestedText) return nestedText;
  }

  let interactiveText = '';
  const nativeFlowParams = message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (nativeFlowParams) {
    try {
      const parsed = JSON.parse(nativeFlowParams);
      interactiveText = parsed?.id || parsed?.display_text || parsed?.title || parsed?.name || '';
    } catch {
      interactiveText = '';
    }
  }

  return sanitizeText(
    message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.documentMessage?.caption
    || message.videoMessage?.caption
    || message.buttonsResponseMessage?.selectedDisplayText
    || message.buttonsResponseMessage?.selectedButtonId
    || message.buttonReplyMessage?.selectedDisplayText
    || message.buttonReplyMessage?.selectedId
    || message.templateButtonReplyMessage?.selectedDisplayText
    || message.templateButtonReplyMessage?.selectedId
    || message.listResponseMessage?.singleSelectReply?.selectedRowId
    || message.listResponseMessage?.singleSelectReply?.title
    || message.interactiveResponseMessage?.body?.text
    || interactiveText
    || message.text
    || message.body
    || message.caption
    || '',
  );
}

function listTechnicalKeys(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value).slice(0, 12);
}

function maskTechnicalIdentity(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const [identity, suffix] = raw.split('@');
  const digits = identity.replace(/\D/g, '');
  if (digits.length >= 4) return `${'*'.repeat(Math.min(8, Math.max(4, digits.length - 4)))}${digits.slice(-4)}${suffix ? `@${suffix}` : ''}`;
  return '<present>';
}

function normalizeJid(value) {
  return String(value || '').trim().toLowerCase();
}

function isWhatsappJid(value, suffix) {
  return String(value || '').trim().toLowerCase().endsWith(`@${suffix}`);
}

function normalizeCommand(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

const SAFE_TABLES = new Map([
  ['1', 2],
  ['2', 5],
  ['3', 10],
  ['4', 20],
]);

const MENU_COMMANDS = new Set(['oi', 'ola', 'menu', 'iniciar', 'comecar']);
const CANCEL_QUEUE_COMMANDS = new Set(['sair', 'cancelar']);
const SUPPORT_COMMANDS = new Set(['4', 'suporte', 'atendimento', 'ajuda']);
const PLAY_COMMANDS = new Set(['1', 'jogar', 'jogar valendo', 'valendo', 'ver mesas', 'mesas', 'mesa']);
const TEST_MODE_COMMANDS = new Set(['2', 'modo teste', 'modo teste gratis', 'teste', 'testar', 'gratis', 'gratuito']);
const RULES_COMMANDS = new Set(['3', 'regras', 'regra', 'como jogar']);
const IDENTIFY_COMMANDS = new Set(['meu numero', 'meu número']);

function isAdminCommandText(command) {
  return (
    command.startsWith('/admin')
    || command.startsWith('admin ')
    || command.startsWith('resetar ')
    || /^(cancelar|reembolsar|recolocar)\s+\d{8,15}$/i.test(command)
  );
}

function selectBotHandler(command, incoming = {}, currentState = null) {
  if (!incoming.text) return 'empty_text';
  if (incoming.fromMe) return 'ignored_from_me';
  if (incoming.isGroup) return 'ignored_group';
  if (IDENTIFY_COMMANDS.has(command)) return 'identify';
  if (isAdminCommandText(command)) return 'admin_command';
  const isTableSelectionInProgress = currentState?.state === 'choosing_table' && SAFE_TABLES.has(command);
  if (SUPPORT_COMMANDS.has(command) && !isTableSelectionInProgress) return 'support';
  if (MENU_COMMANDS.has(command)) return 'menu';
  if (CANCEL_QUEUE_COMMANDS.has(command)) return 'cancel_queue';
  if (isTableSelectionInProgress) return 'table_selection';
  if (PLAY_COMMANDS.has(command)) return 'play_or_tables';
  if (TEST_MODE_COMMANDS.has(command)) return 'test_mode';
  if (RULES_COMMANDS.has(command)) return 'rules';
  if (SUPPORT_COMMANDS.has(command)) return 'support';
  if (incoming.hasReceiptMedia) return 'receipt_media';
  return 'fallback_invalid';
}

function maskDigitsInText(value) {
  return String(value || '').replace(/\d{8,15}/g, (digits) => maskPhone(digits));
}

function defaultLogInfo(event, payload) {
  console.log(`[PIFE_SERVER][${event}]`, {
    timestamp: new Date().toISOString(),
    ...(payload || {}),
  });
}

function defaultLogWarn(event, payload) {
  console.warn(`[PIFE_SERVER][${event}]`, {
    timestamp: new Date().toISOString(),
    ...(payload || {}),
  });
}

function defaultLogError(event, payload) {
  console.error(`[PIFE_SERVER][${event}]`, {
    timestamp: new Date().toISOString(),
    ...(payload || {}),
  });
}

function getOwnerJid(payload = {}) {
  const candidates = [
    payload.ownerJid,
    payload.instance?.ownerJid,
    payload.data?.ownerJid,
  ];
  return candidates.find((value) => /@(?:s\.whatsapp\.net|lid)$/i.test(String(value || ''))) || '';
}

function sameJid(left, right) {
  return Boolean(left && right && normalizeJid(left) === normalizeJid(right));
}

function pickIncomingPlayerJid({ keyRemoteJid, keyRemoteJidAlt, senderJid, participant, participantAlt, ownerJid }) {
  const chatCandidates = [keyRemoteJid, keyRemoteJidAlt, participant, participantAlt]
    .map((value) => String(value || ''))
    .filter(Boolean)
    .filter((jid) => !sameJid(jid, ownerJid));
  const directWhatsappJid = chatCandidates.find((jid) => isWhatsappJid(jid, 's.whatsapp.net'));
  if (directWhatsappJid) return { jid: directWhatsappJid, source: 'chat_s_whatsapp_net' };

  if (senderJid && isWhatsappJid(senderJid, 's.whatsapp.net') && !sameJid(senderJid, ownerJid)) {
    return { jid: senderJid, source: 'sender_s_whatsapp_net_fallback' };
  }

  const lidJid = chatCandidates.find((jid) => isWhatsappJid(jid, 'lid'));
  if (lidJid) return { jid: lidJid, source: 'chat_lid' };

  if (senderJid && !sameJid(senderJid, ownerJid)) {
    return { jid: senderJid, source: 'sender_fallback' };
  }

  return { jid: keyRemoteJid || keyRemoteJidAlt || senderJid || participant || participantAlt || '', source: 'last_resort' };
}

function parseIncomingMessage(payload = {}) {
  const data = payload.data ?? payload;
  const key = data.key ?? {};
  const message = data.message ?? {};
  const keyRemoteJid = String(key.remoteJid || '');
  const keyRemoteJidAlt = String(key.remoteJidAlt || data.remoteJidAlt || '');
  const senderJid = String(data.sender || payload.sender || '');
  const remoteJid = String(keyRemoteJid || senderJid || '');
  const participant = String(key.participant || data.participant || '');
  const participantAlt = String(key.participantAlt || data.participantAlt || '');
  const ownerJid = getOwnerJid(payload);
  const { jid: phoneJid, source: phoneSource } = pickIncomingPlayerJid({
    keyRemoteJid,
    keyRemoteJidAlt,
    senderJid,
    participant,
    participantAlt,
    ownerJid,
  });
  const phone = normalizePhone(phoneJid.split('@')[0]);
  const canReplyToPhone = Boolean(phone && phoneJid && !isWhatsappJid(phoneJid, 'lid'));
  const replyTo = (canReplyToPhone ? phone : '')
    || keyRemoteJid
    || senderJid
    || [keyRemoteJid, keyRemoteJidAlt, participant, participantAlt, senderJid]
      .find((jid) => isWhatsappJid(jid, 'lid'))
    || '';
  return {
    phone,
    phoneSource,
    replyTo,
    remoteJid,
    remoteJidAlt: keyRemoteJidAlt,
    participant,
    participantAlt,
    ownerJid,
    messageId: String(key.id || data.messageId || payload.messageId || '').trim(),
    fromMe: key.fromMe === true,
    rawFromMe: key.fromMe,
    isGroup: remoteJid.endsWith('@g.us'),
    messageType: String(data.messageType || Object.keys(message)[0] || ''),
    sender: data.sender || payload.sender || null,
    pushName: data.pushName || payload.pushName || null,
    text: getMessageText(message) || getMessageText(data) || getMessageText(payload),
    hasReceiptMedia: Boolean(message.imageMessage || message.documentMessage),
  };
}

export function buildEvolutionMessageDiagnostic(payload = {}) {
  const incoming = parseIncomingMessage(payload);
  const remoteJid = normalizeJid(incoming.remoteJid);
  const participant = normalizeJid(incoming.participant);
  const ownerJid = normalizeJid(incoming.ownerJid);
  let decision = 'processed_incoming';
  let reason = 'incoming_private_text';

  if (incoming.fromMe) {
    decision = 'ignored_from_me';
    reason = 'key_from_me_true';
  } else if (incoming.isGroup) {
    decision = 'ignored_invalid';
    reason = 'group_not_supported';
  } else if (!incoming.phone || !remoteJid) {
    decision = 'ignored_invalid';
    reason = 'missing_remote_jid';
  } else if (!incoming.text) {
    decision = 'ignored_invalid';
    reason = 'empty_text';
  }

  return {
    event: String(payload?.event || ''),
    instance: String(payload?.instance || ''),
    messageType: incoming.messageType || null,
    dataKeys: listTechnicalKeys(payload.data ?? payload),
    messageKeys: listTechnicalKeys((payload.data ?? payload).message),
    keyFromMe: incoming.rawFromMe ?? null,
    remoteJid: maskTechnicalIdentity(incoming.remoteJid),
    remoteJidAlt: maskTechnicalIdentity(incoming.remoteJidAlt),
    participant: maskTechnicalIdentity(incoming.participant),
    participantAlt: maskTechnicalIdentity(incoming.participantAlt),
    sender: maskTechnicalIdentity(incoming.sender),
    pushName: incoming.pushName ? maskTechnicalIdentity(incoming.pushName) : null,
    playerPhone: maskPhone(incoming.phone),
    playerPhoneSource: incoming.phoneSource,
    ownerJid: maskTechnicalIdentity(incoming.ownerJid),
    replyTo: maskTechnicalIdentity(incoming.replyTo),
    remoteEqualsOwner: Boolean(remoteJid && ownerJid && remoteJid === ownerJid),
    participantEqualsOwner: Boolean(participant && ownerJid && participant === ownerJid),
    decision,
    reason,
  };
}

function parseTable(text) {
  const normalized = text.toLowerCase();
  const match = normalized.match(/(?:mesa\s*)?(2|5|10|20)(?:\s*reais)?\b/);
  return match ? Number(match[1]) : null;
}

function money(value) {
  return `R$${Number(value || 0).toFixed(2).replace('.', ',')}`;
}

function errorMessage(error) {
  const messages = {
    PAYMENT_NOT_FOUND: 'Pagamento não encontrado.',
    PAYMENT_NOT_PENDING: 'Esse pagamento não está pendente e não pode ser confirmado novamente.',
    RECEIPT_REQUIRED: 'O comprovante ainda não foi recebido.',
    REJECTION_REASON_REQUIRED: 'Informe o motivo da rejeição.',
    TABLE_LOCKED_AFTER_RECEIPT: 'A mesa não pode ser alterada depois do envio do comprovante.',
    PAYMENT_ACCESS_ALREADY_USED: 'Esse acesso já foi utilizado.',
  };
  return messages[error?.message] || 'Não foi possível executar o comando.';
}

export class WhatsAppPaymentBot {
  constructor({
    paymentService,
    entryService,
    matchQueue,
    safeEntryEnabled = false,
    evolutionClient,
    pixKey,
    pixReceiver,
    adminNumbers = [],
    supportNumber = '',
    publicGameUrl = '',
    clock = Date.now,
    logInfo = defaultLogInfo,
    logWarn = defaultLogWarn,
    logError = defaultLogError,
  } = {}) {
    this.paymentService = paymentService;
    this.entryService = entryService;
    this.matchQueue = matchQueue;
    this.safeEntryEnabled = Boolean(safeEntryEnabled);
    this.evolutionClient = evolutionClient;
    this.pixKey = String(pixKey || '');
    this.pixReceiver = String(pixReceiver || '');
    this.adminNumbers = adminNumbers.map(normalizePhone).filter(Boolean);
    this.supportNumber = normalizePhone(supportNumber) || this.adminNumbers[0] || '';
    this.publicGameUrl = String(publicGameUrl || '').replace(/\/$/, '');
    this.clock = clock;
    this.logInfo = logInfo;
    this.logWarn = logWarn;
    this.logError = logError;
    this.rateLimits = new Map();
    this.recentFingerprints = new Map();
    this.conversationStates = new Map();
    this.webhookDiagnostics = {
      lastWebhookReceivedAt: null,
      lastWebhookEvent: null,
      lastWebhookInstance: null,
      lastMessageProcessedAt: null,
      lastMessageFrom: null,
      lastInvalidPayloadReason: null,
    };
  }

  isConfigured() {
    return Boolean(
      this.paymentService
      && this.evolutionClient?.isConfigured()
      && this.pixKey
      && this.pixReceiver
      && this.adminNumbers.length,
    );
  }

  checkRateLimit(phone, text) {
    const now = this.clock();
    const timestamps = (this.rateLimits.get(phone) || []).filter((timestamp) => now - timestamp < 60000);
    if (timestamps.length >= 10) return false;
    timestamps.push(now);
    this.rateLimits.set(phone, timestamps);

    const fingerprint = `${phone}:${text.toLowerCase()}`;
    const previous = this.recentFingerprints.get(fingerprint) || 0;
    this.recentFingerprints.set(fingerprint, now);
    return now - previous >= 3000;
  }

  async send(phone, text, metadata = {}) {
    const targetMasked = maskTechnicalIdentity(phone) || maskPhone(phone);
    const textLength = String(text || '').length;
    this.logInfo('BOT_REPLY_ATTEMPT', {
      target: targetMasked,
      textLength,
      replyType: metadata.replyType ?? null,
      reason: metadata.reason ?? null,
    });
    try {
      const result = this.evolutionClient?.sendWhatsAppMessage
        ? await this.evolutionClient.sendWhatsAppMessage(phone, text, {
          checkStatus: metadata.checkStatus ?? true,
          throwOnFailure: false,
        })
        : await this.evolutionClient.sendText(phone, text);
      if (result?.ok === false) {
        this.logError('BOT_REPLY_FAILED', {
          target: targetMasked,
          textLength,
          replyType: metadata.replyType ?? null,
          reason: metadata.reason ?? null,
          message: result.reason || result.error || 'WHATSAPP_SEND_FAILED',
          httpStatus: result.httpStatus ?? null,
        });
        if (metadata.throwOnFailure) {
          const error = new Error(result.reason || result.error || 'WHATSAPP_SEND_FAILED');
          error.result = result;
          throw error;
        }
        return result;
      }
      this.logInfo('BOT_REPLY_SENT', {
        target: targetMasked,
        textLength,
        replyType: metadata.replyType ?? null,
        reason: metadata.reason ?? null,
      });
      return result;
    } catch (error) {
      this.logError('BOT_REPLY_FAILED', {
        target: targetMasked,
        textLength,
        replyType: metadata.replyType ?? null,
        reason: metadata.reason ?? null,
        message: error.message,
      });
      if (metadata.throwOnFailure) throw error;
      return {
        ok: false,
        sent: false,
        reason: error.message,
      };
    }
  }

  async getWhatsAppStatusText() {
    const status = this.evolutionClient?.checkInstanceStatus
      ? await this.evolutionClient.checkInstanceStatus()
      : { state: 'unknown', isOpen: null, reason: 'status_check_unavailable' };
    const diagnostics = this.evolutionClient?.getDiagnostics?.() ?? {};
    const reconnectNeeded = Boolean(diagnostics.reconnectNeeded || status.isOpen === false);
    const openLabel = status.isOpen === true ? 'sim' : (status.isOpen === false ? 'n\u00e3o' : 'desconhecido');
    return [
      '\u{1F4E1} Status WhatsApp/Evolution',
      '',
      `Provider solicitado: ${diagnostics.requestedProvider || diagnostics.provider || 'evolution'}`,
      `Provider ativo: ${diagnostics.activeProvider || diagnostics.provider || 'evolution'}`,
      `Evolution configurado: ${diagnostics.evolutionConfigured ? 'sim' : 'n\u00e3o'}`,
      `Meta Cloud configurado: ${diagnostics.metaCloudConfigured ? 'sim' : 'n\u00e3o'}`,
      `Meta phone number id: ${diagnostics.metaPhoneNumberIdConfigured ? 'configurado' : 'ausente'}`,
      `Meta token: ${diagnostics.metaTokenConfigured ? 'configurado' : 'ausente'}`,
      `Meta verify token: ${diagnostics.metaVerifyTokenConfigured ? 'configurado' : 'ausente'}`,
      `Meta app secret: ${diagnostics.metaAppSecretConfigured ? 'configurado' : 'ausente'}`,
      `Meta Graph API version: ${diagnostics.metaGraphApiVersionConfigured ? 'configurado' : 'ausente'}`,
      `Inst\u00e2ncia/ID: ${diagnostics.instanceName || this.evolutionClient?.instanceName || 'n\u00e3o configurada'}`,
      `Status: ${status.state || diagnostics.lastStatus || 'desconhecido'}`,
      `Inst\u00e2ncia aberta/conectada: ${openLabel}`,
      `HTTP status check: ${status.httpStatus ?? diagnostics.lastStatusHttpStatus ?? 'n/a'}`,
      '',
      `\u00daltimo webhook recebido: ${diagnostics.lastWebhookReceivedAt || this.webhookDiagnostics.lastWebhookReceivedAt || 'n/a'}`,
      `\u00daltima mensagem processada: ${diagnostics.lastMessageProcessedAt || this.webhookDiagnostics.lastMessageProcessedAt || 'n/a'}`,
      `\u00daltima tentativa de envio: ${diagnostics.lastSendAttemptAt || 'n/a'}`,
      `\u00daltimo envio com sucesso: ${diagnostics.lastSendSuccessAt || 'n/a'}`,
      `\u00daltimo erro: ${diagnostics.lastError || this.webhookDiagnostics.lastInvalidPayloadReason || 'nenhum'}`,
      `Precisa reconectar: ${reconnectNeeded ? 'sim' : 'n\u00e3o'}`,
    ].join('\n');
  }

  async handleAdminTestSend({ adminPhone, replyTo, rawText }) {
    const testSendMatch = rawText.match(/^(?:\/admin|admin)\s+teste\s+envio\s+(.+)$/i);
    const targetPhone = normalizePhone(testSendMatch?.[1]);
    if (!targetPhone) {
      return {
        ok: false,
        targetPhone: null,
        error: 'invalid_target_phone',
      };
    }
    const testMessage = `Teste Evolution Pife Duelo - ${new Date(this.clock()).toISOString()}`;
    const payloadPreview = this.evolutionClient?.buildSendPayloadPreview?.(targetPhone, testMessage) ?? {
      target: maskPhone(targetPhone),
      payload: { textLength: testMessage.length },
    };
    const result = this.evolutionClient?.sendWhatsAppMessage
      ? await this.evolutionClient.sendWhatsAppMessage(targetPhone, testMessage, {
        attempts: 1,
        checkStatus: true,
        throwOnFailure: false,
      })
      : await this.send(targetPhone, testMessage);
    this.logInfo('ADMIN_COMMAND_EXECUTED', {
      command: 'teste_envio',
      adminPhone: maskPhone(adminPhone),
      targetPhone: maskPhone(targetPhone),
      result: result?.ok === false ? 'failed' : 'ok',
      httpStatus: result?.httpStatus ?? null,
    });
    await this.send(replyTo, [
      '\u{1F9EA} Teste de envio WhatsApp',
      '',
      `Destino: ${maskPhone(targetPhone)}`,
      `Payload: endpoint ${payloadPreview.endpoint || '/message/sendText'}`,
      `N\u00famero no payload: ${payloadPreview.payload?.number || payloadPreview.target || maskPhone(targetPhone)}`,
      `Texto: ${payloadPreview.payload?.textLength ?? testMessage.length} caracteres`,
      `HTTP status: ${result?.httpStatus ?? 'n/a'}`,
      `Resultado: ${result?.ok === false ? 'falha' : 'sucesso/aceito pela Evolution'}`,
      `Resposta: ${JSON.stringify(result?.response ?? result?.rawResponse ?? {}).slice(0, 700)}`,
      result?.ok === false ? `Erro: ${result.reason || result.error || 'desconhecido'}` : '',
    ].filter(Boolean).join('\n'));
    return {
      ok: result?.ok !== false,
      targetPhone: maskPhone(targetPhone),
      result,
    };
  }

  getConversationState(phone) {
    return this.conversationStates.get(phone) || { state: 'idle', selectedTable: null };
  }

  setConversationState(phone, state, selectedTable = null) {
    if (this.conversationStates.size >= 5000 && !this.conversationStates.has(phone)) {
      const oldestPhone = this.conversationStates.keys().next().value;
      this.conversationStates.delete(oldestPhone);
    }
    this.conversationStates.set(phone, { state, selectedTable, updatedAt: new Date(this.clock()).toISOString() });
  }

  safeMenuText() {
    return [
      '\u{1F3B4} Bem-vindo ao Pife Duelo!',
      '',
      'Escolha uma op\u00e7\u00e3o:',
      '',
      '1\uFE0F\u20E3 Jogar valendo',
      '2\uFE0F\u20E3 Modo teste gr\u00e1tis',
      '3\uFE0F\u20E3 Regras',
      '4\uFE0F\u20E3 Suporte',
    ].join('\n');
  }

  buildTestModeLink() {
    if (!this.publicGameUrl) return '/?mode=test';
    return `${this.publicGameUrl}/?mode=test`;
  }

  safeTestModeText(testModeLink = this.buildTestModeLink()) {
    return [
      '\u{1F3AE} Modo Teste gr\u00e1tis liberado!',
      '',
      'Aqui voc\u00ea pode conhecer o Pife Duelo sem pagar nada e sem pr\u00eamio.',
      '',
      '\u2705 Sem Pix',
      '\u2705 Sem aposta',
      '\u2705 Sem pr\u00eamio',
      '\u2705 Apenas para testar a gameplay',
      '',
      'Clique no link abaixo para jogar no modo teste:',
      '',
      testModeLink,
    ].join('\n');
  }

  safeTablesText() {
    return [
      'Escolha sua mesa:',
      '',
      '1\uFE0F\u20E3 Mesa R$2,00 \u2014 vencedor recebe R$3,60',
      '2\uFE0F\u20E3 Mesa R$5,00 \u2014 vencedor recebe R$9,00',
      '3\uFE0F\u20E3 Mesa R$10,00 \u2014 vencedor recebe R$17,00',
      '4\uFE0F\u20E3 Mesa R$20,00 \u2014 vencedor recebe R$32,80',
      '',
      'Digite o n\u00famero da mesa desejada.',
    ].join('\n');
  }

  safeRulesText() {
    return [
      '\u{1F4DC} Regras b\u00e1sicas do Pife Duelo:',
      '',
      '* Partida 1x1',
      '* Voc\u00ea joga no seu turno',
      '* Pode comprar do monte ou do descarte',
      '* Depois deve descartar uma carta',
      '* Para vencer, forme combina\u00e7\u00f5es v\u00e1lidas do Pife',
      '* Tempo por jogada: 60 segundos',
      '* Se o tempo acabar, o sistema faz jogada autom\u00e1tica',
      '* Ap\u00f3s pagamento confirmado, n\u00e3o h\u00e1 cancelamento autom\u00e1tico',
    ].join('\n');
  }

  buildSupportLink() {
    if (!this.supportNumber) return '';
    return `https://wa.me/${this.supportNumber}?text=Ol%C3%A1,%20preciso%20de%20suporte%20no%20Pife%20Duelo`;
  }

  safeSupportText({ activeContext = null } = {}) {
    const supportLink = this.buildSupportLink();
    const lines = [
      '\u{1F4DE} Suporte Pife Duelo',
      '',
      'Para falar com o suporte, toque no link abaixo:',
      '',
      supportLink || 'Suporte temporariamente indispon\u00edvel. Responda aqui descrevendo o problema.',
      '',
      'Se voc\u00ea j\u00e1 pagou ou est\u00e1 com problema em uma partida, envie:',
      '\u2022 seu n\u00famero',
      '\u2022 mesa escolhida',
      '\u2022 print do erro',
      '\u2022 comprovante, se houver pagamento',
      '',
      'Tamb\u00e9m pode responder aqui descrevendo o problema.',
    ];

    if (activeContext) {
      lines.push(
        '',
        'Identificamos que voc\u00ea pode ter uma entrada ativa. Fale com o suporte antes de cancelar ou sair.',
      );
    }

    return lines.join('\n');
  }

  getSupportContext(phone) {
    const activeMatch = this.matchQueue?.findActiveMatch?.(phone) ?? null;
    const activeEntry = this.entryService?.getActiveEntryForPhone?.(phone) ?? null;
    const activeQueue = this.matchQueue?.findPlayerQueue?.(phone) ?? null;
    const status = activeMatch?.status
      ?? activeEntry?.status
      ?? (activeQueue ? 'queued' : null);
    const table = activeMatch?.tableValue
      ?? activeEntry?.selectedTable
      ?? activeQueue?.tableValue
      ?? null;
    const matchId = activeMatch?.matchId
      ?? activeEntry?.linkedMatchId
      ?? null;

    return {
      status,
      table,
      matchId,
      hasActiveContext: Boolean(activeMatch || activeEntry || activeQueue),
    };
  }

  async handleSupportRequest(incoming, { replyTo, originIp } = {}) {
    const context = this.getSupportContext(incoming.phone);
    this.logInfo('WHATSAPP_SUPPORT_REQUEST', {
      playerId: maskPhone(incoming.phone),
      phone: maskPhone(incoming.phone),
      status: context.status,
      table: context.table,
      matchId: context.matchId,
      originIp,
    });

    await this.send(replyTo, this.safeSupportText({
      activeContext: context.hasActiveContext ? context : null,
    }));

    this.logInfo('WHATSAPP_SUPPORT_LINK_SENT', {
      playerId: maskPhone(incoming.phone),
      supportNumber: maskPhone(this.supportNumber),
    });

    return {
      type: 'whatsapp_support_sent',
      decision: 'reply_sent',
      reason: 'support_requested',
      state: this.getConversationState(incoming.phone).state,
      status: context.status,
      table: context.table,
      matchId: context.matchId,
      originIp,
    };
  }

  safeTableSelectedText(amount, { entryRegistered = false } = {}) {
    if (entryRegistered) {
      return [
        `\u2705 Mesa selecionada: R$${Number(amount).toFixed(2).replace('.', ',')}.`,
        '',
        'Sua entrada foi registrada em modo seguro.',
        'Aguarde a libera\u00e7\u00e3o do admin para receber o link da partida.',
        '',
        '\u26A0\uFE0F Pix e pagamentos ainda est\u00e3o desligados nesta fase de teste.',
      ].join('\n');
    }
    return [
      `\u2705 Mesa selecionada: R$${Number(amount).toFixed(2).replace('.', ',')}`,
      '',
      'O fluxo de pagamento ainda est\u00e1 em modo seguro/desligado.',
      'Em breve enviaremos as instru\u00e7\u00f5es de Pix por aqui.',
    ].join('\n');
  }

  safeEntryApprovedText(entry, accessLink) {
    return [
      '\u2705 Entrada liberada!',
      '',
      `Mesa: R$${Number(entry.tableAmount).toFixed(2).replace('.', ',')}`,
      `Pr\u00eamio da mesa: R$${Number(entry.prizeAmount).toFixed(2).replace('.', ',')}`,
      '',
      'Entre pelo link:',
      accessLink,
      '',
      'Tempo por jogada: 60 segundos.',
    ].join('\n');
  }

  pendingEntriesText() {
    const entries = this.entryService?.listEntries({ status: 'pending_admin_validation' }) ?? [];
    if (!entries.length) return 'Nenhuma entrada pendente.';
    return [
      'Entradas pendentes:',
      ...entries.slice(0, 20).map((entry) => (
        `#${entry.entryId} | Mesa R$${Number(entry.tableAmount).toFixed(2).replace('.', ',')} | Tel: ${entry.phoneMasked}`
      )),
    ].join('\n');
  }

  async handleSafeEntryAdminCommand(phone, text, { replyTo = phone } = {}) {
    const senderPhone = normalizePhone(phone);
    const rawText = sanitizeText(text);
    const normalizedText = normalizeCommand(rawText).replace(/\s+/g, ' ');
    this.logInfo('ADMIN_COMMAND_RECEIVED', {
      rawText: maskDigitsInText(rawText),
      senderPhone: maskPhone(senderPhone),
    });
    const isAdmin = Boolean(
      senderPhone
      && (
        this.adminNumbers.includes(senderPhone)
        || this.entryService?.isAdmin?.(senderPhone)
      ),
    );
    this.logInfo('ADMIN_COMMAND_AUTH_CHECK', {
      senderPhone: maskPhone(senderPhone),
      configuredAdmins: this.adminNumbers.map(maskPhone),
      isAdmin,
    });
    if (!isAdmin) {
      this.logWarn('ADMIN_COMMAND_DENIED', {
        senderPhone: maskPhone(senderPhone),
        reason: 'admin_not_authorized',
      });
      await this.send(replyTo, '❌ Comando admin não autorizado para este número.');
      return { type: 'entry_admin_unauthorized', decision: 'reply_sent', reason: 'admin_not_authorized' };
    }

    if (normalizedText === 'admin ping' || normalizedText === '/admin ping') {
      await this.send(replyTo, '✅ Admin ativo.');
      this.logInfo('ADMIN_COMMAND_EXECUTED', {
        command: 'ping',
        adminPhone: maskPhone(senderPhone),
        targetPhone: null,
        result: 'ok',
      });
      return { type: 'entry_admin_ping', decision: 'reply_sent', reason: 'admin_ping_ok' };
    }

    if (normalizedText === 'admin status whatsapp' || normalizedText === '/admin status whatsapp') {
      await this.send(replyTo, await this.getWhatsAppStatusText());
      this.logInfo('ADMIN_COMMAND_EXECUTED', {
        command: 'status_whatsapp',
        adminPhone: maskPhone(senderPhone),
        targetPhone: null,
        result: 'ok',
      });
      return { type: 'entry_admin_status_whatsapp', decision: 'reply_sent', reason: 'admin_status_whatsapp_ok' };
    }

    if (normalizedText === 'admin status' || normalizedText === '/admin status') {
      await this.send(replyTo, [
        '✅ Admin reconhecido.',
        `Seu número: ${senderPhone}`,
        'Comandos disponíveis:',
        'admin status whatsapp',
        'admin teste envio NUMERO',
        'admin recolocar NUMERO',
        'admin cancelar NUMERO',
        'admin reembolsar NUMERO',
      ].join('\n'));
      this.logInfo('ADMIN_COMMAND_EXECUTED', {
        command: 'status',
        adminPhone: maskPhone(senderPhone),
        targetPhone: null,
        result: 'ok',
      });
      return { type: 'entry_admin_status', decision: 'reply_sent', reason: 'admin_status_ok' };
    }

    if (/^(?:\/admin|admin)\s+teste\s+envio\s+/i.test(rawText)) {
      const testResult = await this.handleAdminTestSend({ adminPhone: senderPhone, replyTo, rawText });
      return {
        type: 'entry_admin_test_send',
        decision: 'reply_sent',
        reason: testResult.ok ? 'admin_test_send_ok' : testResult.error,
        targetPhone: testResult.targetPhone,
      };
    }

    const invalidFormatText = [
      '❌ Formato inválido.',
      'Use:',
      'admin status whatsapp',
      'admin teste envio 5521999999999',
      'admin recolocar 5521999999999',
      'admin cancelar 5521999999999',
      'admin reembolsar 5521999999999',
    ].join('\n');

    if (/^\/admin\s+entradas$/i.test(text)) {
      await this.send(replyTo, this.pendingEntriesText());
      return { type: 'entry_admin_pending_list', decision: 'reply_sent', reason: 'pending_entries_listed' };
    }

    const resetMatch = text.match(/^(?:(?:\/admin|admin)\s+)?resetar\s+(\d{8,15})$/i);
    if (resetMatch) {
      const targetPhone = normalizePhone(resetMatch[1]);
      const result = this.matchQueue?.clearPlayerState?.(targetPhone, {
        actor: phone,
        reason: 'whatsapp_admin_reset',
      });
      const paidWarning = result?.paidEntryPreserved
        ? '⚠️ RESET_PAID_ENTRY_WARNING: existe entrada paga/validada preservada. Decida manualmente: requeue, refund ou cancel.'
        : null;
      await this.send(replyTo, [
        `✅ Estado limpo para ${maskPhone(targetPhone)}.`,
        `Filas removidas: ${result?.removedFromQueues ?? 0}`,
        `Entradas canceladas: ${result?.clearedEntries?.cleared ?? 0}`,
        result?.realMatchPreserved ? 'Partida real preservada.' : 'Nenhuma partida real foi cancelada.',
      ].join('\n'));
      if (paidWarning) await this.send(replyTo, paidWarning);
      return {
        type: 'entry_admin_player_reset',
        decision: 'reply_sent',
        reason: 'player_state_reset_by_admin',
        targetPhone: maskPhone(targetPhone),
      };
    }

    const paidDecisionMatch = rawText.match(/^(?:(?:\/admin|admin)\s+)?(cancelar|reembolsar|recolocar)(?:\s+(.+))?$/i);
    if (paidDecisionMatch) {
      const decisionByCommand = {
        cancelar: 'cancel',
        reembolsar: 'refund',
        recolocar: 'requeue',
      };
      const command = paidDecisionMatch[1].toLowerCase();
      const targetPhone = normalizePhone(paidDecisionMatch[2]);
      if (!targetPhone) {
        this.logWarn('ADMIN_COMMAND_INVALID_FORMAT', {
          senderPhone: maskPhone(senderPhone),
          rawText: maskDigitsInText(rawText),
        });
        await this.send(replyTo, invalidFormatText);
        return { type: 'entry_admin_invalid_format', decision: 'reply_sent', reason: 'invalid_target_phone' };
      }
      const preStartMatch = this.entryService?.getPreStartMatchForPhone?.(targetPhone);
      if (preStartMatch?.matchId) {
        this.matchQueue?.abortMatchAndReleaseParticipants?.({
          matchId: preStartMatch.matchId,
          reason: `whatsapp_admin_${command}_before_start`,
          cancelledBy: targetPhone,
        });
      }
      const result = this.entryService?.adminDecidePaidEntryForPhone?.(targetPhone, {
        actor: senderPhone,
        decision: decisionByCommand[command],
        source: `whatsapp_admin_${command}`,
      }) ?? { updated: false, reason: 'entry_service_unavailable' };
      if (!result.updated) {
        this.logWarn('ADMIN_COMMAND_EXECUTED', {
          command,
          adminPhone: maskPhone(senderPhone),
          targetPhone: maskPhone(targetPhone),
          result: result.reason,
        });
        await this.send(replyTo, '⚠️ Jogador não encontrado ou sem entrada ativa.');
        return {
          type: 'entry_admin_paid_decision_failed',
          decision: 'reply_sent',
          reason: result.reason,
          targetPhone: maskPhone(targetPhone),
        };
      }
      const successText = {
        cancelar: '✅ Entrada cancelada pelo admin.',
        reembolsar: '✅ Entrada marcada para reembolso/admin review.',
        recolocar: '✅ Jogador recolocado com sucesso.',
      };
      await this.send(replyTo, [
        successText[command],
        `Jogador: ${maskPhone(targetPhone)}`,
        `Entrada: #${result.entry.entryId}`,
        `Status: ${result.entry.status}`,
        'Histórico preservado.',
      ].join('\n'));
      this.logInfo('ADMIN_COMMAND_EXECUTED', {
        command,
        adminPhone: maskPhone(senderPhone),
        targetPhone: maskPhone(targetPhone),
        result: result.entry.status,
      });
      return {
        type: 'entry_admin_paid_decision',
        decision: 'reply_sent',
        reason: `paid_entry_${decisionByCommand[command]}`,
        targetPhone: maskPhone(targetPhone),
        entryId: result.entry.entryId,
      };
    }

    const approveMatch = text.match(/^\/admin\s+liberar\s+(E?\d+)$/i);
    if (approveMatch) {
      const entryId = approveMatch[1].toUpperCase().startsWith('E') ? approveMatch[1].toUpperCase() : `E${approveMatch[1]}`;
      let approval = null;
      try {
        const internalEntry = this.entryService.getEntry(entryId, { includeSecrets: true });
        approval = this.entryService.approveEntry({ entryId, actor: phone, source: 'whatsapp-admin' });
        await this.send(internalEntry.phone, this.safeEntryApprovedText(approval.entry, approval.accessLink));
        this.entryService.markLinkDelivery(entryId, { sent: true });
        await this.send(replyTo, `\u2705 Entrada #${entryId} liberada. Link enviado ao jogador.`);
        return { type: 'entry_approved', decision: 'reply_sent', reason: 'entry_approved_by_whatsapp', entryId };
      } catch (error) {
        const current = approval ? this.entryService.getEntry(entryId) : null;
        if (current?.status === 'approved_for_queue' && !current.linkSentAt) {
          this.entryService.markLinkDelivery(entryId, { sent: false, error: error.message });
          this.entryService.rollbackApprovalAfterDeliveryFailure(entryId, { error: error.message });
        }
        await this.send(replyTo, `N\u00e3o foi poss\u00edvel liberar a entrada: ${error.message}`);
        return { type: 'entry_admin_command_failed', decision: 'reply_sent', reason: error.message, entryId };
      }
    }

    const rejectMatch = text.match(/^\/admin\s+rejeitar\s+(E?\d+)\s+(.+)$/i);
    if (rejectMatch) {
      const entryId = rejectMatch[1].toUpperCase().startsWith('E') ? rejectMatch[1].toUpperCase() : `E${rejectMatch[1]}`;
      try {
        const internalEntry = this.entryService.getEntry(entryId, { includeSecrets: true });
        const entry = this.entryService.rejectEntry({
          entryId,
          actor: phone,
          reason: sanitizeText(rejectMatch[2]),
          source: 'whatsapp-admin',
        });
        await this.send(internalEntry.phone, [
          '\u274C Sua entrada n\u00e3o foi liberada pelo admin.',
          '',
          `Motivo: ${entry.rejectionReason}`,
          '',
          'Digite menu para come\u00e7ar novamente.',
        ].join('\n'));
        await this.send(replyTo, `Entrada #${entryId} rejeitada e jogador avisado.`);
        return { type: 'entry_rejected', decision: 'reply_sent', reason: 'entry_rejected_by_whatsapp', entryId };
      } catch (error) {
        await this.send(replyTo, `N\u00e3o foi poss\u00edvel rejeitar a entrada: ${error.message}`);
        return { type: 'entry_admin_command_failed', decision: 'reply_sent', reason: error.message, entryId };
      }
    }

    await this.send(replyTo, 'Comando admin inválido. Use /admin entradas, /admin liberar ENTRY_ID, /admin rejeitar ENTRY_ID motivo ou resetar NUMERO.');
    return { type: 'entry_admin_invalid_command', decision: 'reply_sent', reason: 'invalid_admin_command' };
  }

  safeQueueJoinedText(amount) {
    return [
      `✅ Você entrou na fila da Mesa R$${Number(amount).toFixed(0)}.`,
      'Aguardando outro jogador entrar...',
      '',
      'Para cancelar, digite sair ou menu.',
    ].join('\n');
  }

  safeQueueDuplicateText() {
    return '⏳ Você já está aguardando um adversário nesta mesa.';
  }

  safeActiveMatchText() {
    return '⚠️ Você já está em uma partida ativa.';
  }

  safeMatchFoundText(amount, accessLink) {
    return [
      '🎮 Partida encontrada!',
      `Mesa: R$${Number(amount).toFixed(0)}`,
      '',
      'Entre na sala pelo link abaixo:',
      accessLink,
    ].join('\n');
  }

  safeOtherQueueText() {
    return '⏳ Você já está aguardando adversário em outra mesa. Aguarde ou digite menu.';
  }

  safeQueueCancelledText() {
    return '\u2705 Sua entrada foi cancelada. Voc\u00ea voltou ao menu.';
  }

  safePaidEntryActiveText(entry = null) {
    const amount = entry?.selectedTable ? ` na Mesa R$${Number(entry.selectedTable).toFixed(0)}` : '';
    return [
      `✅ Você possui uma entrada paga ativa${amount}.`,
      'Aguarde o início da partida ou fale com o suporte/admin.',
    ].join('\n');
  }

  safeOpponentCancelledRequeuedText(amount) {
    return [
      '⚠️ O outro jogador cancelou antes da partida começar.',
      'Sua entrada continua válida.',
      `Você voltou para a fila da Mesa R$${Number(amount).toFixed(0)} e estamos aguardando um novo adversário.`,
    ].join('\n');
  }

  async handleConnectivityWebhook(payload, { originIp = null } = {}) {
    const event = String(payload?.event || '').toUpperCase().replace('.', '_');
    this.webhookDiagnostics.lastWebhookReceivedAt = new Date(this.clock()).toISOString();
    this.webhookDiagnostics.lastWebhookEvent = payload?.event ?? null;
    this.webhookDiagnostics.lastWebhookInstance = payload?.instance ?? null;
    this.evolutionClient?.recordWebhookReceived?.(payload);
    this.logInfo('WHATSAPP_WEBHOOK_RECEIVED', {
      originIp,
      event: payload?.event ?? null,
      instance: payload?.instance ?? null,
    });
    if (event !== 'MESSAGES_UPSERT') {
      this.webhookDiagnostics.lastInvalidPayloadReason = 'unsupported-event';
      this.logWarn('WHATSAPP_WEBHOOK_INVALID_PAYLOAD', {
        originIp,
        event: payload?.event ?? null,
        instance: payload?.instance ?? null,
        reason: 'unsupported-event',
      });
      return { ignored: true, reason: 'unsupported-event' };
    }
    this.logInfo('MESSAGES_UPSERT_RECEIVED', {
      originIp,
      event: payload?.event ?? null,
      instance: payload?.instance ?? null,
    });

    const incoming = parseIncomingMessage(payload);
    if (incoming.fromMe) {
      this.logInfo('WHATSAPP_WEBHOOK_IGNORED_FROM_ME', {
        originIp,
        playerPhone: maskPhone(incoming.phone),
        remoteJid: maskTechnicalIdentity(incoming.remoteJid),
        replyTo: maskTechnicalIdentity(incoming.replyTo),
      });
      this.logInfo('MESSAGE_FROM_ME_IGNORED', {
        originIp,
        playerPhone: maskPhone(incoming.phone),
        remoteJid: maskTechnicalIdentity(incoming.remoteJid),
        replyTo: maskTechnicalIdentity(incoming.replyTo),
        reason: 'key_from_me_true',
      });
      return { ignored: true, decision: 'ignored_from_me', reason: 'key_from_me_true' };
    }
    if (incoming.isGroup) {
      this.webhookDiagnostics.lastInvalidPayloadReason = 'group_not_supported';
      this.logWarn('WHATSAPP_WEBHOOK_INVALID_PAYLOAD', {
        originIp,
        reason: 'group_not_supported',
        remoteJid: maskTechnicalIdentity(incoming.remoteJid),
      });
      return { ignored: true, decision: 'ignored_invalid', reason: 'group_not_supported' };
    }
    if (!incoming.phone || !incoming.remoteJid) {
      this.webhookDiagnostics.lastInvalidPayloadReason = 'missing_remote_jid';
      this.logWarn('WHATSAPP_WEBHOOK_INVALID_PAYLOAD', {
        originIp,
        reason: 'missing_remote_jid',
        remoteJid: maskTechnicalIdentity(incoming.remoteJid),
        sender: maskTechnicalIdentity(incoming.sender),
      });
      return { ignored: true, decision: 'ignored_invalid', reason: 'missing_remote_jid' };
    }

    if (this.safeEntryEnabled && incoming.messageId && this.entryService?.store?.hasProcessedMessage(incoming.messageId)) {
      return { ignored: true, decision: 'ignored_invalid', reason: 'duplicate_message' };
    }
    if (this.safeEntryEnabled && incoming.messageId) this.entryService?.store?.markMessageProcessed(incoming.messageId);

    const command = normalizeCommand(incoming.text);
    const replyTo = incoming.replyTo || incoming.phone;
    const currentState = this.getConversationState(incoming.phone);
    this.logInfo('MESSAGE_TEXT_PARSED', {
      originIp,
      playerPhone: maskPhone(incoming.phone),
      phoneSource: incoming.phoneSource,
      remoteJid: maskTechnicalIdentity(incoming.remoteJid),
      replyTo: maskTechnicalIdentity(replyTo),
      messageType: incoming.messageType || null,
      hasText: Boolean(incoming.text),
      textLength: incoming.text.length,
      knownCommand: Boolean(
        MENU_COMMANDS.has(command)
        || CANCEL_QUEUE_COMMANDS.has(command)
        || SUPPORT_COMMANDS.has(command)
        || PLAY_COMMANDS.has(command)
        || TEST_MODE_COMMANDS.has(command)
        || RULES_COMMANDS.has(command)
        || IDENTIFY_COMMANDS.has(command)
        || SAFE_TABLES.has(command)
        || isAdminCommandText(command)
      ),
    });
    this.logInfo('WHATSAPP_MESSAGE_REMOTE_JID', {
      originIp,
      remoteJid: maskTechnicalIdentity(incoming.remoteJid),
      replyTo: maskTechnicalIdentity(replyTo),
      playerPhone: maskPhone(incoming.phone),
    });
    this.logInfo('WHATSAPP_MESSAGE_FROM_ME', {
      originIp,
      fromMe: incoming.fromMe,
      rawFromMe: incoming.rawFromMe ?? null,
      messageType: incoming.messageType || null,
    });
    this.logInfo('WHATSAPP_MESSAGE_TEXT', {
      originIp,
      textLength: incoming.text.length,
      command: maskDigitsInText(command).slice(0, 120),
    });
    this.logInfo('BOT_HANDLER_SELECTED', {
      originIp,
      handler: selectBotHandler(command, incoming, currentState),
      conversationState: currentState.state ?? null,
    });
    if (!incoming.text) {
      this.webhookDiagnostics.lastInvalidPayloadReason = 'empty_text';
      this.logWarn('WHATSAPP_WEBHOOK_INVALID_PAYLOAD', {
        originIp,
        reason: 'empty_text',
        playerPhone: maskPhone(incoming.phone),
        messageType: incoming.messageType || null,
      });
      return { ignored: true, decision: 'ignored_invalid', reason: 'empty_text' };
    }
    this.webhookDiagnostics.lastMessageProcessedAt = new Date(this.clock()).toISOString();
    this.webhookDiagnostics.lastMessageFrom = maskPhone(incoming.phone);
    this.evolutionClient?.recordMessageProcessed?.({ phone: incoming.phone });
    if (IDENTIFY_COMMANDS.has(command)) {
      const isAdmin = Boolean(
        incoming.phone
        && (
          this.adminNumbers.includes(incoming.phone)
          || this.entryService?.isAdmin?.(incoming.phone)
        ),
      );
      await this.send(replyTo, [
        `Seu número: ${incoming.phone}`,
        `Admin autorizado: ${isAdmin ? 'sim' : 'não'}`,
      ].join('\n'));
      return {
        type: 'whatsapp_identity_sent',
        decision: 'reply_sent',
        reason: 'identity_command',
        state: this.getConversationState(incoming.phone),
        originIp,
      };
    }
    if (isAdminCommandText(command)) return this.handleSafeEntryAdminCommand(incoming.phone, incoming.text, { replyTo });
    const isTableSelectionInProgress = currentState.state === 'choosing_table' && SAFE_TABLES.has(command);
    if (SUPPORT_COMMANDS.has(command) && !isTableSelectionInProgress) {
      return this.handleSupportRequest(incoming, { replyTo, originIp });
    }
    if (MENU_COMMANDS.has(command) || CANCEL_QUEUE_COMMANDS.has(command)) {
      const clearResult = this.matchQueue?.clearPlayerState?.(incoming.phone, {
        actor: incoming.phone,
        reason: `whatsapp_${command}`,
      });
      this.setConversationState(incoming.phone, 'idle');
      if (clearResult?.realMatchPreserved && !clearResult.cleared && !clearResult?.paidEntryPreserved) {
        await this.send(replyTo, this.safeActiveMatchText());
        return {
          type: 'whatsapp_queue_cancel_real_match_preserved',
          decision: 'reply_sent',
          reason: 'real_match_not_cancelled',
          state: 'idle',
          originIp,
        };
      }
      if (clearResult?.preStartCancellation?.aborted) {
        const releasedParticipants = clearResult.releasedParticipants ?? [];
        const paidEntryPreserved = Boolean(clearResult.paidEntryPreserved);
        for (const entry of releasedParticipants) {
          if (entry.playerPhone) this.setConversationState(entry.playerPhone, 'idle');
          if (!entry.notifyTo || entry.playerPhone === incoming.phone) continue;
          await this.send(entry.notifyTo, paidEntryPreserved
            ? [
                'Sua partida pendente foi encerrada.',
                'Sua entrada paga foi preservada e os links antigos foram invalidados.',
                'Aguarde a recolocacao na mesma mesa ou a revisao do admin.',
              ].join('\n')
            : [
                'Sua partida anterior foi encerrada.',
                'Voce ja pode escolher uma mesa novamente.',
                '',
                this.safeMenuText(),
              ].join('\n'));
        }
        await this.send(replyTo, paidEntryPreserved
          ? [
              'Sua partida pendente foi encerrada e os links antigos foram invalidados.',
              'Sua entrada paga nao foi apagada nem consumida.',
              'O admin deve revisar ou recolocar voce na mesma mesa.',
            ].join('\n')
          : [
              this.safeQueueCancelledText(),
              'Os dois jogadores foram liberados da partida pendente.',
              '',
              this.safeMenuText(),
            ].join('\n'));
        return {
          type: paidEntryPreserved ? 'whatsapp_paid_pre_start_match_aborted' : 'whatsapp_pre_start_match_aborted',
          decision: 'reply_sent',
          reason: paidEntryPreserved
            ? 'pre_start_match_aborted_paid_entries_preserved'
            : 'pre_start_match_aborted_and_participants_released',
          state: 'idle',
          releasedParticipants: releasedParticipants.length,
          paidEntryPreserved,
          originIp,
        };
      }
      if (clearResult?.preStartCancellation?.cancelled) {
        for (const entry of clearResult.requeuedOpponents ?? []) {
          if (entry.notifyTo) {
            await this.send(entry.notifyTo, this.safeOpponentCancelledRequeuedText(entry.selectedTable));
          }
        }
        await this.send(replyTo, [
          '✅ Sua solicitação de cancelamento foi registrada.',
          'Se sua entrada já estava paga/validada, o admin deverá revisar o caso.',
          '',
          this.safeMenuText(),
        ].join('\n'));
        return {
          type: 'whatsapp_pre_start_cancelled_requeued_opponent',
          decision: 'reply_sent',
          reason: 'opponent_cancelled_before_start',
          state: 'idle',
          requeuedOpponents: clearResult.requeuedOpponents?.length ?? 0,
          originIp,
        };
      }
      if (clearResult?.paidEntryPreserved) {
        const preserved = clearResult.clearedEntries?.entries?.find((entry) => entry.paidConfirmed)
          ?? clearResult.clearedEntries?.entries?.[0]
          ?? clearResult.blockedEntry
          ?? null;
        await this.send(replyTo, this.safePaidEntryActiveText(preserved));
        return {
          type: 'whatsapp_paid_entry_preserved',
          decision: 'reply_sent',
          reason: 'paid_entry_requires_admin_review',
          state: 'idle',
          originIp,
        };
      }
      if (clearResult?.cleared) {
        await this.send(replyTo, [
          this.safeQueueCancelledText(),
          '',
          this.safeMenuText(),
        ].join('\n'));
        return {
          type: 'whatsapp_queue_cancelled',
          decision: 'reply_sent',
          reason: command === 'menu' ? 'menu_command_cleared_state' : 'queue_cancel_command_cleared_state',
          state: 'idle',
          originIp,
        };
      }
      if (MENU_COMMANDS.has(command)) {
        await this.send(replyTo, this.safeMenuText());
        return { type: 'whatsapp_menu_sent', decision: 'reply_sent', reason: 'menu_command', state: 'idle', originIp };
      }
      await this.send(replyTo, [
        'Você não está aguardando em nenhuma fila.',
        '',
        this.safeMenuText(),
      ].join('\n'));
      return { type: 'whatsapp_queue_cancel_empty', decision: 'reply_sent', reason: 'player_not_in_queue', state: 'idle', originIp };
    }
    if (currentState.state === 'choosing_table' && SAFE_TABLES.has(command)) {
      const selectedTable = SAFE_TABLES.get(command);
      if (this.safeEntryEnabled && this.matchQueue?.isConfigured?.()) {
        const queueResult = this.matchQueue.joinQueue(incoming.phone, selectedTable, { replyTo });
        if (queueResult.blocked) {
          if (queueResult.reason === 'already_in_queue') {
            await this.send(replyTo, this.safeQueueDuplicateText());
            return { type: 'whatsapp_queue_duplicate', decision: 'reply_sent', reason: 'already_in_queue', state: 'choosing_table', selectedTable, originIp };
          }
          if (queueResult.reason === 'already_in_active_match' || queueResult.reason === 'PLAYER_ALREADY_ACTIVE_MATCH') {
            await this.send(replyTo, this.safeActiveMatchText());
            return { type: 'whatsapp_queue_active_match_blocked', decision: 'reply_sent', reason: queueResult.reason, state: 'table_selected', selectedTable, originIp };
          }
          if (queueResult.reason === 'already_in_other_queue') {
            await this.send(replyTo, this.safeOtherQueueText());
            return { type: 'whatsapp_queue_other_table_blocked', decision: 'reply_sent', reason: 'already_in_other_queue', state: 'choosing_table', selectedTable, originIp };
          }
          if (queueResult.reason === 'ENTRY_TABLE_LOCKED') {
            await this.send(replyTo, 'Você já possui uma entrada ativa em outra mesa. Aguarde ou digite menu.');
            return { type: 'whatsapp_entry_table_locked', decision: 'reply_sent', reason: queueResult.reason, state: currentState.state, originIp };
          }
          await this.send(replyTo, 'Não foi possível entrar na fila agora. Digite menu e tente novamente.');
          return { type: 'whatsapp_queue_join_failed', decision: 'reply_sent', reason: queueResult.reason, state: currentState.state, selectedTable, originIp };
        }

        this.setConversationState(incoming.phone, queueResult.match ? 'table_selected' : 'choosing_table', selectedTable);
        if (queueResult.match) {
          const sendFailures = [];
          const matchTable = queueResult.match.tableValue ?? selectedTable;
          for (const [index, player] of queueResult.match.players.entries()) {
            const playerLabel = index === 0 ? 'A' : 'B';
            const sendTargets = [...new Set([player.replyTo, player.sendTo].filter(Boolean))];
            if (!player.accessLink) {
              const error = new Error('MATCH_LINK_EMPTY');
              console.log('[5.3] erro:', error.message);
              sendFailures.push({ entryId: player.entryId, message: error.message });
              this.entryService?.markLinkDelivery?.(player.entryId, { sent: false, error: error.message });
              this.matchQueue?.logError?.('Erro ao enviar link:', {
                matchId: queueResult.match.matchId,
                roomId: queueResult.match.roomId ?? queueResult.match.matchId,
                tableValue: matchTable,
                entryId: player.entryId,
                phone: player.phoneMasked,
                message: error.message,
              });
              continue;
            }
            try {
              this.matchQueue?.logInfo?.(`Enviando link para jogador ${playerLabel}:`, {
                matchId: queueResult.match.matchId,
                roomId: queueResult.match.roomId ?? queueResult.match.matchId,
                tableValue: matchTable,
                entryId: player.entryId,
                phone: player.phoneMasked,
                sendTargetsMasked: sendTargets.map(maskPhone),
                linkGenerated: Boolean(player.accessLink),
              });
              console.log(`[5.3] enviando link para jogador ${playerLabel}:`, player.phoneMasked);
              console.log('[5.3] enviando link para:', player.phoneMasked);
              let sent = false;
              let lastError = null;
              for (const sendTarget of sendTargets) {
                try {
                  await this.send(sendTarget, this.safeMatchFoundText(matchTable, player.accessLink));
                  sent = true;
                  break;
                } catch (targetError) {
                  lastError = targetError;
                  console.log('[5.3] erro:', targetError.message);
                  this.matchQueue?.logError?.('Erro ao enviar link:', {
                    matchId: queueResult.match.matchId,
                    roomId: queueResult.match.roomId ?? queueResult.match.matchId,
                    tableValue: matchTable,
                    entryId: player.entryId,
                    phone: player.phoneMasked,
                    sendTargetMasked: maskPhone(sendTarget),
                    message: targetError.message,
                  });
                }
              }
              if (!sent) throw lastError || new Error('MATCH_LINK_SEND_FAILED');
              this.entryService?.markLinkDelivery?.(player.entryId, { sent: true });
              this.matchQueue?.logInfo?.('WHATSAPP_MATCH_LINK_SENT', {
                matchId: queueResult.match.matchId,
                roomId: queueResult.match.roomId ?? queueResult.match.matchId,
                tableValue: matchTable,
                entryId: player.entryId,
                playerLabel,
                phone: player.phoneMasked,
                sendTargetsMasked: sendTargets.map(maskPhone),
                linkGenerated: Boolean(player.accessLink),
              });
            } catch (error) {
              sendFailures.push({ entryId: player.entryId, message: error.message });
              this.entryService?.markLinkDelivery?.(player.entryId, { sent: false, error: error.message });
              this.matchQueue?.logError?.('Erro ao enviar link:', {
                matchId: queueResult.match.matchId,
                roomId: queueResult.match.roomId ?? queueResult.match.matchId,
                tableValue: matchTable,
                entryId: player.entryId,
                phone: player.phoneMasked,
                sendTargetsMasked: sendTargets.map(maskPhone),
                message: error.message,
              });
              this.matchQueue?.logError?.('WHATSAPP_MATCH_LINK_SEND_FAILED', {
                matchId: queueResult.match.matchId,
                roomId: queueResult.match.roomId ?? queueResult.match.matchId,
                tableValue: matchTable,
                entryId: player.entryId,
                phone: player.phoneMasked,
                sendTargetsMasked: sendTargets.map(maskPhone),
                message: error.message,
              });
            }
          }
          if (sendFailures.length) {
            return {
              type: 'whatsapp_match_link_send_failed',
              decision: 'processed_incoming',
              reason: 'match_created_but_link_send_failed',
              state: 'table_selected',
              selectedTable: matchTable,
              matchId: queueResult.match.matchId,
              sendFailures,
              originIp,
            };
          }
          return {
            type: 'whatsapp_match_created',
            decision: 'reply_sent',
            reason: 'two_players_matched',
            state: 'table_selected',
            selectedTable: matchTable,
            matchId: queueResult.match.matchId,
            originIp,
          };
        }

        await this.send(replyTo, this.safeQueueJoinedText(selectedTable));
        return {
          type: 'whatsapp_queue_joined',
          decision: 'reply_sent',
          reason: 'waiting_for_opponent',
          state: 'choosing_table',
          selectedTable,
          entryId: queueResult.entry?.entryId ?? null,
          originIp,
        };
      }

      let entry = null;
      if (this.safeEntryEnabled) {
        if (!this.entryService?.isConfigured()) {
          await this.send(replyTo, 'As entradas est\u00e3o temporariamente indispon\u00edveis. Digite menu e tente novamente mais tarde.');
          return { type: 'whatsapp_entry_unavailable', decision: 'reply_sent', reason: 'entry_service_not_configured', state: 'idle', originIp };
        }
        try {
          entry = this.entryService.createEntry({ phone: incoming.phone, selectedTable, source: 'whatsapp' });
        } catch (error) {
          if (error.message === 'ENTRY_TABLE_LOCKED') {
            await this.send(replyTo, 'Voc\u00ea j\u00e1 possui uma entrada ativa em outra mesa. Aguarde o admin ou digite menu.');
            return { type: 'whatsapp_entry_table_locked', decision: 'reply_sent', reason: error.message, state: currentState.state, originIp };
          }
          throw error;
        }
      }
      this.setConversationState(incoming.phone, 'table_selected', selectedTable);
      await this.send(replyTo, this.safeTableSelectedText(selectedTable, { entryRegistered: Boolean(entry) }));
      return {
        type: entry ? 'whatsapp_entry_pending_admin' : 'whatsapp_table_selected_safe',
        decision: 'reply_sent',
        reason: entry ? 'entry_pending_admin_validation' : 'table_selected_payments_disabled',
        state: 'table_selected',
        selectedTable,
        entryId: entry?.entryId ?? null,
        originIp,
      };
    }

    if (PLAY_COMMANDS.has(command)) {
      this.setConversationState(incoming.phone, 'choosing_table');
      await this.send(replyTo, this.safeTablesText());
      return { type: 'whatsapp_tables_sent', decision: 'reply_sent', reason: 'tables_requested', state: 'choosing_table', originIp };
    }

    if (TEST_MODE_COMMANDS.has(command)) {
      const testModeLink = this.buildTestModeLink();
      this.matchQueue?.logInfo?.('WHATSAPP_TEST_MODE_REQUEST', {
        playerId: maskPhone(incoming.phone),
        phone: maskPhone(incoming.phone),
        testModeLink,
      });
      this.setConversationState(incoming.phone, 'idle');
      await this.send(replyTo, this.safeTestModeText(testModeLink));
      this.matchQueue?.logInfo?.('WHATSAPP_TEST_MODE_LINK_SENT', {
        playerId: maskPhone(incoming.phone),
        link: testModeLink,
      });
      return {
        type: 'whatsapp_test_mode_link_sent',
        decision: 'reply_sent',
        reason: 'test_mode_requested',
        state: 'idle',
        testModeLink,
        originIp,
      };
    }

    if (RULES_COMMANDS.has(command)) {
      this.setConversationState(incoming.phone, 'idle');
      await this.send(replyTo, this.safeRulesText());
      return { type: 'whatsapp_rules_sent', decision: 'reply_sent', reason: 'rules_requested', state: 'idle', originIp };
    }

    if (SUPPORT_COMMANDS.has(command)) return this.handleSupportRequest(incoming, { replyTo, originIp });

    this.setConversationState(incoming.phone, 'idle');
    await this.send(replyTo, 'Op\u00e7\u00e3o inv\u00e1lida. Digite menu para ver as op\u00e7\u00f5es.');
    return { type: 'whatsapp_invalid_option', decision: 'reply_sent', reason: 'invalid_option', state: 'idle', originIp };
  }

  menuText() {
    return [
      '🎴 Pife Duelo online.',
      '',
      'Escolha uma mesa:',
      '2 - Mesa R$2 | prêmio R$3,60',
      '5 - Mesa R$5 | prêmio R$9,00',
      '10 - Mesa R$10 | prêmio R$17,00',
      '20 - Mesa R$20 | prêmio R$32,80',
      '',
      'Envie apenas o número da mesa.',
    ].join('\n');
  }

  pixText(payment) {
    return [
      `Pagamento #${payment.paymentId}`,
      `Mesa: ${money(payment.selectedTable)}`,
      `Valor do Pix: ${money(payment.amount)}`,
      `Prêmio: ${money(payment.prize)}`,
      `Chave Pix: ${this.pixKey}`,
      `Recebedor: ${this.pixReceiver}`,
      '',
      'Depois do pagamento, envie a imagem ou o PDF do comprovante aqui.',
      'O comprovante ficará pendente até a confirmação manual do administrador.',
    ].join('\n');
  }

  pendingListText() {
    const pending = this.paymentService.listPayments({ status: 'pending' });
    if (!pending.length) return 'Nenhum pagamento pendente.';
    return [
      'Pagamentos pendentes:',
      ...pending.slice(0, 20).map((payment) => (
        `#${payment.paymentId} | Mesa ${money(payment.selectedTable)} | Tel: ${maskPhone(payment.phone)} | Recebido: ${payment.receiptReceived ? 'sim' : 'não'}`
      )),
    ].join('\n');
  }

  async notifyAdmins(payment) {
    const message = `Novo comprovante pendente: #${payment.paymentId} | Mesa ${money(payment.selectedTable)} | Tel: ${maskPhone(payment.phone)}`;
    await Promise.allSettled(this.adminNumbers.map((phone) => this.send(phone, message)));
  }

  async handleAdminCommand(phone, text) {
    if (!this.paymentService.isAdmin(phone)) {
      await this.send(phone, 'Comando não autorizado.');
      return { type: 'admin_unauthorized' };
    }

    if (/^\/admin\s+pendentes$/i.test(text)) {
      await this.send(phone, this.pendingListText());
      return { type: 'admin_pending_list' };
    }

    const confirmMatch = text.match(/^\/admin\s+confirmar\s+#?(\w+)$/i);
    if (confirmMatch) {
      try {
        const currentPayment = this.paymentService.getPayment(confirmMatch[1]);
        const deliveryRetry = currentPayment?.status === 'confirmed' && !currentPayment.linkSentAt;
        const result = deliveryRetry
          ? this.paymentService.retryAccessLinkDelivery({
            paymentId: confirmMatch[1],
            adminPhone: phone,
            source: 'whatsapp-delivery-retry',
          })
          : this.paymentService.confirmPayment({
            paymentId: confirmMatch[1],
            adminPhone: phone,
            source: 'whatsapp',
          });
        try {
          await this.send(result.payment.phone, [
            '✅ Pagamento confirmado!',
            'Sua partida está pronta:',
            result.accessLink,
          ].join('\n'));
          this.paymentService.markLinkDelivery(result.payment.paymentId, { sent: true });
          await this.send(phone, deliveryRetry
            ? `✅ Link do pagamento #${result.payment.paymentId} reenviado ao jogador.`
            : `✅ Pagamento #${result.payment.paymentId} confirmado. Link enviado ao jogador.`);
          return { type: deliveryRetry ? 'payment_link_resent' : 'payment_confirmed', paymentId: result.payment.paymentId };
        } catch (deliveryError) {
          this.paymentService.markLinkDelivery(result.payment.paymentId, { sent: false, error: deliveryError.message });
          await this.send(phone, `Pagamento #${result.payment.paymentId} confirmado, mas o envio do link falhou. Verifique a Evolution API.`);
          return { type: 'payment_confirmed_delivery_failed', paymentId: result.payment.paymentId };
        }
      } catch (error) {
        await this.send(phone, errorMessage(error));
        return { type: 'admin_command_failed', error: error.message };
      }
    }

    const rejectMatch = text.match(/^\/admin\s+rejeitar\s+#?(\w+)\s+(.+)$/i);
    if (rejectMatch) {
      try {
        const payment = this.paymentService.rejectPayment({
          paymentId: rejectMatch[1],
          adminPhone: phone,
          reason: sanitizeText(rejectMatch[2]),
          source: 'whatsapp',
        });
        await this.send(payment.phone, `❌ O pagamento #${payment.paymentId} não foi aprovado. Motivo: ${payment.rejectionReason}`);
        await this.send(phone, `Pagamento #${payment.paymentId} rejeitado e jogador avisado.`);
        return { type: 'payment_rejected', paymentId: payment.paymentId };
      } catch (error) {
        await this.send(phone, errorMessage(error));
        return { type: 'admin_command_failed', error: error.message };
      }
    }

    await this.send(phone, 'Comando admin inválido. Use /admin pendentes, /admin confirmar ID ou /admin rejeitar ID motivo.');
    return { type: 'admin_invalid_command' };
  }

  async handleWebhook(payload, { originIp = null } = {}) {
    const event = String(payload?.event || '').toUpperCase().replace('.', '_');
    this.webhookDiagnostics.lastWebhookReceivedAt = new Date(this.clock()).toISOString();
    this.webhookDiagnostics.lastWebhookEvent = payload?.event ?? null;
    this.webhookDiagnostics.lastWebhookInstance = payload?.instance ?? null;
    this.evolutionClient?.recordWebhookReceived?.(payload);
    if (event !== 'MESSAGES_UPSERT') {
      this.webhookDiagnostics.lastInvalidPayloadReason = 'unsupported-event';
      this.logWarn('WHATSAPP_WEBHOOK_INVALID_PAYLOAD', {
        originIp,
        event: payload?.event ?? null,
        instance: payload?.instance ?? null,
        reason: 'unsupported-event',
      });
      return { ignored: true, reason: 'unsupported-event' };
    }
    const incoming = parseIncomingMessage(payload);
    if (incoming.fromMe) {
      this.logInfo('WHATSAPP_WEBHOOK_IGNORED_FROM_ME', {
        originIp,
        playerPhone: maskPhone(incoming.phone),
        remoteJid: maskTechnicalIdentity(incoming.remoteJid),
      });
      return { ignored: true, reason: 'invalid-or-outgoing-message' };
    }
    if (!incoming.phone) {
      this.webhookDiagnostics.lastInvalidPayloadReason = 'missing_phone';
      this.logWarn('WHATSAPP_WEBHOOK_INVALID_PAYLOAD', {
        originIp,
        reason: 'missing_phone',
        remoteJid: maskTechnicalIdentity(incoming.remoteJid),
      });
      return { ignored: true, reason: 'invalid-or-outgoing-message' };
    }
    this.webhookDiagnostics.lastMessageProcessedAt = new Date(this.clock()).toISOString();
    this.webhookDiagnostics.lastMessageFrom = maskPhone(incoming.phone);
    this.evolutionClient?.recordMessageProcessed?.({ phone: incoming.phone });
    if (incoming.messageId && this.paymentService.store.hasProcessedMessage(incoming.messageId)) {
      return { ignored: true, reason: 'duplicate-message' };
    }
    if (!this.checkRateLimit(incoming.phone, incoming.text || (incoming.hasReceiptMedia ? 'receipt' : 'media'))) {
      if (incoming.messageId) this.paymentService.store.markMessageProcessed(incoming.messageId);
      return { ignored: true, reason: 'rate-limited' };
    }

    let result;
    if (incoming.text.toLowerCase().startsWith('/admin')) {
      result = await this.handleAdminCommand(incoming.phone, incoming.text);
    } else if (incoming.hasReceiptMedia) {
      try {
        const payment = this.paymentService.markReceiptReceived({
          phone: incoming.phone,
          messageId: incoming.messageId,
          source: 'whatsapp',
        });
        await this.send(incoming.phone, [
          `Comprovante do pagamento #${payment.paymentId} recebido.`,
          'Status: pendente de confirmação manual.',
          'O envio do comprovante não libera a partida automaticamente.',
        ].join('\n'));
        await this.notifyAdmins(payment);
        result = { type: 'receipt_received', paymentId: payment.paymentId, originIp };
      } catch (error) {
        await this.send(incoming.phone, 'Não encontrei um pagamento pendente. Envie "oi" para começar.');
        result = { type: 'receipt_rejected', error: error.message, originIp };
      }
    } else {
      const table = parseTable(incoming.text);
      if (table) {
        try {
          const payment = this.paymentService.selectTable({
            phone: incoming.phone,
            selectedTable: table,
            source: 'whatsapp',
          });
          await this.send(incoming.phone, this.pixText(payment));
          result = { type: 'table_selected', paymentId: payment.paymentId, originIp };
        } catch (error) {
          await this.send(incoming.phone, errorMessage(error));
          result = { type: 'table_selection_failed', error: error.message, originIp };
        }
      } else {
        await this.send(incoming.phone, this.menuText());
        result = { type: 'menu_sent', originIp };
      }
    }

    if (incoming.messageId) this.paymentService.store.markMessageProcessed(incoming.messageId);
    return result;
  }
}

export default WhatsAppPaymentBot;
