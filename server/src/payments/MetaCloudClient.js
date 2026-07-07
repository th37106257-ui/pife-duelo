import { createHmac, timingSafeEqual } from 'node:crypto';
import { maskPhone, normalizePhone } from './PaymentService.js';

const DEFAULT_GRAPH_API_VERSION = 'v23.0';

function errorMessage(error) {
  return error?.name === 'AbortError' ? 'request_timeout' : (error?.message || String(error));
}

function maskTechnicalIdentity(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 4) return `${'*'.repeat(Math.min(8, Math.max(4, digits.length - 4)))}${digits.slice(-4)}`;
  if (raw.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, raw.length - 4))}${raw.slice(-4)}`;
}

function sanitizeMetaResponse(responseBody, depth = 0) {
  if (responseBody == null) return responseBody;
  if (depth > 3) return '<nested>';
  if (typeof responseBody === 'string') return responseBody.slice(0, 500);
  if (typeof responseBody !== 'object') return responseBody;
  if (Array.isArray(responseBody)) {
    return responseBody.slice(0, 10).map((item) => sanitizeMetaResponse(item, depth + 1));
  }
  return Object.fromEntries(Object.entries(responseBody).slice(0, 30).map(([key, value]) => {
    if (/token|secret|password|apikey|authorization/i.test(key)) return [key, '<hidden>'];
    if (/phone|number|wa_id|from|to|recipient|contact/i.test(key)) return [key, maskTechnicalIdentity(value)];
    return [key, sanitizeMetaResponse(value, depth + 1)];
  }));
}

function summarizeMetaResponse(responseBody = {}) {
  const firstMessage = Array.isArray(responseBody?.messages) ? responseBody.messages[0] : null;
  const firstContact = Array.isArray(responseBody?.contacts) ? responseBody.contacts[0] : null;
  return {
    messagingProduct: responseBody?.messaging_product ?? null,
    messageId: maskTechnicalIdentity(firstMessage?.id || responseBody?.id),
    contactInput: maskTechnicalIdentity(firstContact?.input),
    contactWaId: maskTechnicalIdentity(firstContact?.wa_id),
    errorCode: responseBody?.error?.code ?? null,
    errorType: responseBody?.error?.type ?? null,
    errorMessage: responseBody?.error?.message ? String(responseBody.error.message).slice(0, 200) : null,
  };
}

function getMetaQueryValue(query = {}, key) {
  return query[key] ?? query[`hub.${key}`] ?? query?.hub?.[key] ?? '';
}

function getMetaMessageText(message = {}) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'button') return message.button?.text || message.button?.payload || '';
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.id
      || message.interactive?.button_reply?.title
      || message.interactive?.list_reply?.id
      || message.interactive?.list_reply?.title
      || '';
  }
  if (message.type === 'image') return message.image?.caption || '';
  if (message.type === 'document') return message.document?.caption || '';
  if (message.type === 'video') return message.video?.caption || '';
  return '';
}

function buildEvolutionLikePayloadFromMeta({ payload = {}, entry = {}, change = {}, message = {}, contact = null }) {
  const value = change.value || {};
  const fromPhone = normalizePhone(message.from);
  const remoteJid = fromPhone ? `${fromPhone}@s.whatsapp.net` : '';
  const text = getMetaMessageText(message);
  const messageType = message.type === 'text' ? 'conversation' : String(message.type || 'unknown');
  const messageBody = message.type === 'image'
    ? { imageMessage: { caption: text } }
    : message.type === 'document'
      ? { documentMessage: { caption: text } }
      : { conversation: text };

  return {
    event: 'MESSAGES_UPSERT',
    instance: `meta_cloud:${value.metadata?.phone_number_id || ''}`,
    data: {
      key: {
        id: message.id || '',
        remoteJid,
        fromMe: false,
      },
      message: messageBody,
      messageType,
      sender: remoteJid,
      pushName: contact?.profile?.name || null,
      metaCloud: {
        object: payload.object || null,
        entryId: entry.id || null,
        field: change.field || null,
        phoneNumberId: value.metadata?.phone_number_id || null,
        displayPhoneNumber: value.metadata?.display_phone_number || null,
        messageType: message.type || null,
        timestamp: message.timestamp || null,
      },
    },
  };
}

export function verifyMetaWebhook(query = {}, verifyToken = '') {
  const mode = getMetaQueryValue(query, 'mode');
  const token = getMetaQueryValue(query, 'verify_token');
  const challenge = getMetaQueryValue(query, 'challenge');
  const ok = mode === 'subscribe' && Boolean(verifyToken) && token === verifyToken && Boolean(challenge);
  return {
    ok,
    challenge: ok ? String(challenge) : '',
    reason: ok ? 'verified' : 'invalid_meta_webhook_verification',
  };
}

export function handleMetaWebhookEvent(payload = {}) {
  const messages = [];
  const statusEvents = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      const contacts = new Map((value.contacts || []).map((contact) => [String(contact.wa_id || ''), contact]));

      for (const message of value.messages || []) {
        const contact = contacts.get(String(message.from || '')) || null;
        messages.push({
          provider: 'meta_cloud',
          phone: normalizePhone(message.from),
          messageId: message.id || '',
          text: getMetaMessageText(message),
          type: message.type || '',
          phoneNumberId: value.metadata?.phone_number_id || '',
          payload: buildEvolutionLikePayloadFromMeta({ payload, entry, change, message, contact }),
        });
      }

      for (const status of value.statuses || []) {
        statusEvents.push({
          provider: 'meta_cloud',
          messageId: status.id || '',
          recipientId: normalizePhone(status.recipient_id),
          status: status.status || '',
          timestamp: status.timestamp || '',
          phoneNumberId: value.metadata?.phone_number_id || '',
        });
      }
    }
  }

  return {
    provider: 'meta_cloud',
    messages,
    statusEvents,
    messageCount: messages.length,
    statusCount: statusEvents.length,
  };
}

export class MetaCloudClient {
  constructor({
    token,
    phoneNumberId,
    verifyToken,
    appSecret = '',
    graphApiVersion = DEFAULT_GRAPH_API_VERSION,
    fetchImpl = fetch,
    timeoutMs = 10000,
  } = {}) {
    this.providerName = 'meta_cloud';
    this.token = String(token || '');
    this.phoneNumberId = String(phoneNumberId || '');
    this.verifyToken = String(verifyToken || '');
    this.appSecret = String(appSecret || '');
    this.graphApiVersion = String(graphApiVersion || DEFAULT_GRAPH_API_VERSION).replace(/^\/+|\/+$/g, '');
    this.baseUrl = `https://graph.facebook.com/${this.graphApiVersion}`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.instanceName = this.phoneNumberId ? `meta_cloud:${this.phoneNumberId}` : 'meta_cloud';
    this.diagnostics = {
      provider: this.providerName,
      instanceName: this.instanceName,
      lastStatusCheckAt: null,
      lastStatus: null,
      lastStatusHttpStatus: null,
      lastStatusError: null,
      lastWebhookReceivedAt: null,
      lastWebhookEvent: null,
      lastWebhookInstance: null,
      lastMessageProcessedAt: null,
      lastMessageFrom: null,
      lastSendAttemptAt: null,
      lastSendTarget: null,
      lastSendHttpStatus: null,
      lastSendSuccessAt: null,
      lastSendErrorAt: null,
      lastError: null,
      lastResponse: null,
      reconnectNeeded: false,
    };
  }

  isConfigured() {
    return Boolean(this.token && this.phoneNumberId);
  }

  getDiagnostics() {
    return {
      ...this.diagnostics,
      provider: this.providerName,
      configured: this.isConfigured(),
      instanceName: this.instanceName,
      phoneNumberIdConfigured: Boolean(this.phoneNumberId),
      tokenConfigured: Boolean(this.token),
      verifyTokenConfigured: Boolean(this.verifyToken),
      appSecretConfigured: Boolean(this.appSecret),
      graphApiVersion: this.graphApiVersion,
    };
  }

  recordWebhookReceived(payload = {}) {
    this.diagnostics.lastWebhookReceivedAt = new Date().toISOString();
    this.diagnostics.lastWebhookEvent = payload?.event ?? payload?.object ?? null;
    this.diagnostics.lastWebhookInstance = this.instanceName;
  }

  recordMessageProcessed({ phone = null } = {}) {
    this.diagnostics.lastMessageProcessedAt = new Date().toISOString();
    this.diagnostics.lastMessageFrom = maskPhone(phone) || null;
  }

  verifyMetaWebhook(query = {}) {
    return verifyMetaWebhook(query, this.verifyToken);
  }

  handleMetaWebhookEvent(payload = {}) {
    this.recordWebhookReceived(payload);
    return handleMetaWebhookEvent(payload);
  }

  verifyRequestSignature(rawBody, signatureHeader) {
    if (!this.appSecret) return { ok: true, reason: 'app_secret_not_configured' };
    const signature = String(signatureHeader || '').replace(/^sha256=/i, '');
    if (!signature || !rawBody) return { ok: false, reason: 'missing_signature' };
    const expected = createHmac('sha256', this.appSecret).update(rawBody).digest('hex');
    const left = Buffer.from(signature, 'hex');
    const right = Buffer.from(expected, 'hex');
    const ok = left.length === right.length && timingSafeEqual(left, right);
    return { ok, reason: ok ? 'signature_valid' : 'invalid_signature' };
  }

  async checkInstanceStatus() {
    const state = this.isConfigured() ? 'configured' : 'not_configured';
    const result = {
      ok: this.isConfigured(),
      isOpen: this.isConfigured(),
      state,
      httpStatus: null,
      provider: this.providerName,
      reason: this.isConfigured() ? null : 'META_CLOUD_NOT_CONFIGURED',
    };
    this.diagnostics.lastStatusCheckAt = new Date().toISOString();
    this.diagnostics.lastStatus = state;
    this.diagnostics.lastStatusError = result.reason;
    this.diagnostics.reconnectNeeded = !this.isConfigured();
    console.log('WHATSAPP_STATUS_CHECK', {
      provider: this.providerName,
      configured: this.isConfigured(),
      state,
      isOpen: result.isOpen,
    });
    return result;
  }

  buildSendPayloadPreview(phone, text) {
    const number = normalizePhone(phone);
    const safeText = String(text || '').trim().slice(0, 4000);
    return {
      provider: this.providerName,
      endpoint: `/${this.graphApiVersion}/${this.phoneNumberId || '<phone_number_id>'}/messages`,
      payload: {
        messaging_product: 'whatsapp',
        to: maskPhone(number),
        type: 'text',
        textLength: safeText.length,
      },
      target: maskPhone(number),
    };
  }

  async sendMetaCloudMessage(phone, text, {
    throwOnFailure = false,
  } = {}) {
    const fail = (reason, extra = {}) => {
      const result = {
        ok: false,
        sent: false,
        provider: this.providerName,
        reason,
        ...extra,
      };
      this.diagnostics.lastSendErrorAt = new Date().toISOString();
      this.diagnostics.lastError = reason;
      if (throwOnFailure) {
        const error = new Error(reason);
        Object.assign(error, result);
        throw error;
      }
      return result;
    };

    if (!this.isConfigured()) return fail('META_CLOUD_NOT_CONFIGURED');

    const number = normalizePhone(phone);
    const safeText = String(text || '').trim().slice(0, 4000);
    if (!number || !safeText) {
      console.error('WHATSAPP_SEND_FAILED', {
        provider: this.providerName,
        reason: 'INVALID_WHATSAPP_MESSAGE',
        target: maskTechnicalIdentity(phone),
        normalizedTarget: maskPhone(number),
      });
      return fail('INVALID_WHATSAPP_MESSAGE', { target: maskPhone(number) });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const attemptedAt = new Date().toISOString();
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: number,
      type: 'text',
      text: {
        preview_url: false,
        body: safeText,
      },
    };

    try {
      this.diagnostics.lastSendAttemptAt = attemptedAt;
      this.diagnostics.lastSendTarget = maskPhone(number);
      console.log('WHATSAPP_SEND_ATTEMPT', {
        provider: this.providerName,
        target: maskPhone(number),
        textLength: safeText.length,
      });
      console.log('META_CLOUD_SEND_ATTEMPT', {
        phoneNumberIdConfigured: Boolean(this.phoneNumberId),
        target: maskPhone(number),
        textLength: safeText.length,
      });
      const response = await this.fetchImpl(
        `${this.baseUrl}/${encodeURIComponent(this.phoneNumberId)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
      const responseBody = await response.json().catch(() => ({}));
      this.diagnostics.lastSendHttpStatus = response.status ?? null;
      this.diagnostics.lastResponse = summarizeMetaResponse(responseBody);
      console.log('WHATSAPP_SEND_STATUS', {
        provider: this.providerName,
        responseOk: response.ok,
        httpStatus: response.status ?? null,
      });
      console.log('META_CLOUD_SEND_RESPONSE', {
        target: maskPhone(number),
        responseOk: response.ok,
        httpStatus: response.status ?? null,
        response: summarizeMetaResponse(responseBody),
      });
      if (!response.ok) {
        console.error('WHATSAPP_SEND_FAILED', {
          provider: this.providerName,
          target: maskPhone(number),
          httpStatus: response.status ?? null,
          response: sanitizeMetaResponse(responseBody),
        });
        return fail(`META_CLOUD_SEND_FAILED_${response.status}`, {
          httpStatus: response.status ?? null,
          response: summarizeMetaResponse(responseBody),
          rawResponse: sanitizeMetaResponse(responseBody),
          request: this.buildSendPayloadPreview(phone, safeText),
        });
      }
      this.diagnostics.lastSendSuccessAt = new Date().toISOString();
      this.diagnostics.lastError = null;
      console.log('WHATSAPP_SEND_SUCCESS', {
        provider: this.providerName,
        target: maskPhone(number),
        httpStatus: response.status ?? null,
        response: summarizeMetaResponse(responseBody),
      });
      return {
        ok: true,
        sent: true,
        provider: this.providerName,
        httpStatus: response.status ?? null,
        response: summarizeMetaResponse(responseBody),
        rawResponse: sanitizeMetaResponse(responseBody),
        request: this.buildSendPayloadPreview(phone, safeText),
      };
    } catch (error) {
      const message = errorMessage(error);
      this.diagnostics.lastSendErrorAt = new Date().toISOString();
      this.diagnostics.lastError = message;
      console.error('WHATSAPP_SEND_FAILED', {
        provider: this.providerName,
        target: maskPhone(number),
        message,
      });
      return fail(message, {
        error: message,
        request: this.buildSendPayloadPreview(phone, safeText),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendWhatsAppMessage(phone, text, options = {}) {
    return this.sendMetaCloudMessage(phone, text, options);
  }

  async sendText(phone, text, options = {}) {
    const result = await this.sendMetaCloudMessage(phone, text, {
      ...options,
      throwOnFailure: options.throwOnFailure ?? true,
    });
    return result.rawResponse ?? result;
  }
}

export default MetaCloudClient;
