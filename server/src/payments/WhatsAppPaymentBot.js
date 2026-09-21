import { balanceMessage, walletMenu, depositPrompt, expiredPixMessage, insufficientBalanceMessage, pixMessage, pixFailureMessage, historyMessage, unavailableWalletMessage, unavailableWithdrawalMessage } from '../services/walletMessages.js';
import { maskPhone, normalizePhone } from './PaymentService.js';
import { buildPublicMatchReference } from '../services/publicMatchReference.js';
import { WhatsAppConversationUiService } from '../services/WhatsAppConversationUiService.js';
import {
  availableUpdates,
  publicProjectStatus,
  publicUpdatesMenu,
  upcomingUpdates,
} from '../services/publicRoadmap.js';
import {
  WHATSAPP_PLAYER_STATES,
  activeMatch as activeMatchMessage,
  adminReview as adminReviewMessage,
  cancelConfirmation as cancelConfirmationMessage,
  cancellationProtocol,
  demoCreditsBalanceMenu,
  demoCreditsExplanation,
  demoCreditsHistory,
  demoCreditsInitialGrant,
  demoCreditsInsufficient,
  friendlyActionError,
  howItWorksMenu,
  invalidCommand,
  mainMenu,
  matchFinished as matchFinishedMessage,
  matchFound as matchFoundMessage,
  matchLinkReady as matchLinkReadyMessage,
  noActiveQueue as noActiveQueueMessage,
  otherQueue as otherQueueMessage,
  paidEntryActive as paidEntryActiveMessage,
  preMatchWaiting as preMatchWaitingMessage,
  queueDuplicate as queueDuplicateMessage,
  refundPending as refundPendingMessage,
  ruleTopic,
  rulesMenu,
  supportContact,
  supportMenu,
  supportTopic,
  tablesMenu,
  testModeMessage,
  unavailableLink,
  waitingForOpponent,
} from '../services/whatsappMessages.js';

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
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const SAFE_TABLES = new Map([
  ['1', 2],
  ['2', 5],
  ['3', 10],
  ['4', 20],
]);

function tableOptionFromCommand(command) {
  if (SAFE_TABLES.has(command)) return command;
  return command.match(/^mesa ([1-4])$/)?.[1] ?? null;
}

function isNamedTableOption(command) {
  return /^mesa [1-4]$/.test(command);
}

const MENU_COMMANDS = new Set(['oi', 'ola', 'menu', 'iniciar', 'comecar']);
const CANCEL_QUEUE_COMMANDS = new Set(['sair', 'cancelar']);
const SUPPORT_COMMANDS = new Set(['4', 'suporte', 'atendimento', 'ajuda']);
const PLAY_COMMANDS = new Set(['1', 'jogar', 'jogar valendo', 'valendo', 'ver mesas', 'mesas', 'mesa']);
const HOW_IT_WORKS_COMMANDS = new Set(['como funciona', 'funcionamento']);
const TEST_MODE_COMMANDS = new Set(['modo teste', 'modo teste gratis', 'teste', 'treino', 'testar', 'gratis', 'gratuito']);
const RULES_COMMANDS = new Set(['3', 'regras', 'regra', 'como jogar']);
const STATUS_COMMANDS = new Set(['status', 'situacao']);
const LINK_COMMANDS = new Set(['link', 'acesso', 'meu link']);
const IDENTIFY_COMMANDS = new Set(['meu numero', 'meu número']);
const UPDATES_COMMANDS = new Set(['5', 'atualizacoes', 'atualizacao', 'novidades', 'roadmap']);
const DEMO_CREDITS_COMMANDS = new Set(['6', 'creditos', 'credito', 'meus creditos', 'creditos de teste']);
const FINANCIAL_WALLET_COMMANDS = new Set(['carteira', 'saldo financeiro', 'meu perfil e saldo', 'perfil financeiro']);
const SALDO_COMMANDS = new Set(['saldo']);
const UPDATE_SECTION_COMMANDS = new Map([
  ['1', 'available'],
  ['novidades disponiveis', 'available'],
  ['2', 'upcoming'],
  ['proximos recursos', 'upcoming'],
  ['3', 'status'],
  ['status do projeto', 'status'],
]);

function isAdminCommandText(command) {
  return (
    command.startsWith('/admin')
    || command.startsWith('admin ')
    || command.startsWith('resetar ')
    || /^(cancelar|reembolsar|recolocar)\s+\d{8,15}$/i.test(command)
  );
}

function isFinancialCommandText(command) {
  return (
    SALDO_COMMANDS.has(command)
    || FINANCIAL_WALLET_COMMANDS.has(command)
    || command === 'saldo financeiro'
    || ['extrato financeiro', 'extrato', 'sacar', 'recarregar', 'perfil'].includes(command)
    || /^depositar(?:\s|$)/.test(command)
    || /^sacar\s+\d+(?:[,.]\d{1,2})?\s+(CPF|CNPJ|EMAIL|PHONE|EVP)\s+[^|]+\|\s*.+$/i.test(command)
  );
}

function selectBotHandler(command, incoming = {}, currentState = null) {
  if (!incoming.text) return 'empty_text';
  if (incoming.fromMe) return 'ignored_from_me';
  if (incoming.isGroup) return 'ignored_group';
  if (IDENTIFY_COMMANDS.has(command)) return 'identify';
  if (isAdminCommandText(command)) return 'admin_command';
  if (currentState?.state === 'cancel_confirmation' && ['1', '2'].includes(command)) return 'cancel_confirmation';
  if (currentState?.state === 'rules_menu' && /^[1-6]$/.test(command)) return 'rules_topic';
  if (currentState?.state === 'support_menu' && /^[1-6]$/.test(command)) return 'support_topic';
  if (currentState?.state === 'updates_menu' && UPDATE_SECTION_COMMANDS.has(command)) return 'updates_section';
  if (currentState?.state === 'demo_credits_menu' && ['1', '2'].includes(command)) return 'demo_credits_section';
  if (UPDATES_COMMANDS.has(command) || (currentState?.state === 'updates_menu' && command === 'voltar')) return 'updates';
  if (DEMO_CREDITS_COMMANDS.has(command)) return 'demo_credits';
  if (SALDO_COMMANDS.has(command)) return 'financial_wallet';
  if (currentState?.state === 'idle' && command === '2') return 'financial_wallet';
  const isTableSelectionInProgress = currentState?.state === 'choosing_table' && tableOptionFromCommand(command) !== null;
  if (SUPPORT_COMMANDS.has(command) && !isTableSelectionInProgress) return 'support';
  if (MENU_COMMANDS.has(command)) return 'menu';
  if (CANCEL_QUEUE_COMMANDS.has(command)) return 'cancel_queue';
  if (isTableSelectionInProgress) return 'table_selection';
  if (PLAY_COMMANDS.has(command) || isNamedTableOption(command)) return 'play_or_tables';
  if (HOW_IT_WORKS_COMMANDS.has(command)) return 'how_it_works';
  if (TEST_MODE_COMMANDS.has(command)) return 'test_mode';
  if (RULES_COMMANDS.has(command)) return 'rules';
  if (STATUS_COMMANDS.has(command)) return 'status';
  if (LINK_COMMANDS.has(command)) return 'link';
  if (isFinancialCommandText(command)) return 'financial_wallet';
  if (SUPPORT_COMMANDS.has(command)) return 'support';
  if (incoming.hasReceiptMedia) return 'receipt_media';
  return 'fallback_invalid';
}

function maskDigitsInText(value) {
  return String(value || '').replace(/\d{8,15}/g, (digits) => maskPhone(digits));
}

