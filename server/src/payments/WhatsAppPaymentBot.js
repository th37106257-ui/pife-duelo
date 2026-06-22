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
  const remoteJid = String(key.remoteJid || data.sender || payload.sender || '');
  const participant = String(key.participant || data.participant || '');
  const ownerJid = getOwnerJid(payload);
  const phone = normalizePhone(remoteJid.split('@')[0]);
  return {
    phone,
    remoteJid,
    participant,
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
    participant: maskTechnicalIdentity(incoming.participant),
    sender: maskTechnicalIdentity(incoming.sender),
    pushName: incoming.pushName ? maskTechnicalIdentity(incoming.pushName) : null,
    ownerJid: maskTechnicalIdentity(incoming.ownerJid),
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
  constructor({ paymentService, evolutionClient, pixKey, pixReceiver, adminNumbers = [], clock = Date.now } = {}) {
    this.paymentService = paymentService;
    this.evolutionClient = evolutionClient;
    this.pixKey = String(pixKey || '');
    this.pixReceiver = String(pixReceiver || '');
    this.adminNumbers = adminNumbers.map(normalizePhone).filter(Boolean);
    this.clock = clock;
    this.rateLimits = new Map();
    this.recentFingerprints = new Map();
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

  async handleConnectivityWebhook(payload, { originIp = null } = {}) {
    const event = String(payload?.event || '').toUpperCase().replace('.', '_');
    if (event !== 'MESSAGES_UPSERT') return { ignored: true, reason: 'unsupported-event' };

    const incoming = parseIncomingMessage(payload);
    if (incoming.fromMe) return { ignored: true, decision: 'ignored_from_me', reason: 'key_from_me_true' };
    if (incoming.isGroup) return { ignored: true, decision: 'ignored_invalid', reason: 'group_not_supported' };
    if (!incoming.phone || !incoming.remoteJid) return { ignored: true, decision: 'ignored_invalid', reason: 'missing_remote_jid' };
    if (!incoming.text) return { ignored: true, decision: 'ignored_invalid', reason: 'empty_text' };
    if (incoming.text.toLowerCase() !== 'oi') return { ignored: true, decision: 'ignored_invalid', reason: 'connectivity_test_only' };

    await this.send(incoming.phone, '\u{1F3B4} Pife Duelo online.');
    return { type: 'connectivity_greeting_sent', decision: 'reply_sent', reason: 'incoming_private_oi', originIp };
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
