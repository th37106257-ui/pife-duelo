import { maskPhone, normalizePhone } from './PaymentService.js';

function sanitizeText(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function getMessageText(message = {}) {
  return sanitizeText(
    message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.documentMessage?.caption
    || message.buttonsResponseMessage?.selectedDisplayText
    || message.buttonsResponseMessage?.selectedButtonId
    || message.listResponseMessage?.singleSelectReply?.selectedRowId
    || '',
  );
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

function getOwnerJid(payload = {}) {
  const candidates = [
    payload.ownerJid,
    payload.instance?.ownerJid,
    payload.data?.ownerJid,
    payload.sender,
  ];
  return candidates.find((value) => /@(?:s\.whatsapp\.net|lid)$/i.test(String(value || ''))) || '';
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
  const phoneJid = [senderJid, keyRemoteJid, keyRemoteJidAlt, participant, participantAlt]
    .find((jid) => isWhatsappJid(jid, 's.whatsapp.net')) || remoteJid;
  const phone = normalizePhone(phoneJid.split('@')[0]);
  const replyTo = [keyRemoteJid, keyRemoteJidAlt, participant, participantAlt, senderJid]
    .find((jid) => isWhatsappJid(jid, 'lid'))
    || keyRemoteJid
    || senderJid
    || phone;
  return {
    phone,
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
    text: getMessageText(message),
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
    keyFromMe: incoming.rawFromMe ?? null,
    remoteJid: maskTechnicalIdentity(incoming.remoteJid),
    remoteJidAlt: maskTechnicalIdentity(incoming.remoteJidAlt),
    participant: maskTechnicalIdentity(incoming.participant),
    participantAlt: maskTechnicalIdentity(incoming.participantAlt),
    sender: maskTechnicalIdentity(incoming.sender),
    pushName: incoming.pushName ? maskTechnicalIdentity(incoming.pushName) : null,
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
    clock = Date.now,
  } = {}) {
    this.paymentService = paymentService;
    this.entryService = entryService;
    this.matchQueue = matchQueue;
    this.safeEntryEnabled = Boolean(safeEntryEnabled);
    this.evolutionClient = evolutionClient;
    this.pixKey = String(pixKey || '');
    this.pixReceiver = String(pixReceiver || '');
    this.adminNumbers = adminNumbers.map(normalizePhone).filter(Boolean);
    this.clock = clock;
    this.rateLimits = new Map();
    this.recentFingerprints = new Map();
    this.conversationStates = new Map();
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

  async send(phone, text) {
    return this.evolutionClient.sendText(phone, text);
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
      '1\uFE0F\u20E3 Jogar',
      '2\uFE0F\u20E3 Ver mesas',
      '3\uFE0F\u20E3 Regras',
      '4\uFE0F\u20E3 Suporte',
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

  safeSupportText() {
    return [
      '\u{1F6E0}\uFE0F Suporte Pife Duelo',
      '',
      'Envie sua d\u00favida aqui e aguarde atendimento.',
    ].join('\n');
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
    if (!this.safeEntryEnabled || !this.entryService?.isConfigured() || !this.entryService.isAdmin(phone)) {
      await this.send(replyTo, 'Comando n\u00e3o autorizado.');
      return { type: 'entry_admin_unauthorized', decision: 'reply_sent', reason: 'admin_not_authorized' };
    }

    if (/^\/admin\s+entradas$/i.test(text)) {
      await this.send(replyTo, this.pendingEntriesText());
      return { type: 'entry_admin_pending_list', decision: 'reply_sent', reason: 'pending_entries_listed' };
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

    await this.send(replyTo, 'Comando admin inv\u00e1lido. Use /admin entradas, /admin liberar ENTRY_ID ou /admin rejeitar ENTRY_ID motivo.');
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
    return [
      '✅ Você saiu da fila.',
      'Voltando ao menu principal.',
    ].join('\n');
  }

  async handleConnectivityWebhook(payload, { originIp = null } = {}) {
    const event = String(payload?.event || '').toUpperCase().replace('.', '_');
    if (event !== 'MESSAGES_UPSERT') return { ignored: true, reason: 'unsupported-event' };

    const incoming = parseIncomingMessage(payload);
    if (incoming.fromMe) return { ignored: true, decision: 'ignored_from_me', reason: 'key_from_me_true' };
    if (incoming.isGroup) return { ignored: true, decision: 'ignored_invalid', reason: 'group_not_supported' };
    if (!incoming.phone || !incoming.remoteJid) return { ignored: true, decision: 'ignored_invalid', reason: 'missing_remote_jid' };
    if (!incoming.text) return { ignored: true, decision: 'ignored_invalid', reason: 'empty_text' };

    if (this.safeEntryEnabled && incoming.messageId && this.entryService?.store?.hasProcessedMessage(incoming.messageId)) {
      return { ignored: true, decision: 'ignored_invalid', reason: 'duplicate_message' };
    }
    if (this.safeEntryEnabled && incoming.messageId) this.entryService?.store?.markMessageProcessed(incoming.messageId);

    const command = normalizeCommand(incoming.text);
    const replyTo = incoming.replyTo || incoming.phone;
    if (command.startsWith('/admin')) return this.handleSafeEntryAdminCommand(incoming.phone, incoming.text, { replyTo });
    const queuedPlayer = this.matchQueue?.findPlayerQueue?.(incoming.phone);
    if ((MENU_COMMANDS.has(command) || CANCEL_QUEUE_COMMANDS.has(command)) && queuedPlayer) {
      this.matchQueue.removeFromQueue(incoming.phone, { reason: `whatsapp_${command}` });
      this.setConversationState(incoming.phone, 'idle');
      await this.send(replyTo, [
        this.safeQueueCancelledText(),
        '',
        this.safeMenuText(),
      ].join('\n'));
      return {
        type: 'whatsapp_queue_cancelled',
        decision: 'reply_sent',
        reason: command === 'menu' ? 'menu_command_cancelled_queue' : 'queue_cancel_command',
        state: 'idle',
        selectedTable: queuedPlayer.tableValue,
        originIp,
      };
    }
    if (CANCEL_QUEUE_COMMANDS.has(command)) {
      this.setConversationState(incoming.phone, 'idle');
      await this.send(replyTo, [
        'Você não está aguardando em nenhuma fila.',
        '',
        this.safeMenuText(),
      ].join('\n'));
      return { type: 'whatsapp_queue_cancel_empty', decision: 'reply_sent', reason: 'player_not_in_queue', state: 'idle', originIp };
    }
    if (MENU_COMMANDS.has(command)) {
      this.setConversationState(incoming.phone, 'idle');
      await this.send(replyTo, this.safeMenuText());
      return { type: 'whatsapp_menu_sent', decision: 'reply_sent', reason: 'menu_command', state: 'idle', originIp };
    }

    const currentState = this.getConversationState(incoming.phone);
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

    if (command === '1' || command === '2') {
      this.setConversationState(incoming.phone, 'choosing_table');
      await this.send(replyTo, this.safeTablesText());
      return { type: 'whatsapp_tables_sent', decision: 'reply_sent', reason: 'tables_requested', state: 'choosing_table', originIp };
    }

    if (command === '3') {
      this.setConversationState(incoming.phone, 'idle');
      await this.send(replyTo, this.safeRulesText());
      return { type: 'whatsapp_rules_sent', decision: 'reply_sent', reason: 'rules_requested', state: 'idle', originIp };
    }

    if (command === '4') {
      this.setConversationState(incoming.phone, 'idle');
      await this.send(replyTo, this.safeSupportText());
      return { type: 'whatsapp_support_sent', decision: 'reply_sent', reason: 'support_requested', state: 'idle', originIp };
    }

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
    if (event !== 'MESSAGES_UPSERT') return { ignored: true, reason: 'unsupported-event' };
    const incoming = parseIncomingMessage(payload);
    if (!incoming.phone || incoming.fromMe) return { ignored: true, reason: 'invalid-or-outgoing-message' };
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