function protectedFinancialCommandLog(command) {
  const value = String(command || '').trim();
  const withdrawal = value.match(/^sacar\s+\S+\s+(CPF|CNPJ|EMAIL|PHONE|EVP)\s+/i);
  if (withdrawal) return { command: '[financial-command-redacted]', financialAction: 'withdrawal_request', pixKeyType: withdrawal[1].toUpperCase() };
  if (/^depositar\s+/i.test(value)) return { command: '[financial-command-redacted]', financialAction: 'deposit_request' };
  if (/^admin\s+(saque|saques|saldo|extrato|financeiro)\b/i.test(value)) {
    return { command: '[financial-command-redacted]', financialAction: 'financial_admin_command' };
  }
  return null;
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

function centsMoney(value) {
  return (Number(value || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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
    demoCreditsService = null,
    financialWalletService = null,
    safeEntryEnabled = false,
    paymentsEnabled = false,
    cleanConversationEnabled = false,
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
    this.demoCreditsService = demoCreditsService;
    this.financialWalletService = financialWalletService;
    this.safeEntryEnabled = Boolean(safeEntryEnabled);
    this.paymentsEnabled = Boolean(paymentsEnabled);
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
    this.conversationTasks = new Map();
    this.conversationUi = new WhatsAppConversationUiService({
      client: evolutionClient,
      enabled: cleanConversationEnabled,
      clock,
      logInfo,
      logWarn,
    });
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
          message: metadata.replyType === 'pix_deposit' ? 'WHATSAPP_SEND_FAILED' : (result.reason || result.error || 'WHATSAPP_SEND_FAILED'),
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
        message: metadata.replyType === 'pix_deposit' ? 'WHATSAPP_SEND_FAILED' : error.message,
      });
      if (metadata.throwOnFailure) throw error;
      return {
        ok: false,
        sent: false,
        reason: error.message,
      };
    }
  }

  async sendPanel(replyTo, playerPhone, state, content) {
    return this.conversationUi.updateConversationPanel({
      phone: playerPhone,
      state,
      content,
      sendNew: (nextContent) => this.send(replyTo, nextContent, { replyType: 'transient_panel' }),
    });
  }

  async sendPermanent(replyTo, playerPhone, content, metadata = {}) {
    await this.conversationUi.retirePanel(playerPhone, { deleteMessage: false });
    return this.send(replyTo, content, { ...metadata, replyType: metadata.replyType || 'permanent' });
  }

  enqueueConversation(phone, task) {
    const key = normalizePhone(phone) || 'unknown';
    const previous = this.conversationTasks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.conversationTasks.set(key, current);
    return current.finally(() => {
      if (this.conversationTasks.get(key) === current) this.conversationTasks.delete(key);
    });
  }

  getPlayerContext(phone) {
    const normalizedPhone = normalizePhone(phone);
    const queue = this.matchQueue?.findPlayerQueue?.(normalizedPhone) ?? null;
    const entry = this.entryService?.getActiveEntryForPhone?.(normalizedPhone) ?? null;
    const latestEntry = this.entryService?.listEntriesForPhone?.(normalizedPhone)?.[0] ?? null;
    const status = entry?.status ?? (queue ? 'approved_for_queue' : latestEntry?.status ?? null);
    const table = entry?.selectedTable ?? queue?.tableValue ?? latestEntry?.selectedTable ?? null;
    const matchId = entry?.linkedMatchId
      ?? entry?.whatsappMatchId
      ?? latestEntry?.linkedMatchId
      ?? latestEntry?.whatsappMatchId
      ?? null;
    const publicReference = entry?.publicMatchReference
      ?? latestEntry?.publicMatchReference
      ?? (matchId ? buildPublicMatchReference(matchId) : null);
    let state = WHATSAPP_PLAYER_STATES.IDLE;

    if (status === 'refund_pending') state = WHATSAPP_PLAYER_STATES.REFUND_PENDING;
    else if (['admin_review', 'abandoned_before_start', 'pending_admin_validation'].includes(status)) {
      state = WHATSAPP_PLAYER_STATES.ADMIN_REVIEW;
    } else if (['playing', 'linked'].includes(status) || Boolean(entry?.playingAt || entry?.linkedMatchId)) {
      state = WHATSAPP_PLAYER_STATES.MATCH_STARTED;
    } else if (status === 'queued' && entry?.whatsappMatchId) {
      state = WHATSAPP_PLAYER_STATES.PRE_MATCH_WAITING;
    } else if (entry?.whatsappMatchId && entry?.linkSentAt) {
      state = WHATSAPP_PLAYER_STATES.MATCH_LINK_READY;
    } else if (queue || ['approved_for_queue', 'queued', 'requeued_after_opponent_cancel'].includes(status)) {
      state = WHATSAPP_PLAYER_STATES.WAITING_FOR_OPPONENT;
    } else if (latestEntry?.status === 'finished') {
      state = WHATSAPP_PLAYER_STATES.MATCH_FINISHED;
    }

    const paidConfirmed = Boolean(entry?.paidConfirmed || latestEntry?.paidConfirmed);
    const canCancel = [
      WHATSAPP_PLAYER_STATES.WAITING_FOR_OPPONENT,
      WHATSAPP_PLAYER_STATES.MATCH_LINK_READY,
      WHATSAPP_PLAYER_STATES.PRE_MATCH_WAITING,
    ].includes(state) && !paidConfirmed;
    return {
      state,
      status,
      table,
      matchId,
      publicReference,
      entry,
      latestEntry,
      queue,
      paidConfirmed,
      canCancel,
      demoCreditsEnabled: Boolean(this.demoCreditsService?.isEnabled?.()),
    };
  }

  messageForContext(context) {
    switch (context.state) {
      case WHATSAPP_PLAYER_STATES.WAITING_FOR_OPPONENT:
        return waitingForOpponent(context);
      case WHATSAPP_PLAYER_STATES.MATCH_LINK_READY:
        return matchLinkReadyMessage(context);
      case WHATSAPP_PLAYER_STATES.PRE_MATCH_WAITING:
        return preMatchWaitingMessage(context);
      case WHATSAPP_PLAYER_STATES.MATCH_STARTED:
        return activeMatchMessage(context);
      case WHATSAPP_PLAYER_STATES.MATCH_FINISHED:
        return matchFinishedMessage();
      case WHATSAPP_PLAYER_STATES.ADMIN_REVIEW:
        return adminReviewMessage(context);
      case WHATSAPP_PLAYER_STATES.REFUND_PENDING:
        return refundPendingMessage(context);
      default:
        return this.safeMenuText();
    }
  }

  async renderCurrentContext(replyTo, playerPhone) {
    const context = this.getPlayerContext(playerPhone);
    await this.sendPanel(replyTo, playerPhone, context.state, this.messageForContext(context));
    return context;
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
    return mainMenu({
      paymentsEnabled: this.paymentsEnabled,
      demoCreditsEnabled: Boolean(this.demoCreditsService?.isEnabled?.()),
    });
  }

  buildTestModeLink() {
    if (!this.publicGameUrl) return '/?mode=test';
    return `${this.publicGameUrl}/?mode=test`;
  }

  safeTestModeText(testModeLink = this.buildTestModeLink()) {
    return testModeMessage(testModeLink);
  }

  safeTablesText(playerPhone = null) {
    const demoCreditsEnabled = Boolean(this.demoCreditsService?.isEnabled?.());
    const demoBalance = demoCreditsEnabled && playerPhone
      ? this.demoCreditsService.getBalance(playerPhone).availableBalance
      : null;
    return tablesMenu({ paymentsEnabled: this.paymentsEnabled, demoCreditsEnabled, demoBalance });
  }

  async prepareDemoCreditsAccount(replyTo, playerPhone) {
    if (!this.demoCreditsService?.isEnabled?.()) return null;
    const balance = this.demoCreditsService.getBalance(playerPhone);
    if (balance.initialGrantApplied) {
      await this.sendPermanent(
        replyTo,
        playerPhone,
        demoCreditsInitialGrant(this.demoCreditsService.startingBalance),
        { replyType: 'demo_credits_initial_grant' },
      );
    }
    return balance;
  }

  async handleDemoCreditsRequest(incoming, { replyTo, originIp }) {
    if (!this.demoCreditsService?.isEnabled?.()) {
      await this.sendPanel(replyTo, incoming.phone, 'MAIN_MENU', this.safeMenuText());
      return { type: 'demo_credits_disabled', decision: 'reply_sent', reason: 'feature_disabled', state: 'idle', originIp };
    }
    const balance = await this.prepareDemoCreditsAccount(replyTo, incoming.phone);
    this.setConversationState(incoming.phone, 'demo_credits_menu');
    await this.sendPanel(replyTo, incoming.phone, 'DEMO_CREDITS_MENU', demoCreditsBalanceMenu(balance));
    return { type: 'demo_credits_balance_sent', decision: 'reply_sent', reason: 'balance_requested', state: 'demo_credits_menu', originIp };
  }

  async handleDemoCreditsSection(incoming, { replyTo, command, originIp }) {
    if (!this.demoCreditsService?.isEnabled?.()) return this.handleDemoCreditsRequest(incoming, { replyTo, originIp });
    if (command === '1') {
      const events = this.demoCreditsService.getHistory(incoming.phone);
      await this.sendPanel(replyTo, incoming.phone, 'DEMO_CREDITS_HISTORY', demoCreditsHistory(events));
      return { type: 'demo_credits_history_sent', decision: 'reply_sent', reason: 'history_requested', state: 'demo_credits_menu', originIp };
    }
    await this.sendPanel(replyTo, incoming.phone, 'DEMO_CREDITS_EXPLANATION', demoCreditsExplanation());
    return { type: 'demo_credits_explanation_sent', decision: 'reply_sent', reason: 'explanation_requested', state: 'demo_credits_menu', originIp };
  }

  safeRulesText() {
    return rulesMenu();
  }

  publicRoadmapOptions() {
    return {
      featureFlags: {
        paymentsEnabled: this.paymentsEnabled,
        whatsappPaymentsEnabled: this.paymentsEnabled,
        gateEnabled: this.paymentsEnabled,
      },
    };
  }

  async handleUpdatesRequest(incoming, { replyTo, originIp }) {
    this.setConversationState(incoming.phone, 'updates_menu');
    await this.sendPanel(
      replyTo,
      incoming.phone,
      'PUBLIC_UPDATES_MENU',
      publicUpdatesMenu(this.publicRoadmapOptions()),
    );
    this.logInfo('WHATSAPP_PUBLIC_UPDATES_REQUEST', {
      playerId: maskPhone(incoming.phone),
      playerState: this.getPlayerContext(incoming.phone).state,
      originIp,
    });
    return {
      type: 'whatsapp_public_updates_sent',
      decision: 'reply_sent',
      reason: 'public_updates_requested',
      state: 'updates_menu',
      originIp,
    };
  }

  async handleUpdatesSection(incoming, { replyTo, command, originIp }) {
    const section = UPDATE_SECTION_COMMANDS.get(command);
    const options = this.publicRoadmapOptions();
    const content = section === 'available'
      ? availableUpdates(options)
      : section === 'upcoming'
        ? upcomingUpdates(options)
        : publicProjectStatus(options);
    this.setConversationState(incoming.phone, 'updates_menu');
    await this.sendPanel(replyTo, incoming.phone, `PUBLIC_UPDATES_${section.toUpperCase()}`, content);
    this.logInfo('WHATSAPP_PUBLIC_UPDATES_SECTION_SENT', {
      playerId: maskPhone(incoming.phone),
      section,
      originIp,
    });
    return {
      type: 'whatsapp_public_updates_section_sent',
      decision: 'reply_sent',
      reason: `public_updates_${section}`,
      section,
      state: 'updates_menu',
      originIp,
    };
  }

  buildSupportLink() {
    if (!this.supportNumber) return '';
    return `https://wa.me/${this.supportNumber}?text=Ol%C3%A1,%20preciso%20de%20suporte%20no%20Pife%20Duelo`;
  }

  safeSupportText({ activeContext = null } = {}) {
    return supportContact({
      supportLink: this.buildSupportLink(),
      publicReference: activeContext?.publicReference ?? null,
      hasActiveContext: Boolean(activeContext),
    });
  }

  getSupportContext(phone) {
    const playerContext = this.getPlayerContext(phone);
    return {
      ...playerContext,
      hasActiveContext: playerContext.state !== WHATSAPP_PLAYER_STATES.IDLE
        && playerContext.state !== WHATSAPP_PLAYER_STATES.MATCH_FINISHED,
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

    this.setConversationState(incoming.phone, 'support_menu');
    await this.sendPanel(replyTo, incoming.phone, 'SUPPORT_MENU', supportMenu({
      publicReference: context.publicReference,
    }));

    return {
      type: 'whatsapp_support_menu_sent',
      decision: 'reply_sent',
      reason: 'support_requested',
      state: 'support_menu',
      status: context.status,
      table: context.table,
      matchId: context.matchId,
      originIp,
    };
  }

  safeTableSelectedText(amount, { entryRegistered = false } = {}) {
    if (!this.paymentsEnabled) {
      return [
        '🎮 *Mesa selecionada*',
        '',
        `Mesa: R$${Number(amount).toFixed(2).replace('.', ',')}`,
        entryRegistered
          ? 'Sua entrada foi registrada. Aguarde a próxima orientação.'
          : 'Esta mesa não aceita entradas no momento.',
        '',
        'Digite *status* para consultar ou *menu* para voltar.',
      ].join('\n');
    }
    if (entryRegistered) {
      return [
        `\u2705 Mesa selecionada: R$${Number(amount).toFixed(2).replace('.', ',')}.`,
        '',
        'Sua entrada foi registrada.',
        'Aguarde a libera\u00e7\u00e3o para receber o link da partida.',
      ].join('\n');
    }
    return [
      `\u2705 Mesa selecionada: R$${Number(amount).toFixed(2).replace('.', ',')}`,
      '',
      'Esta mesa n\u00e3o aceita entradas no momento.',
      'Digite *menu* para voltar.',
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
    const isFinancialCommand = /^(?:\/admin|admin)\s+(?:saque|saques|financeiro|saldo|extrato)\b/i.test(rawText);
    const isFinancialAdmin = Boolean(this.financialWalletService?.config?.financialAdminNumbers?.includes(senderPhone));
    const isAdmin = Boolean(
      senderPhone
      && (
        this.adminNumbers.includes(senderPhone)
        || this.entryService?.isAdmin?.(senderPhone)
        || (isFinancialCommand && isFinancialAdmin)
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

    if (this.financialWalletService?.isEnabled?.() && isFinancialCommand) {
      try {
        if (/^(?:\/admin|admin)\s+saques\s+pendentes$/i.test(rawText)) {
          const items = await this.financialWalletService.listPendingWithdrawals(senderPhone);
          await this.send(replyTo, ['💸 *SAQUES PENDENTES*', ...(items.length
            ? items.map((item) => `${item.public_reference} | ${centsMoney(item.amount_cents)} | ${item.public_id} | tel. final ${item.phone_last4}`)
            : ['Nenhum saque pendente.']), '', this.financialWalletService.notice()].join('\n'));
          return { type: 'financial_admin_pending_withdrawals', decision: 'reply_sent' };
        }
        const detailsMatch = rawText.match(/^(?:\/admin|admin)\s+saque\s+detalhes\s+([A-Z0-9-]+)$/i);
        if (detailsMatch) {
          const item = await this.financialWalletService.getWithdrawalDetails(senderPhone, detailsMatch[1]);
          await this.send(replyTo, [
            '💸 *DETALHES DO SAQUE*', `Solicitação: ${item.public_reference}`, `Jogador: ${item.display_name}`,
            `ID: ${item.public_id}`, `Telefone: final ${String(item.phone_normalized).slice(-4)}`,
            `Valor: ${centsMoney(item.amount_cents)}`, `Tipo Pix: ${item.pix_key_type}`, `Chave Pix: ${item.pix_key}`,
            `Titular: ${item.holder_name}`, `Status: ${item.status}`, '', this.financialWalletService.notice(),
          ].join('\n'));
          return { type: 'financial_admin_withdrawal_details', decision: 'reply_sent' };
        }
        const paidMatch = rawText.match(/^(?:\/admin|admin)\s+saque\s+pago\s+([A-Z0-9-]+)\s+(\S+)$/i);
        if (paidMatch) {
          const details = await this.financialWalletService.getWithdrawalDetails(senderPhone, paidMatch[1]);
          const result = await this.financialWalletService.markWithdrawalPaid(senderPhone, paidMatch[1], paidMatch[2]);
          await this.send(replyTo, `✅ Saque ${result.public_reference} marcado como pago${result.duplicate ? ' (já processado)' : ''}.`);
          if (!result.duplicate) await this.send(details.phone_normalized, ['✅ *SAQUE PAGO*', `Operação: ${result.public_reference}`, `Valor: ${centsMoney(result.amount_cents)}`].join('\n'));
          return { type: 'financial_admin_withdrawal_paid', decision: 'reply_sent', duplicate: Boolean(result.duplicate) };
        }
        const rejectMatch = rawText.match(/^(?:\/admin|admin)\s+saque\s+rejeitar\s+([A-Z0-9-]+)\s+(.+)$/i);
        if (rejectMatch) {
          const details = await this.financialWalletService.getWithdrawalDetails(senderPhone, rejectMatch[1]);
          const result = await this.financialWalletService.rejectWithdrawal(senderPhone, rejectMatch[1], rejectMatch[2]);
          await this.send(replyTo, `✅ Saque ${result.public_reference} rejeitado${result.duplicate ? ' (já processado)' : ''}.`);
          if (!result.duplicate) await this.send(details.phone_normalized, ['❌ *SAQUE REJEITADO*', `Operação: ${result.public_reference}`, `Motivo: ${result.failure_reason}`, 'O valor reservado voltou ao saldo disponível.'].join('\n'));
          return { type: 'financial_admin_withdrawal_rejected', decision: 'reply_sent', duplicate: Boolean(result.duplicate) };
        }
        const reviewMatch = rawText.match(/^(?:\/admin|admin)\s+saque\s+revisar\s+([A-Z0-9-]+)\s+(.+)$/i);
        if (reviewMatch) {
          const result = await this.financialWalletService.markWithdrawalReview(senderPhone, reviewMatch[1], reviewMatch[2]);
          await this.send(replyTo, `⚠️ Saque ${result.public_reference} enviado para revisão.`);
          return { type: 'financial_admin_withdrawal_review', decision: 'reply_sent' };
        }
        if (/^(?:\/admin|admin)\s+financeiro\s+status$/i.test(rawText)) {
          const status = await this.financialWalletService.getStatus();
          await this.send(replyTo, ['📊 *STATUS FINANCEIRO*', `Modo: ${status.mode}`, `Provedor: ${status.provider}`, `Contas: ${status.accounts}`, `Depósitos pendentes: ${status.pending_deposits}`, `Saques pendentes: ${status.pending_withdrawals}`, '', this.financialWalletService.notice()].join('\n'));
          return { type: 'financial_admin_status', decision: 'reply_sent' };
        }
        if (/^(?:\/admin|admin)\s+financeiro\s+conciliar$/i.test(rawText)) {
          const result = await this.financialWalletService.reconcile(senderPhone);
          await this.send(replyTo, [`Conciliação: ${result.status}`, `Passivo interno: ${centsMoney(result.internal_liability_cents)}`, `Saldo do provedor: ${centsMoney(result.provider_balance_cents)}`, `Diferença: ${centsMoney(result.mismatch_cents)}`, '', this.financialWalletService.notice()].join('\n'));
          return { type: 'financial_admin_reconciliation', decision: 'reply_sent' };
        }
        const accountMatch = rawText.match(/^(?:\/admin|admin)\s+(saldo|extrato)\s+(\+?\d{8,15})$/i);
        if (accountMatch) {
          const account = await this.financialWalletService.getAccount(accountMatch[2]);
          if (!account) throw new Error('FINANCIAL_ACCOUNT_NOT_FOUND');
          const lines = [`ID: ${account.public_id}`, `Disponível: ${centsMoney(account.available_balance_cents)}`, `Reservado: ${centsMoney(account.reserved_balance_cents)}`, `Saque pendente: ${centsMoney(account.withdrawal_pending_balance_cents)}`];
          if (accountMatch[1].toLowerCase() === 'extrato') {
            const history = await this.financialWalletService.listHistory(accountMatch[2]);
            lines.push('', ...history.map((item) => `${item.public_reference} | ${item.transaction_type} | ${centsMoney(item.amount_cents)}`));
          }
          await this.send(replyTo, lines.join('\n'));
          return { type: 'financial_admin_account', decision: 'reply_sent' };
        }
      } catch (error) {
        await this.send(replyTo, `❌ Operação financeira recusada: ${error.message}`);
        return { type: 'financial_admin_failed', decision: 'reply_sent', reason: error.message };
      }
    }

    if (normalizedText === 'admin demo status' || normalizedText === '/admin demo status') {
      const status = this.demoCreditsService?.getStatus?.() ?? {
        enabled: false,
        persistenceConfigured: false,
        accountCount: 0,
        activeReservations: 0,
        ledgerEvents: 0,
      };
      await this.send(replyTo, [
        '*🧪 STATUS DOS CRÉDITOS DE TESTE*',
        '',
        `Ativo: ${status.enabled ? 'sim' : 'não'}`,
        `Persistência configurada: ${status.persistenceConfigured ? 'sim' : 'não'}`,
        `Contas de teste: ${status.accountCount}`,
        `Reservas ativas: ${status.activeReservations}`,
        `Eventos no histórico: ${status.ledgerEvents}`,
        '',
        'AMBIENTE DEMONSTRATIVO — SEM VALOR FINANCEIRO',
      ].join('\n'));
      return { type: 'demo_admin_status', decision: 'reply_sent', reason: 'demo_status_ok' };
    }

    const demoBalanceMatch = rawText.match(/^(?:\/admin|admin)\s+demo\s+saldo\s+(.+)$/i);
    if (demoBalanceMatch) {
      const targetPhone = normalizePhone(demoBalanceMatch[1]);
      if (!targetPhone || !this.demoCreditsService?.isEnabled?.()) {
        await this.send(replyTo, !this.demoCreditsService?.isEnabled?.()
          ? '⚠️ Créditos de Teste estão desligados.'
          : '❌ Número inválido.');
        return { type: 'demo_admin_balance_failed', decision: 'reply_sent', reason: targetPhone ? 'feature_disabled' : 'invalid_phone' };
      }
      const balance = this.demoCreditsService.getBalance(targetPhone);
      await this.send(replyTo, [
        '*🧪 SALDO DE TESTE*',
        `Jogador: ${maskPhone(targetPhone)}`,
        `Disponível: ${balance.availableBalance}`,
        `Reservado: ${balance.reservedBalance}`,
        'Sem valor financeiro.',
      ].join('\n'));
      return { type: 'demo_admin_balance', decision: 'reply_sent', reason: 'demo_balance_ok' };
    }

    const demoStatementMatch = rawText.match(/^(?:\/admin|admin)\s+demo\s+extrato\s+(.+)$/i);
    if (demoStatementMatch) {
      const targetPhone = normalizePhone(demoStatementMatch[1]);
      if (!targetPhone || !this.demoCreditsService?.isEnabled?.()) {
        await this.send(replyTo, !this.demoCreditsService?.isEnabled?.() ? '⚠️ Créditos de Teste estão desligados.' : '❌ Número inválido.');
        return { type: 'demo_admin_history_failed', decision: 'reply_sent', reason: targetPhone ? 'feature_disabled' : 'invalid_phone' };
      }
      await this.send(replyTo, demoCreditsHistory(this.demoCreditsService.getHistory(targetPhone)));
      return { type: 'demo_admin_history', decision: 'reply_sent', reason: 'demo_history_ok' };
    }

    const demoGrantMatch = rawText.match(/^(?:\/admin|admin)\s+demo\s+conceder\s+(\+?\d{8,15})\s+(\d+)\s+(.+)$/i);
    if (demoGrantMatch) {
      const targetPhone = normalizePhone(demoGrantMatch[1]);
      try {
        const result = this.demoCreditsService?.adminGrantCredits?.(
          targetPhone,
          Number(demoGrantMatch[2]),
          sanitizeText(demoGrantMatch[3]),
          senderPhone,
        );
        if (!result) throw new Error('DEMO_CREDITS_DISABLED');
        await this.send(replyTo, [
          `✅ ${Number(demoGrantMatch[2])} Créditos de Teste adicionados.`,
          `Saldo anterior: ${result.previousBalance}`,
          `Novo saldo: ${result.account.availableBalance}`,
          `Referência: ${result.publicReference}`,
          'Sem valor financeiro.',
        ].join('\n'));
        return { type: 'demo_admin_grant', decision: 'reply_sent', reason: 'demo_grant_ok' };
      } catch (error) {
        await this.send(replyTo, `❌ Não foi possível conceder Créditos de Teste: ${error.message}`);
        return { type: 'demo_admin_grant_failed', decision: 'reply_sent', reason: error.message };
      }
    }

    const demoResetMatch = rawText.match(/^(?:\/admin|admin)\s+demo\s+reset\s+(\+?\d{8,15})\s+(.+)$/i);
    if (demoResetMatch) {
      const targetPhone = normalizePhone(demoResetMatch[1]);
      try {
        const result = this.demoCreditsService?.adminResetDemoAccount?.(
          targetPhone,
          sanitizeText(demoResetMatch[2]),
          senderPhone,
        );
        if (!result) throw new Error('DEMO_CREDITS_DISABLED');
        await this.send(replyTo, [
          '✅ Conta de Créditos de Teste reiniciada.',
          `Saldo anterior: ${result.previousBalance}`,
          `Novo saldo: ${result.account.availableBalance}`,
          `Referência: ${result.publicReference}`,
          'Histórico preservado.',
        ].join('\n'));
        return { type: 'demo_admin_reset', decision: 'reply_sent', reason: 'demo_reset_ok' };
      } catch (error) {
        await this.send(replyTo, `❌ Não foi possível reiniciar a conta de teste: ${error.message}`);
        return { type: 'demo_admin_reset_failed', decision: 'reply_sent', reason: error.message };
      }
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
        'admin demo status',
        'admin demo saldo NUMERO',
        'admin demo extrato NUMERO',
        'admin demo conceder NUMERO QUANTIDADE MOTIVO',
        'admin demo reset NUMERO MOTIVO',
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
      const result = await this.matchQueue?.clearPlayerState?.(targetPhone, {
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
          '\u274C Sua entrada n\u00e3o foi liberada.',
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
    return waitingForOpponent({ table: amount, demoCreditsEnabled: Boolean(this.demoCreditsService?.isEnabled?.()) });
    /* istanbul ignore next */
    return [
      `✅ Você entrou na fila da Mesa R$${Number(amount).toFixed(0)}.`,
      'Aguardando outro jogador entrar...',
      '',
      'Para cancelar, digite sair ou menu.',
    ].join('\n');
  }

  safeQueueDuplicateText() {
    return queueDuplicateMessage({
      table: arguments[0]?.table ?? arguments[0]?.tableValue ?? null,
      demoCreditsEnabled: Boolean(this.demoCreditsService?.isEnabled?.()),
    });
    /* istanbul ignore next */
    return '⏳ Você já está aguardando um adversário nesta mesa.';
  }

  safeActiveMatchText() {
    return activeMatchMessage(arguments[0] || {});
    /* istanbul ignore next */
    return '⚠️ Você já está em uma partida ativa.';
  }

  safeMatchFoundText(amount, accessLink) {
    return matchFoundMessage({
      table: amount,
      accessLink,
      publicReference: arguments[2] ?? null,
      demoCreditsEnabled: Boolean(this.demoCreditsService?.isEnabled?.()),
    });
    /* istanbul ignore next */
    return [
      '🎮 Partida encontrada!',
      `Mesa: R$${Number(amount).toFixed(0)}`,
      '',
      'Entre na sala pelo link abaixo:',
      accessLink,
    ].join('\n');
  }

  safeOtherQueueText() {
    return otherQueueMessage({
      table: arguments[0]?.table ?? arguments[0]?.tableValue ?? null,
      demoCreditsEnabled: Boolean(this.demoCreditsService?.isEnabled?.()),
    });
    /* istanbul ignore next */
    return '⏳ Você já está aguardando adversário em outra mesa. Aguarde ou digite menu.';
  }

  safeQueueCancelledText() {
    if (this.demoCreditsService?.isEnabled?.()) {
      return [
        '*✅ ENTRADA CANCELADA*',
        '',
        'Sua espera foi cancelada e os Créditos de Teste foram devolvidos ao seu saldo.',
        'Você já pode escolher outra Mesa.',
      ].join('\n');
    }
    return cancellationProtocol();
    /* istanbul ignore next */
    return '\u2705 Sua entrada foi cancelada. Voc\u00ea voltou ao menu.';
  }

  safePaidEntryActiveText(entry = null) {
    return paidEntryActiveMessage({
      table: entry?.selectedTable ?? null,
      demoCreditsEnabled: Boolean(this.demoCreditsService?.isEnabled?.()),
    });
    /* istanbul ignore next */
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

  async handleRulesTopic(incoming, { replyTo, command, originIp }) {
    this.setConversationState(incoming.phone, 'rules_menu');
    await this.sendPanel(replyTo, incoming.phone, `RULES_${command}`, ruleTopic(command));
    return {
      type: 'whatsapp_rules_topic_sent',
      decision: 'reply_sent',
      reason: `rules_topic_${command}`,
      state: 'rules_menu',
      originIp,
    };
  }

  async handleSupportTopic(incoming, { replyTo, command, originIp }) {
    const context = this.getSupportContext(incoming.phone);
    if (command === '6') {
      await this.sendPermanent(replyTo, incoming.phone, supportContact({
        supportLink: this.buildSupportLink(),
        publicReference: context.publicReference,
        hasActiveContext: context.hasActiveContext,
      }), { replyType: 'support_protocol' });
      this.logInfo('WHATSAPP_SUPPORT_LINK_SENT', {
        playerId: maskPhone(incoming.phone),
        supportNumber: maskPhone(this.supportNumber),
        publicReference: context.publicReference,
      });
      return {
        type: 'whatsapp_support_link_sent',
        decision: 'reply_sent',
        reason: 'support_contact_requested',
        state: 'support_menu',
        originIp,
      };
    }

    this.setConversationState(incoming.phone, 'support_menu');
    await this.sendPanel(replyTo, incoming.phone, `SUPPORT_${command}`, supportTopic(command, {
      publicReference: context.publicReference,
    }));
    return {
      type: 'whatsapp_support_topic_sent',
      decision: 'reply_sent',
      reason: `support_topic_${command}`,
      state: 'support_menu',
      originIp,
    };
  }

  async handleStatusCommand(incoming, { replyTo, originIp }) {
    const context = await this.renderCurrentContext(replyTo, incoming.phone);
    return {
      type: 'whatsapp_status_sent',
      decision: 'reply_sent',
      reason: 'status_requested',
      state: context.state,
      originIp,
    };
  }

  async handleLinkCommand(incoming, { replyTo, originIp }) {
    const context = this.getPlayerContext(incoming.phone);
    const entry = context.entry;
    if (
      context.state === WHATSAPP_PLAYER_STATES.MATCH_LINK_READY
      && entry?.entryId
      && entry?.whatsappMatchId
    ) {
      try {
        const refreshed = this.entryService.refreshQueueAccessLink(entry.entryId, {
          actor: incoming.phone,
          source: 'whatsapp-link-recovery',
          matchId: entry.whatsappMatchId,
          preMatchDeadline: entry.preMatchDeadline,
        });
        this.entryService?.markLinkDelivery?.(entry.entryId, { sent: true });
        await this.sendPermanent(replyTo, incoming.phone, matchFoundMessage({
          table: context.table,
          accessLink: refreshed.accessLink,
          publicReference: context.publicReference,
        }), { replyType: 'match_link' });
        return {
          type: 'whatsapp_match_link_recovered',
          decision: 'reply_sent',
          reason: 'match_link_recovered',
          state: context.state,
          originIp,
        };
      } catch (error) {
        this.logWarn('WHATSAPP_MATCH_LINK_RECOVERY_FAILED', {
          playerId: maskPhone(incoming.phone),
          publicReference: context.publicReference,
          reason: error.message,
        });
        await this.sendPanel(replyTo, incoming.phone, 'LINK_UNAVAILABLE', unavailableLink());
        return {
          type: 'whatsapp_match_link_unavailable',
          decision: 'reply_sent',
          reason: 'match_link_recovery_failed',
          state: context.state,
          originIp,
        };
      }
    }

    if ([WHATSAPP_PLAYER_STATES.PRE_MATCH_WAITING, WHATSAPP_PLAYER_STATES.MATCH_STARTED].includes(context.state)) {
      await this.sendPanel(replyTo, incoming.phone, context.state, this.messageForContext(context));
    } else {
      await this.sendPanel(replyTo, incoming.phone, 'LINK_UNAVAILABLE', unavailableLink());
    }
    return {
      type: 'whatsapp_match_link_unavailable',
      decision: 'reply_sent',
      reason: 'no_recoverable_link',
      state: context.state,
      originIp,
    };
  }

  async handleMenuCommand(incoming, { replyTo, originIp }) {
    const context = this.getPlayerContext(incoming.phone);
    if ([WHATSAPP_PLAYER_STATES.IDLE, WHATSAPP_PLAYER_STATES.MATCH_FINISHED].includes(context.state)) {
      this.setConversationState(incoming.phone, 'idle');
      await this.sendPanel(replyTo, incoming.phone, 'MAIN_MENU', this.safeMenuText());
      return { type: 'whatsapp_menu_sent', decision: 'reply_sent', reason: 'menu_command', state: 'idle', originIp };
    }

    this.setConversationState(incoming.phone, 'idle');
    await this.sendPanel(replyTo, incoming.phone, context.state, this.messageForContext(context));
    return {
      type: 'whatsapp_context_menu_sent',
      decision: 'reply_sent',
      reason: 'menu_preserved_active_state',
      state: context.state,
      originIp,
    };
  }

  async financialMainMenu(incoming) {
    const account = await this.financialWalletService.getOrCreateAccount(incoming.phone, {
      displayName: sanitizeText(incoming.pushName || 'Jogador'),
    });
    this.setConversationState(incoming.phone, 'financial_menu');
    return walletMenu(account);
  }

  async handleFinancialCommand(incoming, { replyTo, command, originIp }) {
    command = normalizeCommand(command);
    const wallet = this.financialWalletService;
    const state = this.getConversationState(incoming.phone).state;
    const walletStates = ['financial_menu', 'financial_deposit_amount', 'financial_history', 'financial_profile', 'financial_pix_expired', 'financial_insufficient'];
    const atRoot = ['idle', 'how_it_works'].includes(state);
    if ((command === '0' || command === 'voltar') && state !== 'cancel_confirmation') {
      if (wallet?.isEnabled?.() && walletStates.includes(state) && state !== 'financial_menu') {
        await this.sendPanel(replyTo, incoming.phone, 'FINANCIAL_MENU', await this.financialMainMenu(incoming));
        return { type: 'financial_menu', decision: 'reply_sent', originIp };
      }
      return this.handleMenuCommand(incoming, { replyTo, originIp });
    }
    const openWallet = FINANCIAL_WALLET_COMMANDS.has(command) || (atRoot && command === '2');
    if (!wallet?.isEnabled?.()) {
      if (/^depositar(?:\s|$)/.test(command)) return this.handleDepositCommand(incoming, { replyTo, command, originIp });
      if (openWallet || SALDO_COMMANDS.has(command) || ['extrato', 'sacar', 'recarregar'].includes(command)) {
        await this.send(replyTo, unavailableWalletMessage());
        return { type: 'financial_unavailable', decision: 'reply_sent', originIp };
      }
      return null;
    }
    if (SALDO_COMMANDS.has(command) || (state === 'financial_menu' && command === '3')) {
      const account = await wallet.getOrCreateAccount(incoming.phone, { displayName: incoming.pushName || 'Jogador' });
      await this.send(replyTo, balanceMessage(account));
      return { type: 'financial_balance', decision: 'reply_sent', originIp };
    }
    if (openWallet) {
      await this.sendPanel(replyTo, incoming.phone, 'FINANCIAL_MENU', await this.financialMainMenu(incoming));
      return { type: 'financial_menu', decision: 'reply_sent', originIp };
    }
    if (command === 'depositar' || command === 'recarregar'
      || (['financial_menu', 'financial_pix_expired', 'financial_insufficient'].includes(state) && command === '1')) {
      this.setConversationState(incoming.phone, 'financial_deposit_amount');
      await this.send(replyTo, depositPrompt());
      return { type: 'financial_deposit_help', decision: 'reply_sent', originIp };
    }
    if (/^depositar\s/.test(command) || (state === 'financial_deposit_amount' && /^\d/.test(command))) {
      return this.handleDepositCommand(incoming, { replyTo, command: /^depositar\s/.test(command) ? command : 'depositar ' + command, originIp });
    }
    if ((state === 'financial_menu' && command === '4') || command === 'perfil') {
      const account = await wallet.getOrCreateAccount(incoming.phone, { displayName: incoming.pushName || 'Jogador' });
      this.setConversationState(incoming.phone, 'financial_profile');
      await this.send(replyTo, ['👤 *Perfil*', '', 'Seu identificador: ' + account.public_id, '', '0 — Voltar'].join('\n'));
      return { type: 'financial_profile', decision: 'reply_sent', originIp };
    }
    if ((state === 'financial_menu' && command === '2') || ['extrato financeiro', 'extrato'].includes(command)) {
      const history = await wallet.listHistory(incoming.phone);
      this.setConversationState(incoming.phone, 'financial_history');
      await this.send(replyTo, historyMessage(history));
      return { type: 'financial_history', decision: 'reply_sent', originIp };
    }
    if (/^sacar(?:\s|$)/.test(command) && wallet.config?.withdrawalsEnabled === false) {
      await this.send(replyTo, unavailableWithdrawalMessage());
      return { type: 'financial_withdrawal_unavailable', decision: 'reply_sent', originIp };
    }
    const withdrawal = incoming.text.match(/^sacar\s+(\d+(?:[,.]\d{1,2})?)\s+(CPF|CNPJ|EMAIL|PHONE|EVP)\s+([^|]+)\|\s*(.+)$/i);
    if (withdrawal) {
      const amountCents = Math.round(Number(withdrawal[1].replace(',', '.')) * 100);
      const before = await wallet.getOrCreateAccount(incoming.phone, { displayName: incoming.pushName || 'Jogador' });
      const request = await wallet.requestWithdrawal(incoming.phone, {
        amountCents, pixKeyType: withdrawal[2], pixKey: withdrawal[3].trim(), holderName: withdrawal[4].trim(),
        idempotencyKey: `whatsapp:${incoming.messageId || Date.now()}:withdrawal`,
      });
      const after = await wallet.getAccount(incoming.phone);
      const adminMessage = [
        '💸 *NOVA SOLICITAÇÃO DE SAQUE*', `Solicitação: ${request.public_reference}`,
        `Jogador: ${before.display_name}`, `ID: ${before.public_id}`, `Telefone: final ${String(before.phone_normalized).slice(-4)}`,
        `Tipo da chave: ${withdrawal[2].toUpperCase()}`, `Chave Pix: ${withdrawal[3].trim()}`,
        `Titular informado: ${withdrawal[4].trim()}`, `Saldo total antes: ${centsMoney(before.available_balance_cents)}`,
        `Valor solicitado: ${centsMoney(request.amount_cents)}`, `Saldo disponível após reserva: ${centsMoney(after.available_balance_cents)}`,
        '', `Após transferir: admin saque pago ${request.public_reference} ID_DA_TRANSFERENCIA`,
        `Para rejeitar: admin saque rejeitar ${request.public_reference} MOTIVO`, '', wallet.notice(),
      ].join('\n');
      const deliveries = await Promise.allSettled(wallet.config.financialAdminNumbers.map((phone) => this.send(phone, adminMessage, { replyType: 'financial_withdrawal_admin' })));
      if (deliveries.some((item) => item.status === 'rejected' || item.value?.ok === false)) {
        this.logWarn('WITHDRAWAL_ADMIN_NOTIFICATION_FAILED', { publicReference: request.public_reference });
      } else {
        this.logInfo('WITHDRAWAL_ADMIN_NOTIFIED', { publicReference: request.public_reference, recipients: deliveries.length });
      }
      await this.send(replyTo, [
        '✅ Solicitação de saque registrada.', `Operação: ${request.public_reference}`,
        `Valor reservado: ${centsMoney(request.amount_cents)}`, 'Status: aguardando pagamento manual do administrador.',
      ].join('\n'));
      return { type: 'financial_withdrawal_requested', decision: 'reply_sent', publicReference: request.public_reference, originIp };
    }
    return null;
  }

  async handleDepositCommand(incoming, { replyTo, command, originIp }) {
    const wallet = this.financialWalletService;
    const record = (stage, errorCode = null) => this.logInfo('PIX_DEPOSIT_STAGE', { stage, errorCode });
    const reply = async (text, type, publicReference = undefined) => {
      record('WHATSAPP_SEND_REQUESTED');
      const result = await this.send(replyTo, text, { replyType: 'pix_deposit' });
      const failed = result?.ok === false;
      record(failed ? 'WHATSAPP_SEND_FAILED' : 'WHATSAPP_SEND_CONFIRMED');
      return { type, decision: failed ? 'reply_failed' : 'reply_sent', publicReference, originIp };
    };
    record('RECEIVED');
    if (!wallet?.isEnabled?.() || wallet.config?.pixDepositsEnabled === false) {
      return reply('Os depósitos estão temporariamente indisponíveis.', 'financial_deposit_unavailable');
    }
    const parsed = command.match(/^depositar\s+(\d+)(?:[,.](\d{1,2}))?$/);
    const amount = parsed ? BigInt(parsed[1]) * 100n + BigInt((parsed[2] || '').padEnd(2, '0')) : 0n;
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      return reply('Valor inválido. Envie depositar 1 ou depositar 1,00.', 'financial_deposit_invalid');
    }
    record('COMMAND_PARSED');
    if (!incoming.messageId) {
      return reply('Não consegui identificar esta mensagem com segurança. Envie novamente o comando.', 'financial_deposit_missing_message_id');
    }
    let order;
    try {
      record('FINANCIAL_SERVICE_CALLED');
      order = await wallet.createDeposit(incoming.phone, Number(amount), {
        displayName: incoming.pushName || 'Jogador',
        idempotencyKey: `whatsapp:${incoming.messageId}:deposit`,
      });
      record('DEPOSIT_CREATED');
    } catch (error) {
      if (error?.message === 'FINANCIAL_DEPOSIT_EXPIRED') {
        this.setConversationState(incoming.phone, 'financial_pix_expired');
        return reply(expiredPixMessage(), 'financial_deposit_expired');
      }
      this.logWarn('FINANCIAL_DEPOSIT_CREATE_REJECTED', {
        stage: 'FINANCIAL_SERVICE_CALLED', errorCode: 'DEPOSIT_REQUEST_FAILED',
      });
      return reply(pixFailureMessage(), 'financial_deposit_failed');
    }
    const text = pixMessage(order, wallet.config?.pixPaymentWindowMinutes || 10);
    record('RESPONSE_BUILT');
    record('WHATSAPP_SEND_REQUESTED');
    const informationResult = await this.send(replyTo, text, { replyType: 'pix_deposit' });
    if (informationResult?.ok === false) {
      record('WHATSAPP_SEND_FAILED');
      return { type: 'financial_deposit_created', decision: 'reply_failed', publicReference: order.public_reference, originIp };
    }
    record('PIX_CODE_SEND_REQUESTED');
    const codeResult = await this.send(replyTo, order.pix_copy_paste, { replyType: 'pix_deposit_code' });
    if (codeResult?.ok === false) {
      record('PIX_CODE_SEND_FAILED');
      record('WHATSAPP_SEND_FAILED');
      return { type: 'financial_deposit_created', decision: 'reply_failed', publicReference: order.public_reference, originIp };
    }
    record('PIX_CODE_SEND_CONFIRMED');
    record('WHATSAPP_SEND_CONFIRMED');
    return { type: 'financial_deposit_created', decision: 'reply_sent', publicReference: order.public_reference, originIp };
  }

  async handleCancelCommand(incoming, { replyTo, originIp }) {
    const context = this.getPlayerContext(incoming.phone);
    if (context.state === WHATSAPP_PLAYER_STATES.MATCH_STARTED) {
      await this.sendPanel(replyTo, incoming.phone, context.state, activeMatchMessage(context));
      return { type: 'whatsapp_cancel_blocked_match_started', decision: 'reply_sent', reason: 'match_started', state: context.state, originIp };
    }
    if ([WHATSAPP_PLAYER_STATES.ADMIN_REVIEW, WHATSAPP_PLAYER_STATES.REFUND_PENDING].includes(context.state) || context.paidConfirmed) {
      await this.sendPermanent(replyTo, incoming.phone, paidEntryActiveMessage(context), { replyType: 'financial_warning' });
      return { type: 'whatsapp_cancel_blocked_preserved_entry', decision: 'reply_sent', reason: 'entry_preserved', state: context.state, originIp };
    }
    if (!context.canCancel) {
      await this.sendPanel(replyTo, incoming.phone, 'NO_ACTIVE_QUEUE', noActiveQueueMessage());
      return { type: 'whatsapp_cancel_empty', decision: 'reply_sent', reason: 'no_cancelable_wait', state: context.state, originIp };
    }

    this.setConversationState(incoming.phone, 'cancel_confirmation', context.table);
    await this.sendPanel(replyTo, incoming.phone, 'CANCEL_CONFIRMATION', cancelConfirmationMessage(context));
    return { type: 'whatsapp_cancel_confirmation', decision: 'reply_sent', reason: 'cancel_confirmation_required', state: 'cancel_confirmation', originIp };
  }

  async notifyCancellationParticipants(clearResult, initiatorPhone) {
    const released = clearResult?.releasedParticipants ?? [];
    for (const entry of released) {
      if (!entry?.playerPhone || entry.playerPhone === initiatorPhone || !entry.notifyTo) continue;
      this.setConversationState(entry.playerPhone, 'idle');
      await this.sendPermanent(entry.notifyTo, entry.playerPhone, clearResult.paidEntryPreserved
        ? paidEntryActiveMessage({ table: entry.selectedTable })
        : [
            '*SALA DE ESPERA ENCERRADA*',
            '',
            'A Partida ainda não havia começado. Os acessos antigos foram invalidados e sua Entrada gratuita foi liberada.',
            'Digite *jogar* para escolher outra Mesa.',
          ].join('\n'), { replyType: 'cancellation_protocol' });
    }
  }

  async handleCancelConfirmation(incoming, { replyTo, command, originIp }) {
    if (command === '1') {
      this.setConversationState(incoming.phone, 'idle');
      const context = await this.renderCurrentContext(replyTo, incoming.phone);
      return { type: 'whatsapp_cancel_aborted', decision: 'reply_sent', reason: 'continue_waiting', state: context.state, originIp };
    }

    const before = this.getPlayerContext(incoming.phone);
    const clearResult = await this.matchQueue?.clearPlayerState?.(incoming.phone, {
      actor: incoming.phone,
      reason: 'whatsapp_cancel_confirmed',
    });
    if (clearResult?.paidEntryPreserved || clearResult?.realMatchPreserved) {
      this.setConversationState(incoming.phone, 'idle');
      const after = this.getPlayerContext(incoming.phone);
      await this.sendPermanent(replyTo, incoming.phone, this.messageForContext(after), { replyType: 'entry_preserved' });
      return { type: 'whatsapp_cancel_blocked_preserved', decision: 'reply_sent', reason: 'server_preserved_entry', state: after.state, originIp };
    }
    if (!clearResult?.cleared) {
      this.setConversationState(incoming.phone, 'idle');
      await this.sendPanel(replyTo, incoming.phone, 'ACTION_ERROR', friendlyActionError());
      return { type: 'whatsapp_cancel_failed', decision: 'reply_sent', reason: 'server_cancel_not_confirmed', state: before.state, originIp };
    }

    await this.notifyCancellationParticipants(clearResult, incoming.phone);
    this.setConversationState(incoming.phone, 'idle');
    await this.sendPermanent(replyTo, incoming.phone, cancellationProtocol({
      publicReference: before.publicReference,
    }), { replyType: 'cancellation_protocol' });
    await this.sendPanel(replyTo, incoming.phone, 'MAIN_MENU', this.safeMenuText());
    return {
      type: 'whatsapp_queue_cancelled',
      decision: 'reply_sent',
      reason: 'cancel_confirmed_after_server_update',
      state: 'idle',
      originIp,
    };
  }

  async handleConnectivityWebhook(payload, options = {}) {
    const incoming = parseIncomingMessage(payload);
    return this.enqueueConversation(incoming.phone || incoming.replyTo, () => (
      this.handleConnectivityWebhookNow(payload, options)
    ));
  }

  async handleConnectivityWebhookNow(payload, { originIp = null } = {}) {
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

    const isDeposit = /^depositar(?:\s|$)/.test(normalizeCommand(incoming.text));
    if (!isDeposit && this.safeEntryEnabled && incoming.messageId && this.entryService?.store?.hasProcessedMessage(incoming.messageId)) {
      return { ignored: true, decision: 'ignored_invalid', reason: 'duplicate_message' };
    }
    if (!isDeposit && this.safeEntryEnabled && incoming.messageId) this.entryService?.store?.markMessageProcessed(incoming.messageId);

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
        || HOW_IT_WORKS_COMMANDS.has(command)
        || TEST_MODE_COMMANDS.has(command)
        || RULES_COMMANDS.has(command)
        || STATUS_COMMANDS.has(command)
        || LINK_COMMANDS.has(command)
        || IDENTIFY_COMMANDS.has(command)
        || UPDATES_COMMANDS.has(command)
        || DEMO_CREDITS_COMMANDS.has(command)
        || isFinancialCommandText(command)
        || (currentState.state === 'demo_credits_menu' && ['1', '2'].includes(command))
        || (currentState.state === 'updates_menu' && UPDATE_SECTION_COMMANDS.has(command))
        || tableOptionFromCommand(command) !== null
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
    const protectedCommand = protectedFinancialCommandLog(command);
    this.logInfo('WHATSAPP_MESSAGE_TEXT', {
      originIp,
      textLength: incoming.text.length,
      ...(protectedCommand ?? { command: maskDigitsInText(command).slice(0, 120) }),
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
    try {
      const financialResult = await this.handleFinancialCommand(incoming, { replyTo, command, originIp });
      if (financialResult) return financialResult;
    } catch {
      this.logWarn('FINANCIAL_PLAYER_ACTION_FAILED', { reason: 'ACTION_UNAVAILABLE' });
      await this.send(replyTo, friendlyActionError());
      return { type: 'financial_action_failed', decision: 'reply_sent', originIp };
    }
    if (currentState.state === 'demo_credits_menu' && ['1', '2'].includes(command)) {
      return this.handleDemoCreditsSection(incoming, { replyTo, command, originIp });
    }
    if (currentState.state === 'cancel_confirmation' && ['1', '2'].includes(command)) {
      return this.handleCancelConfirmation(incoming, { replyTo, command, originIp });
    }
    if (currentState.state === 'rules_menu' && /^[1-6]$/.test(command)) {
      return this.handleRulesTopic(incoming, { replyTo, command, originIp });
    }
    if (currentState.state === 'support_menu' && /^[1-6]$/.test(command)) {
      return this.handleSupportTopic(incoming, { replyTo, command, originIp });
    }
    if (currentState.state === 'updates_menu' && UPDATE_SECTION_COMMANDS.has(command)) {
      return this.handleUpdatesSection(incoming, { replyTo, command, originIp });
    }
    if (UPDATES_COMMANDS.has(command) || (currentState.state === 'updates_menu' && command === 'voltar')) {
      return this.handleUpdatesRequest(incoming, { replyTo, originIp });
    }
    if (DEMO_CREDITS_COMMANDS.has(command)) {
      return this.handleDemoCreditsRequest(incoming, { replyTo, originIp });
    }
    if (STATUS_COMMANDS.has(command)) return this.handleStatusCommand(incoming, { replyTo, originIp });
    if (LINK_COMMANDS.has(command)) return this.handleLinkCommand(incoming, { replyTo, originIp });
    if (MENU_COMMANDS.has(command)) return this.handleMenuCommand(incoming, { replyTo, originIp });
    if (CANCEL_QUEUE_COMMANDS.has(command)) return this.handleCancelCommand(incoming, { replyTo, originIp });
    const tableOption = tableOptionFromCommand(command);
    const isTableSelectionInProgress = currentState.state === 'choosing_table' && tableOption !== null;
    if (SUPPORT_COMMANDS.has(command) && !isTableSelectionInProgress) {
      return this.handleSupportRequest(incoming, { replyTo, originIp });
    }
    if (MENU_COMMANDS.has(command) || CANCEL_QUEUE_COMMANDS.has(command)) {
      const clearResult = await this.matchQueue?.clearPlayerState?.(incoming.phone, {
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
      await this.send(replyTo, noActiveQueueMessage());
      return { type: 'whatsapp_queue_cancel_empty', decision: 'reply_sent', reason: 'player_not_in_queue', state: 'idle', originIp };
    }
    if (currentState.state === 'choosing_table' && tableOption !== null) {
      const selectedTable = SAFE_TABLES.get(tableOption);
      if (this.safeEntryEnabled && this.matchQueue?.isConfigured?.()) {
        const queueResult = this.financialWalletService?.isEnabled?.()
          ? await this.matchQueue.joinFinancialQueue(incoming.phone, selectedTable, { replyTo })
          : await this.matchQueue.joinQueue(incoming.phone, selectedTable, { replyTo });
        if (queueResult.blocked) {
          if (queueResult.reason === 'FINANCIAL_INSUFFICIENT_BALANCE') {
            this.setConversationState(incoming.phone, 'financial_insufficient');
            await this.send(replyTo, insufficientBalanceMessage());
            return { type: 'financial_insufficient_balance', decision: 'reply_sent', reason: queueResult.reason, originIp };
          }
          if (queueResult.reason === 'REAL_MONEY_GAMES_DISABLED') {
            await this.send(replyTo, 'As mesas estão indisponíveis no momento. Digite *teste* para treinar ou *menu* para voltar.');
            return { type: 'financial_tables_unavailable', decision: 'reply_sent', reason: queueResult.reason, originIp };
          }
          if (queueResult.reason === 'DEMO_INSUFFICIENT_CREDITS') {
            await this.sendPanel(replyTo, incoming.phone, 'DEMO_CREDITS_INSUFFICIENT', demoCreditsInsufficient({
              availableBalance: queueResult.availableBalance,
              requiredAmount: queueResult.requiredAmount ?? selectedTable,
            }));
            return { type: 'demo_credits_insufficient', decision: 'reply_sent', reason: queueResult.reason, state: 'choosing_table', selectedTable, originIp };
          }
          if (queueResult.reason === 'DEMO_ACTIVE_RESERVATION_EXISTS') {
            await this.renderCurrentContext(replyTo, incoming.phone);
            return { type: 'demo_credits_active_reservation', decision: 'reply_sent', reason: queueResult.reason, state: currentState.state, selectedTable, originIp };
          }
          if (queueResult.reason === 'already_in_queue') {
            await this.sendPanel(replyTo, incoming.phone, 'WAITING_FOR_OPPONENT', queueDuplicateMessage({
              table: queueResult.queue?.tableValue ?? selectedTable,
              demoCreditsEnabled: Boolean(this.demoCreditsService?.isEnabled?.()),
            }));
            return { type: 'whatsapp_queue_duplicate', decision: 'reply_sent', reason: 'already_in_queue', state: 'choosing_table', selectedTable, originIp };
          }
          if (queueResult.reason === 'already_in_active_match' || queueResult.reason === 'PLAYER_ALREADY_ACTIVE_MATCH') {
            const context = this.getPlayerContext(incoming.phone);
            await this.sendPanel(replyTo, incoming.phone, 'MATCH_STARTED', activeMatchMessage(context));
            return { type: 'whatsapp_queue_active_match_blocked', decision: 'reply_sent', reason: queueResult.reason, state: 'table_selected', selectedTable, originIp };
          }
          if (queueResult.reason === 'already_in_other_queue') {
            await this.sendPanel(replyTo, incoming.phone, 'WAITING_FOR_OPPONENT', otherQueueMessage({
              table: queueResult.queue?.tableValue ?? queueResult.queue?.entry?.tableValue,
              demoCreditsEnabled: Boolean(this.demoCreditsService?.isEnabled?.()),
            }));
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
                  await this.sendPermanent(sendTarget, player.sendTo, this.safeMatchFoundText(
                    matchTable,
                    player.accessLink,
                    queueResult.match.publicReference,
                  ), { replyType: 'match_link' });
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

        await this.sendPanel(replyTo, incoming.phone, 'WAITING_FOR_OPPONENT', waitingForOpponent({
          table: selectedTable,
          demoCreditsEnabled: Boolean(this.demoCreditsService?.isEnabled?.()),
          availableBalance: queueResult.demoReservation?.account?.availableBalance ?? null,
          reservedAmount: queueResult.demoReservation?.reservation?.amount ?? null,
        }));
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
            await this.send(replyTo, 'Voc\u00ea j\u00e1 possui uma entrada ativa em outra mesa. Aguarde ou digite *menu*.');
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

    if (PLAY_COMMANDS.has(command) || isNamedTableOption(command)) {
      const context = this.getPlayerContext(incoming.phone);
      if (![WHATSAPP_PLAYER_STATES.IDLE, WHATSAPP_PLAYER_STATES.MATCH_FINISHED].includes(context.state)) {
        await this.sendPanel(replyTo, incoming.phone, context.state, this.messageForContext(context));
        return {
          type: 'whatsapp_play_blocked_active_state',
          decision: 'reply_sent',
          reason: 'active_state_preserved',
          state: context.state,
          originIp,
        };
      }
      this.setConversationState(incoming.phone, 'choosing_table');
      await this.prepareDemoCreditsAccount(replyTo, incoming.phone);
      await this.sendPanel(replyTo, incoming.phone, 'TABLE_SELECTION', this.safeTablesText(incoming.phone));
      return { type: 'whatsapp_tables_sent', decision: 'reply_sent', reason: 'tables_requested', state: 'choosing_table', originIp };
    }

    if (HOW_IT_WORKS_COMMANDS.has(command)) {
      this.setConversationState(incoming.phone, 'how_it_works');
      await this.sendPanel(replyTo, incoming.phone, 'HOW_IT_WORKS', howItWorksMenu({
        paymentsEnabled: this.paymentsEnabled,
      }));
      return { type: 'whatsapp_how_it_works_sent', decision: 'reply_sent', reason: 'how_it_works_requested', state: 'how_it_works', originIp };
    }

    if (TEST_MODE_COMMANDS.has(command)) {
      const testModeLink = this.buildTestModeLink();
      this.matchQueue?.logInfo?.('WHATSAPP_TEST_MODE_REQUEST', {
        playerId: maskPhone(incoming.phone),
        phone: maskPhone(incoming.phone),
        testModeLink,
      });
      this.setConversationState(incoming.phone, 'idle');
      await this.sendPermanent(replyTo, incoming.phone, this.safeTestModeText(testModeLink), { replyType: 'test_mode_link' });
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
      this.setConversationState(incoming.phone, 'rules_menu');
      await this.sendPanel(replyTo, incoming.phone, 'RULES_MENU', this.safeRulesText());
      return { type: 'whatsapp_rules_sent', decision: 'reply_sent', reason: 'rules_requested', state: 'rules_menu', originIp };
    }

    if (SUPPORT_COMMANDS.has(command)) return this.handleSupportRequest(incoming, { replyTo, originIp });

    if (currentState.state === 'rules_menu') {
      await this.sendPanel(replyTo, incoming.phone, 'RULES_MENU', rulesMenu());
      return { type: 'whatsapp_invalid_rules_option', decision: 'reply_sent', reason: 'invalid_rules_option', state: 'rules_menu', originIp };
    }
    if (currentState.state === 'support_menu') {
      const context = this.getPlayerContext(incoming.phone);
      await this.sendPanel(replyTo, incoming.phone, 'SUPPORT_MENU', supportMenu({ publicReference: context.publicReference }));
      return { type: 'whatsapp_invalid_support_option', decision: 'reply_sent', reason: 'invalid_support_option', state: 'support_menu', originIp };
    }
    if (currentState.state === 'updates_menu') {
      await this.sendPanel(
        replyTo,
        incoming.phone,
        'PUBLIC_UPDATES_MENU',
        publicUpdatesMenu(this.publicRoadmapOptions()),
      );
      return { type: 'whatsapp_invalid_updates_option', decision: 'reply_sent', reason: 'invalid_updates_option', state: 'updates_menu', originIp };
    }
    await this.sendPanel(replyTo, incoming.phone, 'INVALID_COMMAND', invalidCommand());
    return { type: 'whatsapp_invalid_option', decision: 'reply_sent', reason: 'invalid_option', state: currentState.state, originIp };
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
      '💳 *Pagamento da mesa*',
      '',
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
        await this.send(payment.phone, `❌ O pagamento não foi aprovado. Motivo: ${payment.rejectionReason}`);
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
    if (isFinancialCommandText(normalizeCommand(parseIncomingMessage(payload).text))) {
      return this.handleConnectivityWebhook(payload, { originIp });
    }
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
          '✅ Comprovante recebido.',
          'A confirmação do pagamento está pendente.',
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
